import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { Check, Move, Pencil, ShieldCheck, Stamp, X } from 'lucide-react'
import type { Op, SvgEl, Transform } from '../core/types'
import { normRect, pointsToPath, r1, tfStr, type Pt } from '../core/geometry'
import type { DrawTarget, GameState, Pen, TargetMark } from './gameTypes'
import { classifyStroke, opsBounds, pathSlots, strokeBBox, targetCenter, type AnchorRelation } from './targeting'
import { renderEl } from '../components/renderEl'
import { AgentGlyph } from '../components/AgentGlyph'
import { AgentTip, HumanTip } from '../components/CursorTips'
import { stageScale } from '../ui/stage'

type Draft =
  | { kind: 'pen'; pts: Pt[] }
  | { kind: 'line' | 'rect' | 'ellipse'; a: Pt; b: Pt }
  | { kind: 'guide'; pts: Pt[]; opId: string | null }
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'ghost'; a: Pt; tfs: Transform[] }
  | { kind: 'gresize'; tfs: Transform[]; c: Pt; d0: number }
  | { kind: 'erase' }

const RELATIONS: { id: AnchorRelation; label: string }[] = [
  { id: 'left', label: '左边' },
  { id: 'right', label: '右边' },
  { id: 'above', label: '上面' },
  { id: 'below', label: '下面' },
  { id: 'inside', label: '里面' },
  { id: 'around', label: '围绕' },
]

const GRID_NAMES = ['左上', '上', '右上', '左', '正中', '右', '左下', '下', '右下']
const GUIDE_HINT: Record<string, string> = {
  auto: '点=令旗 · 拖=区域 · 圈=套索 · 线=引路 · 点笔迹=锚定',
  pin: '单击插令旗',
  box: '拖出区域框',
  lasso: '圈出一片地',
  path: '画一条引路线',
  anchor: '点中一笔已有笔迹',
}

