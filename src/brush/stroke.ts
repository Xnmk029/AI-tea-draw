import type { SvgEl } from '../core/types'
import type { Pt } from '../core/geometry'
import { getStroke } from 'perfect-freehand'

/* ============================================================
   笔墨渲染管线（T2）
   Op.el 仍是唯一数据；这里只负责把「描边」翻译成变宽笔迹轮廓。
   - Agent / 素材笔迹：重采样中心线 + 由 op.id 驱动的种子压力曲线（各端一致）
   - 人手笔迹：finalize 时把 PointerEvent.pressure 存进 data-pp，渲染时回放
   输出是纯 SVG 填充路径，确定性；不含 Math.random / 时间依赖。
   ============================================================ */

const NS = 'http://www.w3.org/2000/svg'
let sampleRoot: SVGSVGElement | null = null

const num = (v: unknown) => Number(v ?? 0)
const r2 = (n: number) => Math.round(n * 100) / 100

/** 元素是否走笔墨渲染（有可见描边且非虚线标记类） */
export function brushable(el: SvgEl): boolean {
  const a = el.attrs
  const s = a.stroke
  if (s == null || s === 'none' || s === 'transparent' || s === '') return false
  if (a.strokeDasharray || a['stroke-dasharray']) return false
  if (num(a.strokeWidth ?? a['stroke-width']) <= 0) return false
  return true
}

/** 快路径：直接解析 M..Q..L 结构的 path 与 points 属性，免 DOM 几何测量 */
function fastPts(el: SvgEl): { pts: Pt[]; closed: boolean } | null {
  const a = el.attrs
  if (el.tag === 'polyline' || el.tag === 'polygon') {
    const nums = String(a.points ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null
    const pts: Pt[] = []
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] })
    return { pts, closed: el.tag === 'polygon' }
  }
  if (el.tag === 'path') {
    const d = String(a.d ?? '')
    const tokenRe = /[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi
    const toks = d.match(tokenRe)
    if (!toks || toks.length < 3 || d.replace(tokenRe, '').replace(/[\s,]/g, '') || !/^[Mm]$/.test(toks[0])) return null
    const pts: Pt[] = []
    let cur: Pt = { x: 0, y: 0 }
    let closed = false
    let i = 0
    let cmd = ''
    const isCmd = (t: string) => /^[A-Za-z]$/.test(t)
    const next = () => Number(toks[i++])
    const hasNumbers = (n: number) => i + n <= toks.length && toks.slice(i, i + n).every((t) => !isCmd(t) && Number.isFinite(Number(t)))
    while (i < toks.length) {
      if (isCmd(toks[i])) {
        cmd = toks[i++]
        if (!'MLQZmlqz'.includes(cmd)) return null // 其它命令回退 DOM 采样
      }
      if (cmd === 'M' || cmd === 'm') {
        // 多子路径交给 DOM，避免把两段不相连的中心线接成一笔。
        if (pts.length || !hasNumbers(2)) return null
        const x = next(), y = next()
        cur = { x: x + (cmd === 'm' ? cur.x : 0), y: y + (cmd === 'm' ? cur.y : 0) }
        pts.push(cur)
        cmd = cmd === 'M' ? 'L' : 'l'
      } else if (cmd === 'L' || cmd === 'l') {
        if (!hasNumbers(2)) return null
        const x = next(), y = next()
        cur = { x: x + (cmd === 'l' ? cur.x : 0), y: y + (cmd === 'l' ? cur.y : 0) }
        pts.push(cur)
      } else if (cmd === 'Q' || cmd === 'q') {
        if (!hasNumbers(4)) return null
        const dx = cmd === 'q' ? cur.x : 0, dy = cmd === 'q' ? cur.y : 0
        const cx = next() + dx, cy = next() + dy, ex = next() + dx, ey = next() + dy
        // 二次贝塞尔按弧长近似细分（人画曲线平滑且密，8 段足够）
        for (let k = 1; k <= 8; k++) {
          const t = k / 8
          const u = 1 - t
          pts.push({ x: u * u * cur.x + 2 * u * t * cx + t * t * ex, y: u * u * cur.y + 2 * u * t * cy + t * t * ey })
        }
        cur = { x: ex, y: ey }
      } else if (cmd === 'Z' || cmd === 'z') {
        closed = true
        // 关闭后不再允许隐式坐标；尾随数据或其它子路径回退 DOM。
        if (i < toks.length) return null
      } else return null
    }
    return pts.length >= 2 ? { pts, closed } : null
  }
  return null
}

