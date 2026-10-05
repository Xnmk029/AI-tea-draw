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
  timers: number[]
  camKey: string
  /** 上次烘焙时的相机（平移缩放期间画布用 CSS 变换假跟随，停稳再重染） */
  bakedCam: Camera | null
  camDebounce: number
  flush: boolean
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
  const st = useRef<WashState>({ brush: null, canvas: null, drawn: new Set(), timers: [], camKey: '', bakedCam: null, camDebounce: 0, flush: false, sync: null, rebuild: null, drawOp: null })
  const latest = useRef({ ops, cam, hiddenSeats })
  latest.current = { ops, cam, hiddenSeats }

  const drawOp = (op: Op) => {
    const s = st.current
    const brush = s.brush
    if (!brush || s.drawn.has(op.id)) return
    // 画进烘焙坐标系（cam 假跟随期间 bakedCam 才是纹理空间）
    const cam = s.bakedCam ?? latest.current.cam
    brush.seed(hashSeed(op.id))
    brush.noiseSeed(hashSeed(op.id) ^ 0x9e37)
    brush.push()
    brush.translate(-cam.x, -cam.y)
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
      brush.render()
    }
  }

  /** 全量重建：clear + 按顺序染所有已落定笔迹，运笔中的排队 */
  const rebuild = () => {
    const s = st.current
    const brush = s.brush
    if (!brush || !s.canvas) return
    const { ops, cam, hiddenSeats } = latest.current
    s.timers.forEach(clearTimeout)
    s.timers = []
    s.drawn.clear()
    // 先落定烘焙坐标系，drawOp 全部画进新纹理空间
    s.camKey = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z}`
    s.bakedCam = { ...cam }
    if (s.canvas) s.canvas.style.transform = ''
    brush.clear()
    const visible = ops.filter((o) => !hiddenSeats.has(o.seat))
    for (const op of visible) {
      if (op.anim) s.timers.push(window.setTimeout(() => drawOp(op), op.anim.delay + op.anim.dur + 90))
      else drawOp(op)
    }
    s.flush = false
  }

  // 相机移动：先用 CSS transform 假跟随，停稳 240ms 后再全量重染
  const followCam = (cam: Camera) => {
    const s = st.current
    const b = s.bakedCam
    if (s.canvas && b && (b.x !== cam.x || b.y !== cam.y || b.z !== cam.z)) {
      const zr = cam.z / b.z
      s.canvas.style.transformOrigin = '0 0'
      s.canvas.style.transform = `translate(${(b.x - cam.x) * cam.z}px, ${(b.y - cam.y) * cam.z}px) scale(${zr})`
    }
    clearTimeout(s.camDebounce)
    s.camDebounce = window.setTimeout(() => rebuild(), 240)
  }

  // 增量同步：相机移动 → 假跟随+防抖重染；增删/隐藏 → rebuild；否则补画新 op
  const sync = () => {
    const s = st.current
    const brush = s.brush
    if (!brush || !s.canvas) return
    const { ops, cam, hiddenSeats } = latest.current
    const key = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z}`
    const visible = ops.filter((o) => !hiddenSeats.has(o.seat))
    const ids = new Set(visible.map((o) => o.id))
    if (key !== s.camKey) {
      followCam(cam)
      return
    }
    if (s.flush || [...s.drawn].some((id) => !ids.has(id)) || visible.length < s.drawn.size) {
      rebuild()
      return
    }
    for (const op of visible) {
      if (s.drawn.has(op.id)) continue
      if (op.anim) s.timers.push(window.setTimeout(() => drawOp(op), op.anim.delay + op.anim.dur + 90))
      else drawOp(op)
    }
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
    const makeCanvas = () => {
      s.canvas?.remove()
      s.canvas = s.brush!.createCanvas(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), {
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
      s.timers.forEach(clearTimeout)
      s.canvas?.remove()
      s.brush = null
      s.canvas = null
      s.sync = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    st.current.sync?.()
  })

  return <div ref={hostRef} className="inkwash" aria-hidden />
}
