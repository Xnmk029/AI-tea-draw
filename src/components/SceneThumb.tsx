import type { CSSProperties } from 'react'
import { tfStr } from '../core/geometry'
import { drawingEls, type SceneItem } from '../mock/drawings'
import { renderEl } from './renderEl'

interface Props {
  items: SceneItem[]
  viewBox?: string
  /** 逐笔绘制动画，每个元素的间隔 ms */
  animate?: number
  className?: string
}

export function SceneThumb({ items, viewBox = '0 0 200 150', animate, className }: Props) {
  let delay = 0
  return (
    <svg className={className} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
      {items.map((it, i) => (
        <g key={i} transform={tfStr(it)}>
          {drawingEls(it.key).map((el, j) => {
            if (!animate) return renderEl(el, { key: j })
            const d = delay
            delay += animate
            return renderEl(el, {
              key: j,
              className: 'draw',
              pathLength: 1,
              style: { '--delay': `${d}ms`, '--dur': `${animate * 2.4}ms` } as CSSProperties,
            })
          })}
        </g>
      ))}
    </svg>
  )
}
