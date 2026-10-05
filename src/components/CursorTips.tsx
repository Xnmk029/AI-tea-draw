/** 人类光标：实心箭头；Agent 光标：虚线空心菱形。颜色都取 CSS 变量 --c（座位色） */
export function HumanTip() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="human-tip">
      <path d="M2 2 L16 8 L9.5 9.5 L8 16 Z" fill="var(--c)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export function AgentTip() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="agent-tip">
      <path d="M10 2 L18 10 L10 18 L2 10 Z" fill="rgba(255,255,255,.9)" stroke="var(--c)" strokeWidth="1.8" strokeDasharray="3 2" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.6" fill="var(--c)" />
    </svg>
  )
}
