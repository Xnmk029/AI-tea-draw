import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createAgentRuntime, type AgentRuntime, type LiveCtx, type LiveHandle } from '../game/liveAgent'
import { McpClient, type CallResult, type LivePeer } from '../game/mcpClient'
import { uid } from '../game/engine'

export interface AgentSession {
  peer: LivePeer
  port: number
  connected: boolean
  enabled: boolean
  error: string | null
  connect: (port?: number) => void
  disconnect: () => void
  reconnect: () => void
  bind: (contextId: string, ctx: LiveCtx, onPeer?: (peer: LivePeer) => void) => LiveHandle
}

interface SessionState {
  peer: LivePeer
  port: number
  enabled: boolean
  error: string | null
}

const STORAGE_KEY = 'teadraw:agent-port'
const AgentSessionContext = createContext<AgentSession | null>(null)
const validPort = (port: unknown) => Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
const initialPort = () => {
  const requested = new URLSearchParams(location.search).get('mcp')
  if (requested && validPort(requested)) return Number(requested)
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && validPort(saved)) return Number(saved)
  } catch {}
  return 5190
}

function createController(initial: SessionState, publish: (state: SessionState) => void) {
  let state = initial
  let active: { runtime: AgentRuntime; onPeer?: (peer: LivePeer) => void } | null = null
  let seq = 0
  const events: { seq: number; type: string; data?: unknown }[] = []
  const update = (next: Partial<SessionState>) => { state = { ...state, ...next }; publish(state) }
  const emit = (type: string, data?: unknown) => {
    const event = { seq: ++seq, type, data }
    events.push(event)
    if (events.length > 160) events.shift()
    client.event({ type, data })
  }
  const idleCall = (name: string): CallResult => {
    if (name === 'turn_get_task') return { data: { task: null, context: 'idle' } }
    if (name === 'room_state') return { data: { context: 'idle', room: null, mode: null, seats: [], me: null, note: '茶绘已连接；打开“我的茶宠”试画纸或进入对局后可以作画。' } }
    return { error: { code: 'no_canvas', message: '当前没有作画环境，请打开“我的茶宠”试画纸或进入对局' } }
  }
  const client = new McpClient({
    url: `ws://127.0.0.1:${initial.port}`,
    autoConnect: false,
    join: () => active?.runtime.join() ?? { context: 'idle', room: null, seat: null },
    onPeer: (peer) => {
      update({ peer, error: peer.error ?? null })
      if (peer.state === 'down' || peer.state === 'off') active?.runtime.failTask('Agent 连接已断开')
      active?.onPeer?.(peer)
    },
    onCall: (name, args) => {
      if (name === 'events_poll') return { data: { events: events.filter((event) => event.seq > (Number(args.since) || 0)), seq } }
      return active ? active.runtime.call(name, args) : idleCall(name)
    },
  })
  const disconnect = () => {
    active?.runtime.cancelTask('Agent 已断开')
    client.dispose()
    update({ enabled: false, peer: { state: 'off' }, error: null })
    active?.onPeer?.({ state: 'off' })
  }
  const connect = (port = state.port) => {
    if (!validPort(port)) { update({ error: '端口必须是 1024–65535 的整数' }); return }
    active?.runtime.cancelTask('连接已重建')
    try { localStorage.setItem(STORAGE_KEY, String(port)) } catch {}
    update({ port, enabled: true, error: null })
    client.connect(`ws://127.0.0.1:${port}`)
  }
  const bind: AgentSession['bind'] = (id, ctx, onPeer) => {
    active?.runtime.dispose()
    const contextId = `${id}:${uid('ctx')}`
    const runtime = createAgentRuntime(ctx, client, { contextId, emit, isCurrent: () => active?.runtime === runtime })
    active = { runtime, onPeer }
    client.updateContext()
    onPeer?.(state.peer)
    emit('context', { context: ctx.context ?? 'game', contextId })
    return {
      ...runtime,
      dispose: () => {
        if (active?.runtime !== runtime) return
        runtime.dispose()
        active = null
        client.updateContext()
        emit('context', { context: 'idle' })
      },
    }
  }
  return {
    connect, disconnect, reconnect: () => connect(), bind,
    dispose: () => { active?.runtime.dispose(); active = null; client.dispose() },
  }
}

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(() => ({ peer: { state: 'off' }, port: initialPort(), enabled: true, error: null }))
  const controller = useRef<ReturnType<typeof createController> | null>(null)
  if (!controller.current) controller.current = createController(state, setState)
  const current = controller.current
  useEffect(() => {
    current.connect()
    return () => current.dispose()
  }, [current])
  return <AgentSessionContext.Provider value={{ ...state, connected: state.peer.state === 'awake', connect: current.connect, disconnect: current.disconnect, reconnect: current.reconnect, bind: current.bind }}>{children}</AgentSessionContext.Provider>
}

export function useAgentSession(): AgentSession | null {
  return useContext(AgentSessionContext)
}
