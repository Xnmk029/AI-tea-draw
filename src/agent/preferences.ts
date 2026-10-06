import { useEffect, useState } from 'react'

export type AgentStyleId = 'ink' | 'sketch' | 'cartoon' | 'geometric' | 'fine' | 'custom'
export type AgentComposition = 'center' | 'left' | 'right' | 'wide' | 'open'
export type AgentColorScheme = 'ink' | 'warm' | 'cool' | 'seat'
export interface AgentPreferences {
  styleId: AgentStyleId
  stylePrompt: string
  detail: number
  regularity: number
  intensity: number
  composition: AgentComposition
  colorScheme: AgentColorScheme
  customInstructions: string
}
export interface AgentStylePreset {
  id: string
  name: string
  preferences: AgentPreferences
}

export const AGENT_STYLES: { id: AgentStyleId; name: string; prompt: string }[] = [
  { id: 'ink', name: '水墨写意', prompt: '用少量流畅线条概括主体，保留明显留白，减少重复描边；以深浅不同的墨色组织层次，优先画清主体轮廓，再补少量细节。' },
  { id: 'sketch', name: '细线速写', prompt: '以轻盈的细线快速捕捉形态，保留少量自然手绘弧度；先画主要轮廓，用短线概括结构与阴影，不用密集排线填满画面。' },
  { id: 'cartoon', name: '简笔卡通', prompt: '用清晰圆润的外轮廓和简洁几何形状画出可辨识主体；适度夸张表情与比例，细节精简，避免复杂阴影和文字。' },
  { id: 'geometric', name: '几何极简', prompt: '以直线、圆弧、圆和矩形组织主体，统一线宽，构图清晰，减少形状数量；强调比例、对齐和负空间，避免多余装饰。' },
  { id: 'fine', name: '工笔线描', prompt: '用克制而精确的细线勾勒主体，认真处理轮廓、转折与结构层次；细节分布有主次，避免重复描边和大片填充，保持画面清楚。' },
]
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  styleId: 'ink', stylePrompt: AGENT_STYLES[0].prompt,
  detail: 40, regularity: 45, intensity: 55, composition: 'center', colorScheme: 'ink', customInstructions: '',
}
export const COMPOSITIONS: { id: AgentComposition; name: string; prompt: string }[] = [
  { id: 'center', name: '主体居中', prompt: '主体置于指定画幅中央，约占可用区域的六成，四周保留余量。' },
  { id: 'left', name: '主体靠左', prompt: '主体安排在可用区域左侧，右侧保留明显留白，不越出落笔区域。' },
  { id: 'right', name: '主体靠右', prompt: '主体安排在可用区域右侧，左侧保留明显留白，不越出落笔区域。' },
  { id: 'wide', name: '横向展开', prompt: '构图沿可用区域横向展开，主体之间有节奏和间距，避免挤在中央。' },
  { id: 'open', name: '充分留白', prompt: '主体只占可用区域约三分之一，其余保留干净留白；先遵守已有指引位置。' },
]
export const COLOR_SCHEMES: { id: AgentColorScheme; name: string; prompt: string }[] = [
  { id: 'ink', name: '单色墨迹', prompt: '以黑灰墨色为主，可以通过透明度体现层次。' },
  { id: 'warm', name: '温暖茶色', prompt: '以棕、赭、朱砂等温暖颜色为主，最多使用三种主色。' },
  { id: 'cool', name: '青绿冷色', prompt: '以青、绿、蓝灰等冷色为主，最多使用三种主色。' },
  { id: 'seat', name: '跟随座位色', prompt: '优先使用当前座位的笔色，辅以少量深浅变化。' },
]

