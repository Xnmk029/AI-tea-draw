import { useEffect, useMemo, useState, type CSSProperties } from 'react'
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
import type { NetLink } from '../game/netSync'

interface Props {
  mode: ModeId
  seats: Seat[]
  rules: RoomRules
  guessRole: GuessRole
  netLink?: NetLink
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
export function GameScreen({ mode, seats, rules, guessRole, netLink, onExit, onFinish }: Props) {
  // 联机深链：?net=<bridge端口>&token=<token>[&room=<房间码>][&name=<名字>]
  const net = useMemo(() => {
    const q = new URLSearchParams(location.search)
    const port = q.get('net')
    const token = q.get('token')
    if (!port || !token) return undefined
    return {
      port: Number(port),
      token,
      room: q.get('room') ?? undefined,
      name: q.get('name') ?? seats.find((s) => s.isMe)?.name,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const g = useGame({ mode, seats, rules, guessRole, net, netLink })
  const [sideOpen, setSideOpen] = useState(true)
  const finish = () => {
    const r = g.requestFinish()
    if (r) onFinish(r)
    // peer 返回 null：等 host 的 session-over 广播 → 下方 netResult 效应兜底
  }
  useEffect(() => {
    if (g.netResult) onFinish(g.netResult)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.netResult])

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
