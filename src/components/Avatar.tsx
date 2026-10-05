import type { CSSProperties } from 'react'
import type { Seat } from '../core/types'
import { AgentGlyph } from './AgentGlyph'

export function Avatar({ seat, size = 32, badge = true }: { seat: Pick<Seat, 'name' | 'color' | 'agent'>; size?: number; badge?: boolean }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, '--c': seat.color } as CSSProperties}>
      {seat.name.slice(0, 1)}
      {badge && seat.agent && (
        <span className={`av-badge st-${seat.agent.status}`}>
          <AgentGlyph size={Math.max(9, Math.round(size * 0.36))} color={seat.color} status={seat.agent.status} />
        </span>
      )}
    </span>
  )
}

export function AvatarStack({ seats, max = 5 }: { seats: Seat[]; max?: number }) {
  const shown = seats.slice(0, max)
  return (
    <div className="avatar-stack">
      {shown.map((s) => (
        <span key={s.id} className="as-item" title={s.agent ? `${s.name} · ${s.agent.name}` : s.name}>
          <Avatar seat={s} size={30} />
        </span>
      ))}
      {seats.length > max && <span className="as-more">+{seats.length - max}</span>}
    </div>
  )
}
