import { useEffect, useState, type CSSProperties } from 'react'
import { ArrowLeft, Download, Film, Heart, ImageIcon, Pause, Play, RotateCcw, Trophy } from 'lucide-react'
import type { ModeId, Op, Seat, SvgEl } from '../core/types'
import { MODES } from '../core/theme'
import { tfStr } from '../core/geometry'
import { LEADERBOARD, RELAY_CHAINS, RELAY_STEP, TEA_RESULT_SCENE, TEA_STATS, TEA_THEME } from '../mock/room'
import type { SessionResult } from '../game/gameTypes'
import { opsBounds } from '../game/targeting'
import { Avatar } from '../components/Avatar'
import { AgentGlyph } from '../components/AgentGlyph'
import { SceneThumb } from '../components/SceneThumb'
import { Segmented } from '../components/Segmented'
import { renderEl } from '../components/renderEl'
import { Key, useBack, useHotkeys } from '../ui/Shell'

interface Props {
  mode: ModeId
  onMode: (m: ModeId) => void
  seats: Seat[]
  /** 真实对局产出；深链直达时为 null，回退演示数据 */
  result?: SessionResult | null
  onLobby: () => void
  onAgain: () => void
}

/** 真实笔迹渲染：把 Op[] 画进 svg（带 op.anim 时逐笔回放） */
function OpsView({ ops, animate, className }: { ops: Op[]; animate?: boolean; className?: string }) {
  const b = ops.length ? opsBounds(ops) : { x: 0, y: 0, w: 400, h: 300 }
  const pad = Math.max(14, Math.min(b.w, b.h) * 0.08)
  return (
    <svg viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`} preserveAspectRatio="xMidYMid meet" className={className}>
      {ops.map((o) => (
        <g key={o.id} transform={tfStr(o.tf)}>
          {renderEl(
            o.el,
            animate && o.anim
              ? { className: 'draw', pathLength: 1, style: { '--delay': `${o.anim.delay}ms`, '--dur': `${o.anim.dur}ms` } as CSSProperties }
              : {},
          )}
        </g>
      ))}
    </svg>
  )
}

const elToString = (el: SvgEl): string => `<${el.tag}${Object.entries(el.attrs)
  .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
  .join('')}/>`

/** 把本局笔迹序列化成独立 SVG 文件内容 */
const opsToSvgText = (ops: Op[]): string => {
  const b = ops.length ? opsBounds(ops) : { x: 0, y: 0, w: 400, h: 300 }
  const vb = `${b.x - 12} ${b.y - 12} ${b.w + 24} ${b.h + 24}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${ops
    .map((o) => `<g transform="${tfStr(o.tf)}">${elToString(o.el)}</g>`)
    .join('')}</svg>`
}

const download = (name: string, url: string) => {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

export function ResultScreen({ mode, onMode, seats, result, onLobby, onAgain }: Props) {
  const seatList = result?.seats ?? seats
  const seatOf = (id: number) => seatList.find((s) => s.id === id) ?? seats.find((s) => s.id === id)!
  const ids = Object.keys(MODES) as ModeId[]
  const shift = (d: number) => onMode(ids[(ids.indexOf(mode) + d + ids.length) % ids.length])
  useBack(onLobby)
  useHotkeys({ Enter: onAgain, q: () => shift(-1), e: () => shift(1) })
  return (
    <div className="scr scr-result">
      <div className="l-bg">
        <div className="lobby-floor" />
      </div>
      <div className="l-world result-stage">
        {mode === 'tea' && <TeaResult seatOf={seatOf} seats={seatList} result={result} />}
        {mode === 'relay' && <RelayAlbum seatOf={seatOf} result={result} />}
        {mode === 'guess' && <GuessBoard seatOf={seatOf} result={result} />}
      </div>
      <div className="l-hud">
        <div className="anchor a-tl hud-row">
          <button className="gbtn ghost" onClick={onLobby}>
            <ArrowLeft size={18} /> 回到茶桌 <Key k="Esc" />
          </button>
        </div>
        <div className="anchor a-tc result-title">
          <span>本局结束</span>
          <h2>{MODES[mode].name}</h2>
        </div>
        <div className="anchor a-tr mode-switch sm">
          <Key k="Q" />
          {ids.map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => onMode(m)}>
              {MODES[m].name}
            </button>
          ))}
          <Key k="E" />
        </div>
        <div className="anchor a-br hud-row">
          <button className="gbtn big primary" onClick={onAgain}>
            <RotateCcw size={18} /> 再来一局 <Key k="Enter" />
          </button>
        </div>
      </div>
    </div>
  )
}

type SeatOf = (id: number) => Seat

function TeaResult({ seats, seatOf, result }: { seats: Seat[]; seatOf: SeatOf; result?: SessionResult | null }) {
  const [playing, setPlaying] = useState(true)
  const [filter, setFilter] = useState<'all' | 'human' | 'agent'>('all')
  const [loop, setLoop] = useState(0)
  const stats = result?.inkStats?.length ? result.inkStats : TEA_STATS
  const totalH = stats.reduce((a, s) => a + s.human, 0)
  const totalA = stats.reduce((a, s) => a + s.agent, 0)
  const max = Math.max(...stats.map((s) => s.human + s.agent), 1)
  const share = totalA / Math.max(1, totalH + totalA)
  const C = 2 * Math.PI * 42
  const dur = result ? `${Math.floor(result.durationMs / 60000)}:${String(Math.floor(result.durationMs / 1000) % 60).padStart(2, '0')}` : '18:42'
  const shownOps = (result?.ops ?? []).filter((o) => filter === 'all' || (filter === 'agent') === (o.author === 'agent'))

  const exportPng = () => {
    const svg = opsToSvgText(result?.ops ?? [])
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = 1600
      cv.height = 1200
      const c = cv.getContext('2d')!
      c.fillStyle = '#FAF7F1'
      c.fillRect(0, 0, cv.width, cv.height)
      c.drawImage(img, 0, 0, cv.width, cv.height)
      download('teadraw.png', cv.toDataURL('image/png'))
    }
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  return (
    <main className="result-grid tea-result">
      <section className="card replay-card">
        <div className="card-head">
          <h3>{result?.theme ?? TEA_THEME}</h3>
          <span className="muted">
            {seats.length} 位玩家 · {seats.filter((s) => s.agent).length} 个 Agent · 用时 {dur}
            {result ? ` · ${result.ops.length} 笔` : ' · 演示数据'}
          </span>
        </div>
        <div className="replay-stage">
          {result && result.ops.length ? (
            <OpsView key={loop} ops={shownOps} animate={playing} className="replay-svg" />
          ) : (
            <SceneThumb key={loop} items={TEA_RESULT_SCENE} viewBox="0 0 400 260" animate={playing ? 140 : undefined} className="replay-svg" />
          )}
        </div>
        <div className="replay-bar">
          <button className="icon-btn" onClick={() => (playing ? setPlaying(false) : (setPlaying(true), setLoop((n) => n + 1)))}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div className="scrub">
            <i style={{ width: playing ? '100%' : '0%' }} key={loop} className={playing ? 'run' : ''} />
          </div>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'human', label: '仅人类' },
              { value: 'agent', label: '仅 Agent' },
            ]}
          />
        </div>
        <div className="export-row">
          <button className="btn btn-sm" disabled={!result?.ops.length} onClick={() => download('teadraw.svg', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(opsToSvgText(result?.ops ?? []))}`)}>
            <Download size={14} /> 导出 SVG
          </button>
          <button className="btn btn-sm" disabled={!result?.ops.length} onClick={exportPng}>
            <ImageIcon size={14} /> 导出 PNG
          </button>
          <button className="btn btn-sm" disabled title="录制回放为视频，待 T4 后做">
            <Film size={14} /> 延时视频
          </button>
          <button className="btn btn-sm btn-primary" disabled title="画廊存储待联网（T3）">
            存入画廊
          </button>
        </div>
      </section>

      <section className="card contrib-card">
        <div className="card-head">
          <h3>贡献</h3>
          <span className="muted">按墨量（笔迹长度）统计</span>
        </div>
        <div className="donut-row">
          <svg width="120" height="120" viewBox="0 0 120 120" className="donut">
            <circle cx="60" cy="60" r="42" className="d-human" />
            <circle cx="60" cy="60" r="42" className="d-agent" strokeDasharray={`${C * share} ${C}`} />
          </svg>
          <div className="donut-legend">
            <div>
              <i className="lg-h" /> 人类 <b>{Math.round((1 - share) * 100)}%</b>
              <span className="muted">{totalH.toLocaleString()}</span>
            </div>
            <div>
              <i className="lg-a" /> Agent <b>{Math.round(share * 100)}%</b>
              <span className="muted">{totalA.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="contrib-list">
          {stats.map((st) => {
            const s = seatOf(st.seat)
            return (
              <div key={st.seat} className="contrib" style={{ '--c': s.color } as CSSProperties}>
                <Avatar seat={s} size={26} badge={false} />
                <span className="c-name">{s.name}</span>
                <span className="c-bar">
                  <i className="c-h" style={{ width: `${(st.human / max) * 100}%` }} />
                  <i className="c-a" style={{ width: `${(st.agent / max) * 100}%` }} />
                </span>
                <span className="c-num">{(st.human + st.agent).toLocaleString()}</span>
              </div>
            )
          })}
        </div>
        <p className="side-note">
          <AgentGlyph size={12} color="var(--ink-3)" /> 斜纹部分为 Agent 笔迹 · 共 {seats.filter((s) => s.agent).length} 个 Agent 参与
        </p>
      </section>
    </main>
  )
}

