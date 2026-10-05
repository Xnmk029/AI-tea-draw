// 真实 Agent 的工具处理器：把 teadraw 桥转发来的 tools/call 接到对局状态上。
// 与 useGame 的关系类似 simulation.ts——通过 LiveCtx 的稳定回调读写状态。
// 坐标契约（见 server/README.md）：Agent 的 SVG 永远画在帧（frame）的局部坐标 0..w×0..h。

import type { AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, Transform } from '../core/types'
import { STAGE, type Pt, type Rect } from '../core/geometry'
import { POLICY_PRESETS, sanitizeSvg } from '../core/svgPolicy'
import { RELAY_PROMPT, RELAY_STEP, ROOM_CODE, TEA_THEME, judgeGuess, whisperFor } from '../mock/room'
import { MAX_MARKS, type Camera, type Ghost, type Pen, type WordOption } from './gameTypes'
import { animateOps, buildBatch, elStart, uid, type Batch } from './engine'
import {
  buildOccupancy, elBounds, findSpace, nudgeFree, occOverlap, opBounds, pathSlots, targetRect, unionRects,
  type TargetMark,
} from './targeting'
import { agentPenKey } from './simulation'
import { McpClient, type CallResult, type LivePeer } from './mcpClient'

const MCP_PORT = new URLSearchParams(location.search).get('mcp') ?? '5190'
const WS_URL = `ws://127.0.0.1:${MCP_PORT}`
const PATH_SLOT = 210

// ---------- useGame 提供给处理器的上下文 ----------
export interface LiveSnapshot {
  seats: Seat[]
  ops: Op[]
  ghost: Ghost | null
  marks: TargetMark[]
  cam: Camera
  word: WordOption | null
  guessed: boolean
  roundOver: boolean
  submitted: boolean
  timeLeft: number | null
  ink: { human: number; agent: number; allowance: number }
  /** 当前轮与本轮题目（猜词视角的答案是 roundTarget） */
  round: number
  roundTarget: WordOption
}

export interface LiveCtx {
  mode: ModeId
  role: GuessRole
  rules: RoomRules
  frame?: Rect
  meId: number
  state: () => LiveSnapshot
  later: (ms: number, fn: () => void) => void
  log: (tool: string, detail: string, tone?: 'ok' | 'warn' | 'muted') => void
  say: (msg: Omit<ChatMsg, 'id'>) => void
  think: (key: string, at: Pt | null, color?: string) => void
  patchAgent: (seatId: number, status: AgentStatus) => void
  score: (seatId: number, delta: number) => void
  markGuessed: (seatId: number) => void
  setGhost: (g: Ghost | null) => void
  markUsed: (ids: string[]) => void
  clearMarks: () => void
  showToast: (text: string) => void
  commitOps: (batch: Batch) => void
  acceptGhost: () => void
  getPen: (key: string) => Pen | undefined
  /** 本轮画手座位（猜词视角轮换） */
  drawerSeat: () => number
}

interface LiveEvent {
  seq: number
  type: string
  data?: unknown
}

interface PendingTask {
  id: string
  text: string
}

export interface LiveHandle {
  client: McpClient
  /** 玩家吩咐 Agent（askAgent 的真实链路）：把任务挂上，等 Agent 拉取 */
  pushTask: (text: string) => void
  /** 草稿被玩家盖章/揉掉 → 通知 Agent */
  previewResult: (result: 'accepted' | 'rejected', previewId?: string) => void
  /** 新增笔迹广播给 Agent（events_poll 的 'ops' 事件）：人画的、别人画的、Agent 自己落定的都算 */
  notifyOps: (ops: Op[]) => void
  /** 笔迹被擦除/撤销 → 'ops_removed' 事件 */
  notifyOpsRemoved: (ids: string[]) => void
  dispose: () => void
}

const ok = (data: unknown): CallResult => ({ data })
const err = (message: string, code = 'invalid'): CallResult => ({ error: { code, message } })

