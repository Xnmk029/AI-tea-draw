import type { AgentLevel, AgentStatus, GuesserAgent, ModeId } from './types'

export const SEAT_COLORS = ['#E0614F', '#3D7DD8', '#D89A2B', '#8A5CD1', '#2FA37A', '#D9578E', '#3AA7B8', '#6B7A8F']

export const PALETTE = [
  '#3B3A36', '#E0614F', '#D89A2B', '#F6C453',
  '#4C8F68', '#3AA7B8', '#3D7DD8', '#8A5CD1',
  '#D9578E', '#8B5E3C', '#9AA6A0', '#FFFFFF',
]

export const WIDTHS = [2, 4, 8, 14]

export const MODES: Record<ModeId, { name: string; en: string; desc: string; tags: string[] }> = {
  tea: { name: '基础茶绘', en: 'Tea Party', desc: '一张无限画布，人和 Agent 自由协作作画', tags: ['2–8 人', '不限时', '协作'] },
  relay: { name: '图文传话', en: 'Relay', desc: '文字与画作轮流接力，看灵感如何一路走样', tags: ['4–8 人', '每步 80 秒', '相册揭晓'] },
  guess: { name: '你画我猜', en: 'Guess', desc: '轮流作画竞猜，Agent 可以帮画，也能悄悄提示', tags: ['3–8 人', '计分', '轮换画手'] },
}

export const AGENT_LEVELS: Record<AgentLevel, { name: string; desc: string }> = {
  off: { name: '关闭', desc: '纯人类对局，Agent 不能落笔' },
  assist: { name: '助手', desc: 'Agent 先给出幽灵预览，由你确认后才落笔' },
  collab: { name: '协作', desc: 'Agent 直接落笔，受墨量与笔速限制' },
  auto: { name: '托管', desc: 'Agent 作为独立选手参赛，单独排名' },
}

export const GUESSER_AGENT: Record<GuesserAgent, { name: string; desc: string }> = {
  off: { name: '禁止', desc: '猜词方 Agent 不参与' },
  whisper: { name: '悄悄提示', desc: '只提示己方玩家，猜中得分 ×0.5' },
  solo: { name: '独立选手', desc: 'Agent 单独猜词，进入 Agent 榜' },
}

export const STATUS_TEXT: Record<AgentStatus, string> = {
  offline: '离线',
  idle: '空闲',
  thinking: '思考中',
  review: '待确认',
  drawing: '绘制中',
}
