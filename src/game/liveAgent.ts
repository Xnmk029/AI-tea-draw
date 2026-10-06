// 真实 Agent 的工具处理器：把 teadraw 桥转发来的 tools/call 接到对局状态上。
// 与 useGame 的关系类似 simulation.ts——通过 LiveCtx 的稳定回调读写状态。
// 坐标契约（见 server/README.md）：Agent 的 SVG 永远画在帧（frame）的局部坐标 0..w×0..h。

import type { AgentStatus, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, Transform } from '../core/types'
import { STAGE, type Pt, type Rect } from '../core/geometry'
import { POLICY_PRESETS, sanitizeSvg } from '../core/svgPolicy'
import { RELAY_STEP, ROOM_CODE, TEA_THEME, judgeGuess, whisperFor } from '../mock/room'
import { MAX_MARKS, type Camera, type Ghost, type Pen, type WordOption } from './gameTypes'
import { animateOps, buildBatch, elStart, uid, type Batch } from './engine'
import {
  buildOccupancy, elBounds, findSpace, nudgeFree, occOverlap, opBounds, pathSlots, targetRect, unionRects,
  type TargetMark,
} from './targeting'
import { agentPenKey } from './simulation'
import { McpClient, type CallResult, type LivePeer } from './mcpClient'

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
  commitOps: (batch: Batch) => string[] | null
  acceptGhost: () => string[] | null
  getPen: (key: string) => Pen | undefined
  /** 本轮画手座位（猜词视角轮换） */
  drawerSeat: () => number
  /** 本场传话题目（网文标题池抽取或房规指定） */
  relayTitle: string
  online?: () => boolean
  net?: () => boolean
  room?: () => string
  submitGuess?: (text: string) => void
  sendChat?: (text: string) => void
  context?: 'sandbox' | 'game'
  profilePrompt?: () => string
  preservePosition?: () => boolean
  onTaskStatus?: (event: LiveTaskStatus) => void
}

export type LiveTaskStage = 'queued' | 'claimed' | 'preview' | 'drawing' | 'completed' | 'cancelled' | 'failed'
export interface LiveTaskStatus {
  taskId: string
  contextId: string
  text: string
  stage: LiveTaskStage
  at: number
  detail?: string
  previewId?: string
  opIds?: string[]
  ink?: number
}

interface LiveEvent {
  seq: number
  type: string
  data?: unknown
}

interface PendingTask {
  id: string
  text: string
  stage: LiveTaskStage
  profilePrompt: string
  preservePosition: boolean
}

