export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M11.5 9.5c0-2 2-2.2 2-4.2M16.5 9.5c0-2 2-2.2 2-4.2" stroke="var(--ink-3)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 13h17v4a8.5 8.5 0 0 1-17 0z" fill="var(--accent)" />
      <path d="M23 15h1.5a3 3 0 0 1 0 6H22" stroke="var(--accent)" strokeWidth="2" />
      <path d="M4.5 27.5c4-1.6 8.5 1.4 12.5 0s7.5-1.2 10.5 0" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
