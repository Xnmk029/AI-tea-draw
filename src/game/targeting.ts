// 落笔指引：目标几何 / 手势分类 / 空间占用。
// 把玩家的指引标记（令旗、区域、套索、路径、锚定、九宫格）翻译成 Agent 可落笔的矩形区域，
// 并用占用网格避开已有笔迹。纯函数模块，无 React / DOM 依赖。

import { clamp, r1, type Pt, type Rect } from '../core/geometry'
import type { Op, SvgEl, Transform } from '../core/types'

// ---------- 类型 ----------

export type AnchorRelation = 'above' | 'below' | 'left' | 'right' | 'inside' | 'around'

/** 指引标记的目标：玩家用指引笔画出的"希望 Agent 落笔的位置" */
export type DrawTarget =
  | { kind: 'pin'; at: Pt; radius: number }
  | { kind: 'box'; rect: Rect }
  | { kind: 'lasso'; polygon: Pt[]; bbox: Rect }
  | { kind: 'path'; points: Pt[]; width: number }
  | { kind: 'anchor'; opId: string; bbox: Rect; relation: AnchorRelation }
  | { kind: 'grid'; cell: [number, number]; rect: Rect } // cell ∈ 0..2 × 0..2

export interface TargetMark {
  id: string
  /** 谁插的旗 */
  seat: number
  /** 座位色 */
  color: string
  target: DrawTarget
  createdAt: number
  /** Agent 已在此处落过笔 → 标记变淡保留，可重复利用 */
  used?: boolean
}

// ---------- 内部小工具 ----------

/** 构造 r1 精度的 Rect（宽高不为负） */
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x: r1(x), y: r1(y), w: r1(Math.max(0, w)), h: r1(Math.max(0, h)) })

