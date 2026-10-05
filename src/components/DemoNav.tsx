import { useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import type { GuessRole, ModeId, Screen } from '../core/types'
import { MODES } from '../core/theme'

interface Props {
  screen: Screen
  mode: ModeId
  guessRole: GuessRole
  onScreen: (s: Screen) => void
  onMode: (m: ModeId) => void
  onGuessRole: (r: GuessRole) => void
}

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'home', label: '主菜单' },
  { id: 'lobby', label: '大厅' },
  { id: 'game', label: '对局' },
  { id: 'result', label: '结算' },
]

/** Demo 专用的页面跳转器，正式版移除 */
export function DemoNav({ screen, mode, guessRole, onScreen, onMode, onGuessRole }: Props) {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <button className="demo-fab" onClick={() => setOpen(true)} title="Demo 导航">
        <FlaskConical size={15} />
        DEMO
      </button>
    )
  return (
    <div className="demo-panel">
      <div className="demo-head">
        <span>
          <FlaskConical size={14} /> Demo 导航
        </span>
        <button className="icon-btn sm" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="demo-label">页面</div>
      <div className="demo-row">
        {SCREENS.map((s) => (
          <button key={s.id} className={screen === s.id ? 'on' : ''} onClick={() => onScreen(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="demo-label">模式</div>
      <div className="demo-row">
        {(Object.keys(MODES) as ModeId[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => onMode(m)}>
            {MODES[m].name}
          </button>
        ))}
      </div>
      {mode === 'guess' && (
        <>
          <div className="demo-label">你画我猜身份</div>
          <div className="demo-row">
            <button className={guessRole === 'drawer' ? 'on' : ''} onClick={() => onGuessRole('drawer')}>
              画手
            </button>
            <button className={guessRole === 'guesser' ? 'on' : ''} onClick={() => onGuessRole('guesser')}>
              猜词者
            </button>
          </div>
        </>
      )}
    </div>
  )
}
