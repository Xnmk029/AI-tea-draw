import type { AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, Transform } from '../core/types'
import { pointsToPath, r1, shuffle, wavePath, type Pt } from '../core/geometry'
import { DRAWINGS, drawingEls, type DrawingKey } from '../mock/drawings'
import { AGENT_LINES, GUESS_DRAWER_SEAT, judgeGuess } from '../mock/room'
import type { Pen, WordOption } from './gameTypes'
import type { TargetMark } from './targeting'
import { buildBatch, elStart, makePen, uid, type Batch } from './engine'

/** useGame 提供给模拟脚本的回调，全部是稳定引用（只读 ref / functional setState） */
export interface SimCtx {
  mode: ModeId
  role: GuessRole
  seats: Seat[]
  rules: RoomRules
  meId: number
  later: (ms: number, fn: () => void) => void
  addOps: (ops: Op[]) => void
  runBatch: (penKey: string, batch: Batch, tf: Transform) => void
  addPen: (pen: Pen) => void
  getPen: (key: string) => Pen | undefined
  think: (key: string, at: Pt | null, color?: string) => void
  patchAgent: (seatId: number, status: AgentStatus) => void
  say: (msg: Omit<ChatMsg, 'id'>) => void
  /** 我座位（含 Agent）的总墨量 */
  myInk: () => number
  getWord: () => WordOption | null
  score: (seatId: number, delta: number) => void
  /** 某座位猜中（用于判断全员猜中提前结束） */
  markGuessed: (seatId: number) => void
  isOver: () => boolean
  /** 当前轮（1 起），用于脚本随轮重启 */
  getRound: () => number
  /** 本轮画手座位（猜词视角会轮换） */
  drawerSeat: () => number
  setDrawerSeat: (id: number) => void
  /** 公开指引标记（房规 targetsPublic）：Agent 思考时把令旗插到目标位置 */
  showMark: (m: TargetMark) => void
  hideMark: (id: string) => void
}

