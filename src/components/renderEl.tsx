import { createElement, Fragment, type ReactNode } from 'react'
import type { SvgEl } from '../core/types'
import { brushOutline, brushable, hashSeed } from '../brush/stroke'

/* ============================================================
   统一渲染入口：所有 SvgEl 都经这里出图。
   带可见描边且无虚线语义的元素 → 「笔墨化」渲染：
     - 中线元素（透明）承担命中/测距/几何职责（data-op、pointOf、elementFromPoint）
     - perfect-freehand 轮廓路径承担视觉（fill = 原 stroke 色，上 ink-edge 滤镜）
     - 动画笔迹用 <mask> 沿中线揭白色描边实现「笔走到哪墨到哪」
   其余元素（纯填充/虚线）原样渲染，行为不变。
   extra.seed 供外部指定压力种子；默认按 el 内容哈希。
   ============================================================ */

let maskSeq = 0

export const renderEl = (el: SvgEl, extra: Record<string, unknown> = {}): ReactNode => {
  const { seed, hitOnly, ...rest } = extra as { seed?: string | number; hitOnly?: boolean } & Record<string, unknown>
  const a = el.attrs
  const sw = Number(a.strokeWidth ?? a['stroke-width'] ?? 4) || 4
  const shared: Record<string, unknown> = { pointerEvents: rest.pointerEvents }

  // hitOnly：笔迹已烘焙进位图层（InkBake），SVG 只留透明命中线
  // （填充区也要透明可命中——fill/stroke 都是 rgba(0,0,0,.02) 级别的"已绘制"）
  if (hitOnly) {
    const hitAttrs: Record<string, unknown> = { ...a, fill: 'transparent', stroke: 'rgba(0,0,0,.02)', strokeWidth: Math.max(sw * 1.9, 7) }
    delete hitAttrs['data-pp']
    delete hitAttrs.strokeDasharray
    delete hitAttrs['stroke-dasharray']
    if (rest['data-op'] != null) hitAttrs['data-op'] = rest['data-op']
    return createElement(el.tag, { ...hitAttrs, ...shared })
  }
  if (!brushable(el)) return createElement(el.tag, { ...el.attrs, ...rest })

  const stroke = String(a.stroke)
  const animated = typeof rest.className === 'string' && rest.className.includes('draw')
  const outline = brushOutline(el, seed ?? hashSeed(`${el.tag}:${JSON.stringify(a)}`))

  const hitAttrs: Record<string, unknown> = { ...a, fill: 'transparent', stroke: 'rgba(0,0,0,.02)', strokeWidth: Math.max(sw * 1.9, 7) }
  delete hitAttrs['data-pp']
  if (rest['data-op'] != null) hitAttrs['data-op'] = rest['data-op']
  const hitEl = createElement(el.tag, { ...hitAttrs, ...shared })
  if (!outline) return hitEl

  const fillPart = a.fill != null && a.fill !== 'none' && a.fill !== 'transparent'
  const opacity = a.opacity != null ? Number(a.opacity) : 1
  const fillOpacity = Number(a.strokeOpacity ?? a['stroke-opacity'] ?? 1) * opacity

  let maskNode: ReactNode = null
  let maskRef: string | undefined
  if (animated) {
    const mid = `bsm${maskSeq++}`
    const pad = sw * 3
    maskRef = `url(#${mid})`
    // 揭幕层：原中线描白边，沿用 .draw 的 dashoffset 运笔动画
    const maskStroke: Record<string, unknown> = {
      ...a, stroke: '#fff', strokeWidth: sw * 2.8, fill: 'none',
      strokeLinecap: 'round', strokeLinejoin: 'round',
      className: 'draw', pathLength: 1, style: rest.style,
    }
    delete maskStroke['data-pp']
    maskNode = (
      <mask
        id={mid}
        maskUnits="userSpaceOnUse"
        x={outline.bbox.x - pad}
        y={outline.bbox.y - pad}
        width={outline.bbox.w + pad * 2}
        height={outline.bbox.h + pad * 2}
      >
        {createElement(el.tag, maskStroke)}
      </mask>
    )
  }

  return (
    <Fragment key={rest.key as string | number | undefined}>
      {hitEl}
      {maskNode}
      {fillPart &&
        createElement(el.tag, {
          ...a, stroke: 'none', ...shared,
          className: animated ? 'draw' : undefined, pathLength: animated ? 1 : undefined, style: rest.style,
        })}
      <path
        d={outline.d}
        fill={stroke}
        fillOpacity={fillOpacity}
        className="bs"
        mask={maskRef}
        transform={a.transform as string | undefined}
        pointerEvents="none"
      />
    </Fragment>
  )
}
