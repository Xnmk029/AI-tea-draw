import { useEffect, useRef, useState } from 'react'
import type { ActivityItem, AgentStatus, Op, RoomRules, Seat } from '../core/types'
import type { Ghost } from '../game/gameTypes'
import { animateOps, buildBatch, nowTime, uid, type Batch } from '../game/engine'
import type { LiveCtx, LiveHandle, LiveTaskStatus } from '../game/liveAgent'
import { opBounds, type DrawTarget, type TargetMark } from '../game/targeting'
import { DEFAULT_RULES, GUESSER_TARGET } from '../mock/room'
import type { AgentSession } from './AgentSession'
import { agentStyleName, buildAgentPrompt, readAgentPreferences } from './preferences'
import type { PetDebugRules, PetGuide, PetSandbox, PetTrial } from './petTypes'

export type { PetSandbox } from './petTypes'
const FRAME = { x: 0, y: 0, w: 640, h: 360 }
const DEFAULT_DEBUG: PetDebugRules = { agentLevel: 'assist', inkLimit: 4000, penSpeed: 900, svgPreset: 'standard', targetFit: 'contain', avoidOthers: true }
type PetState = Pick<PetSandbox, 'ops' | 'ghost' | 'marks' | 'status' | 'taskState' | 'error' | 'history' | 'activity' | 'guide' | 'debugRules'>
const initial = (): PetState => ({ ops: [], ghost: null, marks: [], status: 'idle', taskState: 'idle', error: null, history: [], activity: [], guide: 'none', debugRules: { ...DEFAULT_DEBUG } })
const terminal = (status: PetTrial['status']) => ['completed', 'cancelled', 'failed'].includes(status)
const staticOps = (ops: Op[]) => ops.map(({ anim: _anim, ...op }) => op)

