import type { AuthorKind, Op, SvgEl, Transform } from '../core/types'
import { clamp, type Pt } from '../core/geometry'
import { measureLength } from '../core/svgPolicy'
import type { Pen, Segment } from './gameTypes'

let seq = 0
export const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export interface Batch {
  ops: Op[]
  timeline: Segment[]
  ink: number
  duration: number
}

export interface BatchOptions {
  seat: number
  author: AuthorKind
  tf: Transform
  /** 笔速 px/s（世界坐标）；不传则静态落入 */
  speed?: number
  label?: string
}

const GAP = 90
const hasStroke = (el: SvgEl) => {
  const s = el.attrs.stroke
  return s != null && s !== 'none' && s !== ''
}

export function buildBatch(els: SvgEl[], o: BatchOptions): Batch {
  const ops: Op[] = []
  const timeline: Segment[] = []
  let t = 0
  let ink = 0
  for (const el of els) {
    const len = measureLength(el)
    const opInk = Math.round(len * o.tf.s)
    ink += opInk
    const op: Op = { id: uid('op'), seat: o.seat, author: o.author, el, tf: o.tf, ink: opInk }
    if (o.label) op.label = o.label
    if (o.speed) {
      const dur = hasStroke(el) ? Math.round(clamp(((len * o.tf.s) / o.speed) * 1000, 160, 2600)) : 280
      op.anim = { delay: t, dur }
      timeline.push({ id: op.id, delay: t, dur })
      t += dur + GAP
    }
    ops.push(op)
  }
  return { ops, timeline, ink, duration: o.speed && ops.length ? t - GAP : 0 }
}

/** 合并多个批次：时间线顺延拼接（多目标/路径槽位的素材共用一次运笔过程） */
export function mergeBatches(list: Batch[]): Batch {
  const ops: Op[] = []
  const timeline: Segment[] = []
  let offset = 0
  let ink = 0
  for (const b of list) {
    b.ops.forEach((op, i) => {
      const seg = b.timeline[i]
      if (seg) {
        const s2 = { ...seg, delay: seg.delay + offset }
        timeline.push(s2)
        ops.push({ ...op, anim: { delay: s2.delay, dur: s2.dur } })
      } else ops.push(op)
    })
    ink += b.ink
    offset += b.duration + GAP
  }
  return { ops, timeline, ink, duration: ops.length ? offset - GAP : 0 }
}

/** 给一批已带各自 tf 的 op 补运笔时间线（幽灵预览被接受后直接落成动画） */
export function animateOps(ops: Op[], speed: number): Batch {
  const timeline: Segment[] = []
  let t = 0
  let ink = 0
  const out = ops.map((op) => {
    ink += op.ink
    const dur = hasStroke(op.el) ? Math.round(clamp((op.ink / speed) * 1000, 160, 2600)) : 280
    const seg = { id: op.id, delay: t, dur }
    timeline.push(seg)
    t += dur + GAP
    return { ...op, anim: { delay: seg.delay, dur } }
  })
  return { ops: out, timeline, ink, duration: out.length ? t - GAP : 0 }
}

const nums = (s: string) => (s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number)

/** 元素在世界坐标下的起笔点 */
export function elStart(el: SvgEl, tf: Transform): Pt {
  const a = el.attrs
  const n = (k: string) => Number(a[k] ?? 0)
  let p: Pt = { x: 0, y: 0 }
  switch (el.tag) {
    case 'path': {
      const [x = 0, y = 0] = nums(String(a.d ?? ''))
      p = { x, y }
      break
    }
    case 'polyline':
    case 'polygon': {
      const [x = 0, y = 0] = nums(String(a.points ?? ''))
      p = { x, y }
      break
    }
    case 'line': p = { x: n('x1'), y: n('y1') }; break
    case 'rect': p = { x: n('x'), y: n('y') }; break
    case 'circle': p = { x: n('cx'), y: n('cy') - n('r') }; break
    case 'ellipse': p = { x: n('cx'), y: n('cy') - n('ry') }; break
  }
  return { x: tf.x + p.x * tf.s, y: tf.y + p.y * tf.s }
}

export type PenInit = Partial<Pen> & Pick<Pen, 'key' | 'seat' | 'author' | 'label' | 'color' | 'home'>

export function makePen(p: PenInit): Pen {
  return {
    range: 300,
    wander: false,
    visible: false,
    ...p,
    pos: p.pos ?? { ...p.home },
    target: p.target ?? { ...p.home },
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
export function nowTime(): string {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