function RelayAlbum({ seatOf, result }: { seatOf: SeatOf; result?: SessionResult | null }) {
  const [chain, setChain] = useState(0)
  const [shown, setShown] = useState(1)
  const [likes, setLikes] = useState<Record<string, boolean>>({})
  const steps = RELAY_CHAINS[chain].steps
  // 我这一步的真实画作：插在链上我那一棒的位置
  const meId = result?.seats.find((s) => s.isMe)?.id
  const myOps = meId != null ? (result?.ops ?? []).filter((o) => o.seat === meId) : []
  const myStep = RELAY_STEP.current - 1

  useEffect(() => {
    setShown(1)
  }, [chain])
  useEffect(() => {
    if (shown >= steps.length) return
    const t = window.setTimeout(() => setShown((n) => n + 1), 1600)
    return () => window.clearTimeout(t)
  }, [shown, steps.length])

  return (
    <main className="result-grid relay-result">
      <aside className="card chain-list">
        <div className="card-head">
          <h3>相册</h3>
          <span className="muted">{RELAY_CHAINS.length} 条传话链</span>
        </div>
        {RELAY_CHAINS.map((c, i) => {
          const s = seatOf(c.starter)
          return (
            <button key={i} className={`chain-item ${chain === i ? 'on' : ''}`} onClick={() => setChain(i)}>
              <Avatar seat={s} size={30} badge={false} />
              <div>
                <b>{s.name} 的起点</b>
                <span>“{c.steps[0].text}”</span>
              </div>
            </button>
          )
        })}
      </aside>

      <section className="album">
        <div className="album-head">
          <h3>
            “{steps[0].text}”<span className="muted"> 的旅程</span>
          </h3>
          <button className="btn btn-sm" onClick={() => setShown(1)}>
            <RotateCcw size={13} /> 重播
          </button>
          <button className="btn btn-sm" onClick={() => setShown(steps.length)}>
            全部展开
          </button>
        </div>
        <div className="album-grid">
          {steps.map((st, i) => {
            const s = seatOf(st.seat)
            const key = `${chain}-${i}`
            return (
              <div key={key} className={`album-card k-${st.kind} ${i < shown ? 'in' : ''}`} style={{ '--c': s.color } as CSSProperties}>
                <div className="ac-head">
                  <span className="ac-step">{i + 1}</span>
                  <Avatar seat={s} size={24} badge={false} />
                  <b>{s.name}</b>
                  {st.withAgent && s.agent && (
                    <span className="ac-agent">
                      <AgentGlyph size={11} color={s.color} />+ {s.agent.name}
                    </span>
                  )}
                  <span className="ac-kind">{st.kind === 'text' ? (i === 0 ? '出题' : '描述') : '作画'}</span>
                </div>
                {st.kind === 'text' ? (
                  <div className="ac-text">“{st.text}”</div>
                ) : (
                  <div className="ac-art">
                    {i === myStep && myOps.length ? <OpsView ops={myOps} className="ac-ops" /> : <SceneThumb items={st.scene ?? []} viewBox="0 0 200 150" />}
                  </div>
                )}
                <div className="ac-foot">
                  <button className={`like ${likes[key] ? 'on' : ''}`} onClick={() => setLikes((l) => ({ ...l, [key]: !l[key] }))}>
                    <Heart size={13} /> 最离谱
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function GuessBoard({ seatOf, result }: { seatOf: SeatOf; result?: SessionResult | null }) {
  const [board, setBoard] = useState<'human' | 'agent'>('human')
  // 真实对局：分数/猜中数来自 seats+guessStats；Agent 墨量占比来自 inkStats
  const rows =
    result?.guessStats != null
      ? result.seats.map((s) => {
          const gs = result.guessStats!.find((x) => x.seat === s.id)
          const ink = result.inkStats.find((x) => x.seat === s.id)
          return {
            seat: s.id,
            score: s.score,
            agentShare: ink ? ink.agent / Math.max(1, ink.human + ink.agent) : 0,
            correct: gs?.correct ?? 0,
            drawn: gs?.drawn ?? 0,
          }
        })
      : LEADERBOARD
  const ranked = [...rows].sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, 3)
  const podium = [top[1], top[0], top[2]].filter(Boolean)

  return (
    <main className="result-grid guess-result">
      <section className="card podium-card">
        <div className="card-head">
          <h3>排行榜</h3>
          <Segmented
            value={board}
            onChange={setBoard}
            options={[
              { value: 'human', label: '玩家榜' },
              { value: 'agent', label: 'Agent 榜' },
            ]}
          />
        </div>
        <div className="podium">
          {podium.map((r) => {
            const s = seatOf(r.seat)
            const place = ranked.indexOf(r) + 1
            return (
              <div key={r.seat} className={`pd p${place}`} style={{ '--c': s.color } as CSSProperties}>
                <Avatar seat={s} size={place === 1 ? 64 : 50} badge={false} />
                <b>{board === 'agent' && s.agent ? s.agent.name : s.name}</b>
                <span className="pd-score">{board === 'agent' ? Math.round(r.score * r.agentShare) : r.score}</span>
                <div className="pd-block">{place === 1 ? <Trophy size={22} /> : place}</div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card board-card">
        <div className="board-row head">
          <span>#</span>
          <span>玩家</span>
          <span>得分</span>
          <span>猜中 / 作画</span>
          <span>人 / Agent 贡献</span>
        </div>
        {ranked.map((r, i) => {
          const s = seatOf(r.seat)
          return (
            <div key={r.seat} className="board-row" style={{ '--c': s.color } as CSSProperties}>
              <span className="br-rank">{i + 1}</span>
              <span className="br-who">
                <Avatar seat={s} size={28} badge={false} />
                <b>{s.name}</b>
                {s.agent && (
                  <span className="muted">
                    <AgentGlyph size={11} color={s.color} /> {s.agent.name}
                  </span>
                )}
              </span>
              <span className="br-score">{r.score}</span>
              <span className="muted">
                {r.correct} / {r.drawn}
              </span>
              <span className="br-share">
                <span className="share-bar">
                  <i className="sh-h" style={{ width: `${(1 - r.agentShare) * 100}%` }} />
                  <i className="sh-a" style={{ width: `${r.agentShare * 100}%` }} />
                </span>
                <span className="muted">{Math.round(r.agentShare * 100)}%</span>
              </span>
            </div>
          )
        })}
        <p className="side-note">
          <AgentGlyph size={12} color="var(--ink-3)" /> 使用 Agent 悄悄提示后猜中，得分 ×0.5；托管模式下 Agent 单独进入 Agent 榜
        </p>
      </section>
    </main>
  )
}
