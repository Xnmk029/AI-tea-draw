import { useState, type CSSProperties } from 'react'
import { Eye } from 'lucide-react'
import type { GuessRole, ModeId, RoomRules, Seat } from '../core/types'
import type { SessionResult } from '../game/gameTypes'
import { useGame } from '../game/useGame'
import { Canvas } from '../game/Canvas'
import { TopBar } from '../game/TopBar'
import { ToolDock, ZoomDock } from '../game/ToolDock'
import { AgentBar, GuessBar } from '../game/AgentBar'
import { SidePanel } from '../game/SidePanel'
import { RelayWaiting, RoundOver, WordPicker } from '../game/Overlays'
import { Portal } from '../ui/Shell'

interface Props {
  mode: ModeId
  seats: Seat[]
  rules: RoomRules
  guessRole: GuessRole
  onExit: () => void
  /** 结束时把本局结算载荷带出去 */
  onFinish: (r: SessionResult) => void
}

/**
 * 对局屏层级：
 *   l-world  画布 + 世界内标记（光标、令旗、草稿）
 *   l-frame  木桌边框（纯装饰，不接收输入）
 *   l-hud    顶栏 / 笔架 / 茶宠指令 / 缩放 —— 锚定在安全区内
 *   l-panel  宾客侧栏
 *   舞台级   modal（选词、等待、回合结束） / toast
 */
export function GameScreen({ mode, seats, rules, guessRole, onExit, onFinish }: Props) {
  const g = useGame({ mode, seats, rules, guessRole })
  const [sideOpen, setSideOpen] = useState(true)
  const finish = () => onFinish(g.collectResult())

  return (
    <div className={`scr scr-game game mode-${mode} ${sideOpen ? 'side-on' : ''}`} style={{ '--side-w': sideOpen ? '344px' : '0px' } as CSSProperties}>
      <div className="l-world">
        <Canvas g={g} />
      </div>
      <div className="l-frame">
        <div className="table-frame" aria-hidden />
      </div>
      <div className="l-hud">
        <TopBar g={g} onExit={onExit} onFinish={finish} />
        {g.readOnly ? (
          <div className="watch-chip island">
            <Eye size={15} />
            观看中 · 你是猜词者
          </div>
        ) : (
          <ToolDock g={g} />
        )}
        {g.role === 'guesser' ? <GuessBar g={g} /> : <AgentBar g={g} />}
        <ZoomDock g={g} />
      </div>
      <div className="l-panel">
        <SidePanel g={g} open={sideOpen} onOpen={setSideOpen} />
      </div>

      {g.toast && (
        <Portal layer="toast">
          <div key={g.toast.id} className="toast">
            {g.toast.text}
          </div>
        </Portal>
      )}
      <Portal layer="modal">
        {mode === 'guess' && g.role === 'drawer' && !g.word && <WordPicker g={g} />}
        {mode === 'relay' && g.submitted && <RelayWaiting g={g} onFinish={finish} />}
        {mode === 'guess' && g.roundOver && <RoundOver g={g} onFinish={finish} />}
      </Portal>
    </div>
  )
}
