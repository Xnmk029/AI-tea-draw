import { useEffect, useRef } from 'react'
import type { Op } from '../core/types'
import type { Camera } from './gameTypes'
import { brushOutline, elToPath2D } from '../brush/stroke'
import { stageScale } from '../ui/stage'

interface Props {
  ops: Op[]
  cam: Camera
  hiddenSeats: Set<number>
  /** 已烘焙 op id 集合变化时上报（父组件据此把对应 op 收成 hitOnly） */
  onBaked: (ids: Set<string>) => void
}

interface BakeState {
  /** 人/Agent 两块位图，分开是为了高亮模式各自的 CSS 滤镜 */
  canvases: Record<'human' | 'agent', HTMLCanvasElement | null>
  ctxs: Record<'human' | 'agent', CanvasRenderingContext2D | null>
  drawn: Set<string>
  timers: number[]
  camKey: string
  bakedCam: Camera | null
  camDebounce: number
  flush: boolean
  lastReported: Set<string>
  sync: (() => void) | null
  rebuild: (() => void) | null
}

/* ============================================================
   落定笔迹烘焙层：动画播完的 op 画进 Canvas2D 位图，
   SVG 只留透明命中线 → DOM 规模不再随对局时长膨胀、
   免去每帧的 SVG 滤镜/路径重排。相机移动时 CSS 假跟随、
   防抖后重烘焙恢复清晰。
   ============================================================ */

const num = (v: unknown) => Number(v ?? 0)

