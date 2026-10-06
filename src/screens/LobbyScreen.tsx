import { useState, type CSSProperties } from 'react'
import { ArrowLeft, Check, Copy, Crown, Minus, Plus, RotateCcw, Send, UserPlus } from 'lucide-react'
import type { AgentLevel, GuesserAgent, ModeId, PresetId, RoomRules, Seat } from '../core/types'
import { AGENT_LEVELS, GUESSER_AGENT, MODES } from '../core/theme'
import type { NetRoom } from '../game/useNetRoom'
import { ALLOWED_TAGS, BLOCKED_TAGS, POLICY_PRESETS } from '../core/svgPolicy'
import { DEFAULT_RULES, MAX_SEATS, ROOM_CODE, TEA_THEME } from '../mock/room'
import { rollRelayTitle } from '../mock/prompts'
import type { SceneItem } from '../mock/drawings'
import { Avatar } from '../components/Avatar'
import { AgentGlyph } from '../components/AgentGlyph'
import { Segmented } from '../components/Segmented'
import { SceneThumb } from '../components/SceneThumb'
import { TeaPet } from '../game/TeaPet'
import { Key, useBack, useHotkeys } from '../ui/Shell'

interface Props {
  mode: ModeId
  onMode: (m: ModeId) => void
  seats: Seat[]
  onSeats: (s: Seat[]) => void
  rules: RoomRules
  onRules: (r: RoomRules) => void
  onBack: () => void
  onStart: () => void
  room?: NetRoom
}

const LOBBY_CHAT = [
  { seat: 2, text: '我带了 GPT，今天让它画背景' },
  { seat: 3, text: '笔速别调太快，看 Agent 一笔一笔画才有意思' },
  { seat: 4, text: '我没带 Agent，纯手绘参战' },
]

const MODE_ART: Record<ModeId, SceneItem[]> = {
  tea: [
    { key: 'house', x: 40, y: 20, s: 0.6 },
    { key: 'tree', x: 130, y: 40, s: 0.42 },
  ],
  relay: [
    { key: 'teapot', x: 20, y: 20, s: 0.45 },
    { key: 'bus', x: 100, y: 40, s: 0.48 },
  ],
  guess: [{ key: 'tree', x: 60, y: 0, s: 0.62 }],
}

// 茶桌：椭圆桌面，8 个座位沿外圈分布（舞台坐标，桌心在 TABLE.cx/cy）
const TABLE = { cx: 680, cy: 500, rx: 540, ry: 300 }
const seatPos = (i: number) => {
  const a = (-90 + i * 45) * (Math.PI / 180)
  return { left: TABLE.cx + Math.cos(a) * TABLE.rx, top: TABLE.cy + Math.sin(a) * TABLE.ry }
}

type RuleTab = 'agent' | 'round' | 'ink'