export function usePetSandbox(session: AgentSession | null, active: boolean): PetSandbox {
  const [state, setState] = useState<PetState>(initial)
  const data = useRef(state)
  const latest = useRef({ session, active })
  latest.current = { session, active }
  const handle = useRef<LiveHandle | null>(null)
  const trialId = useRef<string | null>(null)
  const trialOps = useRef<Op[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const generation = useRef(0)
  const ready = useRef(false)
  const change = (patch: Partial<PetState>) => {
    data.current = { ...data.current, ...patch }
    setState(data.current)
  }
  const log = (tool: string, detail: string, tone: ActivityItem['tone'] = 'muted') => {
    change({ activity: [...data.current.activity, { id: uid('act'), time: nowTime(), tool, detail, tone }].slice(-60) })
  }
  const updateTrial = (id: string | null, patch: Partial<PetTrial>) => {
    if (!id) return
    change({ history: data.current.history.map(row => row.id === id ? { ...row, ...patch } : row) })
  }
  const later = (ms: number, callback: () => void) => {
    const g = generation.current
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      if (g === generation.current && ready.current) callback()
    }, ms)
    timers.current.add(timer)
  }
  const clearTimers = () => {
    generation.current++
    timers.current.forEach(clearTimeout)
    timers.current.clear()
  }
  const end = (status: 'completed' | 'cancelled' | 'failed', detail?: string) => {
    const row = data.current.history.find(item => item.id === trialId.current)
    if (row && !terminal(row.status)) {
      const drawn = trialOps.current
      updateTrial(row.id, { status, elapsedMs: Date.now() - row.startedAt, ink: drawn.reduce((sum, op) => sum + op.ink, 0), bytes: new TextEncoder().encode(JSON.stringify(drawn)).byteLength, ops: drawn.length ? staticOps(data.current.ops) : [], ...(detail ? { error: detail } : {}) })
    }
    change({ status: 'idle', taskState: status, error: status === 'failed' ? detail ?? '试画失败' : null })
  }
  const onTaskStatus = (event: LiveTaskStatus) => {
    const row = data.current.history.find(item => item.id === trialId.current)
    if (!row || terminal(row.status)) return
    if (event.stage === 'queued') {
      updateTrial(row.id, { id: event.taskId })
      trialId.current = event.taskId
    } else if (event.taskId !== row.id) return
    if (event.stage === 'failed' || event.stage === 'cancelled') {
      clearTimers()
      change({ ghost: null, ops: staticOps(data.current.ops) })
      end(event.stage, event.detail)
    } else if (event.stage === 'completed') end('completed')
    else {
      updateTrial(trialId.current, { status: event.stage, elapsedMs: event.at - row.startedAt })
      change({ taskState: event.stage, error: event.detail ?? null })
    }
  }
  const commit = (batch: Batch): string[] => {
    if (!ready.current || !latest.current.active) return []
    const used = data.current.ops.filter(op => op.author === 'agent').reduce((sum, op) => sum + op.ink, 0)
    if (used + batch.ink > data.current.debugRules.inkLimit || batch.ops.some(op => {
      const b = opBounds(op)
      const outside = b.x < 0 || b.y < 0 || b.x + b.w > FRAME.w || b.y + b.h > FRAME.h
      return ![b.x, b.y, b.w, b.h, op.tf.s].every(Number.isFinite) || (outside && data.current.debugRules.targetFit !== 'clip')
    })) {
      log('canvas_commit', '试画墨量不足或笔迹超出试画纸', 'warn')
      end('failed', '试画墨量不足或笔迹超出试画纸')
      return []
    }
    const currentTask = trialId.current
    trialOps.current = [...trialOps.current, ...batch.ops]
    change({ ops: [...data.current.ops, ...batch.ops], ghost: null, status: 'drawing', taskState: 'drawing' })
    updateTrial(currentTask, { status: 'drawing' })
    handle.current?.notifyOps(batch.ops)
    later(batch.duration + 30, () => {
      if (trialId.current !== currentTask) return
      change({ ops: staticOps(data.current.ops) })
      end('completed')
      handle.current?.completeTask(currentTask ?? undefined)
    })
    return batch.ops.map(op => op.id)
  }
  const commitGhost = () => {
    const ghost = data.current.ghost
    if (!ghost) return []
    return commit(animateOps(ghost.ops, data.current.debugRules.penSpeed))
  }
  const bind = session?.bind
  useEffect(() => {
    if (!active || !bind) return
    ready.current = true
    const rules = new Proxy({ ...DEFAULT_RULES }, {
      get: (target, property: keyof RoomRules) => property in data.current.debugRules ? data.current.debugRules[property as keyof PetDebugRules] : target[property],
    }) as RoomRules
    const ctx: LiveCtx = {
      mode: 'tea', role: 'drawer', context: 'sandbox', rules, frame: FRAME, meId: 1,
      state: () => {
        const pet = latest.current.session?.peer
        const seats: Seat[] = [{ id: 1, name: '我的试画纸', color: '#B74331', online: true, ready: true, score: 0, isMe: true, agent: { name: pet?.name ?? 'Agent', model: pet?.model ?? 'unknown', status: data.current.status, latency: 0 } }]
        const human = data.current.ops.filter(op => op.author === 'human').reduce((sum, op) => sum + op.ink, 0)
        const agent = data.current.ops.filter(op => op.author === 'agent').reduce((sum, op) => sum + op.ink, 0)
        return { seats, ops: data.current.ops, ghost: data.current.ghost, marks: data.current.marks, cam: { x: 0, y: 0, z: 1 }, word: null, guessed: false, roundOver: false, submitted: false, timeLeft: null, ink: { human, agent, allowance: data.current.debugRules.inkLimit }, round: 1, roundTarget: GUESSER_TARGET }
      },
      later, log,
      say: message => log('chat_send', message.text, 'ok'),
      think: () => {},
      patchAgent: (_seat, status) => change({ status }),
      score: () => {}, markGuessed: () => {},
      setGhost: ghost => change({ ghost }),
      markUsed: ids => change({ marks: data.current.marks.map(mark => ids.includes(mark.id) ? { ...mark, used: true } : mark) }),
      clearMarks: () => change({ marks: [] }),
      showToast: message => { log('notice', message, 'warn'); change({ error: message }) },
      commitOps: commit, acceptGhost: commitGhost, getPen: () => undefined, drawerSeat: () => 1,
      relayTitle: '', online: () => !!latest.current.session?.connected, net: () => false, room: () => 'pet-sandbox',
      preservePosition: () => (data.current.history.find(item => item.id === trialId.current)?.preferences ?? readAgentPreferences()).composition !== 'center',
      onTaskStatus,
    }
    handle.current = bind(uid('pet'), ctx)
    return () => {
      handle.current?.cancelTask('已离开试画纸')
      handle.current?.dispose()
      handle.current = null
      clearTimers()
      ready.current = false
      change({ ghost: null, ops: staticOps(data.current.ops), status: 'idle' })
    }
  }, [active, bind])
  useEffect(() => {
    if (!active || session?.connected) return
    const row = data.current.history.find(item => item.id === trialId.current)
    if (row && !terminal(row.status)) {
      handle.current?.cancelTask('Agent 连接已断开')
      end('failed', 'Agent 连接已断开，请重连后重试')
    }
  }, [active, session?.connected])
  const cancel = () => {
    handle.current?.cancelTask('用户取消试画')
    clearTimers()
    change({ ghost: null, ops: staticOps(data.current.ops) })
    end('cancelled', '用户取消试画')
  }
  const send = (text: string) => {
    const t = text.trim().slice(0, 3000)
    if (!t) return
    if (!latest.current.session?.connected || !ready.current || !handle.current) {
      change({ error: '请先连接并唤醒真实 Agent，再发送试画任务' })
      return
    }
    if (data.current.ghost || ['queued', 'claimed', 'drawing'].includes(data.current.taskState)) {
      change({ error: '请先完成、揉掉或取消当前试画' })
      return
    }
    const preferences = readAgentPreferences()
    const prompt = buildAgentPrompt(t, preferences)
    const row: PetTrial = { id: uid('trial'), text: t, prompt, styleName: agentStyleName(preferences), preferences, rules: { ...data.current.debugRules }, guide: data.current.guide, status: 'queued', startedAt: Date.now(), elapsedMs: 0, ink: 0, bytes: 0, baselineOps: staticOps(data.current.ops), ops: [] }
    trialId.current = row.id
    trialOps.current = []
    change({ history: [row, ...data.current.history].slice(0, 20), error: null, taskState: 'queued', status: 'thinking' })
    const id = handle.current.pushTask(prompt)
    if (trialId.current === row.id) { updateTrial(row.id, { id }); trialId.current = id }
  }
  const seedHuman = () => {
    if (['queued', 'claimed', 'preview', 'drawing'].includes(data.current.taskState)) return
    const seed = buildBatch([{ tag: 'path', attrs: { d: 'M250 225 Q255 295 320 300 Q385 295 390 225 M252 225 Q320 240 388 225', fill: 'none', stroke: '#8D6548', strokeWidth: 4 } }], { seat: 1, author: 'human', tf: { x: 0, y: 0, s: 1 }, label: '协作起笔：半只茶杯' }).ops
    change({ ops: [...data.current.ops, ...seed], error: null })
    handle.current?.notifyOps(seed)
  }
  const setGuide = (guide: PetGuide) => {
    if (['queued', 'claimed', 'preview', 'drawing'].includes(data.current.taskState)) return
    let target: DrawTarget | null = null
    if (guide === 'center') target = { kind: 'pin', at: { x: 320, y: 180 }, radius: 125 }
    if (guide === 'corner') target = { kind: 'box', rect: { x: 28, y: 28, w: 210, h: 160 } }
    if (guide === 'narrow') target = { kind: 'box', rect: { x: 265, y: 30, w: 110, h: 300 } }
    if (guide === 'path') target = { kind: 'path', points: [{ x: 110, y: 180 }, { x: 530, y: 180 }], width: 130 }
    if (guide === 'anchor') {
      if (!data.current.ops.some(op => op.author === 'human')) seedHuman()
      const op = [...data.current.ops].reverse().find(item => item.author === 'human')!
      target = { kind: 'anchor', opId: op.id, bbox: opBounds(op), relation: 'above' }
    }
    change({ guide, marks: target ? [{ id: uid('mark'), seat: 1, color: '#B74331', target, createdAt: Date.now() }] : [] })
  }
  return {
    ...state, frame: FRAME, send, cancel,
    accept: () => { const id = data.current.ghost?.previewId; if (!id) return; const ids = commitGhost(); if (ids.length) handle.current?.previewResult('accepted', id) },
    reject: () => { const id = data.current.ghost?.previewId; if (!id) return; change({ ghost: null }); handle.current?.previewResult('rejected', id); end('cancelled', '草稿已揉掉') },
    clear: () => { cancel(); const ids = data.current.ops.map(op => op.id); change({ ops: [], marks: [], ghost: null, guide: 'none', error: null, taskState: 'idle' }); handle.current?.notifyOpsRemoved(ids) },
    restoreBaseline: ops => { cancel(); const ids = data.current.ops.map(op => op.id); change({ ops: staticOps(ops), marks: [], ghost: null, guide: 'none', error: null, taskState: 'idle' }); handle.current?.notifyOpsRemoved(ids); handle.current?.notifyOps(ops) },
    seedHuman, setGuide,
    setDebugRules: patch => {
      if (['queued', 'claimed', 'preview', 'drawing'].includes(data.current.taskState)) return
      const next = { ...data.current.debugRules, ...patch }
      next.inkLimit = Number.isFinite(next.inkLimit) ? Math.max(100, Math.min(30000, next.inkLimit)) : DEFAULT_DEBUG.inkLimit
      next.penSpeed = Number.isFinite(next.penSpeed) ? Math.max(100, Math.min(2400, next.penSpeed)) : DEFAULT_DEBUG.penSpeed
      next.agentLevel = next.agentLevel === 'collab' ? 'collab' : 'assist'
      next.svgPreset = ['strict', 'standard', 'loose'].includes(next.svgPreset) ? next.svgPreset : 'standard'
      next.targetFit = ['contain', 'clip', 'strict'].includes(next.targetFit) ? next.targetFit : 'contain'
      change({ debugRules: next })
    },
  }
}
