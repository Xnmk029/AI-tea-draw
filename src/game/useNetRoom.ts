import { useEffect, useRef, useState } from 'react'
import type { ChatMsg, ModeId, RoomRules, Screen, Seat } from '../core/types'
import { SEAT_COLORS } from '../core/theme'
import type { SessionResult } from './gameTypes'
import { connectNet, type NetLink, type NetParams, type RoomMsg } from './netSync'

type Phase = 'lobby' | 'game' | 'result'
interface Member { peerId: string; seat: number; name: string; color: string }
interface RoomState { mode: ModeId; rules: RoomRules; phase: Phase; gameId: string; members: Member[]; result?: SessionResult | null }

export function netParams(): NetParams | undefined {
  const q = new URLSearchParams(location.search)
  const port = Number(q.get('net'))
  const token = q.get('token')
  return Number.isInteger(port) && port > 0 && port < 65536 && token
    ? { port, token, room: q.get('room') || undefined, name: q.get('name') || undefined }
    : undefined
}

const cacheKey = (p: NetParams) => `teadraw:room:${p.port}:${p.token}`
export function savedNetRoom(p?: NetParams): RoomState | undefined {
  if (!p) return
  try { return JSON.parse(sessionStorage.getItem(cacheKey(p)) || 'null') ?? undefined } catch { return }
}

