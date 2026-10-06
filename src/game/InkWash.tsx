import { useEffect, useRef } from 'react'
import type { Op } from '../core/types'
import type { Camera } from './gameTypes'
import { brushOutline, hashSeed, sampleCenterline } from '../brush/stroke'
import { stageScale } from '../ui/stage'

type Brush = typeof import('p5.brush/standalone')

interface Props {
  ops: Op[]
  cam: Camera
  hiddenSeats: Set<number>
}

interface WashState {
  brush: Brush | null
  canvas: HTMLCanvasElement | null
  drawn: Set<string>
  pending: Map<string, number>
  deadlines: Map<string, number>
  camKey: string
  followKey: string
  /** 上次烘焙时的相机（平移缩放期间画布用 CSS 变换假跟随，停稳再重染） */
  bakedCam: Camera | null
  camDebounce: number
  flush: boolean
  renderFrame: number
  active: boolean
  width: number
  height: number
  sync: (() => void) | null
  rebuild: (() => void) | null
  drawOp: ((op: Op) => void) | null
}

/* ============================================================
   水墨洇散底衬层：SVG 底下铺 canvas，每笔落定后用
   p5.brush(standalone, MIT) 把笔迹轮廓以水彩洇散方式染开。
   - 确定性：每笔前 seed(hash(op.id))，洇散形状由数据决定
   - 装饰层：轮廓/内容以 SVG 层为准，洇散只做"纸吸墨"的氛围
   - 增量：运笔中的笔迹等动画结束后再染
   ============================================================ */

