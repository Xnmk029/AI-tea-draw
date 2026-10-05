import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Crown, Eye, EyeOff, Layers, Lock, MessageCircle, PanelRightClose, PanelRightOpen, Send, Unlock, Users } from 'lucide-react'
import type { ChatMsg, Seat } from '../core/types'
import { STATUS_TEXT } from '../core/theme'
import { Avatar } from '../components/Avatar'
import { AgentGlyph } from '../components/AgentGlyph'
import type { GameState } from './gameTypes'

type Tab = 'members' | 'layers' | 'chat'

export function SidePanel({ g, open, onOpen }: { g: GameState; open: boolean; onOpen: (v: boolean) => void }) {
  const [tab, setTab] = useState<Tab>(g.mode === 'guess' ? 'chat' : 'members')
  const [seen, setSeen] = useState(g.chat.length)
  const unread = tab === 'chat' ? 0 : g.chat.length - seen

  useEffect(() => {
    if (tab === 'chat') setSeen(g.chat.length)
  }, [tab, g.chat.length])

  const stats = useMemo(() => {
    const m = new Map<number, { human: number; agent: number; hc: number; ac: number }>()
    for (const s of g.seats) m.set(s.id, { human: 0, agent: 0, hc: 0, ac: 0 })
    for (const op of g.ops) {
      const st = m.get(op.seat)
      if (!st) continue
      if (op.author === 'human') {
        st.human += op.ink
        st.hc++
      } else {
        st.agent += op.ink
        st.ac++
      }
    }
    return m
  }, [g.ops, g.seats])

  if (!open)
    return (
      <button className="side-open island" onClick={() => onOpen(true)} title="展开侧栏">
        <PanelRightOpen size={17} />
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
    )

  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'members', label: '成员', icon: <Users size={14} /> },
    ...(g.mode === 'relay' ? [] : [{ id: 'layers' as Tab, label: '图层', icon: <Layers size={14} /> }]),
    { id: 'chat', label: g.mode === 'guess' ? '猜词' : '聊天', icon: <MessageCircle size={14} /> },
  ]

  return (
    <aside className="side island">
      <div className="side-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.icon}
            {t.label}
            {t.id === 'chat' && unread > 0 && <span className="badge">{unread}</span>}
          </button>
        ))}
        <button className="icon-btn sm side-close" onClick={() => onOpen(false)} title="收起">
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="side-body">
        {tab === 'members' && <Members g={g} stats={stats} />}
        {tab === 'layers' && <LayersTab g={g} stats={stats} />}
        {tab === 'chat' && <Chat g={g} />}
      </div>
    </aside>
  )
}

type Stats = Map<number, { human: number; agent: number; hc: number; ac: number }>

function Members({ g, stats }: { g: GameState; stats: Stats }) {
  const seats = g.mode === 'guess' ? [...g.seats].sort((a, b) => b.score - a.score) : g.seats
  return (
    <div className="members">
      {seats.map((s) => {
        const st = stats.get(s.id)!
        const drawer = g.mode === 'guess' && (g.role === 'drawer' ? s.isMe : s.id === 2)
        return (
          <div key={s.id} className="member" style={{ '--c': s.color } as CSSProperties}>
            <div className="m-row">
              <Avatar seat={s} size={30} badge={false} />
              <div className="m-name">
                <b>{s.name}</b>
                {s.isMe && <em>你</em>}
                {s.isHost && <Crown size={12} className="crown" />}
                {drawer && <span className="pill accent">画手</span>}
              </div>
              <span className="m-num">{g.mode === 'guess' ? s.score : st.human}</span>
            </div>
            {s.agent ? (
              <div className="m-agent">
                <span className="m-branch" />
                <AgentGlyph size={14} color={s.color} status={s.agent.status} />
                <span className="m-agent-name">{s.agent.name}</span>
                <span className={`pill st-${s.agent.status}`}>{STATUS_TEXT[s.agent.status]}</span>
                <span className="m-num">{g.mode === 'guess' ? '' : st.agent}</span>
              </div>
            ) : (
              <div className="m-agent none">
                <span className="m-branch" />
                未携带 Agent
              </div>
            )}
          </div>
        )
      })}
      <p className="side-note">
        <Lock size={12} /> 每个座位只能修改自己（和自己 Agent）的笔迹。{g.mode === 'guess' ? '' : '数字为墨量。'}
      </p>
    </div>
  )
}

function LayersTab({ g, stats }: { g: GameState; stats: Stats }) {
  return (
    <div className="layers">
      {g.seats.map((s) => {
        const st = stats.get(s.id)!
        const hidden = g.hiddenSeats.has(s.id)
        return (
          <div key={s.id} className={`layer ${hidden ? 'off' : ''}`}>
            <button className="icon-btn sm" onClick={() => g.toggleSeatVisible(s.id)} title={hidden ? '显示' : '隐藏'}>
              {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <i className="ly-dot" style={{ background: s.color }} />
            <span className="ly-name">{s.name}</span>
            <span className="ly-count">
              {st.hc}
              <span className="muted"> 笔</span>
              {s.agent && (
                <>
                  <AgentGlyph size={11} color={s.color} />
                  {st.ac}
                </>
              )}
            </span>
            {s.isMe ? <Unlock size={13} className="muted" /> : <Lock size={13} className="muted" />}
          </div>
        )
      })}
      <div className="layer common">
        <i className="ly-dot" />
        <span className="ly-name">公共层</span>
        <span className="muted">房主可编辑</span>
      </div>
    </div>
  )
}

function Chat({ g }: { g: GameState }) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [g.chat.length])

  const guessMode = g.mode === 'guess'
  const send = () => {
    if (!text.trim()) return
    g.sendChat(text.trim())
    setText('')
  }

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {g.chat.map((m) => (
          <ChatLine key={m.id} m={m} seat={g.seats.find((s) => s.id === m.seat)} />
        ))}
      </div>
      {guessMode ? (
        <div className="chat-note">{g.role === 'drawer' ? '画手不能发言，专心画吧' : '在底部输入框里猜词'}</div>
      ) : (
        <div className="chat-input">
          <input value={text} placeholder="发消息…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="icon-btn" onClick={send}>
            <Send size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function ChatLine({ m, seat }: { m: ChatMsg; seat?: Seat }) {
  if (m.kind === 'correct' || m.kind === 'close')
    return (
      <div className={`msg ${m.kind}`}>
        {seat && <i className="dot" style={{ background: seat.color }} />}
        {m.text}
      </div>
    )
  if (m.author === 'system' || !seat) return <div className="msg system">{m.text}</div>
  const isAgent = m.author === 'agent'
  return (
    <div className={`msg ${isAgent ? 'agent' : ''}`}>
      <div className="msg-who" style={{ color: seat.color }}>
        {isAgent && <AgentGlyph size={11} color={seat.color} />}
        {isAgent ? `${seat.name} 的 ${seat.agent?.name}` : seat.name}
      </div>
      <div className="msg-text">{m.text}</div>
    </div>
  )
}
