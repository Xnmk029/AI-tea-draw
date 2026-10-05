import type { RoomRules, Seat } from '../core/types'
import type { Rect } from '../core/geometry'
import { SEAT_COLORS } from '../core/theme'
import type { WordOption } from '../game/gameTypes'
import type { DrawingKey, SceneItem } from './drawings'

export const ROOM_CODE = 'A7K2'
export const MAX_SEATS = 8

const agent = (name: string, model: string, latency: number) => ({ name, model, status: 'idle' as const, latency })

export const INITIAL_SEATS: Seat[] = [
  { id: 1, name: '青柠', color: SEAT_COLORS[0], isMe: true, isHost: true, ready: true, online: true, score: 0, agent: agent('Claude', 'claude-sonnet', 86) },
  { id: 2, name: '阿墨', color: SEAT_COLORS[1], ready: true, online: true, score: 0, agent: agent('GPT', 'gpt-4.1', 132) },
  { id: 3, name: '栗子', color: SEAT_COLORS[2], ready: true, online: true, score: 0, agent: agent('Gemini', 'gemini-2.5-pro', 168) },
  { id: 4, name: '小满', color: SEAT_COLORS[3], ready: false, online: true, score: 0, agent: null },
  { id: 5, name: 'Kiko', color: SEAT_COLORS[4], ready: true, online: true, score: 0, agent: agent('Qwen', 'qwen-max', 104) },
  { id: 6, name: '南风', color: SEAT_COLORS[5], ready: false, online: true, score: 0, agent: agent('DeepSeek', 'deepseek-v3', 190) },
]

export const DEFAULT_RULES: RoomRules = {
  agentLevel: 'assist',
  guesserAgent: 'whisper',
  inkRatio: 0.5,
  penSpeed: 900,
  roundTime: 80,
  rounds: 3,
  svgPreset: 'standard',
  targetsPublic: true,
  targetFit: 'contain',
  avoidOthers: true,
}

export const TEA_THEME = '雨天的茶馆'
export const RELAY_PROMPT = '会飞的茶壶在追公交'
export const RELAY_STEP = { current: 3, total: 6 }
export const RELAY_FRAME: Rect = { x: -400, y: -300, w: 800, h: 600 }

export const GUESS_WORDS: WordOption[] = [
  { word: '茶壶', drawing: 'teapot', level: '简单', close: ['壶', '水壶', '茶杯'] },
  { word: '茶馆', drawing: 'house', level: '中等', close: ['房子', '亭子', '寺庙'] },
  { word: '雨云', drawing: 'cloud', level: '简单', close: ['云', '云朵', '乌云'] },
  { word: '松树', drawing: 'tree', level: '简单', close: ['树', '圣诞树', '杉树', '柏树'] },
  { word: '太阳', drawing: 'sun', level: '简单', close: ['日', '日光', '夕阳'] },
  { word: '山', drawing: 'mountain', level: '简单', close: ['山峰', '雪山', '丘陵'] },
  { word: '猫', drawing: 'cat', level: '简单', close: ['小猫', '猫咪', '老虎'] },
  { word: '花', drawing: 'flower', level: '简单', close: ['花朵', '盆栽', '玫瑰'] },
  { word: '公交车', drawing: 'bus', level: '中等', close: ['巴士', '大巴', '汽车'] },
  { word: '茶杯', drawing: 'cup', level: '简单', close: ['杯子', '咖啡杯', '茶壶'] },
]

/** 我是猜词者时第 1 轮的题目（后续轮从词池随机抽），画手轮换 */
export const GUESSER_TARGET: WordOption = GUESS_WORDS[3]
export const GUESS_DRAWER_SEAT = 2

/** 抽 n 个不重复的选项（画手选词卡）；exclude 掉本场已用过的词 */
export function pickOptions(pool: WordOption[], n = 3, exclude: string[] = []): WordOption[] {
  const rest = pool.filter((w) => !exclude.includes(w.word))
  const bag = rest.length >= n ? rest : pool
  return [...bag].sort(() => Math.random() - 0.5).slice(0, Math.min(n, bag.length))
}

/** 抽一个题（猜词视角 / Agent 读题） */
export const pickTarget = (pool: WordOption[], exclude: string[] = []): WordOption => pickOptions(pool, 1, exclude)[0] ?? pool[0]

