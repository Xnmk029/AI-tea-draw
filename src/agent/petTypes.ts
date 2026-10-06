import type { ActivityItem, AgentLevel, AgentStatus, Op, PresetId, RoomRules } from '../core/types'
import type { Rect } from '../core/geometry'
import type { Ghost } from '../game/gameTypes'
import type { LiveTaskStage } from '../game/liveAgent'
import type { TargetMark } from '../game/targeting'
import type { AgentPreferences } from './preferences'

export type PetGuide = 'none' | 'center' | 'corner' | 'narrow' | 'path' | 'anchor'
export interface PetDebugRules {
  agentLevel: Exclude<AgentLevel, 'off' | 'auto'>
  inkLimit: number
  penSpeed: number
  svgPreset: PresetId
  targetFit: RoomRules['targetFit']
  avoidOthers: boolean
}
export interface PetTrial {
  id: string
  text: string
  prompt: string
  styleName: string
  preferences: AgentPreferences
  rules: PetDebugRules
  guide: PetGuide
  status: LiveTaskStage
  startedAt: number
  elapsedMs: number
  ink: number
  bytes: number
  baselineOps: Op[]
  ops: Op[]
  error?: string
}
export interface PetSandbox {
  frame: Rect
  ops: Op[]
  ghost: Ghost | null
  marks: TargetMark[]
  status: AgentStatus
  taskState: LiveTaskStage | 'idle'
  error: string | null
  history: PetTrial[]
  activity: ActivityItem[]
  guide: PetGuide
  debugRules: PetDebugRules
  send: (text: string) => void
  cancel: () => void
  accept: () => void
  reject: () => void
  clear: () => void
  restoreBaseline: (ops: Op[]) => void
  setGuide: (guide: PetGuide) => void
  seedHuman: () => void
  setDebugRules: (rules: Partial<PetDebugRules>) => void
}