/** 用浏览器几何引擎把元素中心线重采样为点列（与 measureLength 同套路） */
export function sampleCenterline(el: SvgEl): { pts: Pt[]; closed: boolean } {
  const fast = fastPts(el)
  if (fast) return fast
  if (!sampleRoot) {
    sampleRoot = document.createElementNS(NS, 'svg')
    sampleRoot.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none')
    document.body.appendChild(sampleRoot)
  }
  const node = document.createElementNS(NS, el.tag) as SVGGeometryElement
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k === 'data-pp') continue
    node.setAttribute(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(v))
  }
  sampleRoot.appendChild(node)
  const len = typeof node.getTotalLength === 'function' ? node.getTotalLength() : 0
  const n = Math.max(6, Math.min(280, Math.round(len / 1.8)))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const p = node.getPointAtLength((len * i) / n)
    pts.push({ x: p.x, y: p.y })
  }
  node.remove()
  const d = String(el.attrs.d ?? '')
  const closed = el.tag === 'polygon' || el.tag === 'rect' || el.tag === 'circle' || el.tag === 'ellipse' || /[zZ]\s*$/.test(d.trim())
  return { pts, closed }
}

/** 字符串 → 稳定整数种子 */
export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) || 1
}

/** 种子化一维值噪声（同 seed 同 i 恒定） */
const snoise = (seed: number, i: number) => {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** 解析 finalize 写入的人手笔压序列（按弧长分数对齐） */
const parsePP = (el: SvgEl): number[] | null => {
  const raw = el.attrs['data-pp']
  if (raw == null) return null
  const arr = String(raw)
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n))
  return arr.length >= 2 ? arr : null
}

/**
 * 压力曲线 f(t)：起笔重按 → 行笔带轻微抖动的悬腕 → 收笔出锋。
 * closed 环（圈/方/云）末尾不接尾巴，压力首尾衔接避免接缝断口。
 * 人手（有 data-pp）：真实笔压 × 同一包络（鼠标恒 0.5 也有起收笔锋）。
 */
function envAt(t: number, closed: boolean): number {
  const e = Math.min(1, t / 0.07)
  const entry = 0.45 + 0.55 * e * e
  let tail: number
  if (closed) {
    tail = 0.72 + 0.28 * Math.min(1, (1 - t) / 0.1)
  } else {
    const tl = Math.min(1, (1 - t) / 0.14)
    tail = 0.18 + 0.82 * tl * tl
  }
  return entry * tail
}

function pressureAt(t: number, seed: number, closed: boolean, i: number): number {
  const wob = 0.86 + 0.14 * (snoise(seed, Math.floor(t * 23)) * 0.6 + snoise(seed + 7, Math.floor(t * 61)) * 0.4)
  return Math.max(0.05, Math.min(1, envAt(t, closed) * wob))
}

export interface StrokeOut {
  /** 笔迹轮廓闭合路径 d（el 局部坐标） */
  d: string
  /** 轮廓包围盒（用于揭幕 mask 的 userSpaceOnUse 区域） */
  bbox: { x: number; y: number; w: number; h: number }
  /** 轮廓点列（水墨洇散层复用） */
  pts: number[][]
}

const strokeCache = new WeakMap<SvgEl, Map<string | number, StrokeOut | null>>()
const pathCache = new WeakMap<SvgEl, Path2D>()
const outlinePathCache = new WeakMap<StrokeOut, Path2D>()

/**
 * 描边元素 → 笔墨轮廓。
 * @param seed  确定性种子（传 op.id；静态素材传稳定键）
 */
export function brushOutline(el: SvgEl, seed: string | number): StrokeOut | null {
  if (!brushable(el)) return null
  let cache = strokeCache.get(el)
  if (cache?.has(seed)) return cache.get(seed)!
  if (!cache) { cache = new Map(); strokeCache.set(el, cache) }
  const press = parsePP(el)
  const out = build(el, typeof seed === 'number' ? seed : hashSeed(seed), press)
  cache.set(seed, out)
  return out
}

