import type { AgentStatus } from '../core/types'
import type { CSSProperties } from 'react'

/**
 * 茶宠：Agent 在游戏里的化身——一只叼着毛笔的紫砂小灵。
 * 状态全部由 SVG + CSS 表达：打盹 / 思考冒茶烟 / 举着草稿待盖章 / 趴纸上作画。
 */
export function TeaPet({ color = '#B85C38', status = 'idle', size = 60, className = '' }: { color?: string; status?: AgentStatus; size?: number; className?: string }) {
  const off = status === 'offline'
  return (
    <svg className={`tea-pet tp-${status} ${className}`} width={size} height={size} viewBox="0 0 64 64" style={{ '--c': color } as CSSProperties} aria-hidden>
      <ellipse cx="32" cy="58" rx="16" ry="3.6" className="tp-shadow" />
      {/* 身体：胖水滴（茶壶形） */}
      <path className="tp-body" d="M32 10 C43 10 51 22 51 36 C51 48 43 56 32 56 C21 56 13 48 13 36 C13 22 21 10 32 10 Z" />
      <ellipse cx="32" cy="43" rx="11.5" ry="8.5" className="tp-belly" />
      {/* 壶盖纽 */}
      <circle cx="32" cy="10" r="3.6" className="tp-knob" />
      {/* 围巾：座位色，人和茶宠一脉同色 */}
      <path className="tp-scarf" d="M15 30 C22 34 42 34 49 30 L49 35 C42 39 22 39 15 35 Z" />
      {/* 眼睛 */}
      {off ? (
        <g className="tp-eyes-x">
          <path d="M22 27 L27 32 M27 27 L22 32" />
          <path d="M37 27 L42 32 M42 27 L37 32" />
        </g>
      ) : status === 'idle' ? (
        <g className="tp-eyes">
          <path d="M21 29 Q24.5 31.5 28 29" />
          <path d="M36 29 Q39.5 31.5 43 29" />
        </g>
      ) : status === 'drawing' ? (
        <g className="tp-eyes">
          <path d="M21 28 Q24.5 25.5 28 28" />
          <path d="M36 28 Q39.5 25.5 43 28" />
        </g>
      ) : (
        <g className="tp-eyes">
          <circle cx="24.5" cy="28" r="2.6" />
          <circle cx="39.5" cy="28" r="2.6" />
          <circle cx="25.4" cy="27.1" r="0.9" className="tp-spark" />
          <circle cx="40.4" cy="27.1" r="0.9" className="tp-spark" />
        </g>
      )}
      {/* 腮红 */}
      <ellipse cx="20" cy="34" rx="2.8" ry="1.8" className="tp-blush" />
      <ellipse cx="44" cy="34" rx="2.8" ry="1.8" className="tp-blush" />
      {/* 嘴 */}
      {!off && status !== 'idle' && <path className="tp-mouth" d="M29 33 Q32 35.4 35 33" />}
      {/* 毛笔：作画/待确认时叼着 */}
      {(status === 'drawing' || status === 'review') && (
        <g className="tp-brush">
          <line x1="50" y1="38" x2="58" y2="26" />
          <path d="M50 38 C49 41 48 43 48.4 45 C51 44.5 52 42 51.5 39.6 Z" className="tp-tip" />
        </g>
      )}
      {/* 待确认：举着草稿纸 */}
      {status === 'review' && (
        <g className="tp-draft">
          <rect x="18" y="-2" width="20" height="14" rx="2" />
          <path d="M21 3 H35 M21 7 H31" />
        </g>
      )}
      {/* 思考：头顶冒茶烟 */}
      {status === 'thinking' && (
        <g className="tp-steam">
          <path className="s1" d="M26 4 C24 0 28 -2 26 -6" />
          <path className="s2" d="M33 5 C31 1 36 -1 34 -5" />
          <path className="s3" d="M40 4 C38 0 42 -2 40 -6" />
        </g>
      )}
      {/* 打盹气泡 */}
      {status === 'idle' && (
        <g className="tp-zzz">
          <circle cx="46" cy="16" r="2.2" />
          <circle cx="52" cy="8" r="3" />
          <circle cx="59" cy="-1" r="3.8" />
        </g>
      )}
      {/* 作画的墨点 */}
      {status === 'drawing' && (
        <g className="tp-splash">
          <circle cx="57" cy="47" r="1.8" />
          <circle cx="60" cy="43" r="1.3" />
          <circle cx="54" cy="50" r="1" />
        </g>
      )}
    </svg>
  )
}

/** 墨囊：茶宠身上的墨量计量 */
export function InkDrop({ pct, color, size = 30 }: { pct: number; color: string; size?: number }) {
  const h = 40 * (1 - Math.min(1, Math.max(0, pct / 100)))
  return (
    <svg className={`ink-drop ${pct >= 90 ? 'full' : ''}`} width={size} height={size * 1.2} viewBox="0 0 32 40" style={{ '--c': color } as CSSProperties} aria-hidden>
      <defs>
        <clipPath id="ink-drop-clip">
          <path d="M16 2 C22 10 28 18 28 26 A12 12 0 0 1 4 26 C4 18 10 10 16 2 Z" />
        </clipPath>
      </defs>
      <path d="M16 2 C22 10 28 18 28 26 A12 12 0 0 1 4 26 C4 18 10 10 16 2 Z" className="id-shell" />
      <rect x="0" y={h} width="32" height={40 - h} clipPath="url(#ink-drop-clip)" className="id-fill" />
    </svg>
  )
}