const PREF_KEY = 'teadraw:agent-preferences:v1'
const PRESETS_KEY = 'teadraw:agent-style-presets:v1'
const listeners = new Set<() => void>()
let memoryPreferences: AgentPreferences | null = null
const str = (value: unknown, fallback: string, max = 2400) => typeof value === 'string' ? value.slice(0, max) : fallback
const level = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback
export function sanitizeAgentPreferences(value: unknown): AgentPreferences {
  const v = value && typeof value === 'object' ? value as Partial<AgentPreferences> : {}
  const styleId = [...AGENT_STYLES.map(x => x.id), 'custom'].includes(v.styleId ?? '') ? v.styleId! : DEFAULT_AGENT_PREFERENCES.styleId
  const base = AGENT_STYLES.find(x => x.id === styleId)?.prompt ?? DEFAULT_AGENT_PREFERENCES.stylePrompt
  return {
    styleId, stylePrompt: str(v.stylePrompt, base),
    detail: level(v.detail, 40), regularity: level(v.regularity, 45), intensity: level(v.intensity, 55),
    composition: COMPOSITIONS.some(x => x.id === v.composition) ? v.composition! : 'center',
    colorScheme: COLOR_SCHEMES.some(x => x.id === v.colorScheme) ? v.colorScheme! : 'ink',
    customInstructions: str(v.customInstructions, '', 1600),
  }
}
export function readAgentPreferences(): AgentPreferences {
  if (memoryPreferences) return { ...memoryPreferences }
  try { return sanitizeAgentPreferences(JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null')) } catch { return { ...DEFAULT_AGENT_PREFERENCES } }
}
export function writeAgentPreferences(value: AgentPreferences) {
  const safe = sanitizeAgentPreferences(value)
  try { localStorage.setItem(PREF_KEY, JSON.stringify(safe)); memoryPreferences = null } catch { memoryPreferences = safe }
  for (const listener of listeners) listener()
  return safe
}
export function subscribeAgentPreferences(listener: () => void) {
  listeners.add(listener)
  const storage = (event: StorageEvent) => { if (event.key === PREF_KEY || event.key === null) { memoryPreferences = null; listener() } }
  window.addEventListener('storage', storage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage) }
}
export function useAgentPreferences() {
  const [preferences, setPreferences] = useState(readAgentPreferences)
  useEffect(() => subscribeAgentPreferences(() => setPreferences(readAgentPreferences())), [])
  const update = (patch: Partial<AgentPreferences>) => {
    const safe = sanitizeAgentPreferences({ ...preferences, ...patch })
    setPreferences(safe)
    writeAgentPreferences(safe)
  }
  return { preferences, update, reset: () => update({ ...DEFAULT_AGENT_PREFERENCES }) }
}
export function agentStyleName(preferences: AgentPreferences) {
  return AGENT_STYLES.find(x => x.id === preferences.styleId)?.name ?? '自定义风格'
}
export function buildAgentPrompt(text: string, preferences: AgentPreferences = readAgentPreferences()) {
  const p = sanitizeAgentPreferences(preferences)
  const detail = p.detail < 34 ? '只画关键轮廓和少量辨识细节，主动省略次要纹理。' : p.detail > 66 ? '在主要轮廓清晰的前提下补充结构、表情与适量纹理，避免重复笔迹。' : '轮廓与细节保持平衡，优先表达主体特征。'
  const regularity = p.regularity < 34 ? '线条自然随性，允许轻微不对称，保持主体易辨认。' : p.regularity > 66 ? '结构规整，关注比例、对齐和线条衔接。' : '保持自然手绘感，同时让结构清楚。'
  const intensity = p.intensity < 34 ? '墨色轻淡，减少密集描边，保留透气的间距。' : p.intensity > 66 ? '主要轮廓浓厚有力，以少量淡线补充层次，避免整幅涂黑。' : '主要轮廓与次要细节有浓淡层次。'
  return [
    `本次题目：${text.trim().slice(0, 3000)}`,
    `绘画风格：${agentStyleName(p)}。${p.stylePrompt}`,
    `线条与细节：细节 ${p.detail}/100，规整 ${p.regularity}/100，浓淡 ${p.intensity}/100。${detail}${regularity}${intensity}`,
    `构图偏好：${COMPOSITIONS.find(x => x.id === p.composition)!.prompt}`,
    `配色偏好：${COLOR_SCHEMES.find(x => x.id === p.colorScheme)!.prompt}`,
    ...(p.customInstructions.trim() ? [`补充要求：${p.customInstructions.trim()}`] : []),
    '先遵守当前任务、座位权限、落笔指引、房间 SVG 与墨量限制；风格偏好不能扩大权限。画布上不要出现文字。',
  ].join('\n')
}
export function readAgentStylePresets(): AgentStylePreset[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]')
    if (!Array.isArray(data)) return []
    const ids = new Set<string>()
    return data.slice(0, 24).flatMap(value => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string') return []
      const id = value.id.slice(0, 80), name = value.name.trim().slice(0, 40)
      if (!id || !name || ids.has(id)) return []
      ids.add(id)
      return [{ id, name, preferences: sanitizeAgentPreferences(value.preferences) }]
    })
  } catch { return [] }
}
export function writeAgentStylePresets(value: AgentStylePreset[]) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(value.slice(0, 24))); return true } catch { return false }
}