function build(el: SvgEl, seed: number, press: number[] | null): StrokeOut | null {
  const { pts, closed } = sampleCenterline(el)
  if (pts.length < 2) return null
  const size = num(el.attrs.strokeWidth ?? el.attrs['stroke-width']) || 4

  // 环形笔迹在尾部追加一段重叠点，让收笔尖锋叠进起笔——像毛笔绕圈收口
  const src = closed ? [...pts, ...pts.slice(1, Math.max(3, Math.round(pts.length * 0.12)))] : pts
  const n = src.length
  const input = src.map((p, i) => {
    const t = i / (n - 1)
    const pv = press
      ? Math.max(0.05, Math.min(1, lerpPress(press, closed && i >= pts.length ? 0 : t) * envAt(t, closed) * 1.5))
      : pressureAt(closed && i >= pts.length ? (i - pts.length) / pts.length : t, seed, closed, i)
    return [r2(p.x), r2(p.y), Math.round(pv * 100) / 100]
  })

  const outline = getStroke(input, {
    size: size * 1.32,
    thinning: 0.72,
    smoothing: 0.55,
    streamline: 0.42,
    simulatePressure: false,
    last: closed,
  })
  if (outline.length < 3) return null
  // 糙边写进几何：种子噪声抖动轮廓顶点，替代 feTurbulence 滤镜（省掉最重的逐像素滤镜）
  const jAmp = Math.min(size * 0.11, 1.25)
  const rough = outline.map(([x, y], i) => [
    x + (snoise(seed + 31, Math.floor(i * 1.7)) - 0.5) * jAmp * 2,
    y + (snoise(seed + 67, Math.floor(i * 1.7)) - 0.5) * jAmp * 2,
  ])
  const d = `M${r2(rough[0][0])} ${r2(rough[0][1])}` + rough.slice(1).map(([x, y]) => `L${r2(x)} ${r2(y)}`).join('') + 'Z'
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of rough) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { d, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, pts: rough }
}

/** 元素 → Canvas Path2D（InkBake 烘焙层用；虚线/填充形状直接栅格化） */
export function elToPath2D(el: SvgEl): Path2D {
  let cached = pathCache.get(el)
  if (!cached) { cached = buildPath2D(el); pathCache.set(el, cached) }
  return cached
}

export function outlineToPath2D(out: StrokeOut): Path2D {
  let cached = outlinePathCache.get(out)
  if (!cached) {
    cached = new Path2D()
    cached.moveTo(out.pts[0][0], out.pts[0][1])
    for (let i = 1; i < out.pts.length; i++) cached.lineTo(out.pts[i][0], out.pts[i][1])
    cached.closePath()
    outlinePathCache.set(out, cached)
  }
  return cached
}

function buildPath2D(el: SvgEl): Path2D {
  const a = el.attrs
  if (el.tag === 'path') return new Path2D(String(a.d ?? ''))
  const p = new Path2D()
  switch (el.tag) {
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height)
      const rx = num(a.rx)
      if (rx > 0 && 'roundRect' in p) (p as Path2D & { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(x, y, w, h, rx)
      else p.rect(x, y, w, h)
      break
    }
    case 'circle':
      p.arc(num(a.cx), num(a.cy), num(a.r), 0, Math.PI * 2)
      break
    case 'ellipse':
      p.ellipse(num(a.cx), num(a.cy), num(a.rx), num(a.ry), 0, 0, Math.PI * 2)
      break
    case 'line':
      p.moveTo(num(a.x1), num(a.y1))
      p.lineTo(num(a.x2), num(a.y2))
      break
    case 'polyline':
    case 'polygon': {
      const nums = String(a.points ?? '').trim().split(/[\s,]+/).map(Number)
      if (nums.length >= 2) {
        p.moveTo(nums[0], nums[1])
        for (let i = 2; i + 1 < nums.length; i += 2) p.lineTo(nums[i], nums[i + 1])
        if (el.tag === 'polygon') p.closePath()
      }
      break
    }
  }
  return p
}

const lerpPress = (arr: number[], t: number) => {
  const f = t * (arr.length - 1)
  const i = Math.floor(f)
  const g = f - i
  return arr[i] + (arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * g
}