/** 悄悄提示语：按当前题目生成（松树保留手写的那条） */
export const whisperFor = (w: WordOption): string =>
  w.word === '松树'
    ? '层层叠叠的三角形，下面有一截树干……像一种四季常绿的植物'
    : w.close.length
      ? `往「${w.close[0]}」那边想一想……再具体一点`
      : `${w.word.length} 个字，很日常的东西`

export function judgeGuess(text: string, target: { word: string; close: string[] }): 'correct' | 'close' | 'wrong' {
  const t = text.trim()
  if (!t) return 'wrong'
  if (t === target.word) return 'correct'
  if (target.close.includes(t) || target.word.includes(t)) return 'close'
  return 'wrong'
}

export interface Friend {
  name: string
  color: string
  status: string
  room?: string
}

export const FRIENDS: Friend[] = [
  { name: '阿墨', color: SEAT_COLORS[1], status: '在房间中', room: ROOM_CODE },
  { name: '团子', color: SEAT_COLORS[6], status: '你画我猜 · 第 2 轮', room: 'Q9X3' },
  { name: '白露', color: SEAT_COLORS[3], status: '在线' },
  { name: '老周', color: SEAT_COLORS[7], status: '图文传话 · 相册揭晓', room: 'M2P8' },
  { name: '阿七', color: SEAT_COLORS[2], status: '2 小时前在线' },
]

export interface RelayStep {
  seat: number
  kind: 'text' | 'draw'
  text?: string
  scene?: SceneItem[]
  withAgent?: boolean
}

export interface RelayChain {
  starter: number
  steps: RelayStep[]
}

// scene 基于 200×150 的 viewBox
export const RELAY_CHAINS: RelayChain[] = [
  {
    starter: 5,
    steps: [
      { seat: 5, kind: 'text', text: '会飞的茶壶在追公交' },
      {
        seat: 6, kind: 'draw', withAgent: true, scene: [
          { key: 'cloud', x: 4, y: -18, s: 0.4 },
          { key: 'teapot', x: 8, y: 22, s: 0.42 },
          { key: 'bus', x: 96, y: 34, s: 0.5 },
        ],
      },
      { seat: 1, kind: 'text', text: '茶壶坐公交去上班' },
      {
        seat: 2, kind: 'draw', scene: [
          { key: 'sun', x: 150, y: -6, s: 0.28 },
          { key: 'bus', x: 20, y: 12, s: 0.75 },
          { key: 'teapot', x: 64, y: 30, s: 0.22 },
        ],
      },
      { seat: 3, kind: 'text', text: '黄色校车拉着一壶热茶去春游' },
      {
        seat: 4, kind: 'draw', scene: [
          { key: 'mountain', x: 90, y: -8, s: 0.55 },
          { key: 'bus', x: 0, y: 30, s: 0.58 },
          { key: 'cup', x: 120, y: 84, s: 0.3 },
          { key: 'flower', x: 168, y: 96, s: 0.24 },
        ],
      },
    ],
  },
  {
    starter: 2,
    steps: [
      { seat: 2, kind: 'text', text: '一只猫在松树下晒太阳' },
      {
        seat: 3, kind: 'draw', withAgent: true, scene: [
          { key: 'sun', x: 144, y: -4, s: 0.3 },
          { key: 'tree', x: 10, y: 6, s: 0.68 },
          { key: 'cat', x: 104, y: 60, s: 0.44 },
        ],
      },
      { seat: 4, kind: 'text', text: '橘猫在守护圣诞树' },
      {
        seat: 5, kind: 'draw', scene: [
          { key: 'tree', x: 56, y: -4, s: 0.76 },
          { key: 'cat', x: 6, y: 66, s: 0.4 },
          { key: 'flower', x: 158, y: 86, s: 0.3 },
        ],
      },
      { seat: 6, kind: 'text', text: '花园里的狮子王即将登基' },
      {
        seat: 1, kind: 'draw', withAgent: true, scene: [
          { key: 'mountain', x: -4, y: -20, s: 0.62 },
          { key: 'sun', x: 140, y: -8, s: 0.32 },
          { key: 'cat', x: 66, y: 46, s: 0.52 },
          { key: 'flower', x: 8, y: 92, s: 0.28 },
          { key: 'flower', x: 156, y: 92, s: 0.28 },
        ],
      },
    ],
  },
  {
    starter: 3,
    steps: [
      { seat: 3, kind: 'text', text: '下雨天躲进茶馆喝茶' },
      {
        seat: 4, kind: 'draw', scene: [
          { key: 'cloud', x: 60, y: -24, s: 0.5 },
          { key: 'house', x: 0, y: 30, s: 0.6 },
          { key: 'cup', x: 126, y: 74, s: 0.36 },
        ],
      },
      { seat: 5, kind: 'text', text: '乌云压顶的小庙，门口一只巨杯' },
      {
        seat: 6, kind: 'draw', withAgent: true, scene: [
          { key: 'cloud', x: 20, y: -20, s: 0.42 },
          { key: 'cloud', x: 100, y: -24, s: 0.42 },
          { key: 'house', x: 40, y: 26, s: 0.6 },
          { key: 'cup', x: 150, y: 96, s: 0.24 },
        ],
      },
      { seat: 1, kind: 'text', text: '山里的寺庙快被雨淹了，快去救杯子' },
      {
        seat: 2, kind: 'draw', scene: [
          { key: 'mountain', x: 60, y: -16, s: 0.7 },
          { key: 'cloud', x: 0, y: -22, s: 0.4 },
          { key: 'house', x: 4, y: 48, s: 0.46 },
          { key: 'tree', x: 134, y: 70, s: 0.36 },
          { key: 'cup', x: 100, y: 104, s: 0.22 },
        ],
      },
    ],
  },
]