// SvgEl → 字符串（快照栅格化用）；attrs 的 camelCase 转回 kebab-case
const KEBAB: Record<string, string> = {
  strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin',
  fillOpacity: 'fill-opacity', strokeOpacity: 'stroke-opacity',
}
const elSvg = (el: SvgEl) =>
  `<${el.tag} ${Object.entries(el.attrs)
    .map(([k, v]) => `${KEBAB[k] ?? k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ')}/>`

export function attachLiveAgent(ctx: LiveCtx, onPeer: (p: LivePeer) => void): LiveHandle {
  const { mode, role, rules, meId } = ctx
  const myKey = agentPenKey(meId)
  const readOnly = mode === 'guess' && role === 'guesser'
  const seatColor = () => ctx.state().seats.find((s) => s.id === meId)?.color ?? '#888'

  let seq = 0
  const events: LiveEvent[] = []
  const emit = (type: string, data?: unknown) => {
    const ev = { seq: ++seq, type, data }
    events.push(ev)
    if (events.length > 120) events.shift()
    client.event({ type, data })
  }

  let pendingTask: PendingTask | null = null
  const spaceCache = new Map<string, { frame: Rect; expires: number }>()

  // ---------- 帧：标记 → 供 Agent 引用的矩形 ----------
  const frames = (): { id: string; kind: string; frame: Rect }[] => {
    const out: { id: string; kind: string; frame: Rect }[] = []
    for (const m of ctx.state().marks) {
      const t = m.target
      if (t.kind === 'path') {
        out.push({ id: m.id, kind: 'path', frame: targetRect(t) })
        pathSlots(t.points, PATH_SLOT, 4).forEach((r, i) => out.push({ id: `${m.id}/s${i}`, kind: 'slot', frame: r }))
      } else out.push({ id: m.id, kind: t.kind, frame: targetRect(t) })
    }
    return out
  }

  const lookupFrame = (id: string): Rect | null => {
    const f = frames().find((x) => x.id === id)
    if (f) return f.frame
    const sp = spaceCache.get(id)
    if (sp && sp.expires > Date.now()) return sp.frame
    return null
  }

  const viewWorld = (): Rect => {
    const { cam } = ctx.state()
    if (ctx.frame) return ctx.frame
    return { x: cam.x, y: cam.y, w: STAGE.w / cam.z, h: STAGE.h / cam.z }
  }

  const regionFor = (targetId?: string): Rect => (targetId ? lookupFrame(targetId) ?? viewWorld() : viewWorld())

  // ---------- 快照栅格化（ops → PNG dataURL） ----------
  const rasterize = async (region: Rect, width = 768): Promise<{ data: string; w: number; h: number }> => {
    const ops = ctx.state().ops.filter((o) => {
      const b = opBounds(o)
      return b.x < region.x + region.w && b.x + b.w > region.x && b.y < region.y + region.h && b.y + b.h > region.y
    })
    const inner = ops.map((o) => `<g transform="translate(${o.tf.x} ${o.tf.y}) scale(${o.tf.s})">${elSvg(o.el)}</g>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${region.x} ${region.y} ${region.w} ${region.h}"><rect x="${region.x}" y="${region.y}" width="${region.w}" height="${region.h}" fill="#FAF7F1"/>${inner}</svg>`
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = rej
        i.src = url
      })
      const h = Math.max(1, Math.round((width / region.w) * region.h))
      const c = document.createElement('canvas')
      c.width = width
      c.height = h
      c.getContext('2d')!.drawImage(img, 0, 0, width, h)
      return { data: c.toDataURL('image/png').split(',')[1], w: width, h }
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  // ---------- 各工具处理器 ----------
  const handlers: Record<string, (a: any) => Promise<CallResult> | CallResult> = {
    turn_get_task: () => {
      ctx.log('turn_get_task', pendingTask ? `领取任务「${pendingTask.text}」` : '无任务')
      if (!pendingTask) return ok({ task: null })
      const L = ctx.state()
      return ok({
        task: {
          id: pendingTask.id,
          text: pendingTask.text,
          mode,
          theme: mode === 'tea' ? rules.theme || TEA_THEME : undefined,
          prompt: mode === 'relay' ? RELAY_PROMPT : undefined,
          step: mode === 'relay' ? RELAY_STEP : undefined,
          word: mode === 'guess' && role === 'drawer' ? L.word?.word : undefined,
          targets: ctx.state().marks.length,
          ink: { used: L.ink.agent, allowance: Math.round(L.ink.allowance), remaining: Math.max(0, Math.round(L.ink.allowance - L.ink.agent)) },
          rules: { penSpeed: rules.penSpeed, inkRatio: rules.inkRatio, targetFit: rules.targetFit, svgPreset: rules.svgPreset, maxMarks: MAX_MARKS },
        },
      })
    },

    canvas_get_targets: () => {
      const t = frames()
      ctx.log('canvas_get_targets', t.length ? `${t.length} 个帧` : '无标记')
      return ok({
        targets: t.map((f) => ({ id: f.id, kind: f.kind, frame: f.frame })),
        note: '你的 SVG 画在 frame 的局部坐标 0..w × 0..h；提交时带 targetId',
      })
    },

    canvas_find_space: (a) => {
      const L = ctx.state()
      const w = Math.min(Math.max(Number(a?.w) || 200, 60), 600)
      const h = Math.min(Math.max(Number(a?.h) || 200, 60), 600)
      const near = a?.near && Number.isFinite(a.near.x) ? { x: a.near.x, y: a.near.y } : undefined
      const view = viewWorld()
      const occ = buildOccupancy(L.ops)
      const bound = ctx.frame ?? (L.ops.length ? occ.bound : { x: -760, y: -460, w: 1520, h: 920 })
      const spot = findSpace(occ, w, h, near ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 }, bound)
      if (!spot) return err('找不到这么大的空位')
      const id = `sp-${uid('x')}`
      spaceCache.set(id, { frame: spot, expires: Date.now() + 60000 })
      ctx.log('canvas_find_space', `${Math.round(spot.w)}×${Math.round(spot.h)} @ (${Math.round(spot.x)}, ${Math.round(spot.y)})`)
      return ok({ space: { id, frame: spot } })
    },

    canvas_snapshot: async (a) => {
      const region = regionFor(a?.targetId)
      ctx.log('canvas_snapshot', `png · ${Math.round(region.w)}×${Math.round(region.h)}${readOnly ? '（仅光栅图，无 SVG 源）' : ''}`, 'muted')
      const img = await rasterize(region)
      return { content: [{ type: 'image', data: img.data, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ w: img.w, h: img.h, region }) }] }
    },

    canvas_describe: (a) => {
      const region = regionFor(a?.targetId)
      const els = ctx
        .state()
        .ops.filter((o) => {
          const b = opBounds(o)
          return b.x < region.x + region.w && b.x + b.w > region.x && b.y < region.y + region.h && b.y + b.h > region.y
        })
        .map((o) => ({
          id: o.id,
          seat: o.seat,
          author: o.author,
          tag: o.el.tag,
          bbox: opBounds(o),
          ...(mode === 'guess' ? {} : { label: o.label }),
        }))
      ctx.log('canvas_describe', `${els.length} 个元素${mode === 'guess' ? ' · label 已隐藏' : ''}`)
      return ok({ region, elements: els })
    },

    canvas_draw: (a) => {
      const L = ctx.state()
      if (readOnly) return err('猜词者的 Agent 不能落笔')
      if (L.roundOver) return err('本轮已结束')
      if (mode === 'relay' && L.submitted) return err('画作已提交')
      if (L.ghost) return err('还有一张草稿待确认（等玩家盖章或揉掉）', 'preview_pending')

      const report = sanitizeSvg(String(a?.svg ?? ''), POLICY_PRESETS[rules.svgPreset])
      if (!report.elements.length) {
        ctx.log('canvas_draw', `无有效元素${report.removed.length ? ` · 已移除 ${report.removed.join('、')}` : ''}`, 'warn')
        return err('SVG 里没有可绘制的元素', 'no_elements')
      }
      const content = unionRects(report.elements.map(elBounds))
      const fit = (a?.fit === 'contain' || a?.fit === 'clip' || a?.fit === 'strict' ? a.fit : rules.targetFit) as 'contain' | 'clip' | 'strict'
      const occ = buildOccupancy(L.ops)

      // 目标帧列表：显式帧（可 repeat 展开）/ 自动找空位
      const ref = a?.targetId ?? a?.spaceId
      const all = frames()
      let picked: { frame: Rect; markIds: string[] }[] = []
      if (ref) {
        const space = spaceCache.get(ref)
        const markId = ref.split('/')[0]
        // repeat：只取引路目标的槽位帧；槽位不存在时退回整体帧
        const hits = a?.repeat ? all.filter((f) => f.id.startsWith(`${ref}/`)) : all.filter((f) => f.id === ref)
        if (space && space.expires > Date.now()) picked = [{ frame: space.frame, markIds: [] }]
        else if (hits.length) picked = hits.map((f) => ({ frame: f.frame, markIds: [markId] }))
        else if (a?.repeat) {
          const parent = all.find((f) => f.id === ref)
          if (!parent) return err(`帧 ${ref} 不存在或已过期，重新 canvas_get_targets / canvas_find_space`, 'bad_frame')
          picked = [{ frame: parent.frame, markIds: [markId] }]
        } else return err(`帧 ${ref} 不存在或已过期，重新 canvas_get_targets / canvas_find_space`, 'bad_frame')
      } else {
        const view = viewWorld()
        const bound = ctx.frame ?? (L.ops.length ? occ.bound : { x: -760, y: -460, w: 1520, h: 920 })
        const spot = findSpace(occ, Math.min(Math.max(content.w, 140), 400), Math.min(Math.max(content.h, 140), 400), { x: view.x + view.w / 2, y: view.y + view.h / 2 }, bound)
        if (!spot) return err('找不到空位落笔')
        picked = [{ frame: spot, markIds: [] }]
      }

      // 局部坐标 → 世界：内容居中放进帧；越界按 fit 策略
      const placements: { els: SvgEl[]; tf: Transform }[] = []
      const usedIds = new Set<string>()
      for (const p of picked) {
        let area = p.frame
        if (!a?.repeat && rules.avoidOthers !== false && occOverlap(occ, area) > 0) area = nudgeFree(occ, area)
        const cw = Math.max(content.w, 1)
        const ch = Math.max(content.h, 1)
        let s = 1
        if (cw > area.w || ch > area.h) {
          if (fit === 'strict') return err(`内容 ${Math.ceil(cw)}×${Math.ceil(ch)} 超出帧 ${Math.ceil(area.w)}×${Math.ceil(area.h)}（strict 拒绝）`, 'overflow')
          if (fit === 'contain') s = Math.min(area.w / cw, area.h / ch) * 0.92
        }
        placements.push({
          els: report.elements,
          tf: { x: area.x + (area.w - cw * s) / 2 - content.x * s, y: area.y + (area.h - ch * s) / 2 - content.y * s, s },
        })
        p.markIds.forEach((id) => usedIds.add(id))
      }

      const previewOps = placements.flatMap((pl) => buildBatch(pl.els, { seat: meId, author: 'agent', tf: pl.tf, label: pendingTask?.text.slice(0, 24) }).ops)
      const inkNeed = previewOps.reduce((n, o) => n + o.ink, 0)
      if (L.ink.agent + inkNeed > L.ink.allowance) {
        ctx.log('canvas_draw', `已拒绝 · 墨量 ${inkNeed} 超出剩余 ${Math.max(0, Math.round(L.ink.allowance - L.ink.agent))}`, 'warn')
        return err(`墨量不足：需要 ${inkNeed}，剩余 ${Math.max(0, Math.round(L.ink.allowance - L.ink.agent))}`, 'ink_quota')
      }

      const notes: string[] = []
      if (report.removed.length) notes.push(`已移除 ${report.removed.join('、')}`)
      if (report.stripped) notes.push(`剥离语义属性 ×${report.stripped}`)
      if (picked.length > 1) notes.push(`帧 ×${picked.length}`)

      const wantsCommit = a?.mode === 'commit' && rules.agentLevel !== 'assist'
      const taskText = pendingTask?.text
      pendingTask = null
      ctx.markUsed([...usedIds])
      ctx.log('canvas_draw', `${previewOps.length} 个元素 · ${wantsCommit ? 'commit' : 'preview'}${taskText ? ` · 任务「${taskText}」` : ''}`)

      const pen = ctx.getPen(myKey)
      const first = previewOps[0]
      if (pen && first) {
        const p0 = elStart(first.el, first.tf)
        pen.target = { ...p0 }
        pen.visible = true
        pen.label = `我的 ${ctx.state().seats.find((s) => s.id === meId)?.agent?.name ?? 'Agent'}`
      }
      ctx.think(myKey, null)

      if (!wantsCommit) {
        const previewId = uid('pv')
        ctx.patchAgent(meId, 'review')
        ctx.setGhost({ ops: previewOps, label: taskText ?? 'Agent 稿件', ink: inkNeed, notes, previewId })
        emit('preview', { result: 'set', previewId, ink: inkNeed })
        return ok({ previewId, ink: inkNeed, removed: report.removed, stripped: report.stripped, note: '等玩家盖章（Tab）或揉掉（Esc），用 events_poll 等结果' })
      }

      ctx.patchAgent(meId, 'drawing')
      ctx.log('canvas_commit', `墨量 ${inkNeed}`, 'ok')
      ctx.commitOps(animateOps(previewOps, rules.penSpeed))
      emit('commit', { ink: inkNeed })
      return ok({ opIds: previewOps.map((o) => o.id), ink: inkNeed, removed: report.removed, stripped: report.stripped })
    },

    canvas_commit: (a) => {
      const L = ctx.state()
      if (rules.agentLevel === 'assist') return err('助手档：草稿只能由玩家盖章确认', 'host_confirm')
      const g = L.ghost
      if (!g || (a?.previewId && g.previewId !== a.previewId)) return err('没有匹配的待审草稿', 'no_preview')
      ctx.acceptGhost()
      return ok({ opIds: g.ops.map((o) => o.id), ink: g.ink })
    },

    chat_send: (a) => {
      const text = String(a?.text ?? '').trim().slice(0, 140)
      if (!text) return err('空消息')
      ctx.say({ seat: meId, author: 'agent', text })
      ctx.log('chat_send', text.slice(0, 40))
      return ok({ sent: true })
    },

    guess_submit: (a) => {
      if (!readOnly) return err('只有猜词方的 Agent 能提交猜测')
      if (rules.guesserAgent === 'off') return err('本房间未开启猜词方 Agent')
      const L = ctx.state()
      if (L.guessed || L.roundOver) return err('你已经猜中 / 本轮已结束')
      const text = String(a?.text ?? '').trim()
      if (!text) return err('空猜测')
      const r = judgeGuess(text, L.roundTarget)
      ctx.log('guess_submit', `「${text}」→ ${r}`, r === 'correct' ? 'ok' : r === 'close' ? 'warn' : 'muted')
      if (r === 'correct') {
        const pts = Math.max(50, Math.round((Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))) / 2))
        ctx.score(meId, pts)
        ctx.score(ctx.drawerSeat(), 40)
        ctx.say({ seat: meId, author: 'system', text: `${ctx.state().seats.find((s) => s.id === meId)?.agent?.name ?? 'Agent'} 帮你猜中了！+${pts}（Agent 提示 ×0.5）`, kind: 'correct' })
        ctx.markGuessed(meId)
        return ok({ result: 'correct', pts })
      }
      if (r === 'close') ctx.say({ seat: meId, author: 'system', text: `Agent 猜「${text}」很接近了`, kind: 'close' })
      else ctx.say({ seat: meId, author: 'agent', text: `我猜猜……${text}` })
      return ok({ result: r })
    },

    hint_whisper: () => {
      if (!readOnly) return err('只有猜词方能收到悄悄提示')
      if (rules.guesserAgent !== 'whisper') return err('本房间未开启悄悄提示')
      const r = ctx.state().round
      if (whisperRound === r) return err('本轮已提示过')
      whisperRound = r
      ctx.say({ seat: meId, author: 'agent', text: '（悄悄提示已送达）' })
      ctx.log('hint_whisper', '悄悄提示已送达 · 猜中得分 ×0.5', 'ok')
      emit('whisper', {})
      return ok({ text: whisperFor(ctx.state().roundTarget) })
    },

    events_poll: (a) => {
      const since = Number(a?.since) || 0
      return ok({ events: events.filter((e) => e.seq > since), seq })
    },

    room_state: () => {
      const L = ctx.state()
      ctx.log('room_state', `${mode} · ${ctx.state().seats.filter((s) => s.online).length} 人在线`)
      return ok({
        room: ROOM_CODE,
        mode,
        role,
        seats: L.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, ready: s.ready, online: s.online, agent: s.agent ? { name: s.agent.name, model: s.agent.model, status: s.agent.status } : null })),
        rules: { agentLevel: rules.agentLevel, guesserAgent: rules.guesserAgent, inkRatio: rules.inkRatio, penSpeed: rules.penSpeed, roundTime: rules.roundTime, svgPreset: rules.svgPreset, targetFit: rules.targetFit, targetsPublic: rules.targetsPublic, maxMarks: MAX_MARKS },
        me: { seat: meId, color: seatColor(), ink: { human: Math.round(L.ink.human), agent: Math.round(L.ink.agent), allowance: Math.round(L.ink.allowance) } },
        ghost: L.ghost ? { previewId: L.ghost.previewId, ink: L.ghost.ink } : null,
        word: mode === 'guess' && role === 'drawer' ? L.word?.word ?? null : undefined,
      })
    },
  }

  // 猜词方：悄悄提示每轮一条（live 路径沿用 whisper ×0.5 的计分语义）
  let whisperRound = 0

  const client = new McpClient({
    url: WS_URL,
    join: () => ({ room: ROOM_CODE, seat: meId, me: { name: ctx.state().seats.find((s) => s.id === meId)?.name } }),
    onPeer,
    onCall: async (name, args) => {
      const h = handlers[name]
      if (!h) return err(`未知工具：${name}`, 'unknown_tool')
      try {
        return await h(args)
      } catch (e) {
        ctx.log(name, `处理器异常：${String(e)}`, 'warn')
        return err(String(e), 'handler_error')
      }
    },
  })

  return {
    client,
    pushTask: (text) => {
      pendingTask = { id: uid('task'), text }
      emit('task', { id: pendingTask.id, text })
      ctx.log('task_push', `已派发 · 指令「${text}」`, 'muted')
      // 45s 没等到 Agent 落笔就把状态灯拨回，防止卡死
      ctx.later(45000, () => {
        if (pendingTask) ctx.patchAgent(meId, 'idle')
      })
    },
    previewResult: (result, previewId) => emit('preview', { result, previewId }),
    notifyOps: (ops) =>
      emit(
        'ops',
        ops.map((o) => ({ id: o.id, seat: o.seat, author: o.author, tag: o.el.tag, ink: o.ink, box: opBounds(o) })),
      ),
    notifyOpsRemoved: (ids) => emit('ops_removed', { ids }),
    dispose: () => client.dispose(),
  }
}
