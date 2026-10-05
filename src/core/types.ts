export type ModeId = 'tea' | 'relay' | 'guess'
export type Screen = 'home' | 'lobby' | 'game' | 'result'
export type AuthorKind = 'human' | 'agent'
export type AgentStatus = 'offline' | 'idle' | 'thinking' | 'review' | 'drawing'
export type AgentLevel = 'off' | 'assist' | 'collab' | 'auto'
export type GuesserAgent = 'off' | 'whisper' | 'solo'
export type PresetId = 'strict' | 'standard' | 'loose'
export type ToolId = 'guide' | 'pen' | 'line' | 'rect' | 'ellipse' | 'eraser' | 'hand'
export type GuessRole = 'drawer' | 'guesser'

export interface AgentInfo {
  name: string
  model: string
  status: AgentStatus
  latency: number
}

export interface Seat {
  id: number
  name: string
  color: string
  isMe?: boolean
  isHost?: boolean
  ready: boolean
  online: boolean
  score: number
  agent: AgentInfo | null
}

export type SvgTag = 'path' | 'line' | 'polyline' | 'polygon' | 'rect' | 'circle' | 'ellipse'

export interface SvgEl {
  tag: SvgTag
  attrs: Record<string, string | number>
}

export interface Transform {
  x: number
  y: number
  s: number
}

/** 画布上的一次落笔：人和 Agent 共用同一种数据结构，只靠 author 区分 */
export interface Op {
  id: string
  seat: number
  author: AuthorKind
  el: SvgEl
  tf: Transform
  ink: number
  label?: string
  anim?: { delay: number; dur: number }
}

export interface RoomRules {
  agentLevel: AgentLevel
  guesserAgent: GuesserAgent
  /** Agent 墨量占座位总墨量的上限 */
  inkRatio: number
  /** Agent 笔速 px/s */
  penSpeed: number
  roundTime: number
  rounds: number
  svgPreset: PresetId
  /** 指引标记（令旗/区域）是否对全房间可见 */
  targetsPublic: boolean
  /** Agent 越界落笔策略：放入 / 裁切 / 拒绝 */
  targetFit: 'contain' | 'clip' | 'strict'
  /** Agent 作画时避让别人的笔迹（占用网格微挪避让） */
  avoidOthers?: boolean
  /** 本场主题（茶绘显示 + 喂给 Agent）；留空用默认主题 */
  theme?: string
  /** 你画我猜的自定义词库（追加进抽词池，没有参考画，Agent 自由发挥） */
  wordBank?: string[]
}

export interface ChatMsg {
  id: string
  seat: number | null
  author: AuthorKind | 'system'
  text: string
  kind?: 'normal' | 'correct' | 'close'
}

export interface ActivityItem {
  id: string
  time: string
  tool: string
  detail: string
  tone?: 'ok' | 'warn' | 'muted'
}
