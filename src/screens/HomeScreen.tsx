import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, Copy, Terminal, Users } from 'lucide-react'
import type { AgentStatus, ModeId } from '../core/types'
import { MODES } from '../core/theme'
import { FRIENDS, INITIAL_SEATS, ROOM_CODE } from '../mock/room'
import type { SceneItem } from '../mock/drawings'
import { Avatar } from '../components/Avatar'
import { AgentGlyph } from '../components/AgentGlyph'
import { Logo } from '../components/Logo'
import { SceneThumb } from '../components/SceneThumb'
import { AgentTip, HumanTip } from '../components/CursorTips'
import { TeaPet } from '../game/TeaPet'
import { Key, useBack, useHotkeys } from '../ui/Shell'

interface Props {
  mode: ModeId
  onMode: (m: ModeId) => void
  onEnter: () => void
  /** 联机会话下输入房间码真实进房（未接 net 时为 undefined，回退 Demo 行为） */
  onJoin?: (code: string) => void
}

type PanelId = 'play' | 'join' | 'pet' | 'gallery' | 'settings' | 'quit'

const MENU: { id: PanelId; label: string; sub: string; disabled?: boolean }[] = [
  { id: 'play', label: '开始茶会', sub: '创建房间，选择玩法' },
  { id: 'join', label: '加入房间', sub: '输入房间码，或跟随好友' },
  { id: 'pet', label: '我的茶宠', sub: '唤醒并测试你的 Agent' },
  { id: 'gallery', label: '画廊', sub: '往期作品 · 即将开放', disabled: true },
  { id: 'settings', label: '设置', sub: '画面 · 声音 · 操作' },
  { id: 'quit', label: '离开茶馆', sub: '退出游戏' },
]

const BG_SCENE: SceneItem[] = [
  { key: 'mountain', x: 0, y: 70, s: 1.15 },
  { key: 'cloud', x: 40, y: -6, s: 0.55 },
  { key: 'house', x: 150, y: 112, s: 0.9 },
  { key: 'tree', x: 300, y: 150, s: 0.55 },
  { key: 'sun', x: 300, y: 0, s: 0.5 },
]