export function InkBake({ ops, cam, hiddenSeats, onBaked }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const st = useRef<BakeState>({
    canvases: { human: null, agent: null },
    ctxs: { human: null, agent: null },
    drawn: new Set(), timers: [], camKey: '', bakedCam: null, camDebounce: 0, flush: false,
    lastReported: new Set(), sync: null, rebuild: null,
  })
  const latest = useRef({ ops, cam, hiddenSeats, onBaked })
  latest.current = { ops, cam, hiddenSeats, onBaked }

  const density = () => Math.min(2, window.devicePixelRatio || 1) * stageScale()

  /** 单 op 画进对应作者的 ctx（烘焙坐标系 = bakedCam 的世界→屏映射） */
  const drawOp = (ctx: CanvasRenderingContext2D, op: Op) => {
    const cam = st.current.bakedCam ?? latest.current.cam
    const el = op.el
    const a = el.attrs
    ctx.save()
    ctx.translate(-cam.x * cam.z, -cam.y * cam.z)
    ctx.scale(cam.z, cam.z)
    ctx.translate(op.tf.x, op.tf.y)
    ctx.scale(op.tf.s, op.tf.s)
    const out = brushOutline(el, op.id)
    const hasFill = a.fill != null && a.fill !== 'none' && a.fill !== 'transparent'
    const opacity = a.opacity != null ? num(a.opacity) : 1
    try {
      if (hasFill) {
        ctx.fillStyle = String(a.fill)
        ctx.globalAlpha = num(a.fillOpacity ?? a['fill-opacity'] ?? 1) * opacity
        ctx.fill(elToPath2D(el))
      }
      if (out) {
        ctx.fillStyle = String(a.stroke)
        ctx.globalAlpha = num(a.strokeOpacity ?? a['stroke-opacity'] ?? 1) * opacity
        const p = new Path2D()
        const pts = out.pts
        p.moveTo(pts[0][0], pts[0][1])
        for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1])
        p.closePath()
        ctx.fill(p)
      } else if (!hasFill) {
        // 非笔墨化描边（虚线指引等）：原样栅格
        const sw = num(a.strokeWidth ?? a['stroke-width'])
        const dash = a.strokeDasharray ?? a['stroke-dasharray']
        ctx.strokeStyle = String(a.stroke)
        ctx.lineWidth = sw || 4
        ctx.globalAlpha = num(a.strokeOpacity ?? a['stroke-opacity'] ?? 1) * opacity
        if (dash) ctx.setLineDash(String(dash).split(/[\s,]+/).map(Number))
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(elToPath2D(el))
      }
    } finally {
      ctx.restore()
    }
  }

  /** 落定一笔：画进位图 + 上报 baked 集合 */
  const settle = (op: Op) => {
    const s = st.current
    if (s.drawn.has(op.id)) return
    const ctx = s.ctxs[op.author === 'agent' ? 'agent' : 'human']
    if (ctx) drawOp(ctx, op)
    s.drawn.add(op.id)
    report()
  }

  const report = () => {
    const s = st.current
    const cur = new Set(s.drawn)
    if (cur.size === s.lastReported.size && [...cur].every((id) => s.lastReported.has(id))) return
    s.lastReported = cur
    latest.current.onBaked(cur)
  }

  const rebuild = () => {
    const s = st.current
    const { ops, cam, hiddenSeats } = latest.current
    s.timers.forEach(clearTimeout)
    s.timers = []
    s.drawn.clear()
    s.camKey = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z}`
    s.bakedCam = { ...cam }
    for (const k of ['human', 'agent'] as const) {
      const cv = s.canvases[k]
      if (cv) cv.style.transform = ''
      const ctx = s.ctxs[k]
      if (ctx && cv) {
        ctx.setTransform(density(), 0, 0, density(), 0, 0)
        ctx.clearRect(0, 0, cv.width / density(), cv.height / density())
      }
    }
    const visible = ops.filter((o) => !hiddenSeats.has(o.seat))
    for (const op of visible) {
      if (op.anim) s.timers.push(window.setTimeout(() => settle(op), op.anim.delay + op.anim.dur + 90))
      else settle(op)
    }
    s.flush = false
    report()
  }

  const followCam = (cam: Camera) => {
    const s = st.current
    const b = s.bakedCam
    if (b && (b.x !== cam.x || b.y !== cam.y || b.z !== cam.z)) {
      const zr = cam.z / b.z
      for (const k of ['human', 'agent'] as const) {
        const cv = s.canvases[k]
        if (cv) {
          cv.style.transformOrigin = '0 0'
          cv.style.transform = `translate(${(b.x - cam.x) * cam.z}px, ${(b.y - cam.y) * cam.z}px) scale(${zr})`
        }
      }
    }
    clearTimeout(s.camDebounce)
    s.camDebounce = window.setTimeout(() => rebuild(), 240)
  }

  const sync = () => {
    const s = st.current
    const { ops, cam, hiddenSeats } = latest.current
    const key = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z}`
    const visible = ops.filter((o) => !hiddenSeats.has(o.seat))
    const ids = new Set(visible.map((o) => o.id))
    if (!s.camKey) {
      rebuild()
      return
    }
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
      if (op.anim) s.timers.push(window.setTimeout(() => settle(op), op.anim.delay + op.anim.dur + 90))
      else settle(op)
    }
  }
  st.current.sync = sync
  st.current.rebuild = rebuild

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const s = st.current
    const make = () => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      for (const k of ['human', 'agent'] as const) {
        s.canvases[k]?.remove()
        const cv = document.createElement('canvas')
        cv.width = Math.round(w * density())
        cv.height = Math.round(h * density())
        cv.style.width = `${w}px`
        cv.style.height = `${h}px`
        cv.className = `inkbake-canvas inkbake-${k}`
        host.appendChild(cv)
        s.canvases[k] = cv
        s.ctxs[k] = cv.getContext('2d')
      }
      s.drawn.clear()
      s.flush = true
      s.camKey = ''
      s.bakedCam = null
    }
    make()
    s.sync?.()
    const ro = new ResizeObserver(() => {
      make()
      s.rebuild?.()
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      s.timers.forEach(clearTimeout)
      s.canvases.human?.remove()
      s.canvases.agent?.remove()
      s.sync = null
      s.rebuild = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    st.current.sync?.()
  })

  return <div ref={hostRef} className="inkbake" aria-hidden />
}
