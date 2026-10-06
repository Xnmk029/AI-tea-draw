import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Activity, ArrowUp, Crosshair, Flag, Grid3X3, Lasso, MessageCircle, Spline, SquareDashed, X } from 'lucide-react'
import { STATUS_TEXT } from '../core/theme'
import { AgentGlyph } from '../components/AgentGlyph'
import { InkDrop, TeaPet } from './TeaPet'
import type { GameState } from './gameTypes'
import { Portal } from '../ui/Shell'
import { toStage } from '../ui/stage'

const SUGGESTIONS: Record<string, string[]> = {
  tea: ['画一棵松树', '在这里加一朵雨云', '画只晒太阳的猫', '茶馆旁边放个茶杯'],
  relay: ['画一个会飞的茶壶', '画一辆公交车', '加几朵云'],
  guess: ['把它画出来', '只画轮廓，别太明显', '加点细节'],
}

const MARK_META: Record<string, { icon: ReactNode; label: string }> = {
  pin: { icon: <Flag size={11} />, label: '令旗' },
  box: { icon: <SquareDashed size={11} />, label: '区域' },
  grid: { icon: <Grid3X3 size={11} />, label: '九宫格' },
  lasso: { icon: <Lasso size={11} />, label: '套索' },
  path: { icon: <Spline size={11} />, label: '引路' },
  anchor: { icon: <Crosshair size={11} />, label: '锚定' },
}

