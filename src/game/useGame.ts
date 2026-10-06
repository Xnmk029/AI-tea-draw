import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem, AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, ToolId, Transform } from '../core/types'
import { clamp, STAGE, type Pt, type Rect } from '../core/geometry'
import { PALETTE, SEAT_COLORS } from '../core/theme'
import { ALLOWED_TAGS, POLICY_PRESETS, measureLength, sanitizeSvg } from '../core/svgPolicy'
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
import { connectNet, type NetHooks, type NetLink, type RoomMsg } from './netSync'

const SIDEBAR = 324
const ORIGIN: Transform = { x: 0, y: 0, s: 1 }
type OpIntent = { el: SvgEl; tf?: Transform; author?: 'human' | 'agent' }
type HostSave = {
  mode: ModeId; seats: Seat[]; ops: Op[]; marks: TargetMark[]; foreignMarks: TargetMark[]; round: number; word: WordOption | null; wordOptions: WordOption[];
  roundTarget: WordOption; drawerSeat: number; endsAt: number; guessedSeats: number[]; guessed: boolean; roundOver: boolean;
  usedWords: string[]; guessCount: [number, number][]; startedAt: number; chat: ChatMsg[]; peers: [string, number][]; peerNames: [string, string][]
}
const xmlAttr = (value: string | number) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const finitePt = (p: Pt) => p && [p.x, p.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 100_000)
const finiteRect = (r: Rect) => r && finitePt(r) && [r.w, r.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 100_000)

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

