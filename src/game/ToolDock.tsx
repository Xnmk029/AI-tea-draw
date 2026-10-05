import { useState, type ReactNode } from 'react'
import { Circle, Eraser, Flag, Hand, History, Maximize, Minus, Pencil, Plus, Redo2, Slash, Sparkles, Square, Undo2 } from 'lucide-react'
import type { ToolId } from '../core/types'
import { PALETTE, WIDTHS } from '../core/theme'
import type { GameState } from './gameTypes'

const TOOLS: { id: ToolId; icon: ReactNode; label: string; key: string }[] = [
  { id: 'guide', icon: <Flag size={18} />, label: '指引笔 · 指定 Agent 落笔位置', key: 'V' },
  { id: 'pen', icon: <Pencil size={18} />, label: '画笔', key: 'B' },
  { id: 'line', icon: <Slash size={18} />, label: '直线', key: 'L' },
  { id: 'rect', icon: <Square size={18} />, label: '矩形', key: 'R' },
  { id: 'ellipse', icon: <Circle size={18} />, label: '椭圆', key: 'O' },
  { id: 'eraser', icon: <Eraser size={18} />, label: '橡皮 · 只能擦自己的', key: 'E' },
  { id: 'hand', icon: <Hand size={18} />, label: '抓手', key: 'H' },
]

export function ToolDock({ g }: { g: GameState }) {
  const [pop, setPop] = useState<'color' | null>(null)
  return (
    <div className="tool-dock brush-rack island">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tool ${g.tool === t.id ? 'on' : ''} ${t.id === 'guide' ? 'agent-tool' : ''}`} onClick={() => g.setTool(t.id)} data-tip={`${t.label}  ${t.key}`}>
          {t.icon}
        </button>
      ))}
      <div className="dock-sep" />
      <button className="tool swatch-btn" onClick={() => setPop(pop ? null : 'color')} data-tip="颜色">
        <span className="swatch" style={{ background: g.color }} />
      </button>
      <div className="widths">
        {WIDTHS.map((w) => (
          <button key={w} className={`wd ${g.width === w ? 'on' : ''}`} onClick={() => g.setWidth(w)} data-tip={`粗细 ${w}`}>
            <i style={{ width: Math.min(16, w + 3), height: Math.min(16, w + 3) }} />
          </button>
        ))}
      </div>
      <div className="dock-sep" />
      <button className="tool" onClick={g.undo} data-tip="撤销  Ctrl Z">
        <Undo2 size={17} />
      </button>
      <button className="tool" onClick={g.redo} data-tip="重做  Ctrl ⇧ Z">
        <Redo2 size={17} />
      </button>

      {pop === 'color' && (
        <div className="color-pop island" onMouseLeave={() => setPop(null)}>
          <div className="cp-grid">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`cp-sw ${g.color === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  g.setColor(c)
                  setPop(null)
                }}
              />
            ))}
          </div>
          <label className="cp-custom">
            <input type="color" value={g.color} onChange={(e) => g.setColor(e.target.value)} />
            自定义颜色
          </label>
        </div>
      )}
    </div>
  )
}

export function ZoomDock({ g }: { g: GameState }) {
  return (
    <div className="zoom-dock">
      <div className="island zd-group">
        <button className="icon-btn" onClick={() => g.zoomBy(1 / 1.2)} title="缩小">
          <Minus size={15} />
        </button>
        <button className="zd-val" onClick={g.resetView} title="重置视图">
          {Math.round(g.cam.z * 100)}%
        </button>
        <button className="icon-btn" onClick={() => g.zoomBy(1.2)} title="放大">
          <Plus size={15} />
        </button>
      </div>
      <div className="island zd-group">
        <button className={`icon-btn ${g.highlightAgent ? 'on' : ''}`} onClick={() => g.setHighlightAgent((v) => !v)} title="高亮 Agent 笔迹  A">
          <Sparkles size={15} />
        </button>
        <button className="icon-btn" onClick={g.replay} title="回放全部笔迹">
          <History size={15} />
        </button>
        <button className="icon-btn" onClick={g.resetView} title="适应画面">
          <Maximize size={15} />
        </button>
      </div>
    </div>
  )
}