export function useNetRoom(options: {
  params?: NetParams; screen: Screen; mode: ModeId; rules: RoomRules; seats: Seat[]
  onMode: (m: ModeId) => void; onRules: (r: RoomRules) => void
  onPhase: (phase: Phase, gameId: string, result?: SessionResult | null) => void
}) {
  const { params } = options
  const latest = useRef(options)
  latest.current = options
  const [active, setActive] = useState(!!params && options.screen !== 'home')
  const [attempt, setAttempt] = useState(0)
  const [link, setLink] = useState<NetLink | null>(null)
  const linkRef = useRef<NetLink | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const target = useRef(params?.room)
  const retryTimer = useRef(0)
  const helloTimer = useRef(0)
  const closed = useRef(false)
  const joining = useRef<Promise<void>>(Promise.resolve())
  const restored = savedNetRoom(params)
  const state = useRef<RoomState>({ mode: options.mode, rules: options.rules, phase: options.screen === 'game' ? 'game' : options.screen === 'result' ? 'result' : 'lobby', gameId: restored?.gameId ?? '', members: restored?.members ?? [], result: restored?.result })

  const persist = () => {
    if (params) try { sessionStorage.setItem(cacheKey(params), JSON.stringify(state.current)) } catch { /* 存储不可用 */ }
  }
  const roster = () => {
    const l = linkRef.current
    if (!l) return []
    const known = new Map(state.current.members.map((m) => [m.peerId, m]))
    const used = new Set(state.current.members.filter((m) => l.members().includes(m.peerId)).map((m) => m.seat))
    return l.members().map((id): Member => {
      const previous = known.get(id)
      if (previous) return previous
      let seat = id === l.hostId ? 1 : 2
      while (used.has(seat)) seat++
      used.add(seat)
      return { peerId: id, seat, name: id === l.selfId ? params?.name ?? latest.current.seats.find((s) => s.isMe)?.name ?? '茶客' : `茶客 ${seat}`, color: SEAT_COLORS[(seat - 1) % SEAT_COLORS.length] }
    })
  }
  const publish = (to?: string) => {
    const l = linkRef.current
    if (l?.role !== 'host') return
    state.current.members = roster()
    l.seatRoster = state.current.members
    setMembers(state.current.members)
    persist()
    const msg = { t: 'lobby-state', ...state.current }
    if (to) l.to(to, msg)
    else l.broadcast(msg)
  }
  const apply = (msg: RoomMsg) => {
    const l = linkRef.current
    if (!l || (msg.mode !== 'tea' && msg.mode !== 'guess') || !msg.rules || typeof msg.rules !== 'object' || !Array.isArray(msg.members) || typeof msg.gameId !== 'string' || !['lobby', 'game', 'result'].includes(String(msg.phase))) return
    state.current = msg as unknown as RoomState
    l.seatRoster = state.current.members
    l.setGame(state.current.gameId)
    latest.current.onMode(state.current.mode)
    latest.current.onRules(state.current.rules)
    setMembers(state.current.members)
    setReady(true)
    setError(null)
    window.clearInterval(helloTimer.current)
    persist()
    latest.current.onPhase(state.current.phase, state.current.gameId, state.current.result)
  }
  const packet = (from: string, msg: RoomMsg) => {
    const l = linkRef.current
    if (!l) return
    if (l.role === 'peer') {
      if (from !== l.hostId) return
      if (msg.t === 'lobby-state') apply(msg)
      if (msg.t === 'lobby-chat' && msg.msg) setChat((c) => [...c.slice(-49), msg.msg as ChatMsg])
      if (msg.t === 'session-over' && msg.gameId === l.gameId) {
        state.current = { ...state.current, phase: 'result', result: msg.result as SessionResult }
        persist()
        latest.current.onPhase('result', l.gameId, msg.result as SessionResult)
      }
      return
    }
    if (!l.members().includes(from)) return
    if (msg.t === 'hello' || msg.t === 'lobby-hello') {
      state.current.members = roster().map((m) => m.peerId === from ? { ...m, name: typeof msg.name === 'string' ? msg.name.trim().slice(0, 12) || '茶客' : m.name } : m)
      publish()
    }
    if (msg.t === 'lobby-chat' && typeof msg.text === 'string') {
      const member = state.current.members.find((m) => m.peerId === from)
      if (member) sendChat(msg.text, member)
    }
  }
  const sendChat = (text: string, member?: Member) => {
    const l = linkRef.current
    const value = text.trim().slice(0, 200)
    if (!l || !value) return
    if (l.role === 'peer') { l.intent({ t: 'lobby-chat', text: value }); return }
    const actor = member ?? state.current.members.find((m) => m.peerId === l.selfId)
    if (!actor) return
    const msg: ChatMsg = { id: crypto.randomUUID(), seat: actor.seat, author: 'human', text: value }
    setChat((c) => [...c.slice(-49), msg])
    l.broadcast({ t: 'lobby-chat', msg })
  }
  const callbacks = useRef({ packet, publish })
  callbacks.current = { packet, publish }

  useEffect(() => {
    if (!params || !active) return
    let dead = false
    closed.current = false
    setError(null)
    const previous = joining.current
    const pending = previous.then(() => dead ? undefined : connectNet({ ...params, room: target.current }, {
      onPacket: (from, msg) => { if (!dead) callbacks.current.packet(from, msg) },
      onMembers: () => { if (!dead) callbacks.current.publish() },
      onClose: (reason) => {
        if (dead || closed.current) return
        setError(reason === 'HOST_LEFT' ? '房主已离开，房间已结束' : `联机连接中断：${reason}`)
        if (reason === 'BRIDGE_CLOSED') {
          retryTimer.current = window.setTimeout(() => setAttempt((a) => a + 1), 1000)
        } else setReady(false)
      },
      onError: (reason) => { if (!dead) setError(`联机消息失败：${reason}`) },
    })).then(async (l) => {
      if (!l) return
      if (dead) { await l.close(); return }
      linkRef.current = l
      setLink(l)
      const u = new URLSearchParams(location.search)
      u.set('room', l.room)
      history.replaceState(null, '', `${location.pathname}?${u}`)
      target.current = l.room
      l.setGame(state.current.gameId || `${l.room}:initial`)
      state.current.gameId = l.gameId
      if (l.role === 'host') {
        if (state.current.mode === 'relay') { setError('传话联机尚未开放，请返回主页选择茶绘或猜词'); setReady(false); return }
        setReady(true)
        callbacks.current.publish()
      } else {
        l.intent({ t: 'lobby-hello', name: params.name ?? latest.current.seats.find((s) => s.isMe)?.name ?? '茶客' })
        helloTimer.current = window.setInterval(() => l.intent({ t: 'lobby-hello', name: params.name ?? '茶客' }), 1000)
      }
    }).catch((e: unknown) => {
      if (dead) return
      setError(`联机失败：${e instanceof Error ? e.message : String(e)}`)
      setReady(false)
    })
    joining.current = pending
    return () => {
      dead = true
      window.clearTimeout(retryTimer.current)
      window.clearInterval(helloTimer.current)
      const disconnected = linkRef.current?.disconnect() ?? Promise.resolve()
      joining.current = Promise.all([joining.current, disconnected]).then(() => {})
    }
  }, [active, attempt, params])

  const changeMode = (mode: ModeId) => {
    if (linkRef.current?.role !== 'host' || mode === 'relay' || state.current.phase === 'game') return
    state.current.mode = mode
    latest.current.onMode(mode)
    publish()
  }
  const changeRules = (rules: RoomRules) => {
    if (linkRef.current?.role !== 'host' || state.current.phase !== 'lobby') return
    state.current.rules = rules
    latest.current.onRules(rules)
    publish()
  }
  const start = () => {
    const l = linkRef.current
    if (l?.role !== 'host' || !ready || error || state.current.mode === 'relay' || state.current.phase === 'game') return
    state.current = { ...state.current, phase: 'game', gameId: crypto.randomUUID(), result: null }
    l.setGame(state.current.gameId)
    publish()
    latest.current.onPhase('game', l.gameId)
  }
  const finish = (result: SessionResult) => {
    state.current = { ...state.current, phase: 'result', result }
    persist()
    if (linkRef.current?.role === 'host') publish()
    latest.current.onPhase('result', state.current.gameId, result)
  }
  const returnLobby = () => {
    if (linkRef.current?.role !== 'host') return
    state.current.phase = 'lobby'
    publish()
    latest.current.onPhase('lobby', state.current.gameId)
  }
  const leave = () => {
    closed.current = true
    const leaving = linkRef.current?.close() ?? Promise.resolve()
    joining.current = Promise.all([joining.current, leaving]).then(() => {})
    linkRef.current = null
    setLink(null)
    setActive(false)
    setReady(false)
    setMembers([])
    setChat([])
    setError(null)
    target.current = undefined
    state.current = { ...state.current, phase: 'lobby', gameId: '', members: [], result: null }
    if (params) sessionStorage.removeItem(cacheKey(params))
    const u = new URLSearchParams(location.search)
    u.delete('room')
    u.set('screen', 'home')
    history.replaceState(null, '', `${location.pathname}?${u}`)
  }
  const seats: Seat[] = members.map((m) => {
    const me = latest.current.seats.find((s) => s.isMe)
    return { id: m.seat, name: m.name, color: m.color, isMe: m.peerId === link?.selfId, isHost: m.peerId === link?.hostId, ready: true, online: true, score: 0, agent: m.peerId === link?.selfId ? me?.agent ?? null : null }
  })
  return { enabled: !!params, link, ready, error, seats, chat, isHost: link?.role === 'host', start, finish, returnLobby, leave, sendChat, changeMode, changeRules,
    enter: (room?: string) => {
      target.current = room
      state.current = { mode: latest.current.mode, rules: latest.current.rules, phase: 'lobby', gameId: '', members: [], result: null }
      setActive(true)
      if (active) setAttempt((a) => a + 1)
    },
    retry: () => setAttempt((a) => a + 1),
  }
}

export type NetRoom = ReturnType<typeof useNetRoom>
