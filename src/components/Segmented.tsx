import type { ReactNode } from 'react'

interface Props<T extends string> {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  className?: string
}

export function Segmented<T extends string>({ value, options, onChange, className }: Props<T>) {
  return (
    <div className={`seg ${className ?? ''}`}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
