import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Copy, Download, Link, RotateCcw, Terminal } from 'lucide-react'
import type { Op } from '../core/types'
import type { Rect } from '../core/geometry'
import { tfStr } from '../core/geometry'
import { renderEl } from '../components/renderEl'
import { TeaPet } from '../game/TeaPet'
import { targetRect } from '../game/targeting'
import { useAgentSession } from './AgentSession'
import type { PetGuide, PetSandbox, PetTrial } from './petTypes'
import {
  AGENT_STYLES, COLOR_SCHEMES, COMPOSITIONS, agentStyleName, buildAgentPrompt,
  readAgentStylePresets, useAgentPreferences, writeAgentStylePresets,
} from './preferences'
import './pet.css'

type Tab = 'draw' | 'style' | 'history' | 'connection'
const TASKS = [
  { name: '茶壶', text: '画一只冒着热气的茶壶，壶嘴、把手和壶盖都要清晰可辨。' },
  { name: '松树', text: '画一棵松树与远山，用简洁的枝干和松针表现姿态。' },
  { name: '纸飞机', text: '画一架向右飞的纸飞机，用折线清楚表现纸张折面。' },
  { name: '人物表情', text: '画一个开心的小人物头像，眉眼和嘴角表达明显情绪，不写文字。' },
  { name: '建筑', text: '画一间带屋檐、门窗的小茶馆，结构清楚，周围适度留白。' },
  { name: '重复花纹', text: '画三组大小相近的叶片花纹，间距均匀，形态有小幅变化。' },
  { name: '补画', text: '先观察已有笔迹，保留它们，为画面补充少量相合的细节，不覆盖原来的主体。' },
]
const GUIDES: { id: PetGuide; name: string }[] = [
  { id: 'none', name: '自由找空位' }, { id: 'center', name: '中央区域' },
  { id: 'corner', name: '角落令旗' }, { id: 'narrow', name: '狭长区域' },
  { id: 'path', name: '沿线引路' }, { id: 'anchor', name: '锚定补画' },
]
const STAGES: Record<PetSandbox['taskState'], string> = {
  idle: '等待试画', queued: '已发送 · 等待领取', claimed: 'Agent 已领取 · 正在思考', preview: '草稿已返回 · 等待盖章',
  drawing: '正在逐笔落定', completed: '真实作画完成', cancelled: '任务已取消', failed: '任务失败',
}
const TABS: { id: Tab; name: string }[] = [
  { id: 'draw', name: '试画与调试' }, { id: 'style', name: '绘画风格' },
  { id: 'history', name: '记录与对比' }, { id: 'connection', name: '连接' },
]
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
const xml = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const svgAttr = (key: string) => key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
const toSvg = (ops: Op[], frame: Rect) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${frame.x} ${frame.y} ${frame.w} ${frame.h}" width="${frame.w}" height="${frame.h}">${ops.map(op => `<g transform="${tfStr(op.tf)}"><${op.el.tag}${Object.entries(op.el.attrs).map(([key, value]) => ` ${svgAttr(key)}="${xml(value)}"`).join('')}/></g>`).join('')}</svg>`
const saveFile = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
const stableValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const baselineSignature = (ops: Op[]) => stableValue(ops.map(op => ({ el: op.el, tf: op.tf, author: op.author })))
const TrialOp = memo(function TrialOp({ op, animate = false }: { op: Op; animate?: boolean }) {
  return <g data-pet-op={op.id} data-author={op.author} transform={tfStr(op.tf)}>{renderEl(op.el, animate && op.anim ? {
    seed: op.id, className: 'draw', pathLength: 1,
    style: { '--delay': `${op.anim.delay}ms`, '--dur': `${op.anim.dur}ms` } as CSSProperties,
  } : { seed: op.id })}</g>
})