/** 属性值 → 数值，缺失/无效按 0 */
const num = (v: string | number | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const nums = (s: string): number[] => (s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number)

/** 一串数对 (x,y) 的最小包围盒 */
const pairBounds = (v: number[]): Rect => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 1 < v.length; i += 2) {
    const x = v[i]
    const y = v[i + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : rect(x0, y0, x1 - x0, y1 - y0)
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** 折线总长 */
const polyLen = (pts: Pt[]): number => {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
  return len
}

// ---------- 元素 / 笔迹包围盒 ----------

/** 元素局部坐标的包围盒；strokeWidth 计入，向外扩 strokeWidth/2 */
export function elBounds(el: SvgEl): Rect {
  const a = el.attrs
  const n = (k: string) => num(a[k])
  let r: Rect = { x: 0, y: 0, w: 0, h: 0 }
  switch (el.tag) {
    case 'path':
      // 本项目 d 只含 M/L/Q/C，数字成对出现，无需解析命令字母
      r = pairBounds(nums(String(a.d ?? '')))
      break
    case 'polyline':
    case 'polygon':
      r = pairBounds(nums(String(a.points ?? '')))
      break
    case 'line':
      r = pairBounds([n('x1'), n('y1'), n('x2'), n('y2')])
      break
    case 'rect':
      r = rect(n('x'), n('y'), n('width'), n('height'))
      break
    case 'circle':
      r = rect(n('cx') - n('r'), n('cy') - n('r'), n('r') * 2, n('r') * 2)
      break
    case 'ellipse':
      r = rect(n('cx') - n('rx'), n('cy') - n('ry'), n('rx') * 2, n('ry') * 2)
      break
  }
  const pad = Math.abs(n('strokeWidth')) / 2
  return pad ? rect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2) : r
}

/** 一笔 Op 在世界坐标下的包围盒（应用 tf） */
export function opBounds(op: Op): Rect {
  const b = elBounds(op.el)
  return rect(op.tf.x + b.x * op.tf.s, op.tf.y + b.y * op.tf.s, b.w * op.tf.s, b.h * op.tf.s)
}

/** 一组 Op 的并集包围盒；空数组返回零矩形 */
export function opsBounds(ops: Op[]): Rect {
  return unionRects(ops.map(opBounds))
}

// ---------- 目标几何 ----------

/** 目标建议的落笔区域（世界坐标） */
export function targetRect(t: DrawTarget): Rect {
  switch (t.kind) {
    case 'pin':
      return rect(t.at.x - t.radius, t.at.y - t.radius, t.radius * 2, t.radius * 2)
    case 'box':
      return rect(t.rect.x, t.rect.y, t.rect.w, t.rect.h)
    case 'lasso':
      return rect(t.bbox.x, t.bbox.y, t.bbox.w, t.bbox.h)
    case 'path': {
      const b = strokeBBox(t.points)
      const pad = t.width / 2
      return rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
    }
    case 'anchor': {
      // anchor 不自带 size：取锚点短边放大一档，夹在 140~360，与素材落笔尺度一致
      const size = clamp(Math.min(t.bbox.w, t.bbox.h) * 1.1, 140, 360)
      return anchorRect(t.bbox, t.relation, size)
    }
    case 'grid':
      return rect(t.rect.x, t.rect.y, t.rect.w, t.rect.h)
  }
}

/** 目标区域中心（世界坐标） */
export function targetCenter(t: DrawTarget): Pt {
  const r = targetRect(t)
  return { x: r1(r.x + r.w / 2), y: r1(r.y + r.h / 2) }
}

/** 目标类型的短标签，用于 UI 显示 */
export function targetKey(t: DrawTarget): string {
  return t.kind
}

// ---------- 手势分类（指引笔的自动判定） ----------

export type GuideGesture = 'pin' | 'box' | 'lasso' | 'path'

/** 指引笔迹的包围盒 */
export function strokeBBox(pts: Pt[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : rect(x0, y0, x1 - x0, y1 - y0)
}

/**
 * 把一条指引笔迹分类成目标手势：
 * - 过短 / 过小 → pin（点一下插旗）
 * - 首尾闭合且足够长 → lasso（圈一块地）
 * - 接近直线的斜拖、且长宽比不太扁 → box（拖个框）
 * - 其余 → path（画一条线，沿线摆；扁长的波浪线也归这里）
 */
export function classifyStroke(pts: Pt[]): GuideGesture {
  if (pts.length < 2) return 'pin'
  const b = strokeBBox(pts)
  if (Math.hypot(b.w, b.h) < 24) return 'pin'
  const len = polyLen(pts)
  const ends = dist(pts[0], pts[pts.length - 1])
  if (len > 120 && ends < Math.max(30, len * 0.2)) return 'lasso'
  const aspect = Math.min(b.w, b.h) / Math.max(b.w, b.h, 1)
  if (ends > 0 && len / ends < 1.18 && aspect > 0.3) return 'box'
  return 'path'
}

// ---------- 适配计算 ----------

export type FitMode = 'contain' | 'clip' | 'strict'

/**
 * 把 content 包围盒映射进 area，返回世界变换（世界坐标 = tf.x + 局部坐标 × tf.s）。
 * - contain：等比缩放居中，填充约 92%
 * - clip：等比放大到铺满 area（s = max），允许越界交给上层裁切
 * - strict：同 contain，但 content 放大 1.0 倍仍超出 area，或落位后外缘距边 <4 → null
 */
export function fitContent(content: Rect, area: Rect, fit: FitMode): Transform | null {
  const cw = content.w
  const ch = content.h
  const aw = area.w
  const ah = area.h
  if (cw <= 0 || ch <= 0 || aw <= 0 || ah <= 0) return null
  const sContain = Math.min(aw / cw, ah / ch) * 0.92
  const s = fit === 'clip' ? Math.max(aw / cw, ah / ch) : sContain
  if (fit === 'strict') {
    if (cw > aw || ch > ah) return null
    if ((aw - cw * s) / 2 < 4 || (ah - ch * s) / 2 < 4) return null
  }
  return {
    x: r1(area.x + (aw - cw * s) / 2 - content.x * s),
    y: r1(area.y + (ah - ch * s) / 2 - content.y * s),
    s: r1(s),
  }
}

/**
 * 锚定已有笔迹的落笔区域：size 为期望边长（世界单位）。
 * left/right/above/below 留出 0.35×size 的缝并与 bbox 居中对齐；
 * inside 放中央（size 超过 bbox 时收缩到短边 ×0.7）；around 在 bbox 外圈确定性伪随机取一点。
 */
export function anchorRect(bbox: Rect, relation: AnchorRelation, size: number): Rect {
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  const gap = size * 0.35
  switch (relation) {
    case 'left':
      return rect(bbox.x - gap - size, cy - size / 2, size, size)
    case 'right':
      return rect(bbox.x + bbox.w + gap, cy - size / 2, size, size)
    case 'above':
      return rect(cx - size / 2, bbox.y - gap - size, size, size)
    case 'below':
      return rect(cx - size / 2, bbox.y + bbox.h + gap, size, size)
    case 'inside': {
      const s = Math.min(size, Math.min(bbox.w, bbox.h) * 0.7)
      return rect(cx - s / 2, cy - s / 2, s, s)
    }
    case 'around': {
      const rad = Math.max(bbox.w, bbox.h) * 0.75
      const h = Math.sin((bbox.x + bbox.y) * 12.9898) * 43758.5453
      const ang = (h - Math.floor(h)) * Math.PI * 2
      return rect(cx + Math.cos(ang) * rad - size / 2, cy + Math.sin(ang) * rad - size / 2, size, size)
    }
  }
}

/**
 * 沿路径均匀取 slot×slot 的槽位（供 Host 沿线重复摆放素材）：
 * 折线化累计弧长，按 slot×1.3 间距取 clamp(floor(len/(slot*1.3)), 1, max) 个。
 */
export function pathSlots(points: Pt[], slot: number, max = 6): Rect[] {
  if (points.length < 2) return []
  const cum: number[] = [0]
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]))
  const len = cum[cum.length - 1]
  const count = clamp(Math.floor(len / (slot * 1.3)), 1, max)
  const slots: Rect[] = []
  for (let k = 0; k < count; k++) {
    const d = (len * (k + 0.5)) / count
    let i = 1
    while (i < cum.length - 1 && cum[i] < d) i++
    const t = cum[i] > cum[i - 1] ? (d - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
    const x = points[i - 1].x + (points[i].x - points[i - 1].x) * t
    const y = points[i - 1].y + (points[i].y - points[i - 1].y) * t
    slots.push(rect(x - slot / 2, y - slot / 2, slot, slot))
  }
  return slots
}

