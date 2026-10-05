import type { Transform } from './types'

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 固定设计画幅：所有屏幕按 1920×1080 设计，整体等比缩放（游戏式 letterbox） */
export const STAGE = { w: 1920, h: 1080 }

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
export const r1 = (n: number) => Math.round(n * 10) / 10

/** 采样点 → 平滑的二次贝塞尔路径（中点法） */
export function pointsToPath(pts: Pt[]): string {
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (pts.length < 3) return `M${r1(first.x)} ${r1(first.y)} L${r1(last.x)} ${r1(last.y)}`
  let d = `M${r1(first.x)} ${r1(first.y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    d += ` Q${r1(a.x)} ${r1(a.y)} ${r1((a.x + b.x) / 2)} ${r1((a.y + b.y) / 2)}`
  }
  return `${d} L${r1(last.x)} ${r1(last.y)}`
}

export function wavePath(x0: number, x1: number, y: number, amp: number, period: number): string {
  const pts: Pt[] = []
  for (let x = x0; x <= x1; x += period / 8) pts.push({ x, y: y + Math.sin((x / period) * Math.PI * 2) * amp })
  return pointsToPath(pts)
}

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export const tfStr = (t: Transform) => `translate(${t.x} ${t.y}) scale(${t.s})`

/** 把 box×box 的素材等比放进区域中央 */
export function fitBox(r: Rect, box = 200): Transform {
  const s = (Math.min(r.w, r.h) / box) * 0.9
  return { x: r.x + (r.w - box * s) / 2, y: r.y + (r.h - box * s) / 2, s }
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