function TrialPaper({ ops, frame, animate = false, pet, label }: { ops: Op[]; frame: Rect; animate?: boolean; pet?: PetSandbox; label: string }) {
  return (
    <div className="pet-paper">
      <svg role="img" aria-label={label} viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`} preserveAspectRatio="xMidYMid meet">
        {ops.map(op => <TrialOp key={op.id} op={op} animate={animate} />)}
        {pet?.marks.map(mark => {
          const rect = targetRect(mark.target)
          return <g key={mark.id} className="pet-target"><rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={3} /><title>{GUIDES.find(x => x.id === pet.guide)?.name}</title>{mark.target.kind === 'path' && <polyline points={mark.target.points.map(p => `${p.x},${p.y}`).join(' ')} />}</g>
        })}
        {pet?.ghost?.ops.map(op => <g key={op.id} className="pet-ghost" transform={tfStr(op.tf)}>{renderEl(op.el, { seed: op.id })}</g>)}
      </svg>
      {!ops.length && !pet?.ghost && <span className="pet-paper-empty">{pet?.taskState === 'queued' || pet?.taskState === 'claimed' ? '等待真实 Agent 返回作品…' : '一张独立试画纸 · 发送题目开始'}</span>}
      <small>{frame.w} × {frame.h}</small>
    </div>
  )
}

export function PetWorkbench({ pet }: { pet: PetSandbox }) {
  const session = useAgentSession()
  const { preferences, update, reset } = useAgentPreferences()
  const [tab, setTab] = useState<Tab>('draw')
  const [text, setText] = useState(TASKS[0].text)
  const [notice, setNotice] = useState('')
  const [presets, setPresets] = useState(readAgentStylePresets)
  const [presetId, setPresetId] = useState('')
  const [presetName, setPresetName] = useState('我的水墨')
  const [port, setPort] = useState(String(session?.port ?? 5190))
  const [launchName, setLaunchName] = useState(session?.peer.name ?? '绘画茶宠')
  const [launchModel, setLaunchModel] = useState(session?.peer.model ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')
  const selected = pet.history.find(item => item.id === selectedId) ?? pet.history[0]
  const a = pet.history.find(item => item.id === compareA)
  const b = pet.history.find(item => item.id === compareB)
  const compareDifferences = a && b ? [
    ...(a.text.trim() !== b.text.trim() ? ['题目'] : []),
    ...(baselineSignature(a.baselineOps) !== baselineSignature(b.baselineOps) ? ['初始笔迹'] : []),
    ...(a.guide !== b.guide ? ['落笔指引'] : []),
    ...(stableValue(a.rules) !== stableValue(b.rules) ? ['试画限制'] : []),
  ] : []
  const busy = ['queued', 'claimed', 'preview', 'drawing'].includes(pet.taskState)
  const connected = !!session?.connected
  const prompt = useMemo(() => buildAgentPrompt(text, preferences), [text, preferences])
  const shownPrompt = busy && pet.history[0] ? pet.history[0].prompt : prompt
  const portValid = /^\d{1,5}$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535
  const launchCommand = `node server/teadraw.mjs mcp --port ${portValid ? port : session?.port ?? 5190} --name ${quote(launchName.trim() || '绘画茶宠')} --model ${quote(launchModel.trim() || '请填写实际模型')}`
  const connectionText = connected ? '真实 Agent 已连接' : !session?.enabled ? '尚未连接' : session.peer.state === 'ready' ? '桥已连接 · 等待 MCP 客户端' : session.peer.state === 'connecting' ? '正在连接本机桥…' : '连接中断 · 正在重试'
  useEffect(() => setPort(String(session?.port ?? 5190)), [session?.port])
  useEffect(() => { if (session?.peer.name) setLaunchName(session.peer.name); if (session?.peer.model) setLaunchModel(session.peer.model) }, [session?.peer.name, session?.peer.model])
  const storePresets = (next: typeof presets) => { setPresets(next); return writeAgentStylePresets(next) }
  const savePreset = (copy: boolean) => {
    if (!presetName.trim()) { setNotice('先为预设取一个名字。'); return }
    const id = !copy && presetId ? presetId : `style-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const value = { id, name: presetName.trim().slice(0, 40), preferences: { ...preferences } }
    const next = presets.some(item => item.id === id) ? presets.map(item => item.id === id ? value : item) : [...presets, value]
    if (next.length > 24) { setNotice('最多保存 24 个预设，请先删除不用的预设。'); return }
    const stored = storePresets(next)
    setPresetId(id); setNotice(stored ? copy ? '已复制当前风格为新预设。' : '已保存风格预设。' : '浏览器存储不可用，预设只保留在本次打开的工作台中。')
  }
  const retry = (item: PetTrial) => {
    if (busy) { setNotice('请先完成或取消当前任务。'); return }
    pet.restoreBaseline(item.baselineOps); update(item.preferences); pet.setDebugRules(item.rules)
    pet.setGuide(item.guide); setText(item.text); setTab('draw')
    window.setTimeout(() => pet.send(item.text), 0)
  }
  const compareAgain = (item: PetTrial) => {
    if (busy) { setNotice('请先完成或取消当前任务。'); return }
    pet.restoreBaseline(item.baselineOps); pet.setDebugRules(item.rules)
    pet.setGuide(item.guide); setText(item.text); setTab('draw')
    setCompareA(item.id)
    setNotice('已在新纸上恢复相同题目和试画限制，使用当前风格再次作画；完成后可在记录中选择为作品 B。')
    window.setTimeout(() => pet.send(item.text), 0)
  }
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice('已复制。') } catch { setNotice('无法访问剪贴板，请选中内容手动复制。') }
  }
  return (
    <div className="pet-workbench">
      <header className="pet-head">
        <TeaPet color="#A74732" status={connected ? pet.status : 'offline'} size={72} />
        <div><h2>我的茶宠</h2><p>连接、调风格、真实试画 · 个人风格会跟随茶宠进入房间</p></div>
        <button className={`pet-connection ${connected ? 'on' : ''}`} onClick={() => setTab('connection')}><i />{connectionText}</button>
      </header>
      <div className="pet-tabs" role="tablist" aria-label="茶宠工作台">
        {TABS.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} aria-controls={`pet-tab-${item.id}`} id={`pet-tab-button-${item.id}`} className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)}>{item.name}{item.id === 'history' && pet.history.length > 0 && <small>{pet.history.length}</small>}</button>)}
      </div>
      <div className="pet-tab-content" role="tabpanel" id={`pet-tab-${tab}`} aria-labelledby={`pet-tab-button-${tab}`}>
        {notice && <div className="pet-notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
        {tab === 'draw' && <>
          <div className="pet-draw-grid">
            <div className="pet-draw-main">
              <div className="pet-paper-title"><b>独立试画纸</b><span>{busy && pet.history[0] ? pet.history[0].styleName : agentStyleName(preferences)} · {GUIDES.find(item => item.id === pet.guide)?.name}</span></div>
              <TrialPaper ops={pet.ops} frame={pet.frame} animate pet={pet} label="茶宠真实试画画布" />
              <div className={`pet-task-status ${pet.taskState}`} role="status"><span>{STAGES[pet.taskState]}</span><span>{pet.ops.length} 笔{pet.ghost ? ` · 草稿 ${pet.ghost.ops.length} 笔 / ${Math.round(pet.ghost.ink)} 墨` : ''}</span></div>
              {pet.error && <div className="pet-error" role="alert">{pet.error}</div>}
              {pet.ghost && <div className="pet-preview-actions"><span>{pet.ghost.label}{pet.ghost.notes.length ? ` · ${pet.ghost.notes.join('；')}` : ''}</span><button className="gbtn sm primary" onClick={pet.accept}>盖章落笔</button><button className="gbtn sm" onClick={pet.reject}>揉掉草稿</button></div>}
              <div className="pet-task-presets" aria-label="试画题目预设">{TASKS.map(item => <button key={item.name} className={text === item.text ? 'on' : ''} onClick={() => setText(item.text)}>{item.name}</button>)}</div>
              <label className="pet-field">本次题目<textarea aria-label="试画提示词" maxLength={3000} value={text} onChange={event => setText(event.target.value)} placeholder="说说希望茶宠画什么，也可以要求补画已有笔迹…" /></label>
              <div className="pet-action-row">
                <button className="gbtn primary" disabled={!connected || busy || !text.trim()} onClick={() => pet.send(text)}>{busy ? '任务进行中' : '发送真实试画'}</button>
                <button className="gbtn" disabled={!busy} onClick={pet.cancel}>取消任务</button>
                <button className="gbtn ghost" disabled={busy} onClick={pet.clear}>清空试画纸</button>
                <button className="gbtn ghost" disabled={!text.trim()} onClick={() => { try { localStorage.setItem('teadraw.presetPrompt', text); setNotice('已保存，下次进入对局将填入吩咐栏。') } catch { setNotice('当前浏览器无法保存提示词。') } }}>带入对局吩咐</button>
              </div>
              {!connected && <p className="pet-muted">先在“连接”中接入真实 Agent，再发送试画。连接到桥后还需 MCP 客户端在线。</p>}
              <details className="pet-details"><summary>{busy ? '查看本次实际发送的完整提示词' : '查看下次试画的完整提示词'}</summary><pre>{shownPrompt}</pre><button className="gbtn sm" onClick={() => void copy(shownPrompt)}>复制提示词</button></details>
            </div>
            <aside className="pet-debug">
              <h3>试画调试</h3><p className="pet-muted">这些限制只作用于试画纸；正式房间使用房主的房规。</p>
              <label className="pet-field">落笔指引<select value={pet.guide} aria-label="试画落笔指引" disabled={busy} onChange={event => pet.setGuide(event.target.value as PetGuide)}>{GUIDES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <button className="gbtn sm" disabled={busy} onClick={() => { pet.seedHuman(); setText(TASKS[6].text); setNotice('已加入人类起笔，请发送“补画”测试协作。') }}>加入人类起笔</button>
              <label className="pet-field">落笔方式<select aria-label="试画落笔方式" value={pet.debugRules.agentLevel} disabled={busy} onChange={event => pet.setDebugRules({ agentLevel: event.target.value as 'assist' | 'collab' })}><option value="assist">助手 · 草稿需盖章</option><option value="collab">协作 · 允许直接落笔</option></select></label>
              <label className="pet-field">SVG 校验<select aria-label="试画SVG校验" value={pet.debugRules.svgPreset} disabled={busy} onChange={event => pet.setDebugRules({ svgPreset: event.target.value as 'strict' | 'standard' | 'loose' })}><option value="strict">严格 · 仅描边</option><option value="standard">标准</option><option value="loose">宽松</option></select></label>
              <label className="pet-field">越界策略<select aria-label="试画越界策略" value={pet.debugRules.targetFit} disabled={busy} onChange={event => pet.setDebugRules({ targetFit: event.target.value as 'contain' | 'clip' | 'strict' })}><option value="contain">适配放入</option><option value="clip">裁切</option><option value="strict">拒绝越界</option></select></label>
              <label className="pet-range">笔速 <b>{pet.debugRules.penSpeed} px/s</b><input aria-label="试画笔速" type="range" min={100} max={2400} step={100} disabled={busy} value={pet.debugRules.penSpeed} onChange={event => pet.setDebugRules({ penSpeed: +event.target.value })} /></label>
              <label className="pet-range">墨量上限 <b>{pet.debugRules.inkLimit}</b><input aria-label="试画墨量上限" type="range" min={500} max={30000} step={500} disabled={busy} value={pet.debugRules.inkLimit} onChange={event => pet.setDebugRules({ inkLimit: +event.target.value })} /></label>
              <label className="pet-check"><input type="checkbox" aria-label="试画避让已有笔迹" disabled={busy} checked={pet.debugRules.avoidOthers} onChange={event => pet.setDebugRules({ avoidOthers: event.target.checked })} />避让已有笔迹</label>
              <div className="pet-limit-buttons"><button className="gbtn sm" disabled={busy} onClick={() => pet.setDebugRules({ inkLimit: 1000, svgPreset: 'strict', penSpeed: 100 })}>少墨慢笔测试</button><button className="gbtn sm ghost" disabled={busy} onClick={() => pet.setDebugRules({ inkLimit: 4000, svgPreset: 'standard', penSpeed: 900, agentLevel: 'assist', targetFit: 'contain', avoidOthers: true })}>恢复试画限制</button></div>
            </aside>
          </div>
        </>}
        {tab === 'style' && <div className="pet-style-grid">
          <div>
            <h3>画法预设</h3><p className="pet-muted">调整生成指令；笔触显示仍由游戏统一渲染。</p>
            <div className="pet-style-choices">{AGENT_STYLES.map(style => <button key={style.id} className={preferences.styleId === style.id ? 'on' : ''} onClick={() => { update({ styleId: style.id, stylePrompt: style.prompt }); setPresetId(''); setPresetName(`我的${style.name}`) }}><b>{style.name}</b><span>{style.prompt}</span></button>)}</div>
            <label className="pet-field">可编辑风格提示词<textarea aria-label="风格提示词" maxLength={2400} value={preferences.stylePrompt} onChange={event => update({ stylePrompt: event.target.value })} /></label>
            <label className="pet-field">额外绘画要求<textarea aria-label="额外绘画要求" maxLength={1600} value={preferences.customInstructions} onChange={event => update({ customInstructions: event.target.value })} placeholder="例如：重点画轮廓，尽量保留左上角空间。" /></label>
          </div>
          <aside className="pet-style-settings">
            <h3>个人绘画偏好</h3>
            {([
              ['detail', '细节', '简洁', '细致'], ['regularity', '结构', '随性', '规整'], ['intensity', '墨色', '淡雅', '浓烈'],
            ] as const).map(([key, name, lo, hi]) => <label className="pet-range" key={key}>{name}<b>{preferences[key]}</b><input aria-label={`绘画${name}`} type="range" min={0} max={100} value={preferences[key]} onChange={event => update({ [key]: +event.target.value })} /><span>{lo}<i />{hi}</span></label>)}
            <label className="pet-field">构图<select aria-label="绘画构图" value={preferences.composition} onChange={event => update({ composition: event.target.value as typeof preferences.composition })}>{COMPOSITIONS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="pet-field">配色<select aria-label="绘画配色" value={preferences.colorScheme} onChange={event => update({ colorScheme: event.target.value as typeof preferences.colorScheme })}>{COLOR_SCHEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="pet-preset-manager">
              <h3>我的风格预设</h3>
              <label className="pet-field">已保存预设<select aria-label="已保存风格预设" value={presetId} onChange={event => { const item = presets.find(value => value.id === event.target.value); setPresetId(item?.id ?? ''); if (item) { update(item.preferences); setPresetName(item.name) } }}><option value="">当前编辑</option>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="pet-field">预设名称<input aria-label="风格预设名称" maxLength={40} value={presetName} onChange={event => setPresetName(event.target.value)} /></label>
              <div className="pet-action-row"><button className="gbtn sm primary" onClick={() => savePreset(false)}>保存预设</button><button className="gbtn sm" onClick={() => savePreset(true)}>复制为新预设</button></div>
              <div className="pet-action-row"><button className="gbtn sm" disabled={!presetId || !presetName.trim()} onClick={() => { const stored = storePresets(presets.map(item => item.id === presetId ? { ...item, name: presetName.trim() } : item)); setNotice(stored ? '预设已重命名。' : '名称仅保留在本次工作台中，浏览器存储不可用。') }}>重命名</button><button className="gbtn sm danger" disabled={!presetId} onClick={() => { const stored = storePresets(presets.filter(item => item.id !== presetId)); setPresetId(''); setNotice(stored ? '已删除保存的预设，当前绘画偏好仍可使用。' : '本次工作台已移除预设，但浏览器存储不可用，未能持久保存。') }}>删除预设</button></div>
            </div>
            <button className="gbtn ghost" onClick={() => { reset(); setPresetId(''); setPresetName('我的水墨'); setNotice('已恢复默认绘画偏好。') }}><RotateCcw size={14} />恢复默认风格</button>
          </aside>
        </div>}
        {tab === 'history' && <>
          <div className="pet-history-grid">
            <div className="pet-history-list"><h3>最近试画</h3>{!pet.history.length && <p className="pet-muted">完成真实试画后，提示词、作品和耗时会记录在这里。</p>}{pet.history.map(item => <button key={item.id} className={selected?.id === item.id ? 'on' : ''} onClick={() => setSelectedId(item.id)}><b>{item.text}</b><span>{item.styleName} · {STAGES[item.status]} · {seconds(item.elapsedMs)}</span><small>{new Date(item.startedAt).toLocaleTimeString('zh-CN')} · {item.ops.length} 笔 · {Math.round(item.ink)} 墨</small></button>)}</div>
            <div className="pet-history-detail">{selected ? <>
              <TrialPaper ops={selected.ops} frame={pet.frame} label="历史真实试画作品" />
              <div className="pet-stat-row"><span>{selected.styleName}</span><span>{seconds(selected.elapsedMs)}</span><span>{selected.ops.length} 个元素</span><span>{Math.round(selected.ink)} 墨</span><span>{(selected.bytes / 1024).toFixed(1)} KB</span></div>
              {selected.error && <p className="pet-error">{selected.error}</p>}
              <div className="pet-action-row"><button className="gbtn sm primary" disabled={!connected || busy} onClick={() => retry(selected)}>恢复配置并重试</button><button className="gbtn sm" disabled={!connected || busy || selected.status !== 'completed'} onClick={() => compareAgain(selected)}>用当前风格在新纸上画同题</button><button className="gbtn sm" disabled={!selected.ops.length} onClick={() => saveFile(`teadraw-trial-${selected.id}.svg`, toSvg(selected.ops, pet.frame), 'image/svg+xml')}><Download size={14} />导出 SVG</button><button className="gbtn sm" onClick={() => saveFile(`teadraw-trial-${selected.id}.json`, JSON.stringify(selected, null, 2), 'application/json')}>导出诊断 JSON</button></div>
              <details className="pet-details"><summary>本次实际提示词与限制</summary><pre>{selected.prompt}</pre><pre>{JSON.stringify({ rules: selected.rules, guide: selected.guide }, null, 2)}</pre></details>
            </> : <div className="pet-history-empty">暂无真实试画记录</div>}</div>
          </div>
          <section className="pet-comparison">
            <h3>同题风格对比</h3><p className="pet-muted">在两次试画间修改风格，再选择记录对比。所有试画使用同一画幅；题目、初始笔迹、指引和限制一致时，才适合比较风格。</p>
            <div className="pet-compare-controls">
              <label className="pet-field">作品 A<select aria-label="对比作品A" value={compareA} onChange={event => setCompareA(event.target.value)}><option value="">选择真实作品</option>{pet.history.filter(item => item.status === 'completed' && item.ops.length).map(item => <option key={item.id} value={item.id}>{item.styleName} · {item.text.slice(0, 22)} · {new Date(item.startedAt).toLocaleTimeString('zh-CN')}</option>)}</select></label>
              <label className="pet-field">作品 B<select aria-label="对比作品B" value={compareB} onChange={event => setCompareB(event.target.value)}><option value="">选择另一幅真实作品</option>{pet.history.filter(item => item.status === 'completed' && item.ops.length && item.id !== compareA).map(item => <option key={item.id} value={item.id}>{item.styleName} · {item.text.slice(0, 22)} · {new Date(item.startedAt).toLocaleTimeString('zh-CN')}</option>)}</select></label>
            </div>
            {a && b && a.id !== b.id && <>
              {compareDifferences.length > 0 && <p className="pet-error">{compareDifferences.join('、')}不同；以下仅并排查看作品，不能单独把差异归因于风格。可用“当前风格画同题”恢复相同试画条件。</p>}
              <div className="pet-compare-papers"><div><b>A · {a.styleName}</b><TrialPaper ops={a.ops} frame={pet.frame} label="对比作品A" /></div><div><b>B · {b.styleName}</b><TrialPaper ops={b.ops} frame={pet.frame} label="对比作品B" /></div></div>
            </>}
          </section>
          <details className="pet-details" open><summary>真实活动记录</summary><div className="pet-activity">{pet.activity.length ? pet.activity.slice().reverse().map(item => <div key={item.id} className={item.tone}><time>{item.time}</time><b>{item.tool}</b><span>{item.detail}</span></div>) : <p className="pet-muted">连接后调用工具时，活动记录会出现在这里。</p>}</div></details>
        </>}
        {tab === 'connection' && <div className="pet-connect-grid">
          <div className="pet-connect-card"><TeaPet color="#A74732" status={connected ? pet.status : 'offline'} size={130} /><h3>{session?.peer.name ?? '等待绘画 Agent'}</h3><p className={`pet-link-state ${connected ? 'on' : ''}`}>{connectionText}</p><dl><dt>实际模型</dt><dd>{session?.peer.model ?? '尚未收到 Agent 的模型信息'}</dd><dt>本机桥</dt><dd>127.0.0.1:{session?.port ?? 5190}</dd><dt>当前任务</dt><dd>{STAGES[pet.taskState]}</dd></dl>{session?.error && <p className="pet-error" role="alert">{session.error}</p>}<div className="pet-action-row"><button className="gbtn primary" disabled={!session} onClick={() => session?.reconnect()}><Link size={15} />重新连接</button><button className="gbtn" disabled={!session?.enabled} onClick={() => session?.disconnect()}>断开连接</button></div><p className="pet-muted">连接在主菜单、大厅和对局之间保持。关闭房间不会关闭你的 Agent 连接。</p></div>
          <div className="pet-connect-instructions"><h3>接入你的绘画 Agent</h3><ol><li>在本机启动 MCP 桥，并让 AI 客户端接入它。</li><li>连接到同一个端口，等待“真实 Agent 已连接”。</li><li>返回“试画与调试”，发送题目并确认真实草稿。</li></ol><label className="pet-field">连接端口<input type="number" aria-label="Agent桥端口" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label><button className="gbtn primary" disabled={!session || !portValid} onClick={() => session?.connect(Number(port))}>连接本机 Agent 桥</button>{!portValid && <p className="pet-error">端口需要是 1024–65535 之间的整数。</p>}<details className="pet-details" open><summary>高级连接 · 启动命令</summary><label className="pet-field">MCP 名称<input aria-label="MCP启动名称" maxLength={80} value={launchName} onChange={event => setLaunchName(event.target.value)} /></label><label className="pet-field">实际客户端的模型声明<input aria-label="MCP启动模型声明" maxLength={120} value={launchModel} placeholder="填写实际使用的模型" onChange={event => setLaunchModel(event.target.value)} /></label><div className="pet-command"><Terminal size={17} /><code>{launchCommand}</code></div><button className="gbtn sm" disabled={!portValid || !launchModel.trim()} onClick={() => void copy(launchCommand)}><Copy size={14} />复制当前启动命令</button><p className="pet-muted">命令用于项目根目录的 PowerShell。名称和模型声明只标识实际客户端；模型切换需在 AI 客户端设置中完成。网页连接按钮连接已有桥，启动进程请使用本地 Agent 或终端。</p></details></div>
        </div>}
      </div>
    </div>
  )
}