export interface LiveHandle {
  client: McpClient
  /** 玩家吩咐 Agent（askAgent 的真实链路）：把任务挂上，等 Agent 拉取 */
  pushTask: (text: string) => string
  cancelTask: (reason?: string) => void
  completeTask: (taskId?: string) => void
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

export interface AgentRuntime extends LiveHandle {
  contextId: string
  call: (name: string, args: Record<string, unknown>) => Promise<CallResult>
  join: () => Record<string, unknown>
  failTask: (reason: string) => void
}

interface RuntimeOptions {
  contextId: string
  isCurrent?: () => boolean
  emit?: (type: string, data?: unknown) => void
}

export function createAgentRuntime(ctx: LiveCtx, client: McpClient, options: RuntimeOptions): AgentRuntime {
  const { mode, rules } = ctx
  const contextId = options.contextId
  const meId = () => ctx.meId
  const myKey = () => agentPenKey(meId())
  const readOnly = () => mode === 'guess' && ctx.role === 'guesser'
  const seatColor = () => ctx.state().seats.find((s) => s.id === meId())?.color ?? '#888'

  let seq = 0
  const events: LiveEvent[] = []
  const emit = (type: string, data?: unknown) => {
    const ev = { seq: ++seq, type, data }
    events.push(ev)
    if (events.length > 120) events.shift()
    if (options.emit) options.emit(type, data)
    else client.event({ type, data })
  }

  let pendingTask: PendingTask | null = null
  let disposed = false
  let taskTimer: ReturnType<typeof setTimeout> | null = null
  let completionTimer: ReturnType<typeof setTimeout> | null = null
  let previewTaskId: string | null = null
  let ownedPreviewId: string | null = null
  let ownedPreviewBatch: Batch | null = null
  let pendingCommit: { taskId: string; batch: Batch } | null = null
  let frameEpoch = 0
  let activeRound = ctx.state().round
  const current = () => !disposed && (options.isCurrent?.() ?? true)
  const clearTaskTimer = () => { if (taskTimer) clearTimeout(taskTimer); taskTimer = null }
  const clearCompletion = () => { if (completionTimer) clearTimeout(completionTimer); completionTimer = null }
  const taskStatus = (stage: LiveTaskStage, extra: Partial<LiveTaskStatus> = {}) => {
    if (!pendingTask) return
    pendingTask.stage = stage
    const event: LiveTaskStatus = { taskId: pendingTask.id, contextId, text: pendingTask.text, stage, at: Date.now(), ...extra }
    ctx.onTaskStatus?.(event)
    emit('task_status', event)
  }
  const cancelTask = (reason = '任务已取消', stage: 'cancelled' | 'failed' = 'cancelled') => {
    const hadTask = !!pendingTask
    clearTaskTimer()
    clearCompletion()
    frameEpoch++
    spaceCache.clear()
    pendingCommit = null
    if (pendingTask) taskStatus(stage, { detail: reason })
    pendingTask = null
    previewTaskId = null
    if (ownedPreviewId && ctx.state().ghost?.previewId === ownedPreviewId) ctx.setGhost(null)
    ownedPreviewId = null
    ownedPreviewBatch = null
    ctx.think(myKey(), null)
    ctx.patchAgent(meId(), 'idle')
    if (stage === 'failed' && hadTask) { ctx.log('task_failed', reason, 'warn'); ctx.showToast(reason) }
  }
  const completeTask = (taskId?: string) => {
    if (!current() || !pendingTask || (taskId && pendingTask.id !== taskId)) return
    clearTaskTimer()
    clearCompletion()
    pendingCommit = null
    taskStatus('completed')
    frameEpoch++
    spaceCache.clear()
    pendingTask = null
    previewTaskId = null
    ownedPreviewId = null
    ownedPreviewBatch = null
    ctx.patchAgent(meId(), 'idle')
  }
  const awaitDrawing = (batch: Batch, opIds: string[] | null) => {
    if (!pendingTask) return
    const taskId = pendingTask.id
    clearTaskTimer()
    taskStatus('drawing', { opIds: opIds ?? [], ink: batch.ops.reduce((ink, op) => ink + op.ink, 0) })
    if (opIds === null) {
      pendingCommit = { taskId, batch }
      taskTimer = setTimeout(() => { if (current() && pendingTask?.id === taskId) cancelTask('房主未确认落笔，任务已取消', 'failed') }, 45000)
    } else completionTimer = setTimeout(() => completeTask(taskId), batch.duration + 80)
  }
  const spaceCache = new Map<string, { frame: Rect; expires: number }>()
  const framePrefix = () => `${contextId}/${activeRound}/${frameEpoch}/`

  // ---------- 帧：标记 → 供 Agent 引用的矩形 ----------
  const frames = (): { id: string; kind: string; frame: Rect }[] => {
    const out: { id: string; kind: string; frame: Rect }[] = []
    for (const m of ctx.state().marks) {
      const t = m.target
      if (t.kind === 'path') {
        out.push({ id: `${framePrefix()}${m.id}`, kind: 'path', frame: targetRect(t) })
        pathSlots(t.points, PATH_SLOT, 4).forEach((r, i) => out.push({ id: `${framePrefix()}${m.id}/s${i}`, kind: 'slot', frame: r }))
      } else out.push({ id: `${framePrefix()}${m.id}`, kind: t.kind, frame: targetRect(t) })
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
      if (!pendingTask || (pendingTask.stage !== 'queued' && pendingTask.stage !== 'claimed')) return ok({ task: null, contextId })
      if (pendingTask.stage === 'queued') taskStatus('claimed')
      const L = ctx.state()
      return ok({
        task: {
          id: pendingTask.id,
          taskId: pendingTask.id,
          contextId,
          context: ctx.context ?? 'game',
          text: pendingTask.text,
          profilePrompt: pendingTask.profilePrompt,
          mode,
          theme: mode === 'tea' ? rules.theme || TEA_THEME : undefined,
          prompt: mode === 'relay' ? ctx.relayTitle : undefined,
          step: mode === 'relay' ? RELAY_STEP : undefined,
          word: mode === 'guess' && ctx.role === 'drawer' ? L.word?.word : undefined,
          targets: ctx.state().marks.length,
          ink: { used: L.ink.agent, allowance: Math.round(L.ink.allowance), remaining: Math.max(0, Math.round(L.ink.allowance - L.ink.agent)) },
          rules: { penSpeed: rules.penSpeed, inkRatio: rules.inkRatio, targetFit: rules.targetFit, svgPreset: rules.svgPreset, maxMarks: MAX_MARKS, preservePosition: pendingTask.preservePosition, contextId, taskId: pendingTask.id, note: '所有修改工具带 contextId 和 taskId；canvas_draw 可兼容引用本次返回的 targetId/spaceId。preservePosition=true 且内容完全位于指定帧局部范围时保留原留白。风格要求服从房规与 SVG 白名单。' },
        },
      })
    },

    canvas_get_targets: () => {
      const t = frames()
      ctx.log('canvas_get_targets', t.length ? `${t.length} 个帧` : '无标记')
      return ok({
        contextId, taskId: pendingTask?.id,
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
      const id = `${framePrefix()}sp-${uid('x')}`
      spaceCache.set(id, { frame: spot, expires: Date.now() + 60000 })
      ctx.log('canvas_find_space', `${Math.round(spot.w)}×${Math.round(spot.h)} @ (${Math.round(spot.x)}, ${Math.round(spot.y)})`)
      return ok({ contextId, taskId: pendingTask?.id, space: { id, frame: spot } })
    },

    canvas_snapshot: async (a) => {
      const region = regionFor(a?.targetId)
      ctx.log('canvas_snapshot', `png · ${Math.round(region.w)}×${Math.round(region.h)}${readOnly() ? '（仅光栅图，无 SVG 源）' : ''}`, 'muted')
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
      if (readOnly()) return err('猜词者的 Agent 不能落笔')
      if (ctx.online && !ctx.online()) return err('联机会话正在恢复，请稍后重试', 'net_unavailable')
      if (rules.agentLevel === 'off') return err('本房间已关闭 Agent 落笔')
      if (mode === 'guess' && !L.word) return err('本轮画手还未选词')
      if (L.roundOver) return err('本轮已结束')
      if (mode === 'relay' && L.submitted) return err('画作已提交')
      if (L.ghost || ownedPreviewId) return err('还有一张草稿待确认（等玩家盖章或揉掉）', 'preview_pending')

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
        const markId = ref.startsWith(framePrefix()) ? ref.slice(framePrefix().length).split('/')[0] : ref
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
      const keepLocalPosition = !!ref && (pendingTask?.preservePosition ?? ctx.preservePosition?.() ?? false)
      for (const p of picked) {
        let area = p.frame
        if (!keepLocalPosition && !a?.repeat && rules.avoidOthers !== false && occOverlap(occ, area) > 0) {
          const nudged = nudgeFree(occ, area)
          const bound = ctx.frame
          if (!bound || (nudged.x >= bound.x && nudged.y >= bound.y && nudged.x + nudged.w <= bound.x + bound.w && nudged.y + nudged.h <= bound.y + bound.h)) area = nudged
        }
        const cw = Math.max(content.w, 1)
        const ch = Math.max(content.h, 1)
        let s = 1
        if (cw > area.w || ch > area.h) {
          if (fit === 'strict') return err(`内容 ${Math.ceil(cw)}×${Math.ceil(ch)} 超出帧 ${Math.ceil(area.w)}×${Math.ceil(area.h)}（strict 拒绝）`, 'overflow')
          if (fit === 'contain') s = Math.min(area.w / cw, area.h / ch) * 0.92
        }
        const preservePosition = keepLocalPosition
          && content.x >= 0 && content.y >= 0 && content.x + content.w <= area.w && content.y + content.h <= area.h
        placements.push({
          els: report.elements,
          tf: preservePosition ? { x: area.x, y: area.y, s: 1 } : { x: area.x + (area.w - cw * s) / 2 - content.x * s, y: area.y + (area.h - ch * s) / 2 - content.y * s, s },
        })
        p.markIds.forEach((id) => usedIds.add(id))
      }

      const previewOps = placements.flatMap((pl) => buildBatch(pl.els, { seat: meId(), author: 'agent', tf: pl.tf, label: pendingTask?.text.slice(0, 24) }).ops)
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
      ctx.markUsed([...usedIds])
      ctx.log('canvas_draw', `${previewOps.length} 个元素 · ${wantsCommit ? 'commit' : 'preview'}${taskText ? ` · 任务「${taskText}」` : ''}`)

      const pen = ctx.getPen(myKey())
      const first = previewOps[0]
      if (pen && first) {
        const p0 = elStart(first.el, first.tf)
        pen.target = { ...p0 }
        pen.visible = true
        pen.label = `我的 ${ctx.state().seats.find((s) => s.id === meId())?.agent?.name ?? 'Agent'}`
      }
      ctx.think(myKey(), null)

      if (!wantsCommit) {
        const previewId = uid('pv')
        clearTaskTimer()
        previewTaskId = pendingTask?.id ?? null
        ownedPreviewId = previewId
        ownedPreviewBatch = animateOps(previewOps, rules.penSpeed)
        ctx.patchAgent(meId(), 'review')
        ctx.setGhost({ ops: previewOps, label: taskText ?? 'Agent 稿件', ink: inkNeed, notes, previewId })
        emit('preview', { result: 'set', previewId, ink: inkNeed })
        taskStatus('preview', { previewId, ink: inkNeed })
        return ok({ previewId, ink: inkNeed, removed: report.removed, stripped: report.stripped, note: '等玩家盖章（Tab）或揉掉（Esc），用 events_poll 等结果' })
      }

      ctx.patchAgent(meId(), 'drawing')
      ctx.log('canvas_commit', `墨量 ${inkNeed}`, 'ok')
      const batch = animateOps(previewOps, rules.penSpeed)
      const opIds = ctx.commitOps(batch)
      if (opIds?.length === 0) { cancelTask('落笔被房规拒绝', 'failed'); return err('落笔被房规拒绝', 'commit_rejected') }
      awaitDrawing(batch, opIds)
      emit('commit', { ink: inkNeed, opIds, pending: opIds === null })
      return ok({ opIds: opIds ?? [], pending: opIds === null, ink: inkNeed, removed: report.removed, stripped: report.stripped })
    },

    canvas_commit: (a) => {
      const L = ctx.state()
      if (readOnly() || L.roundOver) return err('当前回合不能落笔')
      if (ctx.online && !ctx.online()) return err('联机会话正在恢复，请稍后重试', 'net_unavailable')
      if (rules.agentLevel === 'assist') return err('助手档：草稿只能由玩家盖章确认', 'host_confirm')
      const g = L.ghost
      if (!g || (a?.previewId && g.previewId !== a.previewId)) return err('没有匹配的待审草稿', 'no_preview')
      const opIds = ctx.acceptGhost()
      if (opIds?.length === 0) return err('落笔被房规拒绝', 'commit_rejected')
      return ok({ opIds: opIds ?? [], pending: opIds === null, ink: g.ink })
    },

    chat_send: (a) => {
      const text = String(a?.text ?? '').trim().slice(0, 140)
      if (!text) return err('空消息')
      if (mode === 'guess' && !readOnly() && !ctx.state().roundOver) return err('画手不能在聊天里发言')
      if (ctx.online && !ctx.online()) return err('联机会话正在恢复，请稍后重试', 'net_unavailable')
      if (ctx.net?.() && ctx.sendChat) ctx.sendChat(text)
      else ctx.say({ seat: meId(), author: 'agent', text })
      ctx.log('chat_send', text.slice(0, 40))
      return ok({ sent: true })
    },

    guess_submit: (a) => {
      if (!readOnly()) return err('只有猜词方的 Agent 能提交猜测')
      if (rules.guesserAgent === 'off') return err('本房间未开启猜词方 Agent')
      const L = ctx.state()
      if (L.guessed || L.roundOver) return err('你已经猜中 / 本轮已结束')
      const text = String(a?.text ?? '').trim()
      if (!text) return err('空猜测')
      if (ctx.online && !ctx.online()) return err('联机会话正在恢复，请稍后重试', 'net_unavailable')
      if (ctx.net?.() && ctx.submitGuess) {
        ctx.submitGuess(text)
        return ok({ result: 'pending', note: '由房主判定，结果经 guess-result 同步' })
      }
      const r = judgeGuess(text, L.roundTarget)
      ctx.log('guess_submit', `「${text}」→ ${r}`, r === 'correct' ? 'ok' : r === 'close' ? 'warn' : 'muted')
      if (r === 'correct') {
        const pts = Math.max(50, Math.round((Math.max(100, Math.round(((L.timeLeft ?? 0) / rules.roundTime) * 300))) / 2))
        ctx.score(meId(), pts)
        ctx.score(ctx.drawerSeat(), 40)
        ctx.say({ seat: meId(), author: 'system', text: `${ctx.state().seats.find((s) => s.id === meId())?.agent?.name ?? 'Agent'} 帮你猜中了！+${pts}（Agent 提示 ×0.5）`, kind: 'correct' })
        ctx.markGuessed(meId())
        return ok({ result: 'correct', pts })
      }
      if (r === 'close') ctx.say({ seat: meId(), author: 'system', text: `Agent 猜「${text}」很接近了`, kind: 'close' })
      else ctx.say({ seat: meId(), author: 'agent', text: `我猜猜……${text}` })
      return ok({ result: r })
    },

    hint_whisper: () => {
      if (!readOnly()) return err('只有猜词方能收到悄悄提示')
      if (ctx.net?.()) return err('联机模式不向猜词方提供答案提示')
      if (rules.guesserAgent !== 'whisper') return err('本房间未开启悄悄提示')
      const r = ctx.state().round
      if (whisperRound === r) return err('本轮已提示过')
      whisperRound = r
      ctx.say({ seat: meId(), author: 'agent', text: '（悄悄提示已送达）' })
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
        context: ctx.context ?? 'game',
        contextId,
        room: ctx.room?.() ?? ROOM_CODE,
        mode,
        role: ctx.role,
        seats: L.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, ready: s.ready, online: s.online, agent: s.agent ? { name: s.agent.name, model: s.agent.model, status: s.agent.status } : null })),
        rules: { agentLevel: rules.agentLevel, guesserAgent: rules.guesserAgent, inkRatio: rules.inkRatio, penSpeed: rules.penSpeed, roundTime: rules.roundTime, svgPreset: rules.svgPreset, targetFit: rules.targetFit, targetsPublic: rules.targetsPublic, maxMarks: MAX_MARKS },
        me: { seat: meId(), color: seatColor(), ink: { human: Math.round(L.ink.human), agent: Math.round(L.ink.agent), allowance: Math.round(L.ink.allowance) } },
        ghost: L.ghost ? { previewId: L.ghost.previewId, ink: L.ghost.ink } : null,
        word: mode === 'guess' && ctx.role === 'drawer' ? L.word?.word ?? null : undefined,
      })
    },
  }

  // 猜词方：悄悄提示每轮一条（live 路径沿用 whisper ×0.5 的计分语义）
  let whisperRound = 0
  const call: AgentRuntime['call'] = async (name, args) => {
      if (!current()) return err('作画环境已切换，请重新领取任务', 'stale_context')
      if (activeRound !== ctx.state().round) {
        activeRound = ctx.state().round
        cancelTask('回合已切换')
        spaceCache.clear()
      }
      const mutating = ['canvas_draw', 'canvas_commit', 'chat_send', 'guess_submit', 'hint_whisper'].includes(name)
      if (mutating && ((args.contextId != null && args.contextId !== contextId) || (args.taskId != null && args.taskId !== pendingTask?.id))) return err('任务或作画环境已过期，请重新领取任务', 'stale_context')
      if (name === 'canvas_draw') {
        const ref = args.targetId ?? args.spaceId
        const validTask = args.contextId === contextId && typeof args.taskId === 'string' && args.taskId === pendingTask?.id
        if (!validTask && !(typeof ref === 'string' && ref.startsWith(framePrefix()) && lookupFrame(ref))) return err('落笔缺少当前任务标识或帧，请重新领取任务或申请空位', 'stale_context')
      }
      if (name === 'canvas_commit' && (!ownedPreviewId || args.previewId !== ownedPreviewId)) return err('草稿不属于当前作画环境', 'stale_context')
      const h = handlers[name]
      if (!h) return err(`未知工具：${name}`, 'unknown_tool')
      try {
        const result = await h(args)
        if (!current()) return err('作画环境已切换', 'stale_context')
        if (result.error) {
          ctx.log(name, result.error.message, 'warn')
          if ((name === 'canvas_draw' || name === 'canvas_commit') && pendingTask && (pendingTask.stage === 'queued' || pendingTask.stage === 'claimed')) taskStatus('claimed', { detail: `上次提交被拒绝：${result.error.message}；可修稿重试` })
        }
        return result
      } catch (e) {
        ctx.log(name, `处理器异常：${String(e)}`, 'warn')
        return err(String(e), 'handler_error')
      }
  }

  return {
    client,
    contextId,
    call,
    failTask: (reason) => { if (current()) cancelTask(reason, 'failed') },
    join: () => ({ context: ctx.context ?? 'game', contextId, room: ctx.room?.() ?? ROOM_CODE, seat: meId(), me: { name: ctx.state().seats.find((s) => s.id === meId())?.name } }),
    pushTask: (text) => {
      if (!current()) return ''
      cancelTask('被新任务替换')
      spaceCache.clear()
      pendingTask = { id: uid('task'), text, stage: 'queued', profilePrompt: ctx.profilePrompt?.() ?? '', preservePosition: ctx.preservePosition?.() ?? false }
      const taskId = pendingTask.id
      emit('task', { id: taskId, taskId, contextId, text })
      taskStatus('queued')
      ctx.patchAgent(meId(), 'thinking')
      ctx.log('task_push', `已派发 · 指令「${text}」`, 'muted')
      taskTimer = setTimeout(() => {
        if (current() && pendingTask?.id === taskId && (pendingTask.stage === 'queued' || pendingTask.stage === 'claimed')) cancelTask('Agent 45 秒未返回画作，任务已取消', 'failed')
      }, 45000)
      return taskId
    },
    cancelTask: (reason) => { if (current()) cancelTask(reason) },
    completeTask,
    previewResult: (result, previewId) => {
      if (!current() || !ownedPreviewId || (previewId && previewId !== ownedPreviewId)) return
      emit('preview', { result, previewId: ownedPreviewId })
      if (result === 'rejected') { cancelTask('玩家揉掉草稿'); return }
      if (previewTaskId === pendingTask?.id) {
        clearCompletion()
        const batch = ownedPreviewBatch
        if (batch) awaitDrawing(batch, ctx.net?.() ? null : batch.ops.map((op) => op.id))
      }
      ownedPreviewId = null
      ownedPreviewBatch = null
    },
    notifyOps: (ops) => {
      emit(
        'ops',
        ops.map((o) => ({ id: o.id, seat: o.seat, author: o.author, tag: o.el.tag, ink: o.ink, box: opBounds(o) })),
      )
      if (pendingCommit && pendingTask?.id === pendingCommit.taskId && ops.some((op) => op.seat === meId() && op.author === 'agent')) {
        const { taskId, batch } = pendingCommit
        pendingCommit = null
        clearTaskTimer()
        completionTimer = setTimeout(() => completeTask(taskId), batch.duration + 80)
      }
    },
    notifyOpsRemoved: (ids) => emit('ops_removed', { ids }),
    dispose: () => {
      if (disposed) return
      cancelTask('作画环境已关闭')
      spaceCache.clear()
      disposed = true
    },
  }
}

export function attachLiveAgent(ctx: LiveCtx, onPeer: (p: LivePeer) => void): LiveHandle {
  let runtime: AgentRuntime
  const port = new URLSearchParams(location.search).get('mcp') ?? '5190'
  const client = new McpClient({
    url: `ws://127.0.0.1:${port}`,
    join: () => runtime.join(),
    onPeer,
    onCall: (name, args) => runtime.call(name, args),
    onDown: () => runtime?.failTask('Agent 连接已断开'),
  })
  runtime = createAgentRuntime(ctx, client, { contextId: uid('ctx') })
  return { ...runtime, dispose: () => { runtime.dispose(); client.dispose() } }
}