export function LobbyScreen({ mode, onMode, seats, onSeats, rules, onRules, onBack, onStart, room }: Props) {
  const me = seats.find((s) => s.isMe) ?? seats[0]
  const [chat, setChat] = useState(LOBBY_CHAT)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<RuleTab>('agent')

  // ---------- 联机大厅 ----------
  // App 常驻会话持有房间连接，大厅只展示房规、成员和聊天。
  const netMode = !!room?.enabled
  const link = room?.ready ? room.link : null
  const netErr = room?.error
  const netRoom = room?.link?.room
  const netMembers = room?.seats ?? []
  const netChat = (room?.chat ?? []).map((m) => ({ text: m.text, name: room?.seats.find((s) => s.id === m.seat)?.name ?? '茶客', color: room?.seats.find((s) => s.id === m.seat)?.color ?? '#8a6a4a' }))
  const viewSeats = netMode ? netMembers.length ? netMembers : [me] : seats
  const isHost = !netMode || !!room?.isHost
  const netQ = netMode ? { name: me.name, room: isHost ? undefined : netRoom } : null
  const readyCount = viewSeats.filter((s) => s.ready).length
  const set = <K extends keyof RoomRules>(k: K, v: RoomRules[K]) => onRules({ ...rules, [k]: v })
  const ids = Object.keys(MODES) as ModeId[]
  /** host 切模式 → 广播给 peer 大厅跟随 */
  const pickMode = (m: ModeId) => {
    if (netMode && !isHost) return
    onMode(m)
  }
  const shiftMode = (d: number) => pickMode(ids[(ids.indexOf(mode) + d + ids.length) % ids.length])
  const toggleReady = () => onSeats(seats.map((s) => (s.isMe ? { ...s, ready: !s.ready } : s)))
  /** host 开局：由常驻会话同步配置与局标识后进入对局 */
  const start = () => {
    if (netMode && (!link || !isHost || netErr || mode === 'relay')) return
    onStart()
  }

  useBack(onBack)
  useHotkeys({ q: () => shiftMode(-1), e: () => shiftMode(1), ' ': netMode ? () => {} : toggleReady, Enter: start })

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    if (!netMode) {
      setChat((c) => [...c, { seat: me.id, text }])
      return
    }
    room?.sendChat(text)
  }

  const copyRoom = () => {
    if (netRoom) void navigator.clipboard?.writeText(netRoom)
  }

  return (
    <div className="scr scr-lobby">
      <div className="l-bg">
        <div className="lobby-floor" />
      </div>

      {/* L1 世界：茶桌与座位 */}
      <div className="l-world">
        <div className="tea-table" style={{ left: TABLE.cx, top: TABLE.cy, width: TABLE.rx * 1.42, height: TABLE.ry * 1.36 }}>
          <div className="tt-center">
            <SceneThumb items={MODE_ART[mode]} viewBox="0 0 200 130" className="tt-art" />
            <b>{MODES[mode].name}</b>
            <span>{MODES[mode].desc}</span>
            <div className="tt-ready">
              {viewSeats.map((s) => (
                <i key={s.id} className={s.ready ? 'on' : ''} style={{ '--c': s.color } as CSSProperties} />
              ))}
              <em>
                {netMode ? `${netMembers.length} 人已入座` : `${readyCount}/${seats.length} 已准备`}
              </em>
            </div>
          </div>
        </div>
        {Array.from({ length: MAX_SEATS }).map((_, i) => {
          const s = viewSeats[i]
          return (
            <div key={i} className="seat-slot" style={seatPos(i)}>
              {s ? (
                <SeatToken seat={s} />
              ) : (
                <button className="seat-token empty">
                  <Plus size={22} />
                  <span>空座</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* L3 HUD */}
      <div className="l-hud">
        <div className="anchor a-tl hud-row">
          <button className="gbtn ghost" onClick={onBack}>
            <ArrowLeft size={18} /> 返回 <Key k="Esc" />
          </button>
          <div className="room-plate">
            <span>茶桌</span>
            <b>#{netMode ? netRoom ?? '…' : ROOM_CODE}</b>
            <button className="icon-btn sm" title="复制房间码" onClick={copyRoom}>
              <Copy size={14} />
            </button>
          </div>
        </div>

        <div className="anchor a-tc mode-switch">
          <Key k="Q" />
          {ids.map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} disabled={netMode && (!isHost || m === 'relay')} title={netMode && m === 'relay' ? '传话联机尚未开放' : netMode && !isHost ? '跟随房主' : undefined} onClick={() => pickMode(m)}>
              {MODES[m].name}
            </button>
          ))}
          <Key k="E" />
        </div>

        <div className="anchor a-tr">
          <button className="gbtn ghost" onClick={copyRoom}>
            <UserPlus size={18} /> 邀请好友
          </button>
        </div>

        <div className="anchor a-bl lobby-chat-strip">
          <div className="lcs-list">
            {netErr && (
              <div className="lcs-msg">
                <b style={{ color: '#b4552f' }}>联机</b>
                <span>{netErr}</span>
              </div>
            )}
            {netMode
              ? netChat.slice(-3).map((m, i) => (
                  <div key={i} className="lcs-msg">
                    <b style={{ color: m.color }}>{m.name}</b>
                    <span>{m.text}</span>
                  </div>
                ))
              : chat.slice(-3).map((m, i) => {
                  const s = seats.find((x) => x.id === m.seat)!
                  return (
                    <div key={i} className="lcs-msg">
                      <b style={{ color: s.color }}>{s.name}</b>
                      <span>{m.text}</span>
                    </div>
                  )
                })}
          </div>
          <div className="lcs-input">
            <input placeholder="和大家聊两句…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button className="icon-btn" onClick={send}>
              <Send size={16} />
            </button>
          </div>
        </div>

        <div className="anchor a-br hud-row">
          <div className="me-status">
            <TeaPet color={me.color} status={netMode ? (link ? 'review' : 'idle') : me.ready ? 'review' : 'idle'} size={44} />
            <span>
              {netMode ? (
                <>
                  <b>{netQ?.name ?? me.name}{!netQ?.room ? ' · 房主' : ''}</b>
                  <small>{link ? `${link.transport === 'steam' ? 'Steam' : 'Mock'} 联机 · ${netMembers.length} 人已入座` : netErr ? '联机失败' : '连接联机桥…'}</small>
                </>
              ) : (
                <>
                  <b>{me.agent ? `${me.agent.name} 已就位` : '未携带茶宠'}</b>
                  <small>{me.agent ? `${me.agent.model} · ${me.agent.latency}ms` : '纯手绘参战'}</small>
                </>
              )}
            </span>
          </div>
          {!netMode && (
            <button className={`gbtn big ${me.ready ? 'ghost' : ''}`} onClick={toggleReady}>
              {me.ready ? '取消准备' : '准备'} <Key k="Space" />
            </button>
          )}
          <button className="gbtn big primary" onClick={netMode && netErr ? room?.retry : start} disabled={netMode && (!link || !isHost || mode === 'relay') && !netErr}>
            {netMode ? (
              netErr ? (
                '重新连接'
              ) : !link ? (
                '连接联机桥…'
              ) : !isHost ? (
                '等待房主开局…'
              ) : (
                <>
                  开始游戏 <em className="gb-sub">{netMembers.length} 人已入座</em> <Key k="Enter" />
                </>
              )
            ) : (
              <>
                开始游戏 <em className="gb-sub">{readyCount}/{viewSeats.length}</em> <Key k="Enter" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* L4 面板：茶单（规则） */}
      <div className="l-panel">
        <aside className="sheet rules-sheet">
          <header className="sheet-head row">
            <h2>茶单</h2>
            <p>仅房主可修改</p>
            <button className="gbtn sm ghost" disabled={netMode && !isHost} onClick={() => onRules(DEFAULT_RULES)}>
              <RotateCcw size={14} /> 默认
            </button>
          </header>
          <div className="g-tabs">
            <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>
              茶宠
            </button>
            <button className={tab === 'round' ? 'on' : ''} onClick={() => setTab('round')}>
              回合
            </button>
            <button className={tab === 'ink' ? 'on' : ''} onClick={() => setTab('ink')}>
              笔墨
            </button>
          </div>
          <fieldset className="sheet-body" disabled={netMode && !isHost} style={{ border: 0, margin: 0, minWidth: 0 }}>
            {tab === 'agent' && (
              <>
                <div className="rule">
                  <div className="rule-label">参与度</div>
                  <div className="level-list">
                    {(Object.keys(AGENT_LEVELS) as AgentLevel[]).map((l) => (
                      <button key={l} className={`level ${rules.agentLevel === l ? 'on' : ''}`} onClick={() => set('agentLevel', l)}>
                        <span className="radio">{rules.agentLevel === l && <Check size={11} strokeWidth={3} />}</span>
                        <b>{AGENT_LEVELS[l].name}</b>
                        <span>{AGENT_LEVELS[l].desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {mode === 'guess' && (
                  <div className="rule">
                    <div className="rule-label">猜词方的茶宠</div>
                    <Segmented
                      value={rules.guesserAgent}
                      onChange={(v: GuesserAgent) => set('guesserAgent', v)}
                      options={(Object.keys(GUESSER_AGENT) as GuesserAgent[]).map((g) => ({ value: g, label: GUESSER_AGENT[g].name }))}
                    />
                    <p className="rule-hint">{GUESSER_AGENT[rules.guesserAgent].desc}</p>
                  </div>
                )}
                <div className="rule">
                  <div className="rule-label">
                    墨囊上限 <b>{Math.round(rules.inkRatio * 100)}%</b>
                  </div>
                  <input type="range" min={0.2} max={0.8} step={0.05} value={rules.inkRatio} onChange={(e) => set('inkRatio', +e.target.value)} />
                  <p className="rule-hint">茶宠的笔迹最多占本座位总墨量的比例</p>
                </div>
                <div className="rule">
                  <div className="rule-label">
                    笔速 <b>{rules.penSpeed} px/s</b>
                  </div>
                  <input type="range" min={300} max={2000} step={100} value={rules.penSpeed} onChange={(e) => set('penSpeed', +e.target.value)} />
                </div>
              </>
            )}
            {tab === 'round' && (
              <>
                {mode === 'tea' ? (
                  <>
                    <div className="rule">
                      <div className="rule-label">本场主题</div>
                      <input
                        className="rule-input"
                        placeholder={TEA_THEME}
                        value={rules.theme ?? ''}
                        onChange={(e) => set('theme', e.target.value.trim() || undefined)}
                      />
                      <p className="rule-hint">显示在房间顶部，也会作为作画主题发给 Agent；留空用默认主题</p>
                    </div>
                    <p className="rule-hint big">基础茶绘不限时、不计分，随时可以结束。</p>
                  </>
                ) : (
                  <div className="rule two">
                    <div>
                      <div className="rule-label">单轮时间</div>
                      <div className="stepper number">
                        <input
                          type="number"
                          min={10}
                          max={300}
                          step={5}
                          value={rules.roundTime}
                          onChange={(e) => {
                            const v = Math.min(300, Math.max(10, Number(e.target.value) || 80))
                            set('roundTime', v)
                          }}
                        />
                        <span className="unit">秒</span>
                      </div>
                    </div>
                    <div>
                      <div className="rule-label">轮数</div>
                      <div className="stepper">
                        <button onClick={() => set('rounds', Math.max(1, rules.rounds - 1))}>
                          <Minus size={13} />
                        </button>
                        <b>{rules.rounds}</b>
                        <button onClick={() => set('rounds', Math.min(8, rules.rounds + 1))}>
                          <Plus size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {mode === 'relay' && (
                  <div className="rule">
                    <div className="rule-label">本场题目</div>
                    <div className="relay-title-card">
                      <b>{rules.relayPrompt || '开局随机抽一条网文标题'}</b>
                      <div className="relay-title-btns">
                        <button className="btn btn-sm" onClick={() => set('relayPrompt', rollRelayTitle())}>
                          换一个
                        </button>
                        {rules.relayPrompt && (
                          <button className="btn btn-sm" onClick={() => set('relayPrompt', undefined)}>
                            随机
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="rule-hint">网文标题生成器：世界 × 职业 × 金手指 × 营生，如「我在大唐送外卖」</p>
                  </div>
                )}
                {mode === 'guess' && (
                  <div className="rule">
                    <div className="rule-label">自定义词库</div>
                    <textarea
                      className="rule-input"
                      rows={2}
                      placeholder="风筝、灯笼、自行车……（顿号或逗号分隔）"
                      value={(rules.wordBank ?? []).join('、')}
                      onChange={(e) => set('wordBank', e.target.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean))}
                    />
                    <p className="rule-hint">追加进抽词池；自定义词没有参考画，茶宠会自由发挥（可能翻车）</p>
                  </div>
                )}
                <div className="rule">
                  <div className="rule-label">避让笔迹</div>
                  <Segmented
                    value={rules.avoidOthers !== false ? 'on' : 'off'}
                    onChange={(v) => set('avoidOthers', v === 'on')}
                    options={[
                      { value: 'on', label: '自动微挪' },
                      { value: 'off', label: '允许叠画' },
                    ]}
                  />
                  <p className="rule-hint">茶宠落点和别人的笔迹重叠时自动避让</p>
                </div>
                <div className="rule">
                  <div className="rule-label">落笔指引</div>
                  <div className="rule two">
                    <div>
                      <div className="rule-sub">标记可见</div>
                      <Segmented
                        value={rules.targetsPublic ? 'pub' : 'priv'}
                        onChange={(v) => set('targetsPublic', v === 'pub')}
                        options={[
                          { value: 'pub', label: '公开' },
                          { value: 'priv', label: '仅自己' },
                        ]}
                      />
                    </div>
                    <div>
                      <div className="rule-sub">越界</div>
                      <Segmented
                        value={rules.targetFit}
                        onChange={(v) => set('targetFit', v)}
                        options={[
                          { value: 'contain', label: '放入' },
                          { value: 'clip', label: '裁切' },
                          { value: 'strict', label: '严格' },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
            {tab === 'ink' && (
              <div className="rule">
                <div className="rule-label">SVG 笔墨规矩</div>
                <Segmented value={rules.svgPreset} onChange={(v: PresetId) => set('svgPreset', v)} options={(Object.keys(POLICY_PRESETS) as PresetId[]).map((p) => ({ value: p, label: POLICY_PRESETS[p].label }))} />
                <p className="rule-hint">{POLICY_PRESETS[rules.svgPreset].desc}</p>
                <div className="tag-cloud">
                  {ALLOWED_TAGS.map((t) => (
                    <code key={t} className="tg ok">
                      {t}
                    </code>
                  ))}
                  {BLOCKED_TAGS.map((t) => (
                    <code key={t} className="tg no">
                      {t}
                    </code>
                  ))}
                </div>
              </div>
            )}
          </fieldset>
        </aside>
      </div>
    </div>
  )
}

function SeatToken({ seat }: { seat: Seat }) {
  return (
    <div className={`seat-token ${seat.ready ? 'ready' : ''} ${seat.isMe ? 'me' : ''}`} style={{ '--c': seat.color } as CSSProperties}>
      <div className="st-av">
        <Avatar seat={seat} size={64} badge={false} />
        {seat.ready && (
          <span className="st-check">
            <Check size={13} strokeWidth={3.2} />
          </span>
        )}
      </div>
      <div className="st-plate">
        <b>
          {seat.name}
          {seat.isHost && <Crown size={13} className="crown" />}
        </b>
        {seat.agent ? (
          <span className="st-pet">
            <AgentGlyph size={12} color={seat.color} /> {seat.agent.name}
          </span>
        ) : (
          <span className="st-pet none">无茶宠</span>
        )}
      </div>
    </div>
  )
}
