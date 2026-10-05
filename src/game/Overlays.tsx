import { ArrowRight, Check, Trophy } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { AgentGlyph } from '../components/AgentGlyph'
import { SceneThumb } from '../components/SceneThumb'
import type { GameState } from './gameTypes'

export function WordPicker({ g }: { g: GameState }) {
  return (
    <div className="overlay">
      <div className="modal word-picker">
        <div className="modal-eyebrow">第 {g.round} 轮 · 轮到你作画</div>
        <h2>选一个词</h2>
        <div className="words">
          {g.wordOptions.map((w) => (
            <button key={w.word} className="word-card" onClick={() => g.pickWord(w)}>
              <SceneThumb items={[{ key: w.drawing, x: 50, y: 10, s: 0.65 }]} viewBox="0 0 200 150" className="wc-art" />
              <b>{w.word}</b>
              <span className={`pill ${w.level === '简单' ? 'ok' : 'warn'}`}>{w.level}</span>
            </button>
          ))}
        </div>
        <p className="modal-note">
          <AgentGlyph size={13} color="var(--accent)" />
          你的 Agent 会同时收到这个词；它的思考内容对猜词者隐藏，画布上禁止出现文字。
        </p>
      </div>
    </div>
  )
}

export function RelayWaiting({ g, onFinish }: { g: GameState; onFinish: () => void }) {
  const left = g.relayQueue.length
  const allDone = g.relayChains.every((c) => c.steps.every((s) => s.done))
  return (
    <div className="overlay soft">
      <div className="modal relay-wait">
        <div className="rw-check">
          <Check size={22} strokeWidth={3} />
        </div>
        <h2>{allDone ? '全部完成' : left > 0 ? `还有 ${left} 题待画` : '等待新题目'}</h2>
        <p className="muted">
          {allDone
            ? '本轮传画链全部完成，可以揭晓了'
            : left > 0
              ? '队列里还有派发给你的题目，继续画吧'
              : '其他玩家正在接力，新题目马上到你'}
        </p>
        <div className="rw-people">
          {g.relayChains.map((chain) => {
            const done = chain.steps.filter((s) => s.done).length
            return (
              <div key={chain.id} className={`rw-p ${done === chain.steps.length ? 'done' : ''}`}>
                <span>{done}/{chain.steps.length}</span>
              </div>
            )
          })}
        </div>
        <button className="btn btn-primary" onClick={onFinish}>
          {allDone ? '揭晓相册' : '先去看看'} <ArrowRight size={15} />
        </button>
      </div>
    </div>
  )
}

export function RoundOver({ g, onFinish }: { g: GameState; onFinish: () => void }) {
  const answer = g.role === 'drawer' ? g.word?.word : g.answer
  const ranked = [...g.seats].sort((a, b) => b.score - a.score)
  return (
    <div className="overlay soft">
      <div className="modal round-over">
        <div className="modal-eyebrow">第 {g.round}/{g.roundsTotal} 轮结束</div>
        <h2>
          答案是 <span className="answer">{answer}</span>
        </h2>
        <div className="ro-list">
          {ranked.map((s, i) => (
            <div key={s.id} className="ro-row">
              <span className="ro-rank">{i === 0 ? <Trophy size={14} /> : i + 1}</span>
              <Avatar seat={s} size={28} badge={false} />
              <b>{s.name}</b>
              {s.isMe && <em className="me-tag">你</em>}
              <span className="ro-score">{s.score}</span>
            </div>
          ))}
        </div>
        <div className="ro-actions">
          {!g.isLastRound && (
            <button className="btn btn-primary" onClick={g.nextRound}>
              下一轮 <ArrowRight size={15} />
            </button>
          )}
          <button className={g.isLastRound ? 'btn btn-primary' : 'btn'} onClick={onFinish}>
            {g.isLastRound ? '查看结算' : '提前结算'} <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
