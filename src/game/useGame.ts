import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem, AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, ToolId, Transform } from '../core/types'
import { clamp, STAGE, type Pt, type Rect } from '../core/geometry'
import { PALETTE, SEAT_COLORS } from '../core/theme'
import { ALLOWED_TAGS, measureLength } from '../core/svgPolicy'
import { DRAWINGS, drawingReport, matchDrawing, type DrawingKey } from '../mock/drawings'
import {
  GUESS_DRAWER_SEAT, GUESSER_TARGET, RELAY_FRAME, RELAY_STEP, ROOM_CODE, TEA_THEME,
  judgeGuess, pickOptions, pickTarget, whisperFor,
} from '../mock/room'
import { guessPool, pickRelayTitle } from '../mock/prompts'
import {
  MAX_MARKS, type Camera, type GameState, type Ghost, type GuideMode, type Pen, type SessionResult,
  type Think, type Toast, type UseGameOptions, type WordOption, type RelayChain, type RelayTurn,
} from './gameTypes'
import { animateOps, buildBatch, elStart, makePen, mergeBatches, nowTime, uid, type Batch } from './engine'
import {
  anchorRect, buildOccupancy, clampRect, elBounds, findSpace, fitContent, nudgeFree, occOverlap, opsBounds, pathSlots,
  targetCenter, targetRect, unionRects, type DrawTarget, type TargetMark,
} from './targeting'
import { agentPenKey, simRoundStart, startSimulation, type SimCtx } from './simulation'
import { attachLiveAgent, type LiveCtx, type LiveHandle } from './liveAgent'
import type { LivePeer } from './mcpClient'
import { connectNet, type NetLink, type RoomMsg } from './netSync'

const SIDEBAR = 324
const ORIGIN: Transform = { x: 0, y: 0, s: 1 }

/** 画布可视区中心（舞台坐标） */
const viewCenter = (): Pt => ({ x: (STAGE.w - SIDEBAR) / 2 + 20, y: STAGE.h / 2 })
const toWorld = (c: Camera, p: Pt): Pt => ({ x: c.x + p.x / c.z, y: c.y + p.y / c.z })

function initCam(frame?: Rect): Camera {
  const vc = viewCenter()
  if (!frame) {
    // 让开局的场景（约 1400×680 的世界范围）完整落在可视区内
    const z = Math.min(1, Math.max(0.55, Math.min((STAGE.w - SIDEBAR - 120) / 1400, (STAGE.h - 180) / 680)))
    return { x: -10 - vc.x / z, y: -70 - vc.y / z, z }
  }
  const aw = Math.max(200, STAGE.w - SIDEBAR - 220)
  const ah = Math.max(200, STAGE.h - 240)
  const z = Math.min(aw / frame.w, ah / frame.h, 1.15)
  return { x: frame.x + frame.w / 2 - vc.x / z, y: frame.y + frame.h / 2 - vc.y / z, z }
}

function initialChat(mode: ModeId, role: GuessRole, rules: RoomRules, seats: Seat[], relayTitle: string): ChatMsg[] {
  const sys = (text: string): ChatMsg => ({ id: uid('m'), seat: null, author: 'system', text })
  const name = (id: number) => seats.find((s) => s.id === id)?.name ?? `玩家${id}`
  if (mode === 'tea') {
    return [
      sys(`欢迎来到茶绘房 ${ROOM_CODE}，今天的主题是「${rules.theme || TEA_THEME}」`),
      sys('不限时，人和 Agent 一起画。Ctrl+K 唤起你的 Agent，Agent 落笔受墨量配额限制'),
      ...(seats.some((s) => s.id === 3) ? [{ id: uid('m'), seat: 3, author: 'human' as const, text: '我让 Gemini 先铺了远山' }] : []),
    ]
  }
  if (mode === 'relay') {
    return [
      sys(`图文传话 · 第 ${RELAY_STEP.current}/${RELAY_STEP.total} 步：根据上一位的文字作画`),
      sys(`题目：「${relayTitle}」`),
      sys(`只有画框内的内容会传给下一位，限时 ${rules.roundTime} 秒，时间到会自动提交`),
    ]
  }
  if (role === 'drawer') {
    return [
      sys(`你画我猜 · 第 1/${rules.rounds} 轮`),
      sys('轮到你作画！先从三个词里选一个'),
      sys('Agent 提交的 SVG 会被剥离文字与语义属性，没法借路径“递答案”'),
    ]
  }
  return [
    sys(`你画我猜 · 第 1/${rules.rounds} 轮：${name(GUESS_DRAWER_SEAT)} 正在作画`),
    sys(`答案共 ${GUESSER_TARGET.word.length} 个字，在聊天框输入你的猜测`),
    ...(rules.guesserAgent === 'whisper' ? [sys('可以让你的 Agent 悄悄提示，但猜中得分减半')] : []),
  ]
}

const hasKeyword = (text: string) => Object.values(DRAWINGS).some((d) => d.keywords.some((w) => text.includes(w)))

