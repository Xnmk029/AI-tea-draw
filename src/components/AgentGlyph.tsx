import type { AgentStatus } from '../core/types'

/** Agent 的统一视觉符号：虚线空心菱形 + 圆心，区别于人类的实心元素 */
export function AgentGlyph({ size = 14, color = 'currentColor', status }: { size?: number; color?: string; status?: AgentStatus }) {
  return (
    <svg className={`agent-glyph${status ? ` g-${status}` : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path className="g-frame" d="M8 1.6 14.4 8 8 14.4 1.6 8Z" stroke={color} strokeWidth="1.6" strokeDasharray="2.6 1.7" strokeLinejoin="round" />
      <circle className="g-core" cx="8" cy="8" r="2.1" fill={color} />
    </svg>
  )
}
