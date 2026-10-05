import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityItem, AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, ToolId, Transform } from '../core/types'
import { clamp, STAGE, type Pt, type Rect } from '../core/geometry'
import { PALETTE } from '../core/theme'
import { measureLength } from '../core/svgPolicy'
import { DRAWINGS, drawingReport, matchDrawing, type DrawingKey } from '../mock/drawings'
import {
  GUESS_DRAWER_SEAT, GUESSER_TARGET, RELAY_FRAME, RELAY_PROMPT, RELAY_STEP, ROOM_CODE, TEA_THEME,
  judgeGuess, pickOptions, pickTarget, whisperFor, wordPool,
} from '../mock/room'
import {
  MAX_MARKS, type Camera, type GameState, type Ghost, type GuideMode, type Pen, type SessionResult,
  type Think, type Toast, type UseGameOptions, type WordOption,
} from './gameTypes'
import { animateOps, buildBatch, elStart, makePen, mergeBatches, nowTime, uid, type Batch } from './engine'
import {
  anchorRect, buildOccupancy, clampRect, elBounds, findSpace, fitContent, nudgeFree, occOverlap, opsBounds, pathSlots,
  targetCenter, targetRect, unionRects, type DrawTarget, type TargetMark,
} from './targeting'
import { agentPenKey, simRoundStart, startSimulation, type SimCtx } from './simulation'
import { attachLiveAgent, type LiveCtx, type LiveHandle } from './liveAgent'
import type { LivePeer } from './mcpClient'

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

