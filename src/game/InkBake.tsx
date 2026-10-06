import { useEffect, useRef } from 'react'
import type { Op } from '../core/types'
import type { Camera } from './gameTypes'
import { brushOutline, elToPath2D, outlineToPath2D } from '../brush/stroke'
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
  pending: Map<string, number>
  /** 动画第一次出现时的绝对落定时刻，相机/尺寸变化不能重新延迟。 */
  deadlines: Map<string, number>
  camKey: string
  followKey: string
  bakedCam: Camera | null
  camDebounce: number
  flush: boolean
  lastReported: Set<string>
  reportFrame: number
  active: boolean
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
    drawn: new Set(), pending: new Map(), deadlines: new Map(), camKey: '', followKey: '', bakedCam: null, camDebounce: 0, flush: false,
    lastReported: new Set(), reportFrame: 0, active: false, sync: null, rebuild: null,
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
        ctx.fill(outlineToPath2D(out))
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

  /** 同一帧落定多笔只复制/上报一次集合，避免每笔触发父组件重渲染。 */
  const report = () => {
    const s = st.current
    if (!s.active || s.reportFrame) return
    s.reportFrame = requestAnimationFrame(() => {
      s.reportFrame = 0
      if (!s.active || (s.drawn.size === s.lastReported.size && [...s.drawn].every((id) => s.lastReported.has(id)))) return
      const cur = new Set(s.drawn)
      s.lastReported = cur
      latest.current.onBaked(cur)
    })
  }

  /** 落定一笔：画进位图，下一帧合并上报。 */
  const settle = (op: Op) => {
    const s = st.current
    if (s.drawn.has(op.id)) return
    const ctx = s.ctxs[op.author === 'agent' ? 'agent' : 'human']
    if (!ctx || !s.active) return
    drawOp(ctx, op)
    s.drawn.add(op.id)
    report()
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
    if (remaining <= 0) settle(op)
    else s.pending.set(op.id, window.setTimeout(() => {
      s.pending.delete(op.id)
      const current = latest.current.ops.find((o) => o.id === op.id)
      if (current && !latest.current.hiddenSeats.has(current.seat)) settle(current)
    }, remaining))
  }

  const rebuild = () => {
    const s = st.current
    const { cam } = latest.current
    cancelPending()
    clearTimeout(s.camDebounce)
    s.camDebounce = 0
    s.drawn.clear()
    s.camKey = s.followKey = `${cam.x}|${cam.y}|${cam.z}`
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
    for (const op of visibleOps()) enqueue(op)
    s.flush = false
    report()
  }

  const followCam = (cam: Camera) => {
    const s = st.current
    const b = s.bakedCam
    s.followKey = `${cam.x}|${cam.y}|${cam.z}`
    if (b) {
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
    s.camDebounce = s.followKey === s.camKey ? 0 : window.setTimeout(() => rebuild(), 240)
  }

  const sync = () => {
    const s = st.current
    const { cam } = latest.current
    const key = `${cam.x}|${cam.y}|${cam.z}`
    const visible = visibleOps()
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

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const s = st.current
    s.active = true
    const make = () => {
      cancelPending()
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
      s.active = false
      cancelPending()
      s.deadlines.clear()
      clearTimeout(s.camDebounce)
      cancelAnimationFrame(s.reportFrame)
      s.reportFrame = 0
      s.canvases.human?.remove()
      s.canvases.agent?.remove()
      s.canvases = { human: null, agent: null }
      s.ctxs = { human: null, agent: null }
      s.sync = null
      s.rebuild = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    st.current.sync?.()
  }, [ops, cam, hiddenSeats])

  return <div ref={hostRef} className="inkbake" aria-hidden />
}