export function Canvas({ g }: { g: GameState }) {
  const { ops, seats, tool, color, width, readOnly, frame, ghost, marks, foreignMarks, pens, penKeys, thinking, highlightAgent, hiddenSeats, cam, setCam, spaceDown } = g
  const svgRef = useRef<SVGSVGElement>(null)
  const camRef = useRef(cam)
  camRef.current = cam
  const cursorEls = useRef(new Map<string, HTMLDivElement>())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hover, setHover] = useState<{ op: Op; x: number; y: number } | null>(null)
  const [wheel, setWheel] = useState<{ op: Op; x: number; y: number } | null>(null)
  const activeTool = spaceDown ? 'hand' : tool

  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const c = camRef.current
    const k = stageScale()
    return { x: c.x + (cx - r.left) / k / c.z, y: c.y + (cy - r.top) / k / c.z }
  }
  /** client 坐标 → 画布局部（舞台）像素 */
  const local = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    const k = stageScale()
    return { x: (cx - r.left) / k, y: (cy - r.top) / k }
  }
  const toScreen = (p: Pt) => ({ x: (p.x - cam.x) * cam.z, y: (p.y - cam.y) * cam.z })

  useEffect(() => {
    const svg = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const k = stageScale()
      const sx = (e.clientX - r.left) / k
      const sy = (e.clientY - r.top) / k
      setCam((c) => {
        const z = Math.min(4, Math.max(0.3, c.z * Math.exp(-e.deltaY * 0.0015)))
        return { x: c.x + sx / c.z - sx / z, y: c.y + sy / c.z - sy / z, z }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [setCam])

  // 把茶宠拖到画布上松手 → 在该处插令旗
  useEffect(() => {
    const h = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail
      const r = svgRef.current?.getBoundingClientRect()
      if (readOnly || !r || x < r.left || x > r.right || y < r.top || y > r.bottom) return
      g.addMark({ kind: 'pin', at: toWorld(x, y), radius: 110 })
    }
    window.addEventListener('tea:drop-pet', h)
    return () => window.removeEventListener('tea:drop-pet', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  // 远端光标：rAF 直接写 DOM，不触发 React 渲染
  useEffect(() => {
    let raf = 0
    const pointOf = (id: string, frac: number, pen: Pen) => {
      const node = svgRef.current?.querySelector(`[data-op="${id}"]`) as SVGGeometryElement | null
      if (!node || typeof node.getTotalLength !== 'function' || !pen.batch) return null
      const p = node.getPointAtLength(node.getTotalLength() * frac)
      const tf = pen.batch.tfs?.get(id) ?? pen.batch.tf
      return { x: tf.x + p.x * tf.s, y: tf.y + p.y * tf.s }
    }
    const tick = (now: number) => {
      const c = camRef.current
      pens.current.forEach((pen) => {
        const el = cursorEls.current.get(pen.key)
        if (!el) return
        let inking = false
        if (pen.batch) {
          const t = now - pen.batch.start
          const seg = pen.batch.timeline.find((s) => t >= s.delay && t <= s.delay + s.dur)
          if (seg) {
            const p = pointOf(seg.id, Math.min(1, (t - seg.delay) / seg.dur), pen)
            if (p) pen.pos = p
          } else {
            const next = pen.batch.timeline.find((s) => s.delay > t)
            const p = next && pointOf(next.id, 0, pen)
            if (p) pen.pos = { x: pen.pos.x + (p.x - pen.pos.x) * 0.25, y: pen.pos.y + (p.y - pen.pos.y) * 0.25 }
          }
          inking = !!seg
        } else {
          if (pen.wander) {
            const dx = pen.target.x - pen.pos.x
            const dy = pen.target.y - pen.pos.y
            if (Math.hypot(dx, dy) < 6) pen.target = { x: pen.home.x + (Math.random() - 0.5) * pen.range, y: pen.home.y + (Math.random() - 0.5) * pen.range * 0.6 }
            pen.pos = { x: pen.pos.x + dx * 0.018, y: pen.pos.y + dy * 0.018 }
          } else if (pen.author === 'agent' && pen.visible) {
            // 自己的茶宠：思考时跑到目标嗅一嗅，完事踱回家
            const dx = pen.target.x - pen.pos.x
            const dy = pen.target.y - pen.pos.y
            if (Math.hypot(dx, dy) > 4) pen.pos = { x: pen.pos.x + dx * 0.045, y: pen.pos.y + dy * 0.045 }
          }
        }
        el.style.transform = `translate(${(pen.pos.x - c.x) * c.z}px, ${(pen.pos.y - c.y) * c.z}px)`
        // 用 data-state 而不是 className，避免 React 重渲染时覆盖
        el.dataset.state = !pen.visible ? 'off' : inking ? 'inking' : 'on'
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pens])

  const eraseAt = (x: number, y: number) => {
    const id = document.elementFromPoint(x, y)?.closest('[data-op]')?.getAttribute('data-op')
    if (id) g.erase(id)
  }

  const ghostBounds = ghost ? opsBounds(ghost.ops) : null

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return
    const p = toWorld(e.clientX, e.clientY)
    const capture = () => e.currentTarget.setPointerCapture(e.pointerId)
    if (wheel) setWheel(null)
    if (ghost && (e.target as Element).closest('[data-ghost]')) {
      capture()
      setDraft({ kind: 'ghost', a: p, tfs: ghost.ops.map((o) => ({ ...o.tf })) })
      return
    }
    if (e.button === 1 || activeTool === 'hand') {
      capture()
      setDraft({ kind: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y })
      return
    }
    if (readOnly) return
    setHover(null)
    capture()
    if (activeTool === 'pen') setDraft({ kind: 'pen', pts: [p] })
    else if (activeTool === 'guide') {
      const opId = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-op]')?.getAttribute('data-op') ?? null
      setDraft({ kind: 'guide', pts: [p], opId })
    } else if (activeTool === 'eraser') {
      setDraft({ kind: 'erase' })
      eraseAt(e.clientX, e.clientY)
    } else setDraft({ kind: activeTool, a: p, b: p })
  }

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!draft) {
      if (activeTool === 'guide' || activeTool === 'hand') {
        const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-op]')?.getAttribute('data-op')
        const op = id ? ops.find((o) => o.id === id) : undefined
        setHover(op ? { op, ...local(e.clientX, e.clientY) } : null)
      }
      return
    }
    const p = toWorld(e.clientX, e.clientY)
    switch (draft.kind) {
      case 'pen':
      case 'guide': {
        const last = draft.pts[draft.pts.length - 1]
        if (Math.hypot(p.x - last.x, p.y - last.y) * cam.z < 2.5) return
        setDraft({ ...draft, pts: [...draft.pts, p] })
        break
      }
      case 'pan':
        setCam((c) => {
          const k = stageScale()
          return { ...c, x: draft.cx - (e.clientX - draft.sx) / k / c.z, y: draft.cy - (e.clientY - draft.sy) / k / c.z }
        })
        break
      case 'ghost': {
        const d = { x: p.x - draft.a.x, y: p.y - draft.a.y }
        g.ghostTf(draft.tfs.map((tf) => ({ ...tf, x: tf.x + d.x, y: tf.y + d.y })))
        break
      }
      case 'gresize': {
        const f = Math.min(4, Math.max(0.25, Math.hypot(p.x - draft.c.x, p.y - draft.c.y) / draft.d0))
        g.ghostTf(draft.tfs.map((tf) => ({ x: draft.c.x + (tf.x - draft.c.x) * f, y: draft.c.y + (tf.y - draft.c.y) * f, s: tf.s * f })))
        break
      }
      case 'erase':
        eraseAt(e.clientX, e.clientY)
        break
      default:
        setDraft({ ...draft, b: p })
    }
  }

  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (!draft) return
    setDraft(null)
    if (draft.kind === 'guide') {
      finishGuide(draft, e)
      return
    }
    const el = finalize(draft, color, width)
    if (el) g.draw(el)
  }

  const finishGuide = (d: Extract<Draft, { kind: 'guide' }>, e: RPointerEvent<SVGSVGElement>) => {
    const pts = d.pts
    const kind = g.guideMode === 'auto' ? classifyStroke(pts) : g.guideMode
    const hit = d.opId ? ops.find((o) => o.id === d.opId) : undefined
    if (hit && (kind === 'pin' || g.guideMode === 'anchor')) {
      // 点中已有笔迹 → 锚定方位轮盘
      setWheel({ op: hit, ...local(e.clientX, e.clientY) })
      return
    }
    const bbox = strokeBBox(pts)
    let t: DrawTarget
    if (kind === 'box' && bbox.w > 24 && bbox.h > 24) t = { kind: 'box', rect: bbox }
    else if (kind === 'lasso' && pts.length > 5) t = { kind: 'lasso', polygon: pts, bbox }
    else if (kind === 'path' && pts.length > 5) t = { kind: 'path', points: pts, width: 42 }
    else t = { kind: 'pin', at: pts[0], radius: 110 }
    g.addMark(t)
  }

  const ghostHandleDown = (e: RPointerEvent<HTMLSpanElement>) => {
    if (!ghost) return
    e.stopPropagation()
    e.preventDefault()
    const gb = opsBounds(ghost.ops)
    const c = { x: gb.x + gb.w / 2, y: gb.y + gb.h / 2 }
    const a = toWorld(e.clientX, e.clientY)
    const d0 = Math.max(20, Math.hypot(a.x - c.x, a.y - c.y))
    const tfs = ghost.ops.map((o) => ({ ...o.tf }))
    setDraft({ kind: 'gresize', tfs, c, d0 })
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY)
      const f = Math.min(4, Math.max(0.25, Math.hypot(p.x - c.x, p.y - c.y) / d0))
      g.ghostTf(tfs.map((tf) => ({ x: c.x + (tf.x - c.x) * f, y: c.y + (tf.y - c.y) * f, s: tf.s * f })))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const z = cam.z
  const world = `matrix(${z} 0 0 ${z} ${-cam.x * z} ${-cam.y * z})`
  const seatOf = (id: number) => seats.find((s) => s.id === id)

  // 座位气泡：每个座位最近一条发言，飘在它的 Pen 锚点上
  const bubbles = (() => {
    const last = new Map<number, (typeof g.chat)[number]>()
    for (const m of g.chat.slice(-24)) if (m.seat != null && m.author !== 'system') last.set(m.seat, m)
    return [...last.values()].slice(-5).map((m) => {
      const pen = pens.current.get(`${m.seat}-human`) ?? pens.current.get(`${m.seat}-agent`)
      const at = pen?.home ?? { x: 0, y: 0 }
      return { m, at }
    })
  })()

  return (
    <div className={`canvas-wrap tool-${activeTool} ${draft?.kind === 'pan' ? 'panning' : ''} ${readOnly ? 'readonly' : ''}`}>
      <svg
        ref={svgRef}
        className="canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="dot-grid" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform={world}>
            <circle cx="12" cy="12" r="1.1" fill="rgba(60,52,40,.16)" />
          </pattern>
          {frame && (
            <clipPath id="frame-clip">
              <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx="10" />
            </clipPath>
          )}
        </defs>
        <rect width="100%" height="100%" fill={frame ? 'transparent' : 'url(#dot-grid)'} />
        <g transform={world}>
          {frame && <rect className="frame-card" x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx="10" />}
          <g clipPath={frame ? 'url(#frame-clip)' : undefined} className={highlightAgent ? 'ops hl' : 'ops'}>
            {ops.map((op) =>
              hiddenSeats.has(op.seat) ? null : (
                <g key={op.id} transform={tfStr(op.tf)} className={`op op-${op.author}`}>
                  {renderEl(op.el, opProps(op))}
                </g>
              ),
            )}
          </g>
          {thinking.map((t) => (
            <g key={t.key} transform={`translate(${t.at.x} ${t.at.y})`} className="think" style={{ '--c': t.color } as CSSProperties}>
              <circle r={70} className="think-fill" />
              <circle r={70} className="think-ring" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {foreignMarks.map((m) => (
            <MarkGlyph key={m.id} m={m} mine={false} />
          ))}
          {marks.map((m) => (
            <MarkGlyph key={m.id} m={m} mine onRemove={() => g.removeMark(m.id)} />
          ))}
          {ghost && ghostBounds && (
            <g className="ghost">
              <rect
                className="ghost-box"
                x={ghostBounds.x - 12}
                y={ghostBounds.y - 12}
                width={ghostBounds.w + 24}
                height={ghostBounds.h + 24}
                rx={10}
                data-ghost
                vectorEffect="non-scaling-stroke"
              />
              <g className="ghost-art">
                {ghost.ops.map((op) => (
                  <g key={op.id} transform={tfStr(op.tf)}>
                    {renderEl(op.el)}
                  </g>
                ))}
              </g>
            </g>
          )}
          {draft && renderDraft(draft, color, width)}
        </g>
      </svg>

      <div className="canvas-overlay">
        {penKeys.map((k) => {
          const pen = pens.current.get(k)
          if (!pen) return null
          return (
            <div
              key={k}
              className={`pen-cursor ${pen.author}`}
              style={{ '--c': pen.color } as CSSProperties}
              ref={(el) => {
                if (el) cursorEls.current.set(k, el)
                else cursorEls.current.delete(k)
              }}
            >
              {pen.author === 'human' ? <HumanTip /> : <AgentTip />}
              <span className="pen-label">
                {pen.author === 'agent' && <AgentGlyph size={11} color="#fff" />}
                {pen.label}
              </span>
            </div>
          )
        })}

        {frame && ops.length === 0 && !ghost && !draft && (
          <div className="frame-empty" style={pos(toScreen({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }))}>
            <Pencil size={22} />
            <b>在这里作画</b>
            <span>自己画，或者在下方让 Agent 帮你起个稿</span>
          </div>
        )}

        {activeTool === 'guide' && !readOnly && (
          <div className="guide-hud">
            <span className="gh-mode">
              <AgentGlyph size={12} color="var(--seal)" /> 指引笔 · {g.guideMode === 'auto' ? '自动判定' : { pin: '令旗', box: '区域', lasso: '套索', path: '引路', anchor: '锚定' }[g.guideMode as string]}
            </span>
            <span className="gh-hint">{GUIDE_HINT[g.guideMode]}</span>
            {marks.length > 0 && <span className="gh-count">{marks.length}/3 处标记 · 双击旗面撤销 · Esc 清空</span>}
          </div>
        )}

        {marks.length > 0 && !ghost && activeTool !== 'guide' && (
          <div className="region-chip" style={pos(toScreen(targetCenter(marks[0].target)))}>
            <AgentGlyph size={12} color="var(--seal)" />
            已标记 {marks.length} 处落笔点
            <button onClick={g.clearMarks}>
              <X size={12} />
            </button>
          </div>
        )}

        {foreignMarks.map((m) => {
          const s = seatOf(m.seat)
          return (
            <div key={m.id} className="mark-tag" style={pos(toScreen(targetCenter(m.target)))}>
              <i className="dot" style={{ background: m.color }} />
              {s?.name} 的 {s?.agent?.name} 想画这里
            </div>
          )
        })}

        {ghost && ghostBounds && (
          <>
            <div className="ghost-bar" style={pos(toScreen({ x: ghostBounds.x + ghostBounds.w + 12, y: ghostBounds.y - 12 }))}>
              <span className="gb-title">
                <AgentGlyph size={13} color="var(--seal)" /> {ghost.label}
                <em>描红</em>
              </span>
              <button className="gb-btn seal" onClick={g.acceptGhost}>
                <Stamp size={14} strokeWidth={2.4} /> 盖章 <kbd>Tab</kbd>
              </button>
              <button className="gb-btn" onClick={g.rejectGhost} title="揉掉 (Esc)">
                <X size={14} />
              </button>
            </div>
            <div className="ghost-notes" style={pos(toScreen({ x: ghostBounds.x - 12, y: ghostBounds.y + ghostBounds.h + 12 }))}>
              <span className="gn-ok">
                <ShieldCheck size={13} /> 校验通过 · {ghost.ops.length} 个元素 · 墨量 {ghost.ink}
              </span>
              {ghost.notes.map((n) => (
                <span key={n} className="gn-warn">
                  {n}
                </span>
              ))}
              <span className="gn-hint">
                <Move size={12} /> 拖动移位 · 拉角缩放
              </span>
            </div>
            {(['tl', 'tr', 'bl', 'br'] as const).map((k) => {
              const corner = {
                tl: { x: ghostBounds.x - 12, y: ghostBounds.y - 12 },
                tr: { x: ghostBounds.x + ghostBounds.w + 12, y: ghostBounds.y - 12 },
                bl: { x: ghostBounds.x - 12, y: ghostBounds.y + ghostBounds.h + 12 },
                br: { x: ghostBounds.x + ghostBounds.w + 12, y: ghostBounds.y + ghostBounds.h + 12 },
              }[k]
              return <span key={k} className={`g-handle ${k}`} style={pos(toScreen(corner))} onPointerDown={ghostHandleDown} />
            })}
          </>
        )}

        {g.lastStamp && (
          <div key={g.lastStamp.nonce} className="seal-stamp" style={pos(toScreen(g.lastStamp.at))}>
            准
          </div>
        )}

        {wheel && (
          <div className="anchor-wheel" style={pos(wheel)} onPointerDown={(e) => e.stopPropagation()}>
            <div className="aw-title">画在它的…</div>
            <div className="aw-grid">
              {RELATIONS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    const gb = opsBounds([wheel.op])
                    g.addMark({ kind: 'anchor', opId: wheel.op.id, bbox: gb, relation: r.id })
                    setWheel(null)
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="aw-x" onClick={() => setWheel(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {g.gridOn && !readOnly && (
          <div
            className="grid-pick"
            style={frame ? { left: toScreen({ x: frame.x, y: frame.y }).x, top: toScreen({ x: frame.x, y: frame.y }).y, width: frame.w * cam.z, height: frame.h * cam.z } : undefined}
          >
            {GRID_NAMES.map((n, i) => (
              <button
                key={n}
                className="gp-cell"
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect()
                  const a = toWorld(b.left, b.top)
                  const c = toWorld(b.right, b.bottom)
                  g.addMark({ kind: 'grid', cell: [i % 3, Math.floor(i / 3)], rect: normRect(a, c) })
                  g.setGridOn(false)
                }}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {bubbles.map(({ m, at }) => (
          <div key={m.id} className={`seat-bubble ${m.author === 'agent' ? 'agent' : ''}`} style={pos(toScreen(at))}>
            {m.author === 'agent' && <AgentGlyph size={11} color={seatOf(m.seat!)?.color} />}
            {m.text}
          </div>
        ))}

        {hover && !draft && (
          <div className="op-tip" style={pos(hover)}>
            {hover.op.author === 'agent' ? <AgentGlyph size={12} color={seatOf(hover.op.seat)?.color} /> : <i className="dot" style={{ background: seatOf(hover.op.seat)?.color }} />}
            {seatOf(hover.op.seat)?.name}
            {hover.op.author === 'agent' && ` 的 ${seatOf(hover.op.seat)?.agent?.name}`}
            {hover.op.label && <span className="muted"> · {hover.op.label}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

const pos = (p: Pt) => ({ left: p.x, top: p.y })

/** 指引标记的世界内渲染：令旗 / 镇纸框 / 朱砂圈 / 引路线 / 锚定环 / 九宫格 */
function MarkGlyph({ m, mine, onRemove }: { m: TargetMark; mine: boolean; onRemove?: () => void }) {
  const t = m.target
  const cls = `mark mk-${t.kind} ${mine ? 'mine' : 'foreign'}${m.used ? ' used' : ''}`
  return (
    <g className={cls} style={{ '--c': m.color } as CSSProperties} onDoubleClick={onRemove}>
      {t.kind === 'pin' && (
        <>
          <circle cx={t.at.x} cy={t.at.y} r={t.radius} className="mk-area" vectorEffect="non-scaling-stroke" />
          <line x1={t.at.x} y1={t.at.y + 6} x2={t.at.x} y2={t.at.y - 52} className="mk-pole" vectorEffect="non-scaling-stroke" />
          <path d={`M${t.at.x} ${t.at.y - 56} L${t.at.x + 30} ${t.at.y - 48} L${t.at.x} ${t.at.y - 36} Z`} className="mk-flag" />
          <circle cx={t.at.x} cy={t.at.y} r={3.4} className="mk-dot" />
        </>
      )}
      {(t.kind === 'box' || t.kind === 'grid') && (
        <>
          <rect x={t.rect.x} y={t.rect.y} width={t.rect.w} height={t.rect.h} rx={8} className="mk-rect" vectorEffect="non-scaling-stroke" />
          {[
            [t.rect.x, t.rect.y],
            [t.rect.x + t.rect.w, t.rect.y],
            [t.rect.x, t.rect.y + t.rect.h],
            [t.rect.x + t.rect.w, t.rect.y + t.rect.h],
          ].map(([x, y], i) => (
            <rect key={i} x={x - 7} y={y - 7} width={14} height={14} rx={3} className="mk-weight" vectorEffect="non-scaling-stroke" />
          ))}
        </>
      )}
      {t.kind === 'lasso' && <polygon points={t.polygon.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ')} className="mk-rect" vectorEffect="non-scaling-stroke" />}
      {t.kind === 'path' && (
        <>
          <polyline points={t.points.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ')} className="mk-line" vectorEffect="non-scaling-stroke" />
          {pathSlots(t.points, 210, 4).map((s, i) => (
            <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={8} className="mk-slot" vectorEffect="non-scaling-stroke" />
          ))}
        </>
      )}
      {t.kind === 'anchor' && (
        <>
          <rect x={t.bbox.x - 10} y={t.bbox.y - 10} width={t.bbox.w + 20} height={t.bbox.h + 20} rx={10} className="mk-rect" vectorEffect="non-scaling-stroke" />
          <circle cx={t.bbox.x + t.bbox.w / 2} cy={t.bbox.y - 10} r={4} className="mk-dot" />
        </>
      )}
    </g>
  )
}

function opProps(op: Op) {
  const extra: Record<string, unknown> = { 'data-op': op.id }
  if (op.anim) {
    extra.className = 'draw'
    extra.pathLength = 1
    extra.style = { '--delay': `${op.anim.delay}ms`, '--dur': `${op.anim.dur}ms` } as CSSProperties
  }
  return extra
}

const strokeBase = (color: string, width: number) => ({
  fill: 'none',
  stroke: color,
  strokeWidth: width,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
})

function finalize(d: Draft, color: string, width: number): SvgEl | null {
  const base = strokeBase(color, width)
  if (d.kind === 'pen') {
    if (d.pts.length === 1) return { tag: 'circle', attrs: { cx: r1(d.pts[0].x), cy: r1(d.pts[0].y), r: width / 2, fill: color } }
    return { tag: 'path', attrs: { d: pointsToPath(d.pts), ...base } }
  }
  if (d.kind === 'line') {
    if (Math.hypot(d.a.x - d.b.x, d.a.y - d.b.y) < 3) return null
    return { tag: 'line', attrs: { x1: r1(d.a.x), y1: r1(d.a.y), x2: r1(d.b.x), y2: r1(d.b.y), ...base } }
  }
  if (d.kind === 'rect' || d.kind === 'ellipse') {
    const r = normRect(d.a, d.b)
    if (r.w < 3 || r.h < 3) return null
    if (d.kind === 'rect') return { tag: 'rect', attrs: { x: r1(r.x), y: r1(r.y), width: r1(r.w), height: r1(r.h), rx: 4, ...base } }
    return { tag: 'ellipse', attrs: { cx: r1(r.x + r.w / 2), cy: r1(r.y + r.h / 2), rx: r1(r.w / 2), ry: r1(r.h / 2), ...base } }
  }
  return null
}

function renderDraft(d: Draft, color: string, width: number) {
  if (d.kind === 'guide') {
    const pts = d.pts
    if (pts.length < 2) return null
    return <polyline points={pts.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ')} className="guide-draft" vectorEffect="non-scaling-stroke" />
  }
  const el = finalize(d, color, width)
  return el ? renderEl(el, { pointerEvents: 'none' }) : null
}