function initialChat(mode: ModeId, role: GuessRole, rules: RoomRules, seats: Seat[], relayTitle: string, net?: boolean): ChatMsg[] {
  const sys = (text: string): ChatMsg => ({ id: uid('m'), seat: null, author: 'system', text })
  const name = (id: number) => seats.find((s) => s.id === id)?.name ?? `玩家${id}`
  if (net) return [sys('联机房间已建立 · 茶客随到随画'), sys('各端笔迹实时同步；你的 Agent 经 MCP 桥接入后自动开工')]
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
  const netEnabled = !!(netParams || init.netLink)
  const [hostSave] = useState<HostSave | null>(() => {
    if (init.netLink?.role !== 'host') return null
    try {
      const saved = JSON.parse(sessionStorage.getItem(`teadraw:host:${init.netLink.room}:${init.netLink.gameId}`) ?? 'null')
      return saved?.mode === mode && Array.isArray(saved.ops) && Array.isArray(saved.seats) ? saved : null
    } catch { return null }
  })
  const netRef = useRef<NetLink | null>(null)
  const netUnavailable = useRef(netEnabled && !init.netLink)
  /** peer 被 host 分配的座位（host/单机为 null → 用 meId） */
  const [netSeat, setNetSeat] = useState<number | null>(init.netLink ? meId : null)
  const netSeatRef = useRef<number | null>(init.netLink ? meId : null)
  const [netView, setNetView] = useState<GameState['net']>(undefined)
  /** host 侧：peerId → 座位 id / 名字 */
  const peerSeats = useRef(new Map<string, number>(hostSave?.peers ?? []))
  const peerNames = useRef(new Map<string, string>(hostSave?.peerNames ?? []))
  /** host 广播来的结算载荷（peer 端据此跳结算屏） */
  const [netResult, setNetResult] = useState<SessionResult | null>(null)
  /** 本轮计时终点（host 发 endsAt 时间戳；peer 据此本地倒计时） */
  const endsAtRef = useRef(hostSave?.endsAt ?? 0)
  /** peer 猜词者的题目长度（词本体不下发，host 判词） */
  const [netHintLen, setNetHintLen] = useState(0)
  const offeredWords = useRef<WordOption[]>(hostSave?.wordOptions ?? [])

  /** 本轮画手座位（state + ref 镜像；net 模式下随 round-start 轮换 → 决定本地画还是猜） */
  const [drawerSeatS, setDrawerSeatS] = useState<number>(
    hostSave?.drawerSeat ?? (netEnabled ? (init.seats.find((s) => s.isHost)?.id ?? meId) : mode === 'guess' && roleProp === 'guesser' ? GUESS_DRAWER_SEAT : meId),
  )
  const drawerSeat = useRef(drawerSeatS)
  const setDrawerNow = (id: number) => {
    drawerSeat.current = id
    setDrawerSeatS(id)
  }
  /** 联机时我的真实座位；单机恒为 meId */
  const mySeat = netSeat ?? meId
  const role: GuessRole = mode === 'guess' && netEnabled ? (mySeat === drawerSeatS ? 'drawer' : 'guesser') : roleProp
  const readOnly = mode === 'guess' && (netEnabled ? mySeat !== drawerSeatS : roleProp === 'guesser')

  // ?resume=1 恢复上一次未完成的画布与比分（刷新/崩溃救场用）
  const resumeData = useMemo(() => {
    if (netEnabled) return null
    if (new URLSearchParams(location.search).get('resume') !== '1') return null
    try {
      const d = JSON.parse(localStorage.getItem(`teadraw:save:${mode}:${role}`) ?? 'null')
      return d && typeof d === 'object' ? (d as { ops?: Op[]; scores?: [number, number][]; round?: number }) : null
    } catch {
      return null
    }
  }, [])

  const [seats, setSeats] = useState<Seat[]>(() => {
    if (hostSave) return hostSave.seats
    // 联机模式：初始只放自己（roster 广播到达后重建真实成员表，避免 mock 成员闪屏）
    const base = (netEnabled && !init.netLink ? init.seats.filter((s) => s.isMe) : init.seats).map((s) => ({
      ...s,
      name: s.isMe && netParams?.name ? netParams.name : s.name,
      agent: s.agent ? { ...s.agent, status: 'idle' as const } : null,
    }))
    if (!resumeData?.scores) return base
    const sc = new Map(resumeData.scores)
    return base.map((s) => ({ ...s, score: sc.get(s.id) ?? s.score }))
  })
  const [ops, setOps] = useState<Op[]>(() => (hostSave?.ops ?? resumeData?.ops ?? []).map(({ anim: _anim, ...o }) => o))
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [marks, setMarks] = useState<TargetMark[]>(hostSave?.marks ?? [])
  const [foreignMarks, setForeignMarks] = useState<TargetMark[]>(hostSave?.foreignMarks ?? [])
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
  const [chat, setChat] = useState<ChatMsg[]>(() => hostSave?.chat ?? initialChat(mode, role, rules, init.seats, firstRelayTitle, netEnabled))
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [highlightAgent, setHighlightAgent] = useState(false)
  const [hiddenSeats, setHiddenSeats] = useState<Set<number>>(() => new Set())
  const [spaceDown, setSpaceDown] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(mode === 'tea' ? null : hostSave?.endsAt ? Math.max(0, Math.ceil((hostSave.endsAt - Date.now()) / 1000)) : rules.roundTime)
  const [word, setWord] = useState<WordOption | null>(hostSave?.word ?? null)
  const [guessed, setGuessed] = useState(hostSave?.guessed ?? false)
  const [guessedSeats, setGuessedSeats] = useState<number[]>(hostSave?.guessedSeats ?? [])
  const [whisper, setWhisper] = useState<string | null>(null)
  const [roundOver, setRoundOver] = useState(hostSave?.roundOver ?? false)
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
  const [round, setRound] = useState(hostSave?.round ?? resumeData?.round ?? 1)
  const roundsTotal = mode === 'guess' ? rules.rounds : 1
  const isLastRound = round >= roundsTotal
  /** 猜词视角的本轮题目（drawer 视角的题目在 word 里） */
  const [roundTarget, setRoundTarget] = useState<WordOption>(hostSave?.roundTarget ?? (netEnabled ? { ...GUESSER_TARGET, word: '' } : GUESSER_TARGET))
  const [wordOptions, setWordOptions] = useState<WordOption[]>(() => hostSave?.wordOptions ?? pickOptions(guessPool(rules), 3))
  const usedWords = useRef(new Set<string>(hostSave?.usedWords ?? [GUESSER_TARGET.word]))
  /** 每座位累计猜中数（跨轮累计，结算用） */
  const guessCount = useRef(new Map<number, number>(hostSave?.guessCount ?? []))
  /** 本轮画手座位（声明已上移到联机块——net 模式下需早于 readOnly 推导） */
  const startedAt = useRef(hostSave?.startedAt ?? Date.now())
  const simCtxRef = useRef<SimCtx | null>(null)

  const me = seats.find((s) => s.id === (netSeat ?? meId)) ?? init.seats.find((s) => s.isMe) ?? seats[0]
  const answer = readOnly ? roundTarget.word : word?.word ?? ''

  const ink = useMemo(() => {
    let human = 0
    let agent = 0
    for (const o of ops) {
      if (o.seat !== mySeat) continue
      if (o.author === 'agent') agent += o.ink
      else human += o.ink
    }
    const r = rules.inkRatio
    const allowance = r >= 0.99 ? 99999 : Math.max(4000, Math.round((human * r) / (1 - r)))
    return { human, agent, allowance }
  }, [ops, mySeat, rules.inkRatio])

  // 最新状态快照，供稳定回调读取
  const S = useRef({ seats, ops, ghost, marks, foreignMarks, cam, word, wordOptions, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget, relayTurn, relayQueue, relayChains })
  S.current = { seats, ops, ghost, marks, foreignMarks, cam, word, wordOptions, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget, relayTurn, relayQueue, relayChains }

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
  const pushScores = useCallback(() => {
    const net = netRef.current
    if (net?.role !== 'host') return
    const cur = new Map(S.current.seats.map((s) => [s.id, s.score] as [number, number]))
    net.broadcast({ t: 'scores', map: [...cur] })
  }, [])

  const patchAgent = useCallback((seatId: number, status: AgentStatus) => {
    S.current.seats = S.current.seats.map((s) => (s.id === seatId && s.agent ? { ...s, agent: { ...s.agent, status } } : s))
    setSeats(S.current.seats)
  }, [])

  const score = useCallback((seatId: number, delta: number) => {
    S.current.seats = S.current.seats.map((s) => (s.id === seatId ? { ...s, score: s.score + delta } : s))
    setSeats(S.current.seats)
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
    const ids = new Set(S.current.ops.map((o) => o.id))
    const fresh = list.filter((o) => !ids.has(o.id))
    S.current.ops = [...S.current.ops, ...fresh]
    setOps(S.current.ops)
    liveRef.current?.notifyOps(fresh)
  }, [])

  const runBatch = useCallback((penKey: string, batch: Batch, tf: Transform) => {
    addOps(batch.ops)
    const pen = pens.current.get(penKey)
    if (!pen) return
    const b = { timeline: batch.timeline, start: performance.now(), end: batch.duration, tf, tfs: new Map(batch.ops.map((o) => [o.id, o.tf])) }
    pen.batch = b
    // 兜底：逐笔把 target 指向下一笔起点
    batch.ops.forEach((op, i) => {
      const seg = batch.timeline[i]
      if (seg) later(seg.delay, () => { if (pen.batch === b) pen.target = elStart(op.el, op.tf) })
    })
    later(batch.duration + 120, () => { if (pen.batch === b) pen.batch = undefined })
  }, [later, addOps])

  const canDraw = useCallback((seat: number) => {
    const L = S.current
    return !netUnavailable.current && !L.roundOver && (mode !== 'guess' ||
      (seat === drawerSeat.current && (netEnabled ? endsAtRef.current > 0 : !!L.word)))
  }, [mode, netEnabled])

  const buildAuthorizedOps = useCallback((seat: number, items: OpIntent[]): Op[] => {
    if (!canDraw(seat) || !Array.isArray(items) || !items.length || items.length > 320) return []
    const built: Op[] = []
    for (const it of items) {
      const el = it?.el
      const tf = it?.tf ?? ORIGIN
      const author = it?.author === 'agent' ? 'agent' : 'human'
      if (author === 'agent' && rules.agentLevel === 'off') return []
      if (!el || !ALLOWED_TAGS.includes(el.tag) || !el.attrs || typeof el.attrs !== 'object' || Array.isArray(el.attrs)) return []
      if (![tf.x, tf.y, tf.s].every(Number.isFinite) || Math.abs(tf.x) > 100_000 || Math.abs(tf.y) > 100_000 || tf.s <= 0 || tf.s > 16) return []
      const entries = Object.entries(el.attrs)
      if (entries.length > 40 || entries.some(([k, v]) => !/^[a-zA-Z][\w:-]*$/.test(k) || (typeof v !== 'string' && typeof v !== 'number') || String(v).length > 64_000 || (typeof v === 'number' && !Number.isFinite(v)))) return []
      const source = `<${el.tag} ${entries.filter(([k]) => k !== 'data-pp').map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${xmlAttr(v)}"`).join(' ')}/>`
      const policy = POLICY_PRESETS[rules.svgPreset]
      const report = sanitizeSvg(source, author === 'agent' ? policy : { ...policy, allowFill: true, maxPathCommands: 8000 })
      const clean = report.elements[0]
      if (!report.ok || !clean) return []
      if (author === 'human' && typeof el.attrs['data-pp'] === 'string') {
        const pressure = el.attrs['data-pp'].split(',')
        if (pressure.length > 8000 || pressure.some((p) => !/^\d*\.?\d+$/.test(p) || Number(p) < 0 || Number(p) > 1)) return []
        clean.attrs['data-pp'] = pressure.map((p) => Math.round(Number(p) * 1000) / 1000).join(',')
      }
      let ink = 0
      try { ink = Math.round(measureLength(clean) * tf.s) } catch { return [] }
      const bounds = elBounds(clean)
      if (!Number.isFinite(ink) || ink > 200_000 || !finiteRect(bounds)) return []
      if (report.stripped || report.removed.length) log('svg_validate', `剥离语义属性 ×${report.stripped}${report.removed.length ? ` · 已移除 ${report.removed.join('、')}` : ''}`, 'warn')
      built.push({ id: uid('op'), seat, author, el: clean, tf: { ...tf }, ink })
    }
    const ink = S.current.ops.filter((o) => o.seat === seat).reduce((v, o) => ({ ...v, [o.author]: v[o.author] + o.ink }), { human: 0, agent: 0 })
    const need = built.filter((o) => o.author === 'agent').reduce((n, o) => n + o.ink, 0)
    const human = ink.human + built.filter((o) => o.author === 'human').reduce((n, o) => n + o.ink, 0)
    const allowance = rules.inkRatio >= 0.99 ? 99999 : Math.max(4000, Math.round(human * rules.inkRatio / (1 - rules.inkRatio)))
    if (ink.agent + need > allowance) {
      log('canvas_draw', `已拒绝 · Agent 墨量 ${need} 超出剩余 ${Math.max(0, allowance - ink.agent)}`, 'warn')
      return []
    }
    const agents = animateOps(built.filter((o) => o.author === 'agent'), rules.penSpeed).ops
    const byId = new Map(agents.map((o) => [o.id, o]))
    return built.map((o) => byId.get(o.id) ?? o)
  }, [canDraw, rules, log])

  const applyCommittedOps = useCallback((list: Op[]) => {
    const ids = new Set(S.current.ops.map((o) => o.id))
    const fresh = list.filter((o) => !ids.has(o.id))
    addOps(fresh.filter((o) => o.author === 'human'))
    for (const seat of new Set(fresh.filter((o) => o.author === 'agent').map((o) => o.seat))) {
      const agentOps = fresh.filter((o) => o.author === 'agent' && o.seat === seat)
      const key = agentPenKey(seat)
      const mine = seat === (netSeatRef.current ?? meId)
      const self = S.current.seats.find((s) => s.id === seat)
      if (!pens.current.has(key)) addPen(makePen({ key, seat, author: 'agent', label: `${mine ? '我的' : self?.name ?? '远端'} Agent`, color: self?.color ?? '#888', home: elStart(agentOps[0].el, agentOps[0].tf) }))
      const pen = pens.current.get(key)!
      pen.visible = true
      pen.pos = elStart(agentOps[0].el, agentOps[0].tf)
      pen.target = { ...pen.pos }
      const timeline = agentOps.map((o) => ({ id: o.id, delay: o.anim?.delay ?? 0, dur: o.anim?.dur ?? 280 }))
      const duration = Math.max(...timeline.map((s) => s.delay + s.dur))
      const batchRound = S.current.round
      if (mine) { busy.current = true; patchAgent(seat, 'drawing') }
      runBatch(key, { ops: agentOps, timeline, duration, ink: agentOps.reduce((n, o) => n + o.ink, 0) }, agentOps[0].tf)
      later(duration + 250, () => {
        if (S.current.round !== batchRound || pen.batch) return
        pen.visible = false
        if (mine) { busy.current = false; patchAgent(seat, 'idle') }
      })
    }
  }, [meId, addOps, addPen, patchAgent, runBatch, later])

  const endRound = useCallback(() => {
    if (S.current.roundOver) return
    S.current.roundOver = true
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

  const guessedRef = useRef(new Set<number>(hostSave?.guessedSeats ?? []))
  const markGuessed = useCallback((seatId: number) => {
    if (guessedRef.current.has(seatId)) return
    guessedRef.current.add(seatId)
    guessCount.current.set(seatId, (guessCount.current.get(seatId) ?? 0) + 1)
    setGuessedSeats([...guessedRef.current])
    const drawerId = drawerSeat.current
    const need = S.current.seats.filter((s) => s.online && s.id !== drawerId).length
    const roundAtGuess = S.current.round
    if (guessedRef.current.size >= need) later(1500, () => { if (S.current.round === roundAtGuess) endRound() })
  }, [later, endRound])

  // ---------- 轮次推进 / 结算收集 ----------
  const nextRound = useCallback(() => {
    const L = S.current
    if (mode !== 'guess' || !L.roundOver || L.round >= roundsTotal) return
    const net = netRef.current
    if (net?.role === 'peer') {
      showToast('等待房主开始下一轮')
      return
    }
    if (netUnavailable.current) return
    const r = L.round + 1
    S.current.round = r
    S.current.ops = []
    S.current.word = null
    S.current.roundOver = false
    S.current.guessed = false
    S.current.timeLeft = rules.roundTime
    S.current.ghost = null
    S.current.marks = []
    S.current.foreignMarks = []
    setRound(r)
    setOps([])
    setGhost(null)
    setMarks([])
    setForeignMarks([])
    setWord(null)
    setGuessed(false)
    setGuessedSeats([])
    guessedRef.current.clear()
    setNetHintLen(0)
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
      const ids = S.current.seats.filter((s) => s.online).map((s) => s.id)
      const idx = ids.indexOf(drawerSeat.current)
      const nextSeat = ids[(idx + 1) % ids.length] ?? meId
      setDrawerNow(nextSeat)
      S.current.roundTarget = { ...GUESSER_TARGET, word: '' }
      setRoundTarget(S.current.roundTarget)
      endsAtRef.current = 0
      net.broadcast({ t: 'round-start', round: r, drawerSeat: nextSeat, hintLen: 0, endsAt: 0 })
      const drawerPeer = [...peerSeats.current.entries()].find(([, sid]) => sid === nextSeat)?.[0]
      const opts = pickOptions(pool, 3, used)
      offeredWords.current = opts
      S.current.wordOptions = opts
      setWordOptions(opts)
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
  }, [mode, readOnly, rules, roundsTotal, say, meId, showToast])

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
    if (netUnavailable.current) return null
    if (net?.role === 'peer') {
      showToast('等待房主结束对局')
      return null
    }
    const r = collectResult()
    net?.broadcast({ t: 'session-over', result: r })
    return r
  }, [collectResult, showToast])

  // ---------- 绘制 / 擦除 / 撤销 ----------
  const redoStack = useRef<Op[]>([])

  const draw = useCallback((el: SvgEl) => {
    const mine = netSeatRef.current ?? meId
    if (readOnly || !canDraw(mine) || (mode === 'relay' && (!relayTurn || S.current.submitted))) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'op', el, author: 'human', round: S.current.round })
      return
    }
    const list = net ? buildAuthorizedOps(mine, [{ el, author: 'human' }]) : [{ id: uid('op'), seat: mine, author: 'human' as const, el, tf: ORIGIN, ink: Math.round(measureLength(el)) }]
    if (!list.length) return
    redoStack.current = []
    addOps(list)
    net?.broadcast({ t: 'ops', ops: list, round: S.current.round })
  }, [readOnly, mode, meId, relayTurn, canDraw, buildAuthorizedOps, addOps])

  const erase = useCallback((opId: string) => {
    if (readOnly || netUnavailable.current || S.current.roundOver) return
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
      net.intent({ t: 'op-erase', id: opId, round: S.current.round })
      return
    }
    S.current.ops = S.current.ops.filter((o) => o.id !== opId)
    setOps(S.current.ops)
    liveRef.current?.notifyOpsRemoved([opId])
    net?.broadcast({ t: 'op-del', ids: [opId] })
  }, [readOnly, meId, showToast])

  const undo = useCallback(() => {
    const mine = netSeatRef.current ?? meId
    if (!canDraw(mine)) return
    const list = S.current.ops
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].seat !== mine) continue
      const op = list[i]
      redoStack.current.push(op)
      const net = netRef.current
      if (net?.role === 'peer') {
        net.intent({ t: 'op-erase', id: op.id, round: S.current.round })
        return
      }
      S.current.ops = S.current.ops.filter((o) => o.id !== op.id)
      setOps(S.current.ops)
      liveRef.current?.notifyOpsRemoved([op.id])
      net?.broadcast({ t: 'op-del', ids: [op.id] })
      return
    }
  }, [meId, canDraw])

  const redo = useCallback(() => {
    const mine = netSeatRef.current ?? meId
    if (!canDraw(mine)) return
    const op = redoStack.current.pop()
    if (!op) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'op', el: op.el, tf: op.tf, author: op.author, round: S.current.round })
      return
    }
    const list = net ? buildAuthorizedOps(mine, [op]) : [{ ...op, id: uid('op'), anim: undefined }]
    applyCommittedOps(list)
    net?.broadcast({ t: 'ops', ops: list, round: S.current.round })
  }, [meId, canDraw, buildAuthorizedOps, applyCommittedOps])

  // ---------- 我的 Agent ----------
  const busy = useRef(false)
  const myAgentKey = agentPenKey(mySeat)
  const liveRef = useRef<LiveHandle | null>(null)

  const commitOps = useCallback((batch: Batch) => {
    const mine = netSeatRef.current ?? meId
    if (!canDraw(mine)) return []
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'ops', items: batch.ops.map((o) => ({ el: o.el, tf: o.tf, author: 'agent' })), round: S.current.round })
      return null
    }
    if (net) {
      const list = buildAuthorizedOps(mine, batch.ops.map((o) => ({ ...o, author: 'agent' })))
      if (!list.length) { busy.current = false; patchAgent(mine, 'idle'); showToast('Agent 落笔被房规拒绝'); return [] }
      applyCommittedOps(list)
      net.broadcast({ t: 'ops', ops: list, round: S.current.round })
      return list.map((o) => o.id)
    }
    const agentName = S.current.seats.find((s) => s.id === mine)?.agent?.name ?? 'Agent'
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
    patchAgent(mine, 'drawing')
    const batchRound = S.current.round
    runBatch(myAgentKey, batch, batch.ops[0]?.tf ?? ORIGIN)
    later(batch.duration + 250, () => {
      if (S.current.round !== batchRound || pen?.batch) return
      patchAgent(mine, 'idle')
      if (pen) pen.visible = false
      busy.current = false
    })
    return batch.ops.map((o) => o.id)
  }, [meId, myAgentKey, patchAgent, runBatch, later, canDraw, buildAuthorizedOps, applyCommittedOps, showToast])

  const askAgent = useCallback((text: string) => {
    const L = S.current
    const mine = netSeatRef.current ?? meId
    const self = L.seats.find((s) => s.id === mine)
    if (netUnavailable.current) return showToast('联机暂时断开，请等待恢复')
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
      patchAgent(mine, 'thinking')
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

    const previewOps = placements.flatMap((p) => buildBatch(p.els, { seat: mine, author: 'agent', tf: p.tf, label }).ops)
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
    const taskRound = L.round
    const step = relayTurn ? relayTurn.stepIdx + 1 : 1
    const task = mode === 'tea' ? `茶绘 · 主题「${rules.theme || TEA_THEME}」` : mode === 'relay' ? `传话第 ${step} 棒 · 「${relayTitle}」` : `你画我猜 · 画手 · 词「${L.word?.word ?? ''}」`
    log('turn_get_task', t ? `${task} · 指令「${t}」` : task)
    log('canvas_get_targets', usedMarks.length ? `${usedMarks.length} 个标记（${usedMarks.map((m) => m.target.kind).join('、')}）` : '无标记 · canvas_find_space')
    log('canvas_snapshot', usedMarks.length ? `png · ${usedMarks.length} 个目标周边` : frame ? `png · 画框 ${frame.w}×${frame.h}` : 'png · 视口')
    patchAgent(mine, 'thinking')
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
      if (S.current.round !== taskRound || S.current.roundOver || (mode === 'relay' && S.current.submitted)) {
        patchAgent(mine, 'idle')
        if (pen) pen.visible = false
        busy.current = false
        return
      }
      if (assist) {
        setGhost({ ops: previewOps, label, ink: previewInk, notes })
        patchAgent(mine, 'review')
        busy.current = false
      } else {
        log('canvas_commit', `${label} · 墨量 ${previewInk}`, 'ok')
        commitOps(animateOps(previewOps, rules.penSpeed))
      }
    })
  }, [meId, mode, readOnly, frame, rules, showToast, log, patchAgent, think, later, myAgentKey, commitOps, relayTurn, relayTitle])

  const acceptGhost = useCallback(() => {
    const g = S.current.ghost
    if (!g) return []
    if (!canDraw(netSeatRef.current ?? meId)) { showToast('当前不能盖章落笔'); return [] }
    S.current.ghost = null
    setGhost(null)
    const b = opsBounds(g.ops)
    setLastStamp({ at: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, nonce: Date.now() })
    log('preview_accept', `${g.label} · 墨量 ${g.ink}`, 'ok')
    if (g.previewId) liveRef.current?.previewResult('accepted', g.previewId)
    return commitOps(animateOps(g.ops, rules.penSpeed))
  }, [log, commitOps, rules.penSpeed, canDraw, meId, showToast])

  const rejectGhost = useCallback(() => {
    const g = S.current.ghost
    if (!g) return
    S.current.ghost = null
    setGhost(null)
    patchAgent(netSeatRef.current ?? meId, 'idle')
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
    if (readOnly || netUnavailable.current || S.current.roundOver) return
    if (S.current.marks.length >= MAX_MARKS) return showToast(`最多同时指定 ${MAX_MARKS} 处，Esc 清空`)
    const target = frame ? clampTarget(t, frame) : t
    const color = S.current.seats.find((s) => s.id === (netSeatRef.current ?? meId))?.color ?? '#888'
    const mark: TargetMark = { id: uid('mk'), seat: netSeatRef.current ?? meId, color, target, createdAt: Date.now() }
    S.current.marks = [...S.current.marks, mark]
    setMarks(S.current.marks)
    const net = netRef.current
    if (net && rules.targetsPublic) {
      if (net.role === 'peer') net.intent({ t: 'mark', mark, round: S.current.round })
      else net.broadcast({ t: 'mark', mark })
    }
  }, [readOnly, frame, meId, showToast, rules.targetsPublic])

  const removeMark = useCallback((id: string) => {
    if (!S.current.marks.some((m) => m.id === id)) return
    S.current.marks = S.current.marks.filter((x) => x.id !== id)
    setMarks(S.current.marks)
    const net = netRef.current
    if (net && rules.targetsPublic) {
      if (net.role === 'peer') net.intent({ t: 'mark-del', id, round: S.current.round })
      else net.broadcast({ t: 'mark-del', id })
    }
  }, [rules.targetsPublic])

  const clearMarks = useCallback(() => {
    const net = netRef.current
    if (net && rules.targetsPublic) {
      for (const m of S.current.marks) {
        if (net.role === 'peer') net.intent({ t: 'mark-del', id: m.id, round: S.current.round })
        else net.broadcast({ t: 'mark-del', id: m.id })
      }
    }
    S.current.marks = []
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
    S.current.seats = roster
    setSeats(roster)
    net.broadcast({ t: 'roster', seats: roster.map((s) => ({ id: s.id, name: s.name, color: s.color, score: s.score, online: s.online, isHost: !!s.isHost })) })
  }, [rosterList])

  /** peer：按广播比分表刷新 seats */
  const patchScores = useCallback((map: [number, number][]) => {
    const m = new Map(map)
    S.current.seats = S.current.seats.map((s) => (m.has(s.id) ? { ...s, score: m.get(s.id)! } : s))
    setSeats(S.current.seats)
  }, [])

  /** peer：按 host roster 重建座位表（自己的座位标 isMe + 保留本地茶宠） */
  const applyRoster = useCallback((list: { id: number; name: string; color: string; score?: number; online?: boolean; isHost?: boolean }[]) => {
    const roster = list.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        ready: true,
        online: s.online ?? true,
        score: s.score ?? 0,
        isMe: s.id === netSeatRef.current,
        isHost: s.isHost,
        agent: s.id === netSeatRef.current ? (init.seats.find((x) => x.isMe)?.agent ?? null) : null,
      }))
    S.current.seats = roster
    setSeats(roster)
  }, [init])

  /** host：校验远端来的 {el,tf} 并落账+广播（轻量白名单 + 墨量上限） */
  const commitRemote = useCallback((from: string, items: OpIntent[], remoteRound: unknown) => {
    const seat = peerSeats.current.get(from)
    if (seat == null) return
    const built = remoteRound === S.current.round ? buildAuthorizedOps(seat, items) : []
    if (!built.length) { netRef.current?.to(from, { t: 'op-rejected', reason: '落笔不符合当前回合、权限或墨量房规' }); return }
    applyCommittedOps(built)
    netRef.current?.broadcast({ t: 'ops', ops: built, round: S.current.round })
  }, [buildAuthorizedOps, applyCommittedOps])

  /** host：成员意图处理 */
  const hostIntent = useCallback(
    (from: string, msg: RoomMsg) => {
      const net = netRef.current
      if (!net || !net.members().includes(from) || netUnavailable.current) return
      if (msg.t !== 'hello' && !peerSeats.current.has(from)) return
      switch (msg.t) {
        case 'hello': {
          // 幂等：peer 大厅→对局重连会重发 hello，已分过座位就补发 seat-assign+roster+snapshot
          let sid = peerSeats.current.get(from)
          if (sid == null) {
            const rosterSeat = net.seatRoster?.find((s) => s.peerId === from)?.seat
            const used = new Set([meId, ...peerSeats.current.values()])
            sid = rosterSeat ?? 1
            if (!rosterSeat) while (used.has(sid)) sid++
            if (sid > 8) return
            peerSeats.current.set(from, sid)
            peerNames.current.set(from, (typeof msg.name === 'string' && msg.name.slice(0, 12)) || '茶客')
          } else if (typeof msg.name === 'string' && msg.name) {
            peerNames.current.set(from, msg.name.slice(0, 12))
          }
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
            guessedSeats: [...guessedRef.current],
            answer: S.current.roundOver ? S.current.answer : '',
            endsAt: endsAtRef.current,
          })
          // 新员恰好是本轮画手且未选词 → 定向发词卡
          if (mode === 'guess' && sid === drawerSeat.current && !endsAtRef.current && !S.current.roundOver) {
            if (!offeredWords.current.length) offeredWords.current = pickOptions(guessPool(rules), 3, [...usedWords.current])
            net.to(from, { t: 'word-offer', options: offeredWords.current })
          } else if (mode === 'guess' && sid === drawerSeat.current && endsAtRef.current) {
            net.to(from, { t: 'word-picked', word: S.current.roundTarget })
          }
          break
        }
        case 'pick-word': {
          const seat = peerSeats.current.get(from)
          if (mode !== 'guess' || seat == null || seat !== drawerSeat.current || S.current.roundOver || endsAtRef.current || msg.round !== S.current.round) return
          const word = typeof msg.word === 'string' ? msg.word.trim().slice(0, 30) : ''
          const opt = offeredWords.current.find((o) => o.word === word)
          if (!opt) return
          S.current.roundTarget = opt
          S.current.answer = opt.word
          setRoundTarget(opt)
          setNetHintLen(opt.word.length)
          usedWords.current.add(word)
          endsAtRef.current = Date.now() + rules.roundTime * 1000
          const name = S.current.seats.find((s) => s.id === seat)?.name ?? '画手'
          const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `${name} 已选定题目，开画！` }
          setChat((c) => [...c.slice(-199), sys])
          net?.broadcast({ t: 'chat', msg: sys })
          net?.broadcast({ t: 'round-live', hintLen: word.length, endsAt: endsAtRef.current })
          net.to(from, { t: 'word-picked', word: opt })
          break
        }
        case 'guess': {
          const seat = peerSeats.current.get(from)
          const L = S.current
          const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 60) : ''
          if (mode !== 'guess' || seat == null || seat === drawerSeat.current || !text || L.roundOver || !endsAtRef.current || guessedRef.current.has(seat) || msg.round !== L.round) return
          const author = msg.author === 'agent' ? 'agent' : 'human'
          if (author === 'agent' && rules.guesserAgent === 'off') return
          const human: ChatMsg = { id: uid('m'), seat, author, text }
          setChat((c) => [...c.slice(-199), human])
          net?.broadcast({ t: 'chat', msg: human })
          const r = judgeGuess(text, L.roundTarget)
          net?.broadcast({ t: 'guess-result', seat, verdict: r })
          if (r === 'correct') {
            const original = Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))
            const base = author === 'agent' ? Math.round(original / 2) : original
            const scoresBefore = L.seats.map((s) => [s.id, s.score] as [number, number])
            score(seat, base)
            score(drawerSeat.current, 40)
            const name = S.current.seats.find((s) => s.id === seat)?.name ?? '对方'
            const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `${name} 猜中了！+${base}`, kind: 'correct' }
            setChat((c) => [...c.slice(-199), sys])
            net?.broadcast({ t: 'chat', msg: sys })
            net.broadcast({ t: 'scores', map: scoresBefore.map(([id, score]) => [id, score + (id === seat ? base : id === drawerSeat.current ? 40 : 0)]) })
            markGuessed(seat)
          } else if (r === 'close') {
            const sys: ChatMsg = { id: uid('m'), seat: null, author: 'system', text: `「${text}」很接近了`, kind: 'close' }
            setChat((c) => [...c.slice(-199), sys])
            net?.broadcast({ t: 'chat', msg: sys })
          }
          break
        }
        case 'next-req':
          break
        case 'end-req': {
          break
        }
        case 'op':
          commitRemote(from, [msg as unknown as OpIntent], msg.round)
          break
        case 'ops':
          commitRemote(from, (msg.items as OpIntent[]) ?? [], msg.round)
          break
        case 'op-erase': {
          const seat = peerSeats.current.get(from)
          const op = S.current.ops.find((o) => o.id === msg.id)
          if (seat == null || !canDraw(seat) || msg.round !== S.current.round || !op || op.seat !== seat) return
          S.current.ops = S.current.ops.filter((o) => o.id !== msg.id)
          setOps(S.current.ops)
          liveRef.current?.notifyOpsRemoved([msg.id as string])
          net?.broadcast({ t: 'op-del', ids: [msg.id] })
          break
        }
        case 'chat': {
          const seat = peerSeats.current.get(from)
          const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : ''
          if (seat == null || !text || (mode === 'guess' && seat === drawerSeat.current && !S.current.roundOver)) return
          const m: ChatMsg = { id: uid('m'), seat, author: msg.author === 'agent' ? 'agent' : 'human', text }
          setChat((c) => [...c.slice(-199), m])
          net?.broadcast({ t: 'chat', msg: m })
          break
        }
        case 'mark': {
          const seat = peerSeats.current.get(from)
          if (seat == null || !rules.targetsPublic || !msg.mark || !canDraw(seat) || msg.round !== S.current.round) return
          const raw = msg.mark as TargetMark
          if (typeof raw.id !== 'string' || raw.id.length > 100 || !raw.target) return
          const target = raw.target
          let valid = false
          switch (target.kind) {
            case 'pin': valid = finitePt(target.at) && Number.isFinite(target.radius) && target.radius > 0 && target.radius <= 10_000; break
            case 'box': valid = finiteRect(target.rect); break
            case 'grid': valid = finiteRect(target.rect) && Array.isArray(target.cell) && target.cell.length === 2 && target.cell.every((n) => Number.isInteger(n) && n >= 0 && n <= 2); break
            case 'lasso': valid = finiteRect(target.bbox) && Array.isArray(target.polygon) && target.polygon.length >= 3 && target.polygon.length <= 1000 && target.polygon.every(finitePt); break
            case 'path': valid = Array.isArray(target.points) && target.points.length >= 2 && target.points.length <= 1000 && target.points.every(finitePt) && Number.isFinite(target.width) && target.width > 0 && target.width <= 10_000; break
            case 'anchor': valid = finiteRect(target.bbox) && S.current.ops.some((o) => o.id === target.opId) && ['above', 'below', 'left', 'right', 'inside', 'around'].includes(target.relation); break
          }
          if (!valid || [...S.current.marks, ...S.current.foreignMarks].some((m) => m.id === raw.id && m.seat !== seat)) return
          if (S.current.foreignMarks.filter((m) => m.seat === seat && m.id !== raw.id).length >= MAX_MARKS) return
          const mark: TargetMark = { id: raw.id, seat, color: S.current.seats.find((s) => s.id === seat)?.color ?? '#888', target, createdAt: Date.now() }
          S.current.foreignMarks = [...S.current.foreignMarks.filter((x) => x.id !== mark.id), mark]
          setForeignMarks(S.current.foreignMarks)
          net?.broadcast({ t: 'mark', mark })
          break
        }
        case 'mark-del': {
          const seat = peerSeats.current.get(from)
          const hit = S.current.foreignMarks.find((m) => m.id === msg.id)
          if (seat == null || !hit || hit.seat !== seat || msg.round !== S.current.round) return
          S.current.foreignMarks = S.current.foreignMarks.filter((x) => x.id !== msg.id)
          setForeignMarks(S.current.foreignMarks)
          net?.broadcast({ t: 'mark-del', id: msg.id })
          break
        }
      }
    },
    [meId, mode, rules, rosterList, pushRoster, commitRemote, canDraw, score, markGuessed],
  )

  /** peer：host 广播处理 */
  const peerEvent = useCallback(
    (msg: RoomMsg) => {
      switch (msg.t) {
        case 'game-ready':
          netRef.current?.intent({ t: 'hello', name: netParams?.name ?? init.seats.find((s) => s.isMe)?.name ?? '茶客' })
          break
        case 'seat-assign':
          if (!Number.isInteger(msg.seat) || Number(msg.seat) < 1 || Number(msg.seat) > 8) return
          netSeatRef.current = msg.seat as number
          setNetSeat(msg.seat as number)
          if (msg.seat !== meId) {
            const pen = pens.current.get(agentPenKey(meId))
            if (pen) {
              pens.current.delete(pen.key)
              pen.key = agentPenKey(msg.seat as number)
              pen.seat = msg.seat as number
              pens.current.set(pen.key, pen)
              setPenKeys([...pens.current.keys()])
            }
          }
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
            guessedSeats?: number[]
          }
          if (Array.isArray(m.seats)) applyRoster(m.seats)
          if (Array.isArray(m.ops)) { S.current.ops = m.ops.map(({ anim: _anim, ...o }) => o); setOps(S.current.ops) }
          if (Array.isArray(m.foreignMarks)) { S.current.foreignMarks = m.foreignMarks.filter((x) => x.seat !== netSeatRef.current); setForeignMarks(S.current.foreignMarks) }
          if (typeof m.round === 'number') { S.current.round = m.round; setRound(m.round) }
          if (typeof m.drawerSeat === 'number') setDrawerNow(m.drawerSeat)
          setNetHintLen(m.hintLen ?? 0)
          endsAtRef.current = m.endsAt ?? 0
          if (Array.isArray(m.guessedSeats)) {
            guessedRef.current = new Set(m.guessedSeats)
            setGuessedSeats(m.guessedSeats)
            S.current.guessed = m.guessedSeats.includes(netSeatRef.current ?? meId)
            setGuessed(S.current.guessed)
          }
          S.current.roundOver = !!m.roundOver
          setRoundOver(!!m.roundOver)
          if (m.roundOver) {
            if (m.answer) setRoundTarget((t) => ({ ...t, word: m.answer! }))
          }
          if (m.endsAt && !m.roundOver) setTimeLeft(Math.max(0, Math.round((m.endsAt - Date.now()) / 1000)))
          break
        }
        case 'word-offer':
          S.current.wordOptions = (msg.options as WordOption[]) ?? []
          setWordOptions((msg.options as WordOption[]) ?? [])
          break
        case 'word-picked': {
          const picked = msg.word as WordOption | undefined
          if (picked?.word && netSeatRef.current === drawerSeat.current) {
            S.current.word = picked
            setWord(picked)
          }
          break
        }
        case 'round-start': {
          const m = msg as unknown as { round: number; drawerSeat: number }
          S.current.round = m.round
          S.current.ops = []
          S.current.word = null
          S.current.marks = []
          S.current.foreignMarks = []
          S.current.roundTarget = { ...GUESSER_TARGET, word: '' }
          S.current.roundOver = false
          S.current.guessed = false
          S.current.timeLeft = rules.roundTime
          S.current.ghost = null
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
          S.current.roundOver = true
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
            if (m.seat === netSeatRef.current) { S.current.guessed = true; setGuessed(true) }
          }
          break
        }
        case 'ops': {
          const ops = msg.ops as Op[] | undefined
          if (!Array.isArray(ops) || (msg.round != null && msg.round !== S.current.round)) return
          applyCommittedOps(ops)
          break
        }
        case 'op-rejected':
          busy.current = false
          patchAgent(netSeatRef.current ?? meId, 'idle')
          showToast(typeof msg.reason === 'string' ? msg.reason : '房主拒绝了这次落笔')
          break
        case 'op-del': {
          const ids = new Set((msg.ids as string[]) ?? [])
          S.current.ops = S.current.ops.filter((o) => !ids.has(o.id))
          setOps(S.current.ops)
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
    [applyRoster, init, netParams, meId, rules.roundTime, say, patchScores, applyCommittedOps, patchAgent, showToast],
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
    if (!netEnabled || mode === 'relay') return
    let dead = false
    let unsubscribe: (() => void) | undefined
    let ownedLink: NetLink | undefined
    const hooks: NetHooks = {
      onPacket: (f, m) => {
        if (!dead) dispatchRef.current.packet(f, m)
      },
      onMembers: (m) => {
        if (!dead) dispatchRef.current.members(m)
      },
      onClose: (reason) => {
        if (dead) return
        netUnavailable.current = true
        setNetView((v) => v ? { ...v, error: reason } : v)
        showToast('联机暂时断开，正在等待恢复')
      },
      onError: (reason) => {
        if (dead) return
        if (reason === 'GAME_SYNC_REQUIRED' && netRef.current?.role === 'peer') netRef.current.intent({ t: 'hello', name: netParams?.name ?? me.name })
        else showToast(`联机消息未送达：${reason}`)
      },
    }
    const attach = (l: NetLink) => {
        if (dead) {
          if (ownedLink === l) l.disconnect()
          return
        }
        netRef.current = l
        netUnavailable.current = false
        for (const entry of l.seatRoster ?? []) {
          if (entry.peerId === l.selfId) { netSeatRef.current = entry.seat; setNetSeat(entry.seat) }
          else if (l.role === 'host') { peerSeats.current.set(entry.peerId, entry.seat); peerNames.current.set(entry.peerId, entry.name) }
        }
        setNetView({ role: l.role, room: l.room, peers: l.members().length })
        unsubscribe = l.subscribe(hooks, 'game')
        if (l.role === 'host') {
          if (!offeredWords.current.length) offeredWords.current = S.current.wordOptions
          pushRoster()
          l.broadcast({ t: 'game-ready' })
        } else l.intent({ t: 'hello', name: netParams?.name ?? init.seats.find((s) => s.isMe)?.name ?? '茶客' })
        say({ seat: null, author: 'system', text: `联机房间 #${l.room} 已${l.role === 'host' ? '创建' : '加入'}（${l.transport}）` })
    }
    if (opts.netLink) attach(opts.netLink)
    else if (netParams) connectNet(netParams, { onPacket: () => {} }).then((l) => { ownedLink = l; attach(l) }).catch(() => {
        if (!dead) { netUnavailable.current = true; showToast('联机连接失败，请返回大厅重试') }
      })
    return () => {
      dead = true
      unsubscribe?.()
      ownedLink?.disconnect()
      netUnavailable.current = true
      netRef.current = null
    }
  }, [opts.netLink]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 你画我猜 ----------
  const pickWord = useCallback((w: WordOption) => {
    if (mode !== 'guess' || readOnly || netUnavailable.current || S.current.word || S.current.roundOver || !S.current.wordOptions.some((o) => o.word === w.word)) return
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'pick-word', word: w.word, round: S.current.round })
      return
    }
    S.current.word = w
    S.current.roundTarget = w
    S.current.answer = w.word
    setWord(w)
    usedWords.current.add(w.word)
    setRoundTarget(w)
    say({ seat: null, author: 'system', text: `你选了「${w.word}」（只有你能看到），计时 ${rules.roundTime} 秒开始！` })
    if (net?.role === 'host') {
      const endsAt = Date.now() + rules.roundTime * 1000
      endsAtRef.current = endsAt
      setNetHintLen(w.word.length)
      net.broadcast({ t: 'round-live', hintLen: w.word.length, endsAt })
    }
  }, [mode, readOnly, rules.roundTime, say])

  const whisperUsed = useRef(false)
  const submitGuess = useCallback((text: string, author: 'human' | 'agent' = 'human') => {
    const t = text.trim()
    if (!t) return
    const L = S.current
    const net = netRef.current
    const mine = netSeatRef.current ?? meId
    if (netUnavailable.current) return showToast('联机暂时断开，请等待恢复')
    if (net?.role === 'peer') {
      // 已猜中/本轮已结束 → 走普通聊天通道（host 的 chat 意图处理与猜词无关）
      net.intent({ t: L.guessed || L.roundOver ? 'chat' : 'guess', text: t, author, round: L.round })
      return
    }
    if (!readOnly || L.guessed || L.roundOver) return sayAll({ seat: mine, author, text: t })
    if (net && !endsAtRef.current) return
    if (author === 'agent' && rules.guesserAgent === 'off') return
    sayAll({ seat: mine, author, text: t })
    const r = judgeGuess(t, L.roundTarget)
    if (r === 'correct') {
      const base = Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))
      const pts = whisperUsed.current || author === 'agent' ? Math.round(base / 2) : base
      S.current.guessed = true
      setGuessed(true)
      score(mine, pts)
      score(drawerSeat.current, 40)
      sayAll({ seat: mine, author: 'system', text: `你猜中了！+${pts}${whisperUsed.current || author === 'agent' ? '（提示 ×0.5）' : ''}`, kind: 'correct' })
      pushScores()
      markGuessed(mine)
    } else if (r === 'close') sayAll({ seat: mine, author: 'system', text: `「${t}」很接近了`, kind: 'close' })
    net?.broadcast({ t: 'guess-result', seat: mine, verdict: r })
  }, [readOnly, meId, rules.roundTime, rules.guesserAgent, sayAll, score, markGuessed, pushScores, showToast])

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
  const sendChat = useCallback((text: string, author: 'human' | 'agent' = 'human') => {
    const t = text.trim()
    if (!t) return
    if (netUnavailable.current) return showToast('联机暂时断开，请等待恢复')
    if (mode === 'guess') {
      if (!readOnly && !S.current.roundOver) return showToast('画手不能在聊天里发言')
      if (readOnly) return submitGuess(t, author)
    }
    const net = netRef.current
    if (net?.role === 'peer') {
      net.intent({ t: 'chat', text: t, author })
      return
    }
    const msg: ChatMsg = { id: uid('m'), seat: netSeatRef.current ?? meId, author, text: t }
    setChat((c) => [...c.slice(-199), msg])
    net?.broadcast({ t: 'chat', msg })
  }, [mode, readOnly, meId, showToast, submitGuess, say])
  const localActions = useRef({ submitGuess, sendChat })
  localActions.current = { submitGuess, sendChat }

  // ---------- 回放 ----------
  const replay = useCallback(() => {
    const list = S.current.ops
    if (!list.length) return
    const per = Math.min(260, 5200 / list.length)
    const dur = Math.round(clamp(per * 2, 120, 600))
    redoStack.current = []
    setOps(list.map((o, i) => ({ ...o, anim: { delay: Math.round(i * per), dur } })))
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

  const previousReadOnly = useRef(readOnly)
  useEffect(() => {
    if (readOnly) { setTool('hand'); setGridOn(false) }
    else if (previousReadOnly.current) setTool('pen')
    previousReadOnly.current = readOnly
  }, [readOnly])

  // ---------- 挂载：模拟 + 计时 ----------
  useEffect(() => {
    const self = init.seats.find((s) => s.id === meId)
    if (self?.agent) {
      const home = frame ? { x: frame.x + 50, y: frame.y + frame.h - 20 } : { x: -560, y: 210 }
      if (!pens.current.has(agentPenKey(meId))) addPen(makePen({ key: agentPenKey(meId), seat: meId, author: 'agent', label: `我的 ${self.agent.name}`, color: self.color, home }))
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
    if (!netEnabled) startSimulation(ctx)
    if (resumeData?.ops?.length) later(800, () => showToast('已恢复上次未完成的画布'))

    // 真实 Agent 桥（teadraw mcp）：连上就把"我的 Agent"交给真实 MCP 工具处理；连不上走本地模拟
    const liveCtx: LiveCtx = {
      mode, rules, frame,
      get role() { return mode === 'guess' && netEnabled ? ((netSeatRef.current ?? meId) === drawerSeat.current ? 'drawer' : 'guesser') : roleProp },
      get meId() { return netSeatRef.current ?? meId },
      state: () => {
        const mine = netSeatRef.current ?? meId
        const used = S.current.ops.filter((o) => o.seat === mine).reduce((v, o) => ({ ...v, [o.author]: v[o.author] + o.ink }), { human: 0, agent: 0 })
        const allowance = rules.inkRatio >= 0.99 ? 99999 : Math.max(4000, Math.round(used.human * rules.inkRatio / (1 - rules.inkRatio)))
        return { ...S.current, ink: { ...used, allowance } }
      },
      later, log, say, think, patchAgent, score, markGuessed,
      setGhost,
      markUsed: (ids) => setMarks((ms) => ms.map((m) => (ids.includes(m.id) ? { ...m, used: true } : m))),
      clearMarks, showToast, commitOps, acceptGhost, getPen,
      drawerSeat: () => drawerSeat.current,
      get relayTitle() { return S.current.relayTurn?.prompt ?? '' },
      online: () => !netUnavailable.current,
      net: () => netEnabled,
      room: () => netRef.current?.room ?? ROOM_CODE,
      submitGuess: (text) => localActions.current.submitGuess(text, 'agent'),
      sendChat: (text) => localActions.current.sendChat(text, 'agent'),
    }
    liveRef.current = attachLiveAgent(liveCtx, setLive)

    if (mode !== 'tea') {
      every(1000, () => {
        const L = S.current
        if (L.timeLeft == null || L.roundOver || netUnavailable.current) return
        const net = netRef.current
        if (L.timeLeft <= 0) { if (net?.role !== 'peer' && mode === 'guess' && endsAtRef.current) endRound(); return }
        if (mode === 'guess') {
          // 选词阶段不走表：单机画手未选词 / host 等本轮词落定（自己选了 or 收到 pick-word）/ peer 等 round-live
          if (!net) {
            if (!readOnly && !L.word) return
          } else if (net.role === 'peer') {
            if (!endsAtRef.current) return
          } else if (!endsAtRef.current) return
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

  useEffect(() => {
    const save = () => {
      const link = netRef.current ?? opts.netLink
      if (link?.role !== 'host') return
      const L = S.current
      const data: HostSave = {
        mode, seats: L.seats, ops: L.ops, marks: L.marks, foreignMarks: L.foreignMarks, round: L.round, word: L.word,
        wordOptions: offeredWords.current.length ? offeredWords.current : L.wordOptions, roundTarget: L.roundTarget, drawerSeat: drawerSeat.current,
        endsAt: endsAtRef.current, guessedSeats: [...guessedRef.current], guessed: L.guessed, roundOver: L.roundOver,
        usedWords: [...usedWords.current], guessCount: [...guessCount.current], startedAt: startedAt.current, chat,
        peers: [...peerSeats.current], peerNames: [...peerNames.current],
      }
      try { sessionStorage.setItem(`teadraw:host:${link.room}:${link.gameId}`, JSON.stringify(data)) } catch { /* 存不下就算了 */ }
    }
    save()
    window.addEventListener('pagehide', save)
    return () => window.removeEventListener('pagehide', save)
  }, [opts.netLink, netView, ops, seats, round, word, wordOptions, roundTarget, drawerSeatS, guessedSeats, guessed, roundOver, chat, marks, foreignMarks, timeLeft, mode])

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
    if (netEnabled) {
      // peer 猜词者：词本体不下发，按 hintLen 画空槽；round-over 后 roundTarget.word 已填回显答案
      const chars = (roundTarget.word || '').split('')
      if (roundOver && chars.length) return chars
      return Array(netHintLen).fill('')
    }
    const chars = roundTarget.word.split('')
    if (guessed || roundOver) return chars
    const half = timeLeft != null && timeLeft <= rules.roundTime / 2
    return chars.map((ch, i) => (half && i === chars.length - 1 ? ch : ''))
  }, [readOnly, word, guessed, roundOver, timeLeft, rules.roundTime, roundTarget, netHintLen, netEnabled])

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