export const LEADERBOARD: { seat: number; score: number; agentShare: number; correct: number; drawn: number }[] = [
  { seat: 3, score: 860, agentShare: 0.32, correct: 3, drawn: 1 },
  { seat: 1, score: 790, agentShare: 0.45, correct: 2, drawn: 1 },
  { seat: 5, score: 720, agentShare: 0.18, correct: 3, drawn: 1 },
  { seat: 2, score: 640, agentShare: 0.5, correct: 2, drawn: 1 },
  { seat: 4, score: 510, agentShare: 0, correct: 2, drawn: 1 },
  { seat: 6, score: 380, agentShare: 0.41, correct: 1, drawn: 1 },
]

export const TEA_STATS: { seat: number; human: number; agent: number }[] = [
  { seat: 1, human: 3420, agent: 2860 },
  { seat: 2, human: 2180, agent: 2050 },
  { seat: 3, human: 1640, agent: 1580 },
  { seat: 4, human: 4120, agent: 0 },
  { seat: 5, human: 2760, agent: 1240 },
  { seat: 6, human: 1310, agent: 1290 },
]

// viewBox 400×260
export const TEA_RESULT_SCENE: SceneItem[] = [
  { key: 'mountain', x: -10, y: 40, s: 1 },
  { key: 'cloud', x: 150, y: -10, s: 0.55 },
  { key: 'sun', x: 320, y: 0, s: 0.4 },
  { key: 'cloud', x: -6, y: -14, s: 0.45 },
  { key: 'house', x: 110, y: 50, s: 1 },
  { key: 'tree', x: 290, y: 110, s: 0.65 },
  { key: 'cat', x: 40, y: 160, s: 0.42 },
  { key: 'cup', x: 262, y: 190, s: 0.28 },
]

export const AGENT_LINES: Partial<Record<DrawingKey, string>> = {
  tree: '在空地上种了一棵松树，雨里也很精神。',
  teapot: '画了一只会冒热气的茶壶，好像要飞起来了。',
  cat: '茶馆门口来了一只躲雨的猫。',
  cloud: '补了一朵雨云，雨丝留给你们来画吧。',
  sun: '太阳先挂上，等雨停就派上用场了。',
  mountain: '远处加了座山，画面纵深感更强了。',
  house: '茶馆的屋檐挑高了一点，挂了两盏灯笼。',
  flower: '路边开了一朵花，颜色和灯笼呼应。',
  bus: '一辆公交刚好停在茶馆门口。',
  cup: '画了一杯刚泡好的绿茶，请大家喝。',
}