export function InkWash({ ops, cam, hiddenSeats }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const st = useRef<WashState>({ brush: null, canvas: null, drawn: new Set(), pending: new Map(), deadlines: new Map(), camKey: '', followKey: '', bakedCam: null, camDebounce: 0, flush: false, renderFrame: 0, active: false, width: 0, height: 0, sync: null, rebuild: null, drawOp: null })
  const latest = useRef({ ops, cam, hiddenSeats })
  latest.current = { ops, cam, hiddenSeats }

  const render = () => {
    const s = st.current
    if (!s.active || s.renderFrame) return
    s.renderFrame = requestAnimationFrame(() => {
      s.renderFrame = 0
      if (s.active) s.brush?.render()
    })
  }

  const drawOp = (op: Op) => {
    const s = st.current
    const brush = s.brush
    if (!brush || !s.active || s.drawn.has(op.id)) return
    // 画进烘焙坐标系（cam 假跟随期间 bakedCam 才是纹理空间）
    const cam = s.bakedCam ?? latest.current.cam
    // 先登记 flush，再调用 p5（它会登记下一帧未 render 的提醒）。
    render()
    brush.seed(hashSeed(op.id))
    brush.noiseSeed(hashSeed(op.id) ^ 0x9e37)
    brush.push()
    // standalone 与 p5 WEBGL 一样以画布中心为原点；先抵消中心，
    // 再应用与 SVG/InkBake 相同的 screen = (world - cam) * zoom。
    brush.translate(-s.width / 2 - cam.x * cam.z, -s.height / 2 - cam.y * cam.z)
    brush.scale(cam.z)
    brush.push()
    brush.translate(op.tf.x, op.tf.y)
    brush.scale(op.tf.s)
    const out = brushOutline(op.el, op.id)
    const fillOnly = !out && op.el.attrs.fill != null && op.el.attrs.fill !== 'none' && op.el.attrs.fill !== 'transparent'
    try {
      if (out) {
        brush.noStroke()
        brush.fill(String(op.el.attrs.stroke), op.author === 'agent' ? 84 : 68)
        brush.fillBleed(0.42)
        brush.fillTexture(0.45, 0.5)
        brush.polygon(out.pts)
      } else if (fillOnly) {
        const { pts } = sampleCenterline(op.el)
        brush.noStroke()
        brush.fill(String(op.el.attrs.fill), 44)
        brush.fillBleed(0.32)
        brush.fillTexture(0.4, 0.45)
        brush.polygon(pts.map((p) => [p.x, p.y]))
      }
    } finally {
      brush.pop()
      brush.pop()
      s.drawn.add(op.id)
    }
  }

  const cancelPending = () => {
    const s = st.current
    for (const timer of s.pending.values()) clearTimeout(timer)
    s.pending.clear()
  }

  const visibleOps = () => {
    const s = st.current
    const { ops, hiddenSeats } = latest.current
    const present = new Set(ops.map((op) => op.id))
    for (const id of s.deadlines.keys()) if (!present.has(id)) s.deadlines.delete(id)
    const now = performance.now()
    for (const op of ops) {
      if (!op.anim) {
        s.deadlines.delete(op.id)
        const pending = s.pending.get(op.id)
        if (pending != null) { clearTimeout(pending); s.pending.delete(op.id) }
      }
      if (op.anim && !s.deadlines.has(op.id)) s.deadlines.set(op.id, now + op.anim.delay + op.anim.dur + 90)
    }
    const visible = ops.filter((op) => !hiddenSeats.has(op.seat))
    const ids = new Set(visible.map((op) => op.id))
    for (const [id, timer] of s.pending) {
      if (!ids.has(id)) {
        clearTimeout(timer)
        s.pending.delete(id)
      }
    }
    return visible
  }

  const enqueue = (op: Op) => {
    const s = st.current
    if (s.drawn.has(op.id) || s.pending.has(op.id)) return
    const remaining = (s.deadlines.get(op.id) ?? 0) - performance.now()
    if (remaining <= 0) drawOp(op)
    else s.pending.set(op.id, window.setTimeout(() => {
      s.pending.delete(op.id)
      const current = latest.current.ops.find((o) => o.id === op.id)
      if (current && !latest.current.hiddenSeats.has(current.seat)) drawOp(current)
    }, remaining))
  }

  /** 全量重建：clear + 按顺序染所有已落定笔迹，运笔中的排队 */
  const rebuild = () => {
    const s = st.current
    const brush = s.brush
    if (!brush || !s.canvas) return
    const { cam } = latest.current
    cancelPending()
    clearTimeout(s.camDebounce)
    s.camDebounce = 0
    s.drawn.clear()
    // 先落定烘焙坐标系，drawOp 全部画进新纹理空间
    s.camKey = s.followKey = `${cam.x}|${cam.y}|${cam.z}`
    s.bakedCam = { ...cam }
    if (s.canvas) s.canvas.style.transform = ''
    brush.clear()
    for (const op of visibleOps()) enqueue(op)
    s.flush = false
    render()
  }

  // 相机移动：先用 CSS transform 假跟随，停稳 240ms 后再全量重染
  const followCam = (cam: Camera) => {
    const s = st.current
    const b = s.bakedCam
    s.followKey = `${cam.x}|${cam.y}|${cam.z}`
    if (s.canvas && b) {
      const zr = cam.z / b.z
      s.canvas.style.transformOrigin = '0 0'
      s.canvas.style.transform = `translate(${(b.x - cam.x) * cam.z}px, ${(b.y - cam.y) * cam.z}px) scale(${zr})`
    }
    clearTimeout(s.camDebounce)
    s.camDebounce = s.followKey === s.camKey ? 0 : window.setTimeout(() => rebuild(), 240)
  }

  // 增量同步：相机移动 → 假跟随+防抖重染；增删/隐藏 → rebuild；否则补画新 op
  const sync = () => {
    const s = st.current
    // 动态引擎还未加载时也记首次出现时刻，避免加载完成后重播等待。
    const visible = visibleOps()
    const brush = s.brush
    if (!brush || !s.canvas) return
    const { cam } = latest.current
    const key = `${cam.x}|${cam.y}|${cam.z}`
    const ids = new Set(visible.map((o) => o.id))
    if (!s.camKey) {
      rebuild()
      return
    }
    if (s.flush || [...s.drawn].some((id) => !ids.has(id)) || visible.length < s.drawn.size) {
      rebuild()
      return
    }
    if (key !== s.followKey) followCam(cam)
    for (const op of visible) enqueue(op)
  }
  st.current.sync = sync
  st.current.rebuild = rebuild
  st.current.drawOp = drawOp

  // 引擎初始化（动态 import，避免拖慢首屏）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let dead = false
    const s = st.current
    s.active = true
    const makeCanvas = () => {
      cancelPending()
      cancelAnimationFrame(s.renderFrame)
      s.renderFrame = 0
      s.canvas?.remove()
      s.width = Math.max(1, host.clientWidth)
      s.height = Math.max(1, host.clientHeight)
      s.canvas = s.brush!.createCanvas(s.width, s.height, {
        parent: host,
        pixelDensity: Math.min(2, window.devicePixelRatio || 1) * stageScale(),
      })
      s.canvas.className = 'inkwash-canvas'
      s.drawn.clear()
      s.flush = true
    }
    ;(async () => {
      const brush = (await import('p5.brush/standalone')) as Brush
      if (dead) return
      s.brush = brush
      makeCanvas()
      s.sync?.()
    })()
    const ro = new ResizeObserver(() => {
      if (!s.brush) return
      makeCanvas()
      s.rebuild?.()
    })
    ro.observe(host)
    return () => {
      dead = true
      ro.disconnect()
      s.active = false
      cancelPending()
      s.deadlines.clear()
      clearTimeout(s.camDebounce)
      cancelAnimationFrame(s.renderFrame)
      s.renderFrame = 0
      s.canvas?.remove()
      s.brush = null
      s.canvas = null
      s.sync = null
      s.rebuild = null
      s.drawOp = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    st.current.sync?.()
  }, [ops, cam, hiddenSeats])

  return <div ref={hostRef} className="inkwash" aria-hidden />
}