/** 把 area 切成 3×3，返回 col,row 格子的 Rect（四周含 8px 内缩间距） */
export function gridRect(area: Rect, col: number, row: number): Rect {
  const cw = area.w / 3
  const ch = area.h / 3
  return rect(area.x + col * cw + 8, area.y + row * ch + 8, cw - 16, ch - 16)
}

// ---------- 矩形 / 多边形工具 ----------

/** 射线法判断点是否在多边形内 */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** r 与 bound 求交；无交集时把 r 平移收进 bound（尺寸超出 bound 时收缩到 bound） */
export function clampRect(r: Rect, bound: Rect): Rect {
  const x0 = Math.max(r.x, bound.x)
  const y0 = Math.max(r.y, bound.y)
  const x1 = Math.min(r.x + r.w, bound.x + bound.w)
  const y1 = Math.min(r.y + r.h, bound.y + bound.h)
  if (x1 > x0 && y1 > y0) return rect(x0, y0, x1 - x0, y1 - y0)
  const w = Math.min(r.w, bound.w)
  const h = Math.min(r.h, bound.h)
  return rect(clamp(r.x, bound.x, bound.x + bound.w - w), clamp(r.y, bound.y, bound.y + bound.h - h), w, h)
}

/** 四边各内缩 inset */
export function shrinkRect(r: Rect, inset: number): Rect {
  return rect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2)
}