const ORIGIN: Transform = { x: 0, y: 0, s: 1 }
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const centerOf = (tf: Transform): Pt => ({ x: tf.x + 100 * tf.s, y: tf.y + 100 * tf.s })
const stroke = (d: string, color: string, w: number): SvgEl => ({
  tag: 'path',
  attrs: { d, fill: 'none', stroke: color, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round' },
})

export const humanPenKey = (seatId: number) => `${seatId}-human`
export const agentPenKey = (seatId: number) => `${seatId}-agent`

export function startSimulation(ctx: SimCtx) {
  if (ctx.mode === 'tea') runTea(ctx)
  else if (ctx.mode === 'guess') {
    if (ctx.role === 'drawer') runGuessDrawer(ctx)
    else runGuessGuesser(ctx)
  }
}

// ---------- 手绘涂鸦生成 ----------
function grass(p: Pt, n = 4 + Math.floor(Math.random() * 3), spread = 16): SvgEl[] {
  const els: SvgEl[] = []
  for (let i = 0; i < n; i++) {
    const x = p.x - ((n - 1) * spread) / 2 + i * spread + rand(-4, 4)
    const h = rand(18, 34)
    const lean = rand(-10, 10)
    els.push(stroke(`M${r1(x)} ${r1(p.y)} Q${r1(x + lean * 0.3)} ${r1(p.y - h * 0.6)} ${r1(x + lean)} ${r1(p.y - h)}`, pick(['#5BA176', '#4C8F68', '#7FA88C']), 3))
  }
  return els
}

function rain(p: Pt): SvgEl[] {
  const els: SvgEl[] = []
  const n = 5 + Math.floor(Math.random() * 3)
  for (let i = 0; i < n; i++) {
    const x = p.x + rand(-60, 60)
    const y = p.y + rand(-40, 40)
    const len = rand(18, 28)
    els.push(stroke(`M${r1(x)} ${r1(y)} L${r1(x - len * 0.25)} ${r1(y + len)}`, '#6FA3D6', 2.5))
  }
  return els
}

function wind(p: Pt): SvgEl[] {
  const els: SvgEl[] = []
  const n = 2 + Math.floor(Math.random() * 2)
  for (let i = 0; i < n; i++) {
    const x0 = p.x - 70 + rand(-8, 8)
    const y0 = p.y - 20 + i * 22
    const pts: Pt[] = []
    for (let t = 0; t <= 10; t++) pts.push({ x: x0 + t * 12, y: y0 + Math.sin((t / 10) * Math.PI * 2) * 6 })
    const end = pts[pts.length - 1]
    for (let a = 1; a <= 6; a++) {
      const ang = -Math.PI / 2 + (a / 6) * Math.PI * 1.5
      pts.push({ x: end.x + Math.cos(ang) * 8, y: end.y + 8 + Math.sin(ang) * 8 })
    }
    els.push(stroke(pointsToPath(pts), '#9AA6A0', 2.5))
  }
  return els
}

function humanDoodle(ctx: SimCtx, pen: Pen, els: SvgEl[]) {
  if (!els.length) return
  const start = elStart(els[0], ORIGIN)
  pen.pos = { ...start }
  pen.target = { ...start }
  ctx.runBatch(pen.key, buildBatch(els, { seat: pen.seat, author: 'human', tf: ORIGIN, speed: 520 }), ORIGIN)
}

// ---------- 其他玩家的 Agent 作画 ----------
function agentDraw(ctx: SimCtx, seat: Seat, key: DrawingKey, tf: Transform, speed: number, thinkMs = 1600, after?: () => void) {
  const pk = agentPenKey(seat.id)
  ctx.patchAgent(seat.id, 'thinking')
  ctx.think(pk, centerOf(tf), seat.color)
  // 房规允许时，把落笔目标公开成令旗，其他人能看到"那里马上会有东西"
  const mk: TargetMark | null = ctx.rules.targetsPublic
    ? { id: uid('mk'), seat: seat.id, color: seat.color, target: { kind: 'pin', at: centerOf(tf), radius: 110 }, createdAt: Date.now() }
    : null
  if (mk) ctx.showMark(mk)
  ctx.later(thinkMs, () => {
    ctx.think(pk, null)
    if (mk) ctx.hideMark(mk.id)
    if (ctx.isOver()) return ctx.patchAgent(seat.id, 'idle')
    const els = drawingEls(key, ctx.rules.svgPreset)
    const batch = buildBatch(els, { seat: seat.id, author: 'agent', tf, speed, label: DRAWINGS[key].label })
    const pen = ctx.getPen(pk)
    if (pen && els.length) {
      const p = elStart(els[0], tf)
      pen.pos = { ...p }
      pen.target = { ...p }
      pen.visible = true
    }
    ctx.patchAgent(seat.id, 'drawing')
    ctx.runBatch(pk, batch, tf)
    ctx.later(batch.duration + 300, () => {
      ctx.patchAgent(seat.id, 'idle')
      if (pen) pen.visible = false
      after?.()
    })
  })
}

function addSeatPens(ctx: SimCtx, s: Seat, home: Pt, range: number) {
  ctx.addPen(makePen({ key: humanPenKey(s.id), seat: s.id, author: 'human', label: s.name, color: s.color, home, range, wander: true, visible: true }))
  if (s.agent) ctx.addPen(makePen({ key: agentPenKey(s.id), seat: s.id, author: 'agent', label: `${s.name} 的 ${s.agent.name}`, color: s.color, home: { x: home.x + 40, y: home.y - 40 } }))
}

// ---------- 基础茶绘 ----------
const TEA_HOMES: Pt[] = [{ x: 160, y: -60 }, { x: -480, y: 40 }, { x: -220, y: 170 }, { x: 430, y: -110 }, { x: -300, y: -250 }, { x: 300, y: 160 }, { x: -40, y: -280 }]

const TEA_JOBS: [DrawingKey, Transform][] = [
  ['tree', { x: 200, y: 20, s: 0.9 }],
  ['cloud', { x: 120, y: -300, s: 0.75 }],
  ['flower', { x: -330, y: 60, s: 0.7 }],
  ['cat', { x: 440, y: 70, s: 0.65 }],
  ['cloud', { x: -600, y: -340, s: 0.7 }],
  ['teapot', { x: 300, y: -160, s: 0.65 }],
  ['cup', { x: -240, y: -150, s: 0.6 }],
  ['tree', { x: -80, y: -330, s: 0.75 }],
]

const TEA_CHAT: [number, number, 'human' | 'agent', string][] = [
  [4000, 2, 'human', '茶馆我先让 GPT 起了个底，门口还空着'],
  [8500, 5, 'human', '下雨天还挂太阳是认真的吗哈哈'],
  [10200, 5, 'agent', '这是太阳雨，雨停之后会有彩虹。'],
  [15000, 4, 'human', '我来画地平线和草地，雨丝也交给我'],
  [21000, 6, 'human', '@DeepSeek 雨云再多来一朵'],
  [22600, 6, 'agent', '收到，墨量还剩一些，我挑个空位置。'],
  [30000, 3, 'human', '远山是 Gemini 画的，我只调了颜色'],
  [38000, 2, 'human', '谁来给茶馆门口画只猫？'],
  [46000, 4, 'human', '纯手画党表示压力很大'],
  [47600, 3, 'agent', '小满的草地笔触很好，我不往那边画了。'],
  [60000, 5, 'human', '这张画完可以当房间封面了'],
  [75000, 6, 'human', '按 A 可以高亮 Agent 的笔迹，挺好玩的'],
]

function runTea(ctx: SimCtx) {
  const { seats, rules } = ctx
  const byId = (id: number) => seats.find((s) => s.id === id)
  const ops: Op[] = []
  const statics: [number, DrawingKey, Transform][] = [
    [3, 'mountain', { x: -680, y: -120, s: 1.6 }],
    [2, 'house', { x: -130, y: -75, s: 1.35 }],
    [5, 'sun', { x: 390, y: -330, s: 0.7 }],
    [6, 'cloud', { x: -420, y: -370, s: 0.9 }],
  ]
  for (const [id, key, tf] of statics) {
    if (byId(id)) ops.push(...buildBatch(drawingEls(key, rules.svgPreset), { seat: id, author: 'agent', tf, label: DRAWINGS[key].label }).ops)
  }
  if (byId(4)) ops.push(...buildBatch([stroke(wavePath(-760, 760, 205, 6, 140), '#7FA88C', 4)], { seat: 4, author: 'human', tf: ORIGIN }).ops)
  ctx.addOps(ops)

  const others = seats.filter((s) => s.id !== ctx.meId && s.online)
  others.forEach((s, i) => addSeatPens(ctx, s, TEA_HOMES[i % TEA_HOMES.length], 360))

  const agents = others.filter((s) => s.agent)
  if (rules.agentLevel !== 'off' && agents.length) {
    let n = 0
    const next = () => {
      const seat = agents[n % agents.length]
      const [key, base] = TEA_JOBS[n % TEA_JOBS.length]
      const round = Math.floor(n / TEA_JOBS.length)
      // 素材用完后向画布两侧扩展，避免叠在一起
      const shift = round === 0 ? 0 : (round % 2 ? 1 : -1) * 1400 * Math.ceil(round / 2)
      const tf = { ...base, x: base.x + shift }
      n++
      agentDraw(ctx, seat, key, tf, rules.penSpeed, 1600, () => {
        const line = AGENT_LINES[key]
        if (line && Math.random() < 0.6) ctx.say({ seat: seat.id, author: 'agent', text: line })
      })
      ctx.later(rand(9000, 13000), next)
    }
    ctx.later(2200, next)
  }

  const doodle = () => {
    const free = others.map((s) => ctx.getPen(humanPenKey(s.id))).filter((p): p is Pen => !!p && !p.batch)
    if (free.length) {
      const pen = pick(free)
      humanDoodle(ctx, pen, pick([grass, rain, wind])(pen.pos))
    }
    ctx.later(rand(5000, 9000), doodle)
  }
  ctx.later(rand(3000, 4500), doodle)

  for (const [at, id, author, text] of TEA_CHAT) {
    const s = byId(id)
    if (!s || (author === 'agent' && !s.agent)) continue
    ctx.later(at, () => ctx.say({ seat: id, author, text }))
  }
}

// ---------- 你画我猜 ----------
function announce(ctx: SimCtx, seat: Seat, text: string, target: { word: string; close: string[] }, order: number, drawerId: number, drawerPts: number) {
  const r = judgeGuess(text, target)
  if (r === 'wrong') ctx.say({ seat: seat.id, author: 'human', text })
  else if (r === 'close') ctx.say({ seat: seat.id, author: 'system', text: `${seat.name} 很接近了`, kind: 'close' })
  else {
    ctx.score(seat.id, Math.max(100, 300 - order * 50))
    ctx.score(drawerId, drawerPts)
    ctx.say({ seat: seat.id, author: 'system', text: `${seat.name} 猜中了！`, kind: 'correct' })
    ctx.markGuessed(seat.id)
  }
  return r
}

const DRAWER_WRONG: Partial<Record<DrawingKey, string[]>> = {
  teapot: ['南瓜', '帽子', '灯笼'],
  house: ['山', '帐篷', '学校'],
  cloud: ['棉花糖', '羊', '雪'],
}

// [猜词者序号, 文本类型, 触发墨量]
const DRAWER_PLAN: [number, 'w0' | 'w1' | 'w2' | 'c0' | 'c1' | 'ok', number][] = [
  [0, 'w0', 60], [1, 'w1', 180], [2, 'c0', 320], [3, 'ok', 460], [0, 'w2', 580],
  [1, 'ok', 720], [2, 'ok', 860], [4, 'c1', 980], [0, 'ok', 1120], [4, 'ok', 1300],
]

function runGuessDrawer(ctx: SimCtx) {
  const others = shuffle(ctx.seats.filter((s) => s.id !== ctx.meId && s.online))
  let queue: { seat: Seat; text: string; ink: number }[] | null = null
  let order = 0
  const done = new Set<number>()
  let queueRound = -1
  const tick = () => {
    // 换轮了：重置猜词队列，等下一轮的新词
    const rd = ctx.getRound()
    if (rd !== queueRound) {
      queueRound = rd
      queue = null
      order = 0
      done.clear()
    }
    if (!ctx.isOver()) {
      const w = ctx.getWord()
      if (w) {
        if (!queue) {
          const wrong = DRAWER_WRONG[w.drawing] ?? ['猫', '鱼', '花']
          const texts = { w0: wrong[0], w1: wrong[1], w2: wrong[2], c0: w.close[0] ?? wrong[0], c1: w.close[1] ?? wrong[1], ok: w.word }
          queue = DRAWER_PLAN.filter(([i]) => i < others.length).map(([i, k, ink]) => ({ seat: others[i], text: texts[k], ink }))
        }
        while (queue.length && done.has(queue[0].seat.id)) queue.shift()
        const g = queue[0]
        if (g && ctx.myInk() >= g.ink) {
          queue.shift()
          if (announce(ctx, g.seat, g.text, w, order, ctx.meId, 60) === 'correct') {
            done.add(g.seat.id)
            order++
          }
        }
      }
    }
    ctx.later(2500, tick)
  }
  ctx.later(2500, tick)
}

const GUESSER_SCRIPT: [number, number, string][] = [
  [5000, 4, '金字塔？'], [8500, 3, '三角形'], [12000, 6, '圣诞树'], [16500, 5, '松树'],
  [21000, 3, '杉树'], [26000, 3, '松树'], [33000, 6, '松树'], [42000, 4, '树'], [50000, 4, '松树'],
]

/** 按题目生成围观者猜词剧本：先错 → 接近 → 陆续猜中（松树保留手写剧本） */
function guesserScript(target: WordOption): [number, number, string][] {
  if (target.word === '松树') return GUESSER_SCRIPT
  const wrongs = ['山', '房子', '太阳'].filter((w) => w !== target.word && !target.close.includes(w))
  const closes = target.close.length ? target.close : ['树', '花']
  return [
    [5000, 4, wrongs[0] ?? '云'],
    [8500, 3, closes[0] ?? '树'],
    [12000, 6, wrongs[1] ?? '茶壶'],
    [16500, 5, target.word],
    [22000, 3, closes[1] ?? closes[0] ?? '树'],
    [28000, 3, target.word],
    [36000, 6, target.word],
    [45000, 4, target.word],
  ]
}

/** 给猜词视角挂一轮剧本：其余座位的猜词队列（跨轮重挂时用 getRound 防串轮） */
function armGuessScript(ctx: SimCtx) {
  const target = ctx.getWord()
  if (!target) return
  const drawerId = ctx.drawerSeat()
  const myRound = ctx.getRound()
  const done = new Set<number>()
  let order = 0
  for (const [at, id, text] of guesserScript(target)) {
    const s = ctx.seats.find((x) => x.id === id)
    if (!s || s.id === drawerId || s.id === ctx.meId) continue
    ctx.later(at, () => {
      if (ctx.isOver() || done.has(id) || ctx.getRound() !== myRound) return
      if (announce(ctx, s, text, target, order, drawerId, 40) === 'correct') {
        done.add(id)
        order++
      }
    })
  }
}

/** 新一轮开局钩子（useGame.nextRound 调）：猜词视角换画手、重挂剧本 */
export function simRoundStart(ctx: SimCtx | null, round: number) {
  if (!ctx || ctx.mode !== 'guess' || ctx.isOver()) return
  if (ctx.role !== 'guesser') return
  const w = ctx.getWord()
  const drawers = ctx.seats.filter((s) => !s.isMe && s.online)
  if (!w || !drawers.length) return
  const drawer = drawers[(round - 1) % drawers.length]
  ctx.setDrawerSeat(drawer.id)
  addSeatPens(ctx, drawer, { x: -40 + ((round - 1) * 160) % 400, y: -20 }, 260)
  ctx.say({ seat: null, author: 'system', text: `这轮轮到 ${drawer.name} 作画` })
  const tf = { x: -150 + ((round - 1) * 220) % 420, y: -170, s: 1.5 }
  if (drawer.agent && ctx.rules.agentLevel !== 'off') agentDraw(ctx, drawer, w.drawing, tf, ctx.rules.penSpeed, 1400)
  else
    ctx.later(1600, () => {
      const pen = ctx.getPen(humanPenKey(drawer.id))
      if (pen) humanDoodle(ctx, pen, drawingEls(w.drawing, ctx.rules.svgPreset))
    })
  armGuessScript(ctx)
}

function runGuessGuesser(ctx: SimCtx) {
  const drawer = ctx.seats.find((s) => s.id === GUESS_DRAWER_SEAT) ?? ctx.seats.find((s) => s.id !== ctx.meId)
  if (!drawer) return
  ctx.setDrawerSeat(drawer.id)
  addSeatPens(ctx, drawer, { x: -40, y: -20 }, 260)
  const w0 = ctx.getWord()
  if (drawer.agent && ctx.rules.agentLevel !== 'off') agentDraw(ctx, drawer, w0?.drawing ?? 'tree', { x: -150, y: -170, s: 1.5 }, 260, 1200)
  ctx.later(14000, () => {
    const pen = ctx.getPen(humanPenKey(drawer.id))
    if (!pen || ctx.isOver()) return
    humanDoodle(ctx, pen, [...grass({ x: -90, y: 122 }, 4, 14), ...grass({ x: 95, y: 122 }, 4, 14)])
  })
  armGuessScript(ctx)
}