function initialChat(mode: ModeId, role: GuessRole, rules: RoomRules, seats: Seat[]): ChatMsg[] {
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
      sys(`题目：「${RELAY_PROMPT}」`),
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
  const role = init.guessRole
  const readOnly = mode === 'guess' && role === 'guesser'
  const frame = mode === 'relay' ? RELAY_FRAME : undefined
  const meId = (init.seats.find((s) => s.isMe) ?? init.seats[0]).id

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
  const [chat, setChat] = useState<ChatMsg[]>(() => initialChat(mode, role, rules, init.seats))
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
  const [othersDone, setOthersDone] = useState(mode === 'relay' ? 2 : 0)
  const [submitted, setSubmitted] = useState(false)
  const [live, setLive] = useState<LivePeer>({ state: 'connecting' })

  // ---------- 局进度 ----------
  const [round, setRound] = useState(resumeData?.round ?? 1)
  const roundsTotal = mode === 'guess' ? rules.rounds : 1
  const isLastRound = round >= roundsTotal
  /** 猜词视角的本轮题目（drawer 视角的题目在 word 里） */
  const [roundTarget, setRoundTarget] = useState<WordOption>(GUESSER_TARGET)
  const [wordOptions, setWordOptions] = useState<WordOption[]>(() => pickOptions(wordPool(rules), 3))
  const usedWords = useRef(new Set<string>([GUESSER_TARGET.word]))
  /** 每座位累计猜中数（跨轮累计，结算用） */
  const guessCount = useRef(new Map<number, number>())
  /** 本轮画手座位（猜词视角按轮换，画手视角恒为我） */
  const drawerSeat = useRef(readOnly ? GUESS_DRAWER_SEAT : meId)
  const startedAt = useRef(Date.now())
  const simCtxRef = useRef<SimCtx | null>(null)

  const me = seats.find((s) => s.id === meId) ?? seats[0]
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
  const S = useRef({ seats, ops, ghost, marks, cam, word, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget })
  S.current = { seats, ops, ghost, marks, cam, word, guessed, roundOver, submitted, timeLeft, ink, answer, live, round, roundTarget }

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
    say({ seat: null, author: 'system', text: a ? `本轮结束，答案是「${a}」` : '本轮结束' })
  }, [say])

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
    const pool = wordPool(rules)
    const used = [...usedWords.current]
    if (readOnly) {
      const t = pickTarget(pool, used)
      usedWords.current.add(t.word)
      setRoundTarget(t)
    } else {
      setWordOptions(pickOptions(pool, 3, used))
    }
    simRoundStart(simCtxRef.current, r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, readOnly, rules, roundsTotal, say])

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
      theme: mode === 'tea' ? rules.theme || TEA_THEME : mode === 'relay' ? RELAY_PROMPT : undefined,
      startedAt: startedAt.current,
      durationMs: Date.now() - startedAt.current,
    }
  }, [mode, rules])

  // ---------- 绘制 / 擦除 / 撤销 ----------
  const redoStack = useRef<Op[]>([])

  const draw = useCallback((el: SvgEl) => {
    if (readOnly || S.current.roundOver || (mode === 'relay' && S.current.submitted)) return
    const op: Op = { id: uid('op'), seat: meId, author: 'human', el, tf: ORIGIN, ink: Math.round(measureLength(el)) }
    redoStack.current = []
    setOps((p) => [...p, op])
    liveRef.current?.notifyOps([op])
  }, [readOnly, mode, meId])

  const erase = useCallback((opId: string) => {
    if (readOnly) return
    const op = S.current.ops.find((o) => o.id === opId)
    if (!op) return
    if (op.seat !== meId) {
      const text = '只能擦除自己（和自己 Agent）的笔迹'
      if (lastToast.current.text !== text || Date.now() - lastToast.current.at > 1500) showToast(text)
      return
    }
    setOps((p) => p.filter((o) => o.id !== opId))
    liveRef.current?.notifyOpsRemoved([opId])
  }, [readOnly, meId, showToast])

  const undo = useCallback(() => {
    const list = S.current.ops
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].seat !== meId) continue
      const op = list[i]
      redoStack.current.push(op)
      setOps((p) => p.filter((o) => o.id !== op.id))
      liveRef.current?.notifyOpsRemoved([op.id])
      return
    }
  }, [meId])

  const redo = useCallback(() => {
    const op = redoStack.current.pop()
    if (!op) return
    const { anim: _a, ...rest } = op
    setOps((p) => [...p, rest])
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
    const task = mode === 'tea' ? `茶绘 · 主题「${rules.theme || TEA_THEME}」` : mode === 'relay' ? `传话第 ${RELAY_STEP.current} 步 · 「${RELAY_PROMPT}」` : `你画我猜 · 画手 · 词「${L.word?.word ?? ''}」`
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
  }, [meId, mode, readOnly, frame, rules, showToast, log, patchAgent, think, later, myAgentKey, commitOps])

  const acceptGhost = useCallback(() => {
    const g = S.current.ghost
    if (!g) return
    setGhost(null)
    const b = opsBounds(g.ops)
    setLastStamp({ at: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, nonce: Date.now() })
    log('preview_accept', `${g.label} · 墨量 ${g.ink}`, 'ok')
    if (g.previewId) liveRef.current?.previewResult('accepted', g.previewId)
    commitOps(animateOps(g.ops, rules.penSpeed))
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
    const color = S.current.seats.find((s) => s.id === meId)?.color ?? '#888'
    setMarks((m) => [...m, { id: uid('mk'), seat: meId, color, target, createdAt: Date.now() }])
  }, [readOnly, frame, meId, showToast])

  const removeMark = useCallback((id: string) => setMarks((m) => m.filter((x) => x.id !== id)), [])
  const clearMarks = useCallback(() => setMarks([]), [])

  // ---------- 你画我猜 ----------
  const pickWord = useCallback((w: WordOption) => {
    if (mode !== 'guess' || readOnly || S.current.word) return
    setWord(w)
    usedWords.current.add(w.word)
    say({ seat: null, author: 'system', text: `你选了「${w.word}」（只有你能看到），计时 ${rules.roundTime} 秒开始！` })
  }, [mode, readOnly, rules.roundTime, say])

  const whisperUsed = useRef(false)
  const submitGuess = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    const L = S.current
    if (!readOnly || L.guessed || L.roundOver) return say({ seat: meId, author: 'human', text: t })
    const r = judgeGuess(t, L.roundTarget)
    if (r === 'correct') {
      const base = Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))
      const pts = whisperUsed.current ? Math.round(base / 2) : base
      setGuessed(true)
      score(meId, pts)
      score(drawerSeat.current, 40)
      say({ seat: meId, author: 'system', text: `你猜中了！+${pts}${whisperUsed.current ? '（提示 ×0.5）' : ''}`, kind: 'correct' })
      markGuessed(meId)
    } else if (r === 'close') say({ seat: meId, author: 'system', text: `「${t}」很接近了`, kind: 'close' })
    else say({ seat: meId, author: 'human', text: t })
  }, [readOnly, meId, rules.roundTime, say, score, markGuessed])

  const whisperReq = useRef(false)
  const askWhisper = useCallback(() => {
    if (rules.guesserAgent !== 'whisper') return showToast('本房间未开启 Agent 悄悄提示')
    if (!readOnly) return showToast('只有猜词者可以请求提示')
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

  // ---------- 图文传话 ----------
  const submitRelay = useCallback(() => {
    if (mode !== 'relay' || S.current.submitted) return
    setSubmitted(true)
    clearMarks()
    say({ seat: null, author: 'system', text: '你的画作已提交，等待其他玩家…' })
  }, [mode, say, clearMarks])

  // ---------- 聊天 ----------
  const sendChat = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    if (mode === 'guess') {
      if (!readOnly && !S.current.roundOver) return showToast('画手不能在聊天里发言')
      if (readOnly) return submitGuess(t)
    }
    say({ seat: meId, author: 'human', text: t })
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
        drawerSeat.current = id
      },
      isOver: () => S.current.roundOver,
      showMark: (m) => {
        if (rules.targetsPublic) setForeignMarks((fm) => (fm.some((x) => x.id === m.id) ? fm : [...fm.slice(-5), m]))
      },
      hideMark: (id) => setForeignMarks((fm) => fm.filter((x) => x.id !== id)),
    }
    simCtxRef.current = ctx
    startSimulation(ctx)
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
    }
    liveRef.current = attachLiveAgent(liveCtx, setLive)

    if (mode !== 'tea') {
      every(1000, () => {
        const L = S.current
        if (L.timeLeft == null || L.timeLeft <= 0 || L.roundOver) return
        if (mode === 'guess' && !readOnly && !L.word) return
        const next = L.timeLeft - 1
        S.current.timeLeft = next
        setTimeLeft(next)
        if (next > 0) return
        if (mode === 'guess') endRound()
        else if (!L.submitted) {
          submitRelay()
          showToast('时间到，已自动提交')
        }
      })
    }
    if (mode === 'relay') {
      const step = () => {
        setOthersDone((d) => Math.min(5, d + 1))
        later(4000 + Math.random() * 3000, step)
      }
      later(4000 + Math.random() * 3000, step)
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
    const chars = roundTarget.word.split('')
    if (guessed || roundOver) return chars
    const half = timeLeft != null && timeLeft <= rules.roundTime / 2
    return chars.map((ch, i) => (half && i === chars.length - 1 ? ch : ''))
  }, [readOnly, word, guessed, roundOver, timeLeft, rules.roundTime, roundTarget])

  return {
    mode, rules, seats, me, role, readOnly, frame, live,
    ops, ghost, marks, foreignMarks, guideMode, setGuideMode, gridOn, setGridOn, thinking, pens, penKeys,
    cam, setCam, tool, setTool, color, setColor, width, setWidth, spaceDown,
    chat, activity, toast, ink, focusNonce,
    highlightAgent, setHighlightAgent, hiddenSeats, toggleSeatVisible,
    timeLeft, word, wordOptions: mode === 'guess' && !readOnly ? wordOptions : [], pickWord, hint, guessed, whisper, roundOver, answer,
    relayDone: othersDone + (submitted ? 1 : 0), submitted, guessedSeats,
    round, roundsTotal, isLastRound, nextRound, collectResult,
    draw, erase, undo, redo, addMark, removeMark, clearMarks, askAgent, acceptGhost, rejectGhost, ghostTf, lastStamp,
    sendChat, submitGuess, askWhisper, submitRelay, replay, zoomBy, resetView,
  }
}