/** 矩形并集；空数组返回零矩形 */
export function unionRects(list: Rect[]): Rect {
  if (!list.length) return { x: 0, y: 0, w: 0, h: 0 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of list) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return rect(x0, y0, x1 - x0, y1 - y0)
}

// ---------- 空间占用网格 ----------

export interface Occupancy {
  /** 网格边长（世界坐标） */
  cell: number
  /** ops 总包围盒外扩 400 */
  bound: Rect
  /** "cx,cy" → 覆盖该格的 op 数 */
  cells: Map<string, number>
}

/** Rect 覆盖到的网格 key 列表 */
const cellKeys = (r: Rect, cell: number): string[] => {
  const keys: string[] = []
  const cx0 = Math.floor(r.x / cell)
  const cy0 = Math.floor(r.y / cell)
  const cx1 = Math.floor((r.x + r.w - 1e-6) / cell)
  const cy1 = Math.floor((r.y + r.h - 1e-6) / cell)
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) keys.push(`${cx},${cy}`)
  return keys
}

/** 把每个 op 的世界包围盒外扩 24px 投影到网格，统计每格被几个 op 覆盖 */
export function buildOccupancy(ops: Op[], cell = 80): Occupancy {
  const cells = new Map<string, number>()
  for (const op of ops) {
    const b = opBounds(op)
    const padded = { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 }
    for (const k of cellKeys(padded, cell)) cells.set(k, (cells.get(k) ?? 0) + 1)
  }
  const all = opsBounds(ops)
  return { cell, bound: rect(all.x - 400, all.y - 400, all.w + 800, all.h + 800), cells }
}

/** r 覆盖到的已占用格子数 */
export function occOverlap(occ: Occupancy, r: Rect): number {
  let n = 0
  for (const k of cellKeys(r, occ.cell)) if (occ.cells.get(k)) n++
  return n
}

const DIRS8: Pt[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
]

/** 若 r 与已占用格重叠，向外按半径环（maxR 圈 × 8 方向）偏移，返回重叠最少的位置（相同取最近者） */
export function nudgeFree(occ: Occupancy, r: Rect, maxR = 3): Rect {
  let best = r
  let bestN = occOverlap(occ, r)
  if (!bestN) return r
  for (let ring = 1; ring <= maxR && bestN > 0; ring++) {
    const d = ring * occ.cell
    for (const dir of DIRS8) {
      const c = rect(r.x + dir.x * d, r.y + dir.y * d, r.w, r.h)
      const n = occOverlap(occ, c)
      if (n < bestN) {
        bestN = n
        best = c
      }
    }
  }
  return best
}

/**
 * 在 near 附近随机采样 tries 次（半径按圈递增），返回第一个 occOverlap==0 的 w×h Rect；
 * 找不到则返回重叠最少者；结果 clamp 在 bound 内；w/h 超过 bound 返回 null。
 */
export function findSpace(occ: Occupancy, w: number, h: number, near: Pt, bound: Rect, tries = 40): Rect | null {
  if (w > bound.w || h > bound.h || tries <= 0) return null
  const first = clampRect(rect(near.x - w / 2, near.y - h / 2, w, h), bound)
  if (!occOverlap(occ, first)) return first
  let best = first
  let bestN = occOverlap(occ, first)
  for (let i = 0; i < tries; i++) {
    const ang = Math.random() * Math.PI * 2
    const d = occ.cell * (0.5 + Math.floor(i / 8)) + Math.random() * occ.cell
    const c = clampRect(rect(near.x - w / 2 + Math.cos(ang) * d, near.y - h / 2 + Math.sin(ang) * d, w, h), bound)
    const n = occOverlap(occ, c)
    if (!n) return c
    if (n < bestN) {
      bestN = n
      best = c
    }
  }
  return best
}