/** 底部茶宠 + 吩咐气泡：人与自己 Agent 的唯一交互入口；茶宠可以直接拖到画布上插令旗 */
export function AgentBar({ g }: { g: GameState }) {
  const agent = g.me.agent
  // 主页「我的茶宠」里选的预设提示词：进对局自动带出到吩咐栏（一次性消费）
  const [text, setText] = useState(() => {
    try {
      const p = localStorage.getItem('teadraw.presetPrompt')
      if (p) localStorage.removeItem('teadraw.presetPrompt')
      return p ?? ''
    } catch { return '' }
  })
  const [focused, setFocused] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [dragPet, setDragPet] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (g.focusNonce) inputRef.current?.focus()
  }, [g.focusNonce])

  if (!agent) return <div className="agent-bar island empty">你没有携带 Agent · 纯手绘模式</div>

  const status = agent.status
  const off = g.rules.agentLevel === 'off'
  const busy = status !== 'idle' || !!g.ghost
  const submit = (t = text) => {
    if (!t.trim() || busy || off) return
    g.askAgent(t.trim())
    setText('')
  }
  const placeholder = off
    ? '房间规则已关闭 Agent 参与'
    : status === 'thinking'
      ? `${agent.name} 正在构思…`
      : status === 'drawing'
        ? `${agent.name} 正在作画…`
        : g.ghost
          ? '先盖章或揉掉当前草稿'
          : g.marks.length
            ? `让 ${agent.name} 在标记处画点什么…`
            : `让 ${agent.name} 画点什么…`

  /** 按住拖动 → 拖到画布松手插令旗；原地松开 → 聚焦输入框 */
  const petDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 14) dragging = true
      if (dragging) setDragPet({ x: ev.clientX, y: ev.clientY })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragPet(null)
      if (dragging) window.dispatchEvent(new CustomEvent('tea:drop-pet', { detail: { x: ev.clientX, y: ev.clientY } }))
      else inputRef.current?.focus()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const inkPct = Math.min(100, Math.round((g.ink.agent / Math.max(g.ink.allowance, 1)) * 100))

  const liveText =
    g.live?.state === 'awake' ? '真实' : g.live?.state === 'ready' ? '待命' : '连接'
  const petTitle = `${agent.name} · ${STATUS_TEXT[status]}${
    g.live && g.live.state !== 'off'
      ? `\n真实桥接：${g.live.state === 'awake' ? `已接入 ${g.live.name ?? 'Agent'}(${g.live.model ?? '?'})` : 'teadraw mcp 桥已连接，等待 MCP 客户端唤醒'}`
      : '\n本地模拟（运行 node server/teadraw.mjs mcp 可接入真实 Agent）'
  }\n拖到画布上插令旗，点一下开聊`

  return (
    <div className={`agent-bar island s-${status}`} style={{ '--c': g.me.color } as CSSProperties}>
      {showLog && (
        <div className="activity-pop island">
          <div className="ap-title">
            <Activity size={13} /> MCP 活动流
            <span className="muted">房间内所有人可见</span>
          </div>
          <div className="act-list">
            {g.activity.length === 0 && <div className="muted act-empty">暂无调用</div>}
            {g.activity
              .slice(-14)
              .reverse()
              .map((a) => (
                <div key={a.id} className={`act t-${a.tone ?? 'ok'}`}>
                  <span className="act-time">{a.time}</span>
                  <code>{a.tool}</code>
                  <span className="act-detail">{a.detail}</span>
                </div>
              ))}
          </div>
        </div>
      )}
      {focused && !text && !busy && !off && (
        <div className="suggest-row">
          {(SUGGESTIONS[g.mode] ?? []).map((s) => (
            <button
              key={s}
              className="chip"
              onMouseDown={(e) => {
                e.preventDefault()
                submit(s)
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="ab-row">
        <div className="pet-col" onPointerDown={petDown} title={petTitle}>
          <TeaPet color={g.me.color} status={off ? 'offline' : status} size={56} />
          <span className={`st st-${status}`}>{STATUS_TEXT[status]}</span>
          {g.live && g.live.state !== 'off' && (
            <span className={`live-tag lt-${g.live.state}`}>{liveText}</span>
          )}
        </div>
        <div className="pet-bubble">
          {g.marks.length > 0 && (
            <div className="marks-chips">
              {g.marks.map((m) => (
                <span key={m.id} className="mk-chip" title="双击画布上的标记可撤销">
                  {MARK_META[m.target.kind].icon}
                  {MARK_META[m.target.kind].label}
                </span>
              ))}
              <button className="mk-clear" onClick={g.clearMarks} title="清空标记 (Esc)">
                <X size={11} />
              </button>
            </div>
          )}
          <div className="pb-input">
            <input
              ref={inputRef}
              value={text}
              disabled={off}
              placeholder={placeholder}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') inputRef.current?.blur()
              }}
            />
            {!focused && !text && <kbd className="ab-kbd">Ctrl K</kbd>}
            <button className="send-btn" disabled={!text.trim() || busy || off} onClick={() => submit()}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
        <div className="pet-rail">
          <div
            className="ink-meter"
            title={`人类墨量 ${g.ink.human}\nAgent 墨量 ${g.ink.agent} / 可用 ${Math.round(g.ink.allowance)}\n规则：Agent ≤ 座位总墨量的 ${Math.round(g.rules.inkRatio * 100)}%`}
          >
            <InkDrop pct={inkPct} color={g.me.color} />
            <span className="ink-num">{inkPct}%</span>
          </div>
          <button className={`icon-btn ${showLog ? 'on' : ''}`} onClick={() => setShowLog((v) => !v)} title="MCP 活动流">
            <Activity size={16} />
          </button>
        </div>
      </div>
      {dragPet && (
        <Portal layer="popover">
          <div className="pet-ghost" style={{ position: 'absolute', left: toStage(dragPet.x, dragPet.y).x, top: toStage(dragPet.x, dragPet.y).y }}>
            <TeaPet color={g.me.color} status="drawing" size={48} />
          </div>
        </Portal>
      )}
    </div>
  )
}

/** 猜词者的输入条：替换 AgentBar */
export function GuessBar({ g }: { g: GameState }) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const agent = g.me.agent
  const canWhisper = !!agent && g.rules.guesserAgent === 'whisper'

  useEffect(() => {
    if (g.focusNonce) inputRef.current?.focus()
  }, [g.focusNonce])

  const submit = () => {
    if (!text.trim() || g.guessed) return
    g.submitGuess(text.trim())
    setText('')
  }

  return (
    <div className={`agent-bar guess-bar island ${g.guessed ? 'done' : ''}`} style={{ '--c': g.me.color } as CSSProperties}>
      {g.whisper && (
        <div className="whisper island">
          <AgentGlyph size={14} color={g.me.color} />
          <span>
            <b>{agent?.name}</b> 悄悄对你说：{g.whisper}
          </span>
          <span className="pill warn">得分 ×0.5</span>
        </div>
      )}
      <div className="ab-row">
        {agent && (
          <div className="pet-col sm" title={`${agent.name} · ${STATUS_TEXT[agent.status]}`}>
            <TeaPet color={g.me.color} status={agent.status} size={44} />
          </div>
        )}
        <MessageCircle size={18} className="gb-icon" />
        <input
          ref={inputRef}
          value={text}
          disabled={g.guessed || g.roundOver}
          placeholder={g.guessed ? '你已经猜中了，等待其他人…' : '输入你的猜测，回车提交'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {canWhisper && (
          <button className="whisper-btn" onClick={g.askWhisper} disabled={!!g.whisper || g.guessed}>
            <AgentGlyph size={14} color={g.me.color} />
            问问 {agent!.name}
          </button>
        )}
        <button className="send-btn" disabled={!text.trim() || g.guessed} onClick={submit}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}
