import { useState } from 'react'
import { ArrowRight, LogOut, Settings, Share2, Undo2 } from 'lucide-react'
import { MODES } from '../core/theme'
import { ROOM_CODE, TEA_THEME } from '../mock/room'
import { AvatarStack } from '../components/Avatar'
import { Logo } from '../components/Logo'
import type { GameState } from './gameTypes'

export function TopBar({ g, onExit, onFinish }: { g: GameState; onExit: () => void; onFinish: () => void }) {
  const [menu, setMenu] = useState(false)
  return (
    <div className="topbar">
      <div className="island tb-left">
        <button className="icon-btn logo-btn" onClick={() => setMenu((v) => !v)} title="菜单">
          <Logo size={24} />
        </button>
        <div className="tb-room">
          <b>#{g.net ? g.net.room : ROOM_CODE}</b>
          <span className={`mode-badge m-${g.mode}`}>{MODES[g.mode].name}</span>
          {g.net && (
            <span className="mode-badge net-badge" title={`联机房间 ${g.net.room}`}>
              {g.net.role === 'host' ? '主机' : '联机'} · {g.net.peers}人
            </span>
          )}
        </div>
        {menu && (
          <div className="menu island" onMouseLeave={() => setMenu(false)}>
            <button onClick={onExit}>
              <Undo2 size={15} /> 返回大厅
            </button>
            <button disabled>
              <Settings size={15} /> 房间设置
            </button>
            <div className="menu-sep" />
            <button className="danger" onClick={onExit}>
              <LogOut size={15} /> 离开房间
            </button>
          </div>
        )}
      </div>

      <ModeHeader g={g} />

      <div className="tb-right">
        <div className="island tb-people">
          <AvatarStack seats={g.seats} />
        </div>
        <button className="btn island-btn" title="邀请">
          <Share2 size={15} />
        </button>
        {g.mode === 'relay' ? (
          <button className="btn btn-primary" onClick={g.submitRelay} disabled={g.submitted}>
            {g.submitted ? '已提交' : '完成并提交'}
          </button>
        ) : (
          <button className="btn island-btn" onClick={onFinish}>
            结束本局 <ArrowRight size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

function ModeHeader({ g }: { g: GameState }) {
  const total = g.rules.roundTime
  if (g.mode === 'tea')
    return (
      <div className="mode-head island">
        <span className="mh-label">主题</span>
        <b className="mh-theme">{g.rules.theme || TEA_THEME}</b>
        <span className="mh-sep" />
        <span className="mh-live">
          <i className="live-dot" />
          {g.seats.length} 人在线 · 自由作画
        </span>
      </div>
    )

  if (g.mode === 'relay') {
    const turn = g.relayTurn
    const chain = g.relayChains.find((c) => c.id === turn?.chainId)
    const step = turn ? turn.stepIdx + 1 : 1
    const total = chain ? chain.steps.length : 3
    const relayTotal = g.relayChains.reduce((n, c) => n + c.steps.length, 0)
    const left = g.relayQueue.length + (turn ? 1 : 0)
    return (
      <div className="mode-head island">
        <div className="mh-steps">
          {Array.from({ length: total }).map((_, i) => (
            <i key={i} className={i < step - 1 ? 'done' : i === step - 1 ? 'cur' : ''} />
          ))}
        </div>
        <span className="mh-label">
          第 {step}/{total} 棒 · 待画 {left} 题 · 总进度 {g.relayDone}/{relayTotal}
        </span>
        <b className="mh-prompt">「{g.relayTitle}」</b>
        <span className="mh-sep" />
        <span className="mh-label">
          已提交 {g.relayDone}/{relayTotal}
        </span>
        <Timer left={g.timeLeft} total={g.rules.roundTime} />
      </div>
    )
  }

  return (
    <div className="mode-head island">
      <span className="mh-round">第 {g.round}/{g.roundsTotal} 轮</span>
      <span className="mh-sep" />
      {g.role === 'drawer' ? (
        <>
          <span className="mh-label">你要画</span>
          <b className="mh-word">{g.word?.word ?? '选词中…'}</b>
        </>
      ) : (
        <>
          <span className="mh-label">{g.guessed ? '答案' : '猜灯谜'}</span>
          <span className="mh-hint">
            {(g.guessed ? g.answer.split('') : g.hint).map((c, i) => (
              <span key={i} className={`lantern ${c ? 'lit' : ''}`}>
                {c}
              </span>
            ))}
          </span>
          <span className="mh-label">{g.hint.length} 个字</span>
        </>
      )}
      <Timer left={g.timeLeft} total={total} />
    </div>
  )
}

/** 燃香计时：一炷香从上往下烧，最后 10 秒火星变红加快 */
function Timer({ left, total }: { left: number | null; total: number }) {
  if (left === null) return null
  const f = Math.max(0, left / total)
  const urgent = left <= 10
  return (
    <span className={`incense ${urgent ? 'urgent' : ''}`} title={`剩 ${left} 秒`}>
      <span className="inc-stick">
        <i className="inc-ash" style={{ height: `${(1 - f) * 100}%` }} />
        <i className="inc-ember" style={{ bottom: `${f * 100}%` }} />
      </span>
      <b>{left}</b>
    </span>
  )
}