export function useGame(opts: UseGameOptions): GameState {
  const init = useRef(opts).current
  const { mode, rules } = init
  const roleProp = init.guessRole
  const frame = mode === 'relay' ? RELAY_FRAME : undefined
  const meId = (init.seats.find((s) => s.isMe) ?? init.seats[0]).id

  // ---------- 图文传话链：每座位同时派多个题目，减少真空期 ----------
  const RELAY_STEP_COUNT = 3
  const CHAINS_PER_SEAT = 3
  function buildRelayChains(seats: Seat[], player: number, roomRules: RoomRules): { chains: RelayChain[]; queue: RelayTurn[] } {
    const active = seats.filter((s) => s.online).map((s) => s.id)
    const chains: RelayChain[] = []
    for (const starter of active) {
      for (let c = 0; c < CHAINS_PER_SEAT; c++) {
        const prompt = pickRelayTitle(roomRules)
        const starterIdx = active.indexOf(starter)
        const steps = Array.from({ length: RELAY_STEP_COUNT }, (_, step) => {
          const seat = active[(starterIdx + step) % active.length]
          return { step, seat, prompt, ops: [] as Op[], done: false }
        })
        chains.push({ id: uid('chain'), starter, steps })
      }
    }
    const queue: RelayTurn[] = chains
      .filter((chain) => chain.steps[0].seat === player)
      .map((chain) => ({ chainId: chain.id, stepIdx: 0, prompt: chain.steps[0].prompt }))
    return { chains, queue }
  }
  const relayInit = useRef(buildRelayChains(init.seats, meId, rules)).current

  // ---------- 联机（netSync；茶绘+你画我猜已接，传话等 P4） ----------
  const netParams = init.net
  const netRef = useRef<NetLink | null>(null)
  /** peer 被 host 分配的座位（host/单机为 null → 用 meId） */
  const [netSeat, setNetSeat] = useState<number | null>(null)
  const netSeatRef = useRef<number | null>(null)
  const [netView, setNetView] = useState<GameState['net']>(undefined)
  /** host 侧：peerId → 座位 id / 名字 */
  const peerSeats = useRef(new Map<string, number>())
  const peerNames = useRef(new Map<string, string>())
  /** host 广播来的结算载荷（peer 端据此跳结算屏） */
  const [netResult, setNetResult] = useState<SessionResult | null>(null)
  /** 本轮计时终点（host 发 endsAt 时间戳；peer 据此本地倒计时） */
  const endsAtRef = useRef(0)
  /** peer 猜词者的题目长度（词本体不下发，host 判词） */
  const [netHintLen, setNetHintLen] = useState(0)

  /** 本轮画手座位（state + ref 镜像；net 模式下随 round-start 轮换 → 决定本地画还是猜） */
  const [drawerSeatS, setDrawerSeatS] = useState<number>(
    netParams ? meId : mode === 'guess' && roleProp === 'guesser' ? GUESS_DRAWER_SEAT : meId,
  )
  const drawerSeat = useRef(drawerSeatS)
  const setDrawerNow = (id: number) => {
    drawerSeat.current = id
    setDrawerSeatS(id)
  }
  /** 联机时我的真实座位；单机恒为 meId */
  const mySeat = netSeat ?? meId
  const role: GuessRole = mode === 'guess' && netParams ? (mySeat === drawerSeatS ? 'drawer' : 'guesser') : roleProp
  const readOnly = mode === 'guess' && (netParams ? mySeat !== drawerSeatS : roleProp === 'guesser')

  // ?resume=1 恢复上一次未完成的画布与比分（刷新/崩溃救场用）
  const resumeData = useMemo(() => {
    if (new URLSearchParams(location.search).get('resume') !== '1') return null
    try {
      const d = JSON.parse(localStorage.getItem(`teadraw:save:${mode}:${role}`) ?? 'null')
      return d && typeof d === 'object' ? (d as { ops?: Op[]; scores?: [number, number][]; round?: number }) : null
    } catch {
      return null
    }
  }, [])

  const [seats, setSeats] = useState<Seat[]>(() => {
    const base = init.seats.map((s) => ({ ...s, agent: s.agent ? { ...s.agent, status: 'idle' as const } : null }))
    if (!resumeData?.scores) return base
    const sc = new Map(resumeData.scores)
    return base.map((s) => ({ ...s, score: sc.get(s.id) ?? s.score }))
  })
  const [ops, setOps] = useState<Op[]>(() => resumeData?.ops ?? [])
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [marks, setMarks] = useState<TargetMark[]>([])
  const [foreignMarks, setForeignMarks] = useState<TargetMark[]>([])
  const [guideMode, setGuideMode] = useState<GuideMode>('auto')
  const [gridOn, setGridOn] = useState(false)
  const [lastStamp, setLastStamp] = useState<{ at: Pt; nonce: number } | null>(null)
  const [thinking, setThinking] = useState<Think[]>([])
  const pens = useRef(new Map<string, Pen>())
  const [penKeys, setPenKeys] = useState<string[]>([])
  const [cam, setCam] = useState<Camera>(() => initCam(frame))
  const [tool, setTool] = useState<ToolId>(readOnly ? 'hand' : 'pen')
  const [color, setColor] = useState(PALETTE[0])
  const [width, setWidth] = useState(4)
  const firstRelayTitle = relayInit.queue[0]?.prompt ?? ''
  const [chat, setChat] = useState<ChatMsg[]>(() => initialChat(mode, role, rules, init.seats, firstRelayTitle))
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [highlightAgent, setHighlightAgent] = useState(false)
  const [hiddenSeats, setHiddenSeats] = useState<Set<number>>(() => new Set())
  const [spaceDown, setSpaceDown] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(mode === 'tea' ? null : rules.roundTime)
  const [word, setWord] = useState<WordOption | null>(null)
  const [guessed, setGuessed] = useState(false)
  const [guessedSeats, setGuessedSeats] = useState<number[]>([])
  const [whisper, setWhisper] = useState<string | null>(null)
  const [roundOver, setRoundOver] = useState(false)
  const [live, setLive] = useState<LivePeer>({ state: 'connecting' })

  // ---------- 传话链状态（多题同派） ----------
  const [relayChains, setRelayChains] = useState<RelayChain[]>(() => relayInit.chains)
  const [relayQueue, setRelayQueue] = useState<RelayTurn[]>(() => relayInit.queue)
  const [relayTurn, setRelayTurn] = useState<RelayTurn | null>(() => relayInit.queue[0] ?? null)
  const [submitted, setSubmitted] = useState(false)
  const relayTitle = relayTurn?.prompt ?? relayQueue[0]?.prompt ?? ''
  const relayDone = useMemo(() => relayChains.reduce((n, c) => n + c.steps.filter((s) => s.done).length, 0), [relayChains])
  const relayTotal = relayChains.length * RELAY_STEP_COUNT

  // ---------- 局进度 ----------
  const [round, setRound] = useState(resumeData?.round ?? 1)
  const roundsTotal = mode === 'guess' ? rules.rounds : 1
  const isLastRound = round >= roundsTotal
  /** 猜词视角的本轮题目（drawer 视角的题目在 word 里） */
  const [roundTarget, setRoundTarget] = useState<WordOption>(GUESSER_TARGET)
  const [wordOptions, setWordOptions] = useState<WordOption[]>(() => pickOptions(guessPool(rules), 3))
  const usedWords = useRef(new Set<string>([GUESSER_TARGET.word]))
  /** 每座位累计猜中数（跨轮累计，结算用） */
  const guessCount = useRef(new Map<number, number>())
  /** 本轮画手座位（声明已上移到联机块——net 模式下需早于 readOnly 推导） */
  const startedAt = useRef(Date.now())
  const simCtxRef = useRef<SimCtx | null>(null)

  const me = seats.find((s) => s.id === (netSeat ?? meId)) ?? seats[0]
  const answer = readOnly ? roundTarget.word : word?.word ?? ''

  const ink = useMemo(() => {
    let human = 0
    let agent = 0
    for (const o of ops) {
      if (o.seat !== meId) continue
      if (o.author === 'agent') agent += o.ink
      else human += o.ink
    }
    const r = rules.inkRatio
    const allowance = r >= 0.99 ? 99999 : Math.max(4000, Math.round((human * r) / (1 - r)))
    return { human, agent, allowance }
  }, [ops, meId, rules.inkRatio])

  // 最新状态快照，供稳定回调读取
  const S = useRef({ seats, ops, ghost, marks, foreignMarks, cam, word, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget, relayTurn, relayQueue, relayChains })
  S.current = { seats, ops, ghost, marks, foreignMarks, cam, word, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget, relayTurn, relayQueue, relayChains }

  // ---------- 计时器 ----------
  const timers = useRef(new Set<number>())
  const intervals = useRef(new Set<number>())
  const later = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
  }, [])
  const every = useCallback((ms: number, fn: () => void) => {
    intervals.current.add(window.setInterval(fn, ms))
  }, [])

  // ---------- 基础回调 ----------
  const toastTimer = useRef(0)
  const lastToast = useRef({ text: '', at: 0 })
  const showToast = useCallback((text: string) => {
    const id = Date.now()
    lastToast.current = { text, at: id }
    setToast({ id, text })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2400)
  }, [])

  const log = useCallback((tool: string, detail: string, tone?: ActivityItem['tone']) => {
    setActivity((a) => [...a.slice(-79), { id: uid('act'), time: nowTime(), tool, detail, tone }])
  }, [])

  const say = useCallback((msg: Omit<ChatMsg, 'id'>) => setChat((c) => [...c.slice(-199), { id: uid('m'), ...msg }]), [])

  /** host 广播一条 sys/聊天消息（本地 say + 远端 chat 包），net 关闭时只 say */
  const sayAll = useCallback(
    (msg: Omit<ChatMsg, 'id'>) => {
      say(msg)
      const net = netRef.current
      if (net?.role === 'host') net.broadcast({ t: 'chat', msg: { id: uid('m'), ...msg } })
    },
    [say],
  )

  /** host：当前比分表广播（peer 端据此刷 seats 比分；extra=未落账的增量） */
  const pushScores = useCallback((extra?: [number, number][]) => {
    const net = netRef.current
    if (net?.role !== 'host') return
    const cur = new Map(S.current.seats.map((s) => [s.id, s.score] as [number, number]))
    for (const [id, d] of extra ?? []) cur.set(id, (cur.get(id) ?? 0) + d)
    net.broadcast({ t: 'scores', map: [...cur] })
  }, [])

  const patchAgent = useCallback((seatId: number, status: AgentStatus) => {
    setSeats((ss) => ss.map((s) => (s.id === seatId && s.agent ? { ...s, agent: { ...s.agent, status } } : s)))
  }, [])

  const score = useCallback((seatId: number, delta: number) => {
    setSeats((ss) => ss.map((s) => (s.id === seatId ? { ...s, score: s.score + delta } : s)))
  }, [])

  const think = useCallback((key: string, at: Pt | null, color = '#9AA6A0') => {
    setThinking((t) => {
      const rest = t.filter((x) => x.key !== key)
      return at ? [...rest, { key, at, color }] : rest
    })
  }, [])

  const addPen = useCallback((pen: Pen) => {
    pens.current.set(pen.key, pen)
    setPenKeys((k) => (k.includes(pen.key) ? k : [...k, pen.key]))
  }, [])
  const getPen = useCallback((key: string) => pens.current.get(key), [])

  const addOps = useCallback((list: Op[]) => {
    setOps((p) => [...p, ...list])
    liveRef.current?.notifyOps(list)
  }, [])

  const runBatch = useCallback((penKey: string, batch: Batch, tf: Transform) => {
    setOps((p) => [...p, ...batch.ops])
    liveRef.current?.notifyOps(batch.ops)
    const pen = pens.current.get(penKey)
    if (!pen) return
    const b = { timeline: batch.timeline, start: performance.now(), end: batch.duration, tf }
    pen.batch = b
    // 兜底：逐笔把 target 指向下一笔起点
    batch.ops.forEach((op, i) => {
      const seg = batch.timeline[i]
      if (seg) later(seg.delay, () => { if (pen.batch === b) pen.target = elStart(op.el, op.tf) })
    })
    later(batch.duration + 120, () => { if (pen.batch === b) pen.batch = undefined })
  }, [later])

  const endRound = useCallback(() => {
    if (S.current.roundOver) return
    setRoundOver(true)
    const a = S.current.answer
    const text = a ? `本轮结束，答案是「${a}」` : '本轮结束'
    sayAll({ seat: null, author: 'system', text })
    const net = netRef.current
    if (net?.role === 'host') {
      net.broadcast({
        t: 'round-over',
        answer: a,
        isLast: S.current.round >= roundsTotal,
        scores: S.current.seats.map((s) => [s.id, s.score]),
      })
    }
  }, [sayAll, roundsTotal])

  const guessedRef = useRef(new Set<number>())
  const markGuessed = useCallback((seatId: number) => {
    if (guessedRef.current.has(seatId)) return
    guessedRef.current.add(seatId)
    guessCount.current.set(seatId, (guessCount.current.get(seatId) ?? 0) + 1)
    setGuessedSeats([...guessedRef.current])
    const drawerId = drawerSeat.current
    const need = S.current.seats.filter((s) => s.online && s.id !== drawerId).length
    if (guessedRef.current.size >= need) later(1500, endRound)
  }, [later, endRound])

  // ---------- 轮次推进 / 结算收集 ----------
  const nextRound = useCallback(() => {
    const L = S.current
    if (mode !== 'guess' || !L.roundOver || L.round >= roundsTotal) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'next-req' })
      return
    }
    const r = L.round + 1
    setRound(r)
    setOps([])
    setGhost(null)
    setMarks([])
    setForeignMarks([])
    setWord(null)
    setGuessed(false)
    setGuessedSeats([])
    guessedRef.current.clear()
    setWhisper(null)
    whisperReq.current = false
    whisperUsed.current = false
    redoStack.current = []
    busy.current = false
    setTimeLeft(rules.roundTime)
    setRoundOver(false)
    say({ seat: null, author: 'system', text: `第 ${r}/${roundsTotal} 轮开始` })
    const pool = guessPool(rules)
    const used = [...usedWords.current]
    if (net?.role === 'host') {
      // 联机轮换：画手沿 roster 座位顺序轮转（host 的 seats 即 roster）；新画手是 peer → 定向发词卡
      const ids = S.current.seats.map((s) => s.id)
      const idx = ids.indexOf(drawerSeat.current)
      const nextSeat = ids[(idx + 1) % ids.length] ?? meId
      setDrawerNow(nextSeat)
      setRoundTarget({ ...GUESSER_TARGET, word: '' })
      endsAtRef.current = 0
      net.broadcast({ t: 'round-start', round: r, drawerSeat: nextSeat, hintLen: 0, endsAt: 0 })
      const drawerPeer = [...peerSeats.current.entries()].find(([, sid]) => sid === nextSeat)?.[0]
      const opts = pickOptions(pool, 3, used)
      if (drawerPeer) {
        net.to(drawerPeer, { t: 'word-offer', options: opts })
      } else {
        setWordOptions(opts)
      }
      return
    }
    if (readOnly) {
      const t = pickTarget(pool, used)
      usedWords.current.add(t.word)
      setRoundTarget(t)
    } else {
      setWordOptions(pickOptions(pool, 3, used))
    }
    simRoundStart(simCtxRef.current, r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, readOnly, rules, roundsTotal, say, meId])

  const collectResult = useCallback((): SessionResult => {
    const L = S.current
    const inkMap = new Map<number, { human: number; agent: number }>()
    for (const o of L.ops) {
      const st = inkMap.get(o.seat) ?? { human: 0, agent: 0 }
      st[o.author === 'agent' ? 'agent' : 'human'] += o.ink
      inkMap.set(o.seat, st)
    }
    const drew = new Set(L.ops.map((o) => o.seat))
    return {
      mode,
      seats: L.seats,
      ops: L.ops,
      inkStats: [...inkMap].map(([seat, v]) => ({ seat, ...v })),
      guessStats:
        mode === 'guess' ? L.seats.map((s) => ({ seat: s.id, correct: guessCount.current.get(s.id) ?? 0, drawn: drew.has(s.id) ? 1 : 0 })) : undefined,
      rounds: L.round,
      theme: mode === 'tea' ? rules.theme || TEA_THEME : mode === 'relay' ? (L.relayTurn?.prompt ?? '') : undefined,
      relayChains: mode === 'relay' ? L.relayChains : undefined,
      startedAt: startedAt.current,
      durationMs: Date.now() - startedAt.current,
    }
  }, [mode, rules])

  /** 结束整局：host 结算+广播 session-over 返回载荷；peer 发 end-req 等广播（返回 null 由 netResult 兜） */
  const requestFinish = useCallback((): SessionResult | null => {
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'end-req' })
      return null
    }
    const r = collectResult()
    net?.broadcast({ t: 'session-over', result: r })
    return r
  }, [collectResult])

  // ---------- 绘制 / 擦除 / 撤销 ----------
  const redoStack = useRef<Op[]>([])

  const draw = useCallback((el: SvgEl) => {
    if (readOnly || S.current.roundOver || (mode === 'relay' && (!relayTurn || S.current.submitted))) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'op', el })
      return
    }
    const op: Op = { id: uid('op'), seat: meId, author: 'human', el, tf: ORIGIN, ink: Math.round(measureLength(el)) }
    redoStack.current = []
    setOps((p) => [...p, op])
    liveRef.current?.notifyOps([op])
    net?.broadcast({ t: 'ops', ops: [op] })
  }, [readOnly, mode, meId, relayTurn])

  const erase = useCallback((opId: string) => {
    if (readOnly) return
    const op = S.current.ops.find((o) => o.id === opId)
    if (!op) return
    const mine = netSeatRef.current ?? meId
    if (op.seat !== mine) {
      const text = '只能擦除自己（和自己 Agent）的笔迹'
      if (lastToast.current.text !== text || Date.now() - lastToast.current.at > 1500) showToast(text)
      return
    }
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'op-erase', id: opId })
      return
    }
    setOps((p) => p.filter((o) => o.id !== opId))
    liveRef.current?.notifyOpsRemoved([opId])
    net?.broadcast({ t: 'op-del', ids: [opId] })
  }, [readOnly, meId, showToast])

  const undo = useCallback(() => {
    const mine = netSeatRef.current ?? meId
    const list = S.current.ops
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].seat !== mine) continue
      const op = list[i]
      redoStack.current.push(op)
      const net = netRef.current
      if (net?.role === 'peer') {
        net.intent({ t: 'op-erase', id: op.id })
        return
      }
      setOps((p) => p.filter((o) => o.id !== op.id))
      liveRef.current?.notifyOpsRemoved([op.id])
      net?.broadcast({ t: 'op-del', ids: [op.id] })
      return
    }
  }, [meId])

  const redo = useCallback(() => {
    const op = redoStack.current.pop()
    if (!op) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'op', el: op.el, tf: op.tf })
      return
    }
    const { anim: _a, ...rest } = op
    setOps((p) => [...p, rest])
    net?.broadcast({ t: 'ops', ops: [rest] })
  }, [])

  // ---------- 我的 Agent ----------
  const busy = useRef(false)
  const myAgentKey = agentPenKey(meId)
  const liveRef = useRef<LiveHandle | null>(null)

  const commitOps = useCallback((batch: Batch) => {
    const agentName = S.current.seats.find((s) => s.id === meId)?.agent?.name ?? 'Agent'
    const pen = pens.current.get(myAgentKey)
    if (pen && batch.ops.length) {
      const first = batch.ops[0]
      const p = elStart(first.el, first.tf)
      pen.pos = { ...p }
      pen.target = { ...p }
      pen.visible = true
      pen.label = `我的 ${agentName}`
    }
    busy.current = true
    redoStack.current = []
    patchAgent(meId, 'drawing')
    runBatch(myAgentKey, batch, batch.ops[0]?.tf ?? ORIGIN)
    later(batch.duration + 250, () => {
      patchAgent(meId, 'idle')
      if (pen) pen.visible = false
      busy.current = false
    })
  }, [meId, myAgentKey, patchAgent, runBatch, later])

  const askAgent = useCallback((text: string) => {
    const L = S.current
    const self = L.seats.find((s) => s.id === meId)
    if (rules.agentLevel === 'off') return showToast('本房间已关闭 Agent 落笔')
    if (!self?.agent) return showToast('你还没有接入 Agent')
    if (readOnly) return showToast(rules.guesserAgent === 'whisper' ? '猜词者的 Agent 不能落笔，可以请它悄悄提示' : '猜词者的 Agent 不能落笔')
    if (L.roundOver) return showToast('本轮已结束')
    if (mode === 'guess' && !L.word) return showToast('先选一个词')
    if (mode === 'relay' && L.submitted) return showToast('已经提交，等待其他人')
    if (mode === 'relay' && !relayTurn) return showToast('当前没有待作画的题目')
    const liveOn = L.live?.state === 'ready' || L.live?.state === 'awake'
    // 真实链路下：草稿待审时仍阻塞；Agent 思考中的旧任务允许被新指令覆盖
    if (L.ghost || (!liveOn && (busy.current || self.agent.status !== 'idle'))) return

    const t = text.trim()
    if (liveOn) {
      busy.current = true
      patchAgent(meId, 'thinking')
      const first = L.marks[0]
      const focus = first ? targetCenter(first.target) : toWorld(L.cam, viewCenter())
      think(myAgentKey, focus, self.color)
      const pen = pens.current.get(myAgentKey)
      if (pen) {
        pen.target = focus
        pen.visible = true
        pen.label = `我的 ${self.agent.name}`
      }
      liveRef.current?.pushTask(t)
      return
    }

    const key: DrawingKey = mode === 'guess' && L.word && !hasKeyword(t) ? L.word.drawing : matchDrawing(t)
    const label = DRAWINGS[key].label
    const report = drawingReport(key, rules.svgPreset)
    const els = report.elements
    const content = unionRects(els.map(elBounds))
    const occ = buildOccupancy(L.ops)
    const agentName = self.agent.name

    // 每个指引标记 → 一组落笔位（path 展开为沿线槽位）
    const placements: { els: SvgEl[]; tf: Transform }[] = []
    const usedMarks = L.marks.slice(0, MAX_MARKS)
    let rejected = 0
    for (const m of usedMarks) {
      if (m.target.kind === 'path') {
        for (const slot of pathSlots(m.target.points, 210, 4)) {
          const s2 = rules.avoidOthers !== false && occOverlap(occ, slot) ? nudgeFree(occ, slot) : slot
          const tf = fitContent(content, s2, 'contain')
          if (tf) placements.push({ els, tf })
        }
        continue
      }
      const area0 =
        m.target.kind === 'anchor'
          ? anchorRect(m.target.bbox, m.target.relation, clamp(Math.min(m.target.bbox.w, m.target.bbox.h) * 1.1, 140, 360))
          : targetRect(m.target)
      const area = rules.avoidOthers !== false && occOverlap(occ, area0) ? nudgeFree(occ, area0) : area0
      const tf = fitContent(content, area, rules.targetFit)
      if (!tf) rejected++
      else placements.push({ els, tf })
    }
    if (!placements.length && rejected) {
      showToast('标记区域太小，放不下这幅素材（越界策略：严格）')
      log('canvas_draw', '已拒绝 · 超出指引区域 · fit=strict', 'warn')
      return
    }
    if (!placements.length) {
      // 没有标记：占用网格找空位（对应 canvas_find_space）
      const near = frame ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : toWorld(L.cam, viewCenter())
      const bound = frame ?? { x: -760, y: -460, w: 1520, h: 920 }
      const spot = findSpace(occ, Math.min(Math.max(content.w, 140), 260), Math.min(Math.max(content.h, 140), 260), near, bound)
      const area = spot ?? { x: near.x - 120 + (Math.random() * 2 - 1) * 90, y: near.y - 120 + (Math.random() * 2 - 1) * 90, w: 240, h: 240 }
      const tf = fitContent(content, area, 'contain')
      if (tf) placements.push({ els, tf })
    }
    if (!placements.length) return showToast('找不到空位落笔')

    const previewOps = placements.flatMap((p) => buildBatch(p.els, { seat: meId, author: 'agent', tf: p.tf, label }).ops)
    const previewInk = previewOps.reduce((n, o) => n + o.ink, 0)
    if (L.ink.agent + previewInk > L.ink.allowance) {
      const pct = Math.round(rules.inkRatio * 100)
      showToast(`超出 Agent 墨量配额（${pct}%），先自己画几笔吧`)
      log('canvas_draw', `已拒绝 · 需要 ${previewInk}，剩余 ${Math.max(0, L.ink.allowance - L.ink.agent)}（配额 ${pct}%）`, 'warn')
      return
    }
    const notes: string[] = []
    if (report.removed.length) notes.push(`已移除 ${report.removed.join('、')}`)
    if (report.stripped) notes.push(`剥离语义属性 ×${report.stripped}`)
    if (usedMarks.length > 1) notes.push(`指引目标 ×${usedMarks.length}`)

    busy.current = true
    const step = relayTurn ? relayTurn.stepIdx + 1 : 1
    const task = mode === 'tea' ? `茶绘 · 主题「${rules.theme || TEA_THEME}」` : mode === 'relay' ? `传话第 ${step} 棒 · 「${relayTitle}」` : `你画我猜 · 画手 · 词「${L.word?.word ?? ''}」`
    log('turn_get_task', t ? `${task} · 指令「${t}」` : task)
    log('canvas_get_targets', usedMarks.length ? `${usedMarks.length} 个标记（${usedMarks.map((m) => m.target.kind).join('、')}）` : '无标记 · canvas_find_space')
    log('canvas_snapshot', usedMarks.length ? `png · ${usedMarks.length} 个目标周边` : frame ? `png · 画框 ${frame.w}×${frame.h}` : 'png · 视口')
    patchAgent(meId, 'thinking')
    // 茶宠跑到第一个目标处思考
    const f0 = placements[0].tf
    const focus = { x: f0.x + (content.x + content.w / 2) * f0.s, y: f0.y + (content.y + content.h / 2) * f0.s }
    think(myAgentKey, focus, self.color)
    const pen = pens.current.get(myAgentKey)
    if (pen) {
      pen.target = focus
      pen.visible = true
      pen.label = `我的 ${agentName}`
    }
    const assist = rules.agentLevel === 'assist'
    later(1400, () => {
      think(myAgentKey, null)
      log('canvas_draw', `${previewOps.length} 个元素 · mode=${assist ? 'preview' : 'commit'}`)
      log('svg_validate', notes.length ? notes.join(' · ') : '通过 · 无需修改', notes.length ? 'warn' : 'ok')
      if (S.current.roundOver || (mode === 'relay' && S.current.submitted)) {
        patchAgent(meId, 'idle')
        if (pen) pen.visible = false
        busy.current = false
        return
      }
      if (assist) {
        setGhost({ ops: previewOps, label, ink: previewInk, notes })
        patchAgent(meId, 'review')
        busy.current = false
      } else {
        log('canvas_commit', `${label} · 墨量 ${previewInk}`, 'ok')
        commitOps(animateOps(previewOps, rules.penSpeed))
      }
    })
  }, [meId, mode, readOnly, frame, rules, showToast, log, patchAgent, think, later, myAgentKey, commitOps, relayTurn, relayTitle])

  const acceptGhost = useCallback(() => {
    const g = S.current.ghost
    if (!g) return
    setGhost(null)
    const b = opsBounds(g.ops)
    setLastStamp({ at: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, nonce: Date.now() })
    log('preview_accept', `${g.label} · 墨量 ${g.ink}`, 'ok')
    if (g.previewId) liveRef.current?.previewResult('accepted', g.previewId)
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'ops', items: g.ops.map((o) => ({ el: o.el, tf: o.tf })) })
      return
    }
    commitOps(animateOps(g.ops, rules.penSpeed))
    net?.broadcast({ t: 'ops', ops: g.ops })
  }, [log, commitOps, rules.penSpeed])

  const rejectGhost = useCallback(() => {
    const g = S.current.ghost
    if (!g) return
    setGhost(null)
    patchAgent(meId, 'idle')
    const pen = pens.current.get(myAgentKey)
    if (pen) pen.visible = false
    busy.current = false
    if (g.previewId) liveRef.current?.previewResult('rejected', g.previewId)
    log('preview_reject', g.label, 'muted')
  }, [meId, myAgentKey, patchAgent, log])

  const ghostTf = useCallback((tfs: Transform[]) => {
    setGhost((g) => (g ? { ...g, ops: g.ops.map((o, i) => ({ ...o, tf: tfs[i] ?? o.tf })) } : g))
  }, [])

  // ---------- 落笔指引标记 ----------
  const clampPt = (p: Pt, r: Rect): Pt => ({ x: clamp(p.x, r.x, r.x + r.w), y: clamp(p.y, r.y, r.y + r.h) })
  const clampTarget = (t: DrawTarget, f: Rect): DrawTarget => {
    switch (t.kind) {
      case 'pin':
        return { ...t, at: clampPt(t.at, f) }
      case 'box':
      case 'grid':
        return { ...t, rect: clampRect(t.rect, f) }
      case 'lasso':
        return { ...t, polygon: t.polygon.map((p) => clampPt(p, f)), bbox: clampRect(t.bbox, f) }
      case 'path':
        return { ...t, points: t.points.map((p) => clampPt(p, f)) }
      case 'anchor':
        return { ...t, bbox: clampRect(t.bbox, f) }
    }
  }

  const addMark = useCallback((t: DrawTarget) => {
    if (readOnly || S.current.roundOver) return
    if (S.current.marks.length >= MAX_MARKS) return showToast(`最多同时指定 ${MAX_MARKS} 处，Esc 清空`)
    const target = frame ? clampTarget(t, frame) : t
    const color = S.current.seats.find((s) => s.id === (netSeatRef.current ?? meId))?.color ?? '#888'
    const mark: TargetMark = { id: uid('mk'), seat: netSeatRef.current ?? meId, color, target, createdAt: Date.now() }
    setMarks((m) => [...m, mark])
    const net = netRef.current
    if (net && rules.targetsPublic) {
      if (net.role === 'peer') net.intent({ t: 'mark', mark })
      else net.broadcast({ t: 'mark', mark })
    }
  }, [readOnly, frame, meId, showToast, rules.targetsPublic])

  const removeMark = useCallback((id: string) => {
    setMarks((m) => m.filter((x) => x.id !== id))
    const net = netRef.current
    if (net && rules.targetsPublic) {
      if (net.role === 'peer') net.intent({ t: 'mark-del', id })
      else net.broadcast({ t: 'mark-del', id })
    }
  }, [rules.targetsPublic])

  const clearMarks = useCallback(() => {
    const net = netRef.current
    if (net && rules.targetsPublic) {
      for (const m of S.current.marks) {
        if (net.role === 'peer') net.intent({ t: 'mark-del', id: m.id })
        else net.broadcast({ t: 'mark-del', id: m.id })
      }
    }
    setMarks([])
  }, [rules.targetsPublic])

  // ---------- 联机同步（netSync：Host 权威，peer 只发意图等回显） ----------
  /** host：roster 序列化（seats 只带同步字段；peer 侧自行标 isMe/agent） */
  const rosterList = useCallback((): Seat[] => {
    const mine = S.current.seats.find((s) => s.id === meId)
    const mineNet = mine ? [{ ...mine, isHost: true }] : []
    const peers = [...peerSeats.current.entries()].map(([pid, sid]) => ({
      id: sid,
      name: peerNames.current.get(pid) ?? '茶客',
      color: SEAT_COLORS[(sid - 1) % SEAT_COLORS.length],
      ready: true,
      online: true,
      score: S.current.seats.find((s) => s.id === sid)?.score ?? 0,
      agent: null,
    }))
    return [...mineNet, ...peers]
  }, [meId])

  const pushRoster = useCallback(() => {
    const net = netRef.current
    if (!net || net.role !== 'host') return
    const roster = rosterList()
    setSeats(roster)
    net.broadcast({ t: 'roster', seats: roster.map((s) => ({ id: s.id, name: s.name, color: s.color, score: s.score, online: s.online, isHost: !!s.isHost })) })
  }, [rosterList])

  /** peer：按广播比分表刷新 seats */
  const patchScores = useCallback((map: [number, number][]) => {
    const m = new Map(map)
    setSeats((ss) => ss.map((s) => (m.has(s.id) ? { ...s, score: m.get(s.id)! } : s)))
  }, [])

  /** peer：按 host roster 重建座位表（自己的座位标 isMe + 保留本地茶宠） */
  const applyRoster = useCallback((list: { id: number; name: string; color: string; score?: number; online?: boolean; isHost?: boolean }[]) => {
    setSeats(
      list.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        ready: true,
        online: s.online ?? true,
        score: s.score ?? 0,
        isMe: s.id === netSeatRef.current,
        isHost: s.isHost,
        agent: s.id === netSeatRef.current ? (init.seats.find((x) => x.isMe)?.agent ?? null) : null,
      })),
    )
  }, [init])

  /** host：校验远端来的 {el,tf} 并落账+广播（轻量白名单 + 墨量上限） */
  const commitRemote = useCallback((from: string, items: { el: SvgEl; tf?: Transform }[]) => {
    const seat = peerSeats.current.get(from)
    if (seat == null || !Array.isArray(items)) return
    const built: Op[] = []
    for (const it of items.slice(0, 64)) {
      const el = it?.el
      const tf = it?.tf
      if (!el || !ALLOWED_TAGS.includes(el.tag)) continue
      if (!el.attrs || typeof el.attrs !== 'object') continue
      if (Object.values(el.attrs).some((v) => typeof v !== 'string' && typeof v !== 'number')) continue
      if (tf && (![tf.x, tf.y, tf.s].every((n) => Number.isFinite(n)) || tf.s <= 0 || tf.s > 16)) continue
      const ink = Math.round(measureLength(el))
      if (ink > 200_000) continue
      built.push({ id: uid('op'), seat, author: 'human', el, tf: tf ?? ORIGIN, ink })
    }
    if (!built.length) return
    setOps((p) => [...p, ...built])
    liveRef.current?.notifyOps(built)
    netRef.current?.broadcast({ t: 'ops', ops: built })
  }, [liveRef])

  /** host：成员意图处理 */
  const hostIntent = useCallback(
    (from: string, msg: RoomMsg) => {
      const net = netRef.current
      switch (msg.t) {
        case 'hello': {
          if (!net || peerSeats.current.has(from)) return
          const used = new Set([meId, ...peerSeats.current.values()])
          let sid = 1
          while (used.has(sid)) sid++
          if (sid > 8) return
          peerSeats.current.set(from, sid)
          peerNames.current.set(from, (typeof msg.name === 'string' && msg.name.slice(0, 12)) || '茶客')
          net.to(from, { t: 'seat-assign', seat: sid, color: SEAT_COLORS[(sid - 1) % SEAT_COLORS.length] })
          pushRoster()
          net.to(from, {
            t: 'snapshot',
            seats: rosterList().map((s) => ({ id: s.id, name: s.name, color: s.color, score: s.score, online: s.online, isHost: !!s.isHost })),
            ops: S.current.ops,
            foreignMarks: rules.targetsPublic ? [...S.current.marks, ...S.current.foreignMarks] : [],
            round: S.current.round,
            drawerSeat: drawerSeat.current,
            hintLen: mode === 'guess' && !S.current.roundOver ? (S.current.answer || '').length : 0,
            roundOver: S.current.roundOver,
            answer: S.current.roundOver ? S.current.answer : '',
            endsAt: endsAtRef.current,
          })
          // 新员恰好是本轮画手且未选词 → 定向发词卡
          if (mode === 'guess' && sid === drawerSeat.current && !S.current.word && !S.current.roundOver) {
            net.to(from, { t: 'word-offer', options: pickOptions(guessPool(rules), 3, [...usedWords.current]) })
          }
          break
        }
        case 'pick-word': {
          const seat = peerSeats.current.get(from)
          if (seat == null || seat !== drawerSeat.current || S.current.roundOver || S.current.word) return
          const word = typeof msg.word === 'string' ? msg.word.trim().slice(0, 30) : ''
          if (!word) return
          const opt: WordOption = guessPool(rules).find((o) => o.word === word) ?? { word, level: '词库', close: [word.slice(0, 2)], drawing: matchDrawing(word) }
          setRoundTarget(opt)
          usedWords.current.add(word)
          endsAtRef.current = Date.now() + rules.roundTime * 1000
          const name = S.current.seats.find((s) => s.id === seat)?.name ?? '画手'
          const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `${name} 已选定题目，开画！` }
          setChat((c) => [...c.slice(-199), sys])
          net?.broadcast({ t: 'chat', msg: sys })
          net?.broadcast({ t: 'round-live', hintLen: word.length, endsAt: endsAtRef.current })
          break
        }
        case 'guess': {
          const seat = peerSeats.current.get(from)
          const L = S.current
          const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 60) : ''
          if (seat == null || !text || L.roundOver || guessedRef.current.has(seat)) return
          const human: ChatMsg = { id: uid('m'), seat, author: 'human', text }
          setChat((c) => [...c.slice(-199), human])
          net?.broadcast({ t: 'chat', msg: human })
          const r = judgeGuess(text, L.roundTarget)
          net?.broadcast({ t: 'guess-result', seat, verdict: r })
          if (r === 'correct') {
            const base = Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))
            score(seat, base)
            score(drawerSeat.current, 40)
            const name = S.current.seats.find((s) => s.id === seat)?.name ?? '对方'
            const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `${name} 猜中了！+${base}`, kind: 'correct' }
            setChat((c) => [...c.slice(-199), sys])
            net?.broadcast({ t: 'chat', msg: sys })
            pushScores([[seat, base], [drawerSeat.current, 40]])
            markGuessed(seat)
          } else if (r === 'close') {
            const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `「${text}」很接近了`, kind: 'close' }
            setChat((c) => [...c.slice(-199), sys])
            net?.broadcast({ t: 'chat', msg: sys })
          }
          break
        }
        case 'next-req':
          nextRound()
          break
        case 'end-req': {
          const r = collectResult()
          net?.broadcast({ t: 'session-over', result: r })
          setNetResult(r)
          break
        }
        case 'op':
          commitRemote(from, [msg as unknown as { el: SvgEl; tf?: Transform }])
          break
        case 'ops':
          commitRemote(from, (msg.items as { el: SvgEl; tf?: Transform }[]) ?? [])
          break
        case 'op-erase': {
          const seat = peerSeats.current.get(from)
          const op = S.current.ops.find((o) => o.id === msg.id)
          if (seat == null || !op || op.seat !== seat) return
          setOps((p) => p.filter((o) => o.id !== msg.id))
          liveRef.current?.notifyOpsRemoved([msg.id as string])
          net?.broadcast({ t: 'op-del', ids: [msg.id] })
          break
        }
        case 'chat': {
          const seat = peerSeats.current.get(from)
          const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : ''
          if (seat == null || !text) return
          const m: ChatMsg = { id: uid('m'), seat, author: 'human', text }
          setChat((c) => [...c.slice(-199), m])
          net?.broadcast({ t: 'chat', msg: m })
          break
        }
        case 'mark': {
          const seat = peerSeats.current.get(from)
          if (seat == null || !rules.targetsPublic || !msg.mark) return
          const mark = { ...(msg.mark as TargetMark), seat }
          setForeignMarks((ms) => [...ms.filter((x) => x.id !== mark.id), mark])
          net?.broadcast({ t: 'mark', mark })
          break
        }
        case 'mark-del': {
          const seat = peerSeats.current.get(from)
          if (seat == null) return
          setForeignMarks((ms) => {
            const hit = ms.find((x) => x.id === msg.id)
            if (hit && hit.seat !== seat) return ms
            return ms.filter((x) => x.id !== msg.id)
          })
          net?.broadcast({ t: 'mark-del', id: msg.id })
          break
        }
      }
    },
    [meId, rules.targetsPublic, rosterList, pushRoster, commitRemote, liveRef],
  )

  /** peer：host 广播处理 */
  const peerEvent = useCallback(
    (msg: RoomMsg) => {
      switch (msg.t) {
        case 'seat-assign':
          netSeatRef.current = msg.seat as number
          setNetSeat(msg.seat as number)
          break
        case 'roster':
          applyRoster(msg.seats as Parameters<typeof applyRoster>[0])
          break
        case 'snapshot': {
          const m = msg as {
            seats?: Parameters<typeof applyRoster>[0]
            ops?: Op[]
            foreignMarks?: TargetMark[]
            round?: number
            drawerSeat?: number
            hintLen?: number
            roundOver?: boolean
            answer?: string
            endsAt?: number
          }
          if (Array.isArray(m.seats)) applyRoster(m.seats)
          if (Array.isArray(m.ops)) setOps(m.ops)
          if (Array.isArray(m.foreignMarks)) setForeignMarks(m.foreignMarks)
          if (typeof m.round === 'number') setRound(m.round)
          if (typeof m.drawerSeat === 'number') setDrawerNow(m.drawerSeat)
          setNetHintLen(m.hintLen ?? 0)
          endsAtRef.current = m.endsAt ?? 0
          if (m.roundOver) {
            setRoundOver(true)
            if (m.answer) setRoundTarget((t) => ({ ...t, word: m.answer! }))
          }
          if (m.endsAt && !m.roundOver) setTimeLeft(Math.max(0, Math.round((m.endsAt - Date.now()) / 1000)))
          break
        }
        case 'word-offer':
          setWordOptions((msg.options as WordOption[]) ?? [])
          break
        case 'round-start': {
          const m = msg as unknown as { round: number; drawerSeat: number }
          setRound(m.round)
          setDrawerNow(m.drawerSeat)
          setOps([])
          setGhost(null)
          setMarks([])
          setForeignMarks([])
          setWord(null)
          setWordOptions([])
          setGuessed(false)
          setGuessedSeats([])
          guessedRef.current.clear()
          setWhisper(null)
          whisperReq.current = false
          whisperUsed.current = false
          redoStack.current = []
          busy.current = false
          setRoundTarget({ ...GUESSER_TARGET, word: '' })
          setNetHintLen(0)
          endsAtRef.current = 0
          setRoundOver(false)
          setTimeLeft(rules.roundTime)
          say({ seat: null, author: 'system', text: `第 ${m.round} 轮开始` })
          break
        }
        case 'round-live': {
          const m = msg as { hintLen?: number; endsAt?: number }
          setNetHintLen(m.hintLen ?? 0)
          endsAtRef.current = m.endsAt ?? 0
          if (m.endsAt) setTimeLeft(Math.max(0, Math.round((m.endsAt - Date.now()) / 1000)))
          break
        }
        case 'round-over': {
          const m = msg as { answer?: string; scores?: [number, number][] }
          if (m.answer) setRoundTarget((t) => ({ ...t, word: m.answer! }))
          if (Array.isArray(m.scores)) patchScores(m.scores)
          setRoundOver(true)
          break
        }
        case 'session-over': {
          const r = (msg as { result?: SessionResult }).result
          if (r) setNetResult(r)
          break
        }
        case 'tick':
          if (typeof msg.left === 'number') setTimeLeft(msg.left)
          break
        case 'scores':
          if (Array.isArray(msg.map)) patchScores(msg.map as [number, number][])
          break
        case 'guess-result': {
          const m = msg as { seat?: number; verdict?: string }
          if (m.seat != null && m.verdict === 'correct') {
            guessedRef.current.add(m.seat)
            setGuessedSeats([...guessedRef.current])
            if (m.seat === netSeatRef.current) setGuessed(true)
          }
          break
        }
        case 'ops': {
          const ops = msg.ops as Op[] | undefined
          if (!Array.isArray(ops)) return
          setOps((prev) => {
            const ids = new Set(prev.map((o) => o.id))
            return [...prev, ...ops.filter((o) => !ids.has(o.id))]
          })
          liveRef.current?.notifyOps(ops)
          break
        }
        case 'op-del': {
          const ids = new Set((msg.ids as string[]) ?? [])
          setOps((p) => p.filter((o) => !ids.has(o.id)))
          liveRef.current?.notifyOpsRemoved([...ids])
          break
        }
        case 'chat': {
          const m = msg.msg as ChatMsg | undefined
          if (m?.text) setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c.slice(-199), m]))
          break
        }
        case 'mark': {
          const mark = msg.mark as TargetMark | undefined
          if (!mark || mark.seat === netSeatRef.current) return
          setForeignMarks((ms) => [...ms.filter((x) => x.id !== mark.id), mark])
          break
        }
        case 'mark-del':
          setForeignMarks((ms) => ms.filter((x) => x.id !== msg.id))
          break
      }
    },
    [applyRoster, liveRef],
  )

  const onNetMembers = useCallback(
    (members: string[]) => {
      setNetView((v) => (v ? { ...v, peers: members.length } : v))
      const net = netRef.current
      if (net?.role !== 'host') return
      const gone = [...peerSeats.current.keys()].filter((p) => !members.includes(p))
      if (!gone.length) return
      const goneSeats = new Set(gone.map((p) => peerSeats.current.get(p)!))
      for (const p of gone) {
        peerSeats.current.delete(p)
        peerNames.current.delete(p)
      }
      setForeignMarks((ms) => ms.filter((m) => !goneSeats.has(m.seat)))
      pushRoster()
    },
    [pushRoster],
  )

  // 分派走 ref：connect effect 只在 mount 跑一次，但要永远调用最新版 handler（避免陈旧闭包）
  const dispatchRef = useRef<{ packet: (f: string, m: RoomMsg) => void; members: (m: string[]) => void }>({
    packet: () => {},
    members: () => {},
  })
  dispatchRef.current = {
    packet: (from, msg) => {
      const net = netRef.current
      if (!net) return
      if (net.role === 'host') hostIntent(from, msg)
      else peerEvent(msg)
    },
    members: onNetMembers,
  }

  useEffect(() => {
    if (!netParams || mode === 'relay') return
    let dead = false
    connectNet(netParams, {
      onPacket: (f, m) => {
        if (!dead) dispatchRef.current.packet(f, m)
      },
      onMembers: (m) => {
        if (!dead) dispatchRef.current.members(m)
      },
      onClose: () => {
        if (dead) return
        netRef.current = null
        setNetView(undefined)
        showToast('联机已断开，回到单机')
      },
    })
      .then((l) => {
        if (dead) {
          l.close()
          return
        }
        netRef.current = l
        setNetView({ role: l.role, room: l.room, peers: l.members().length })
        if (l.role === 'host') pushRoster()
        say({ seat: null, author: 'system', text: `联机房间 #${l.room} 已${l.role === 'host' ? '创建' : '加入'}（${l.transport}）` })
      })
      .catch(() => {
        if (!dead) showToast('联机桥未响应，已回退单机')
      })
    return () => {
      dead = true
      netRef.current?.close()
      netRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 你画我猜 ----------
  const pickWord = useCallback((w: WordOption) => {
    if (mode !== 'guess' || readOnly || S.current.word) return
    const net = netRef.current
    setWord(w)
    usedWords.current.add(w.word)
    if (net?.role === 'peer') {
      net.intent({ t: 'pick-word', word: w.word })
      say({ seat: null, author: 'system', text: `你选了「${w.word}」（只有你能看到）` })
      return
    }
    setRoundTarget(w)
    say({ seat: null, author: 'system', text: `你选了「${w.word}」（只有你能看到），计时 ${rules.roundTime} 秒开始！` })
    if (net?.role === 'host') {
      const endsAt = Date.now() + rules.roundTime * 1000
      endsAtRef.current = endsAt
      net.broadcast({ t: 'round-live', hintLen: w.word.length, endsAt })
    }
  }, [mode, readOnly, rules.roundTime, say])

  const whisperUsed = useRef(false)
  const submitGuess = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    const L = S.current
    const net = netRef.current
    if (net?.role === 'peer') {
      // 已猜中/本轮已结束 → 走普通聊天通道（host 的 chat 意图处理与猜词无关）
      net.intent({ t: L.guessed || L.roundOver ? 'chat' : 'guess', text: t })
      return
    }
    if (!readOnly || L.guessed || L.roundOver) return say({ seat: meId, author: 'human', text: t })
    const r = judgeGuess(t, L.roundTarget)
    if (r === 'correct') {
      const base = Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))
      const pts = whisperUsed.current ? Math.round(base / 2) : base
      setGuessed(true)
      score(meId, pts)
      score(drawerSeat.current, 40)
      say({ seat: meId, author: 'system', text: `你猜中了！+${pts}${whisperUsed.current ? '（提示 ×0.5）' : ''}`, kind: 'correct' })
      pushScores([[meId, pts], [drawerSeat.current, 40]])
      markGuessed(meId)
    } else if (r === 'close') say({ seat: meId, author: 'system', text: `「${t}」很接近了`, kind: 'close' })
    else say({ seat: meId, author: 'human', text: t })
  }, [readOnly, meId, mySeat, rules.roundTime, say, score, markGuessed, pushScores])

  const whisperReq = useRef(false)
  const askWhisper = useCallback(() => {
    if (rules.guesserAgent !== 'whisper') return showToast('本房间未开启 Agent 悄悄提示')
    if (!readOnly) return showToast('只有猜词者可以请求提示')
    if (netRef.current) return showToast('联机模式下悄悄提示暂不可用')
    const self = S.current.seats.find((s) => s.id === meId)
    if (!self?.agent) return showToast('你还没有接入 Agent')
    if (S.current.guessed || S.current.roundOver || whisperReq.current) return
    whisperReq.current = true
    whisperUsed.current = true
    patchAgent(meId, 'thinking')
    log('canvas_snapshot', 'png · 视口（仅光栅图，无 SVG 源）', 'muted')
    later(1200, () => {
      setWhisper(whisperFor(S.current.roundTarget))
      patchAgent(meId, 'idle')
      log('hint_whisper', '悄悄提示已送达 · 猜中得分 ×0.5', 'ok')
    })
  }, [rules.guesserAgent, readOnly, meId, showToast, patchAgent, log, later])

  // ---------- 图文传话（多题同派） ----------
  const submitRelay = useCallback(() => {
    if (mode !== 'relay' || !relayTurn || S.current.submitted) return
    const turn = relayTurn
    const turnOps = S.current.ops.slice()
    const nextQueue: RelayTurn[] = []
    setRelayChains((chains) =>
      chains.map((chain) => {
        if (chain.id !== turn.chainId) return chain
        const nextSteps = chain.steps.map((s, i) => (i === turn.stepIdx ? { ...s, ops: turnOps, done: true } : s))
        const nxt = nextSteps[turn.stepIdx + 1]
        if (nxt && nxt.seat === meId) nextQueue.push({ chainId: chain.id, stepIdx: nxt.step, prompt: nxt.prompt })
        return { ...chain, steps: nextSteps }
      }),
    )
    const updated = relayQueue.filter((t) => !(t.chainId === turn.chainId && t.stepIdx === turn.stepIdx))
    const rest = [...updated, ...nextQueue]
    setRelayQueue(rest)
    const next = rest[0] ?? null
    setRelayTurn(next)
    setSubmitted(!next)
    setOps([])
    setGhost(null)
    clearMarks()
    redoStack.current = []
    if (next) {
      setTimeLeft(rules.roundTime)
      say({ seat: null, author: 'system', text: `第 ${turn.stepIdx + 1} 棒已提交；下一题「${next.prompt}」` })
    } else if (relayChains.every((c) => c.steps.every((s) => s.done))) {
      setRoundOver(true)
      say({ seat: null, author: 'system', text: '所有传画链已完成，前往相册揭晓' })
    } else {
      say({ seat: null, author: 'system', text: `第 ${turn.stepIdx + 1} 棒已提交，等新题目派发…` })
    }
  }, [mode, meId, relayTurn, relayQueue, relayChains, rules.roundTime, say, clearMarks])

  // ---------- 聊天 ----------
  const sendChat = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    if (mode === 'guess') {
      if (!readOnly && !S.current.roundOver) return showToast('画手不能在聊天里发言')
      if (readOnly) return submitGuess(t)
    }
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'chat', text: t })
      return
    }
    const msg: ChatMsg = { id: uid('m'), seat: meId, author: 'human', text: t }
    setChat((c) => [...c.slice(-199), msg])
    net?.broadcast({ t: 'chat', msg })
  }, [mode, readOnly, meId, showToast, submitGuess, say])

  // ---------- 回放 ----------
  const replay = useCallback(() => {
    const list = S.current.ops
    if (!list.length) return
    const per = Math.min(260, 5200 / list.length)
    const dur = Math.round(clamp(per * 2, 120, 600))
    redoStack.current = []
    setOps(list.map((o, i) => ({ ...o, id: uid('op'), anim: { delay: Math.round(i * per), dur } })))
  }, [])

  // ---------- 视图 ----------
  const zoomBy = useCallback((f: number) => {
    setCam((c) => {
      const z = clamp(c.z * f, 0.3, 4)
      const vc = viewCenter()
      const a = toWorld(c, vc)
      return { x: a.x - vc.x / z, y: a.y - vc.y / z, z }
    })
  }, [])
  const resetView = useCallback(() => setCam(initCam(frame)), [frame])

  const toggleSeatVisible = useCallback((seatId: number) => {
    setHiddenSeats((h) => {
      const n = new Set(h)
      if (n.has(seatId)) n.delete(seatId)
      else n.add(seatId)
      return n
    })
  }, [])

  // ---------- 挂载：模拟 + 计时 ----------
  useEffect(() => {
    const self = init.seats.find((s) => s.id === meId)
    if (self?.agent) {
      const home = frame ? { x: frame.x + 50, y: frame.y + frame.h - 20 } : { x: -560, y: 210 }
      addPen(makePen({ key: agentPenKey(meId), seat: meId, author: 'agent', label: `我的 ${self.agent.name}`, color: self.color, home }))
    }
    const ctx: SimCtx = {
      mode, role, seats: init.seats, rules, meId, later, addOps, runBatch, addPen, getPen, think, patchAgent, say, score, markGuessed,
      myInk: () => S.current.ops.reduce((n, o) => (o.seat === meId ? n + o.ink : n), 0),
      getWord: () => (readOnly ? S.current.roundTarget : S.current.word),
      getRound: () => S.current.round,
      drawerSeat: () => drawerSeat.current,
      setDrawerSeat: (id) => {
        setDrawerNow(id)
      },
      isOver: () => S.current.roundOver,
      showMark: (m) => {
        if (rules.targetsPublic) setForeignMarks((fm) => (fm.some((x) => x.id === m.id) ? fm : [...fm.slice(-5), m]))
      },
      hideMark: (id) => setForeignMarks((fm) => fm.filter((x) => x.id !== id)),
    }
    simCtxRef.current = ctx
    // 联机模式下关掉本地剧本：真实对端就是玩家，各端各跑模拟会分裂画面（bot 填充等 P4）
    if (!netParams) startSimulation(ctx)
    if (resumeData?.ops?.length) later(800, () => showToast('已恢复上次未完成的画布'))

    // 真实 Agent 桥（teadraw mcp）：连上就把"我的 Agent"交给真实 MCP 工具处理；连不上走本地模拟
    const liveCtx: LiveCtx = {
      mode, role, rules, frame, meId,
      state: () => S.current,
      later, log, say, think, patchAgent, score, markGuessed,
      setGhost,
      markUsed: (ids) => setMarks((ms) => ms.map((m) => (ids.includes(m.id) ? { ...m, used: true } : m))),
      clearMarks, showToast, commitOps, acceptGhost, getPen,
      drawerSeat: () => drawerSeat.current,
      get relayTitle() { return S.current.relayTurn?.prompt ?? '' },
    }
    liveRef.current = attachLiveAgent(liveCtx, setLive)

    if (mode !== 'tea') {
      every(1000, () => {
        const L = S.current
        if (L.timeLeft == null || L.timeLeft <= 0 || L.roundOver) return
        const net = netRef.current
        if (mode === 'guess') {
          // 选词阶段不走表：单机画手未选词 / host 等本轮词落定（自己选了 or 收到 pick-word）/ peer 等 round-live
          if (!net) {
            if (!readOnly && !L.word) return
          } else if (net.role === 'peer') {
            if (!endsAtRef.current) return
          } else if (!(drawerSeat.current === meId ? L.word : L.roundTarget.word)) return
        }
        const next = L.timeLeft - 1
        S.current.timeLeft = next
        setTimeLeft(next)
        if (net?.role === 'host' && next % 5 === 0) net.broadcast({ t: 'tick', left: next })
        if (next > 0) return
        if (net?.role === 'peer') return // 结束判定归 host，等 round-over 广播
        if (mode === 'guess') endRound()
        else if (!L.submitted) {
          submitRelay()
          showToast('时间到，已自动提交')
        }
      })
    }
    if (mode === 'relay') {
      // 后台模拟：每 2.5-4.5 秒随机完成一条链的下一棒；若下一棒是本地座位，就加进队列
      const sim = () => {
        const L = S.current
        if (L.roundOver) return
        const candidates = L.relayChains.filter((c) => c.steps.some((s) => !s.done && s.seat !== meId))
        if (!candidates.length) return
        const chain = candidates[Math.floor(Math.random() * candidates.length)]
        const idx = chain.steps.findIndex((s) => !s.done && s.seat !== meId)
        if (idx === -1) return
        const nxt = chain.steps[idx + 1]
        const enqueued: RelayTurn | null = nxt && nxt.seat === meId ? { chainId: chain.id, stepIdx: nxt.step, prompt: nxt.prompt } : null
        setRelayChains((chains) =>
          chains.map((c) => {
            if (c.id !== chain.id) return c
            const steps = c.steps.map((s, i) => (i === idx ? { ...s, ops: [] as Op[], done: true } : s))
            return { ...c, steps }
          }),
        )
        if (enqueued) {
          setRelayQueue((q) => {
            const queue = [...q, enqueued!]
            if (!L.relayTurn) {
              setRelayTurn(queue[0])
              setSubmitted(false)
              setTimeLeft(rules.roundTime)
              say({ seat: null, author: 'system', text: `新题目已派发 · 「${queue[0].prompt}」` })
            }
            return queue
          })
        }
      }
      every(2500 + Math.random() * 2000, sim)
    }

    const ts = timers.current
    const is = intervals.current
    return () => {
      ts.forEach((id) => window.clearTimeout(id))
      ts.clear()
      is.forEach((id) => window.clearInterval(id))
      is.clear()
      window.clearTimeout(toastTimer.current)
      liveRef.current?.dispose()
      liveRef.current = null
      simCtxRef.current = null
    }
  }, [])

  // 自动存档：误刷新 / 崩溃后用 ?resume=1 恢复
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(
          `teadraw:save:${mode}:${role}`,
          JSON.stringify({ ops, scores: seats.map((s) => [s.id, s.score] as [number, number]), round, savedAt: Date.now() }),
        )
      } catch {
        /* 存不下就算了 */
      }
    }, 800)
    return () => window.clearTimeout(t)
  }, [ops, seats, round, mode, role])

  // ---------- 快捷键 ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    const inInput = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'k') {
      e.preventDefault()
      setFocusNonce((n) => n + 1)
      return
    }
    // 有预览时 Tab/Esc 始终生效（刚在指令条里回车，焦点通常还在输入框）
    if (S.current.ghost && (e.key === 'Tab' || e.key === 'Escape')) {
      e.preventDefault()
      if (e.key === 'Tab') acceptGhost()
      else rejectGhost()
      return
    }
    if (inInput) return
    if (e.key === 'Escape') {
      clearMarks()
      setGridOn(false)
      return
    }
    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && k === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      if (!e.repeat) setSpaceDown(true)
      return
    }
    if (mod || e.altKey) return
    if (k === 'q') {
      if (!readOnly) setGridOn((v) => !v)
      return
    }
    if (tool === 'guide' && !readOnly) {
      const gm: Record<string, GuideMode> = { '1': 'auto', '2': 'pin', '3': 'box', '4': 'lasso', '5': 'path', '6': 'anchor' }
      if (gm[e.key]) {
        setGuideMode(gm[e.key])
        return
      }
    }
    const map: Record<string, ToolId> = { v: 'guide', b: 'pen', l: 'line', r: 'rect', o: 'ellipse', e: 'eraser', h: 'hand' }
    if (map[k]) {
      if (readOnly && k !== 'h') return
      setTool(map[k])
      return
    }
    if (k === 'a') setHighlightAgent((v) => !v)
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e)
    const up = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceDown(false) }
    const blur = () => setSpaceDown(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const hint = useMemo(() => {
    if (!readOnly) return word ? word.word.split('') : []
    if (netParams) {
      // peer 猜词者：词本体不下发，按 hintLen 画空槽；round-over 后 roundTarget.word 已填回显答案
      const chars = (roundTarget.word || '').split('')
      if (roundOver && chars.length) return chars
      return Array(netHintLen).fill('')
    }
    const chars = roundTarget.word.split('')
    if (guessed || roundOver) return chars
    const half = timeLeft != null && timeLeft <= rules.roundTime / 2
    return chars.map((ch, i) => (half && i === chars.length - 1 ? ch : ''))
  }, [readOnly, word, guessed, roundOver, timeLeft, rules.roundTime, roundTarget, netHintLen, netParams])

  return {
    mode, rules, seats, me, role, readOnly, frame, live, net: netView, netResult,
    ops, ghost, marks, foreignMarks, guideMode, setGuideMode, gridOn, setGridOn, thinking, pens, penKeys,
    cam, setCam, tool, setTool, color, setColor, width, setWidth, spaceDown,
    chat, activity, toast, ink, focusNonce,
    highlightAgent, setHighlightAgent, hiddenSeats, toggleSeatVisible,
    timeLeft, word, wordOptions: mode === 'guess' && !readOnly ? wordOptions : [], pickWord, hint, guessed, whisper, roundOver, answer,
    relayDone, submitted, guessedSeats, relayTitle, relayChains, relayQueue, relayTurn,
    round, roundsTotal, isLastRound, nextRound, collectResult, requestFinish,
    draw, erase, undo, redo, addMark, removeMark, clearMarks, askAgent, acceptGhost, rejectGhost, ghostTf, lastStamp,
    sendChat, submitGuess, askWhisper, submitRelay, replay, zoomBy, resetView,
  }
}