export function HomeScreen({ mode, onMode, onEnter, onJoin }: Props) {
  const [focus, setFocus] = useState(0)
  const [panel, setPanel] = useState<PanelId | null>(null)
  const me = INITIAL_SEATS[0]

  const open = (i: number) => {
    const item = MENU[i]
    setFocus(i)
    if (!item.disabled) setPanel(item.id)
  }
  const move = (d: number) => {
    let i = focus
    do i = (i + d + MENU.length) % MENU.length
    while (MENU[i].disabled)
    setFocus(i)
    if (panel) setPanel(MENU[i].id)
  }

  useBack(() => setPanel(null), !!panel)
  useHotkeys({
    ArrowUp: () => move(-1),
    ArrowDown: () => move(1),
    w: () => move(-1),
    s: () => move(1),
    Enter: () => (panel === 'play' ? onEnter() : open(focus)),
    ...Object.fromEntries(MENU.map((_, i) => [String(i + 1), () => open(i)])),
  })

  return (
    <div className={`scr scr-home ${panel ? 'has-panel' : ''}`}>
      {/* L0 背景：大幅场景 */}
      <div className="l-bg">
        <div className="home-scene">
          <SceneThumb items={BG_SCENE} viewBox="0 0 400 290" animate={160} className="hs-svg" />
          <div className="hs-cursor human" style={{ '--c': '#3D7DD8' } as CSSProperties}>
            <HumanTip />
            <span className="pen-label">阿墨</span>
          </div>
          <div className="hs-cursor agent" style={{ '--c': '#D89A2B' } as CSSProperties}>
            <AgentTip />
            <span className="pen-label">
              <AgentGlyph size={11} color="#fff" />
              栗子 的 Gemini
            </span>
          </div>
        </div>
        <div className="home-vignette" />
      </div>

      {/* L3 HUD：标题 + 主菜单 + 角落信息 */}
      <div className="l-hud">
        <div className="home-title">
          <Logo size={72} />
          <div>
            <h1>茶绘</h1>
            <span>TeaDraw · 带上你的 Agent，来一场纸上茶会</span>
          </div>
        </div>

        <nav className="main-menu" onMouseLeave={() => !panel && setFocus(focus)}>
          {MENU.map((m, i) => (
            <button
              key={m.id}
              className={`mm-item ${focus === i ? 'focus' : ''} ${panel === m.id ? 'on' : ''}`}
              disabled={m.disabled}
              onMouseEnter={() => !m.disabled && setFocus(i)}
              onClick={() => open(i)}
            >
              <span className="mm-idx">{String(i + 1).padStart(2, '0')}</span>
              <span className="mm-text">
                <b>{m.label}</b>
                <small>{m.sub}</small>
              </span>
              <span className="mm-mark" />
            </button>
          ))}
        </nav>

        <div className="anchor a-tr home-tr">
          <button className="hud-chip" onClick={() => setPanel('pet')}>
            <TeaPet color={me.color} status="idle" size={30} />
            <span>
              <b>{me.agent?.name}</b>
              <small>茶宠已唤醒</small>
            </span>
            <i className="conn-dot" />
          </button>
          <div className="hud-chip">
            <Avatar seat={me} size={30} badge={false} />
            <span>
              <b>{me.name}</b>
              <small>Steam 已登录</small>
            </span>
          </div>
        </div>

        <div className="anchor a-bl hud-hints">
          <span>
            <Key k="↑" />
            <Key k="↓" /> 选择
          </span>
          <span>
            <Key k="Enter" /> 确认
          </span>
          <span>
            <Key k="Esc" /> 返回
          </span>
          <em>v0.3 · Demo Build</em>
        </div>

        <button className="anchor a-br hud-chip friends-chip" onClick={() => setPanel('join')}>
          <Users size={16} />
          <span>
            <b>{FRIENDS.filter((f) => f.room).length} 位好友在房间中</b>
            <small>点击跟随加入</small>
          </span>
          <span className="fc-avatars">
            {FRIENDS.slice(0, 4).map((f) => (
              <Avatar key={f.name} seat={{ name: f.name, color: f.color, agent: null }} size={26} />
            ))}
          </span>
        </button>
      </div>

      {/* L4 面板：右侧滑出的纸页 */}
      <div className="l-panel">
        {panel && (
          <section key={panel} className="sheet home-sheet">
            {panel === 'play' && <PlayPanel mode={mode} onMode={onMode} onEnter={onEnter} />}
            {panel === 'join' && <JoinPanel onEnter={onEnter} onJoin={onJoin} />}
            {panel === 'pet' && <PetPanel />}
            {panel === 'settings' && <SettingsPanel />}
            {panel === 'quit' && (
              <SheetBody title="离开茶馆" sub="茶还热着呢，真的要走吗？">
                <div className="sheet-actions">
                  <button className="gbtn" onClick={() => setPanel(null)}>
                    再坐会儿 <Key k="Esc" />
                  </button>
                  <button className="gbtn danger">离开</button>
                </div>
              </SheetBody>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function SheetBody({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <>
      <header className="sheet-head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </header>
      <div className="sheet-body">{children}</div>
    </>
  )
}

function PlayPanel({ mode, onMode, onEnter }: { mode: ModeId; onMode: (m: ModeId) => void; onEnter: () => void }) {
  const ids = Object.keys(MODES) as ModeId[]
  useHotkeys({
    ArrowLeft: () => onMode(ids[(ids.indexOf(mode) + 2) % 3]),
    ArrowRight: () => onMode(ids[(ids.indexOf(mode) + 1) % 3]),
    a: () => onMode(ids[(ids.indexOf(mode) + 2) % 3]),
    d: () => onMode(ids[(ids.indexOf(mode) + 1) % 3]),
  })
  return (
    <SheetBody title="开始茶会" sub="选一种玩法开房，进入茶桌后还能再换">
      <div className="mode-tiles">
        {ids.map((id) => (
          <button key={id} className={`mode-tile ${mode === id ? 'on' : ''}`} onClick={() => onMode(id)} onDoubleClick={onEnter}>
            <div className="mt-art">
              <ModeArt id={id} />
            </div>
            <div className="mt-text">
              <b>{MODES[id].name}</b>
              <span>{MODES[id].en}</span>
              <p>{MODES[id].desc}</p>
              <div className="mt-tags">
                {MODES[id].tags.map((t) => (
                  <i key={t}>{t}</i>
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="sheet-actions">
        <span className="hud-hints inline">
          <Key k="←" />
          <Key k="→" /> 切换玩法
        </span>
        <button className="gbtn primary" onClick={onEnter}>
          创建房间 <ArrowRight size={18} /> <Key k="Enter" />
        </button>
      </div>
    </SheetBody>
  )
}

function JoinPanel({ onEnter, onJoin }: { onEnter: () => void; onJoin?: (code: string) => void }) {
  const [code, setCode] = useState('')
  // 联机：数字 mock 码或 15–21 位 Steam lobby 码；单机 demo 仍按 4 位走
  const ok = onJoin ? /^\d{4,21}$/.test(code) : code.length === 4
  const submit = () => {
    if (!ok) return
    if (onJoin) onJoin(code)
    else onEnter()
  }
  return (
    <SheetBody title="加入房间" sub={onJoin ? '输入房主的数字房间码（测试码或 Steam 大厅码）' : '向房主要四位房间码，或者直接跟随好友'}>
      <label className={`code-boxes ${onJoin ? 'wide' : ''}`}>
        <input
          autoFocus
          value={code}
          maxLength={onJoin ? 21 : 4}
          aria-label="房间码"
          placeholder={onJoin ? '粘贴房主的房间码' : undefined}
          onChange={(e) => setCode(onJoin ? e.target.value.replace(/\D/g, '') : e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && ok && submit()}
        />
        {!onJoin && Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className={i === code.length ? 'cur' : ''}>
            {code[i] ?? ''}
          </span>
        ))}
      </label>
      <button className="gbtn primary wide" disabled={!ok} onClick={submit}>
        入座 <Key k="Enter" />
      </button>
      {/* 联机时隐藏 mock 好友列表（好友跟随功能未实装） */}
      {!onJoin && <div className="sheet-sec">好友</div>}
      {!onJoin && (
        <div className="friend-rows">
          {FRIENDS.map((f) => (
            <div key={f.name} className="friend-row">
              <Avatar seat={{ name: f.name, color: f.color, agent: null }} size={40} />
              <div>
                <b>{f.name}</b>
                <span>{f.status}</span>
              </div>
              {f.room ? (
                <button className="gbtn sm" onClick={onEnter}>
                  跟随加入
                </button>
              ) : (
                <button className="gbtn sm ghost">邀请</button>
              )}
            </div>
          ))}
        </div>
      )}
    </SheetBody>
  )
}

function PetPanel() {
  const agent = INITIAL_SEATS[0].agent!
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [test, setTest] = useState(0)
  useEffect(() => {
    if (!test) return
    setStatus('thinking')
    const a = window.setTimeout(() => setStatus('drawing'), 900)
    const b = window.setTimeout(() => setStatus('idle'), 3200)
    return () => {
      window.clearTimeout(a)
      window.clearTimeout(b)
    }
  }, [test])
  return (
    <SheetBody title="我的茶宠" sub="你的 Agent 通过 CLI + MCP 附身在茶宠身上">
      <div className="pet-stage">
        <TeaPet color={INITIAL_SEATS[0].color} status={status} size={150} />
        <div className="pet-test">{test > 0 ? <SceneThumb key={test} items={[{ key: 'sun', x: 50, y: 0, s: 0.5 }]} viewBox="0 0 200 100" animate={160} /> : <span>让茶宠在这里画一笔，检查链路</span>}</div>
      </div>
      <dl className="kv-rows">
        <dt>附身 Agent</dt>
        <dd>
          <AgentGlyph size={14} color="var(--accent)" /> {agent.name} · {agent.model}
        </dd>
        <dt>连接</dt>
        <dd>stdio · teadraw-mcp</dd>
        <dt>延迟</dt>
        <dd>{agent.latency} ms</dd>
        <dt>可用工具</dt>
        <dd>9 个 · canvas / turn / chat</dd>
      </dl>
      <div className="cli-line">
        <Terminal size={15} />
        <code>teadraw agent attach --room {ROOM_CODE}</code>
        <button className="icon-btn sm" title="复制">
          <Copy size={13} />
        </button>
      </div>
      <div className="sheet-actions">
        <button className="gbtn ghost">断开</button>
        <button className="gbtn primary" onClick={() => setTest((n) => n + 1)}>
          测试画一笔
        </button>
      </div>
    </SheetBody>
  )
}

function SettingsPanel() {
  const [tab, setTab] = useState<'video' | 'audio' | 'input'>('audio')
  const [vol, setVol] = useState({ 主音量: 80, 音乐: 60, 音效: 90, 环境音: 50 })
  return (
    <SheetBody title="设置">
      <div className="g-tabs">
        {(
          [
            ['video', '画面'],
            ['audio', '声音'],
            ['input', '操作'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'audio' &&
        (Object.keys(vol) as (keyof typeof vol)[]).map((k) => (
          <div key={k} className="set-row">
            <span>{k}</span>
            <input type="range" min={0} max={100} value={vol[k]} onChange={(e) => setVol({ ...vol, [k]: +e.target.value })} />
            <b>{vol[k]}</b>
          </div>
        ))}
      {tab === 'video' && (
        <>
          <div className="set-row">
            <span>显示模式</span>
            <div className="g-toggle">
              <button className="on">全屏</button>
              <button>窗口</button>
            </div>
          </div>
          <div className="set-row">
            <span>减少动效</span>
            <div className="g-toggle">
              <button>开</button>
              <button className="on">关</button>
            </div>
          </div>
        </>
      )}
      {tab === 'input' &&
        [
          ['唤起茶宠', 'Ctrl K'],
          ['接受草稿', 'Tab'],
          ['指引笔', 'V'],
          ['画笔', 'B'],
          ['橡皮', 'E'],
          ['抓手', 'H / 空格'],
          ['撤销', 'Ctrl Z'],
        ].map(([a, k]) => (
          <div key={a} className="set-row">
            <span>{a}</span>
            <Key k={k} />
          </div>
        ))}
    </SheetBody>
  )
}

function ModeArt({ id }: { id: ModeId }) {
  if (id === 'tea')
    return (
      <SceneThumb
        items={[
          { key: 'house', x: 52, y: 18, s: 0.62 },
          { key: 'cloud', x: 4, y: -8, s: 0.42 },
          { key: 'tree', x: 150, y: 40, s: 0.45 },
        ]}
        viewBox="0 0 240 140"
      />
    )
  if (id === 'relay')
    return (
      <SceneThumb
        items={[
          { key: 'teapot', x: 20, y: 20, s: 0.5 },
          { key: 'bus', x: 120, y: 40, s: 0.55 },
        ]}
        viewBox="0 0 240 140"
      />
    )
  return <SceneThumb items={[{ key: 'tree', x: 70, y: 0, s: 0.68 }]} viewBox="0 0 240 140" />
}
