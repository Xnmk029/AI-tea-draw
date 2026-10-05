import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { ActivityItem, AuthorKind, ChatMsg, GuessRole, ModeId, Op, RoomRules, Seat, SvgEl, ToolId, Transform } from '../core/types'
import type { Pt, Rect } from '../core/geometry'
import type { DrawingKey } from '../mock/drawings'
import type { DrawTarget, TargetMark } from './targeting'
import type { LivePeer } from './mcpClient'

export type { DrawTarget, TargetMark } from './targeting'
export type { LivePeer, LivePeerState } from './mcpClient'

/** 指引笔子模式：auto 按手势自动判定，其余为显式指定 */
export type GuideMode = 'auto' | 'pin' | 'box' | 'lasso' | 'path' | 'anchor'

export const MAX_MARKS = 3

/** 世界坐标 → 屏幕坐标：screen = (world - {x,y}) * z */
export interface Camera {
  x: number
  y: number
  z: number
}

/** Agent 的幽灵预览（描红草稿）：确认前不进入 Op Log；每个 op 自带 tf，支持多目标 */
export interface Ghost {
  ops: Op[]
  label: string
  ink: number
  /** 校验器摘要，如 "已移除 <text>"、"剥离语义属性 ×2" */
  notes: string[]
  /** 真实 Agent 提交的草稿 id（canvas_commit / preview 事件用它对账） */
  previewId?: string
}

/** Agent 思考中的落笔区域提示 */
export interface Think {
  key: string
  at: Pt
  color: string
}

export interface WordOption {
  word: string
  drawing: DrawingKey
  level: string
  close: string[]
}

export interface Toast {
  id: number
  text: string
}

export interface Segment {
  id: string
  delay: number
  dur: number
}

/** 远端光标（人或 Agent），由 Canvas 的 rAF 循环直接读取并驱动 DOM */
export interface Pen {
  key: string
  seat: number
  author: AuthorKind
  label: string
  color: string
  pos: Pt
  target: Pt
  home: Pt
  range: number
  wander: boolean
  visible: boolean
  batch?: { timeline: Segment[]; start: number; end: number; tf: Transform; tfs?: Map<string, Transform> }
}

export interface UseGameOptions {
  mode: ModeId
  seats: Seat[]
  rules: RoomRules
  guessRole: GuessRole
}

/** 一场对局的结算载荷：进结算屏时由 useGame 收集，App 透传给 ResultScreen */
export interface SessionResult {
  mode: ModeId
  /** 终局座位（真实得分/在线状态） */
  seats: Seat[]
  /** 本局全部笔迹（回放用） */
  ops: Op[]
  /** 每座位墨量拆分（人 / Agent） */
  inkStats: { seat: number; human: number; agent: number }[]
  /** 你画我猜：每人猜中数 / 作过画 */
  guessStats?: { seat: number; correct: number; drawn: number }[]
  /** 实际打了多少轮 */
  rounds: number
  /** 茶绘主题 / 传话题目 */
  theme?: string
  startedAt: number
  durationMs: number
}

export interface GameState {
  mode: ModeId
  rules: RoomRules
  seats: Seat[]
  me: Seat
  role: GuessRole
  /** 猜词者不能画 */
  readOnly: boolean
  /** 图文传话的固定画框（世界坐标），其他模式为 undefined */
  frame?: Rect

  ops: Op[]
  ghost: Ghost | null
  /** 我的落笔指引标记（令旗/区域，≤MAX_MARKS） */
  marks: TargetMark[]
  /** 其他玩家的公开指引标记（房规 targetsPublic 开启时） */
  foreignMarks: TargetMark[]
  guideMode: GuideMode
  setGuideMode: (m: GuideMode) => void
  /** 九宫格落笔（Q）是否展开 */
  gridOn: boolean
  setGridOn: Dispatch<SetStateAction<boolean>>
  thinking: Think[]
  pens: MutableRefObject<Map<string, Pen>>
  penKeys: string[]

  cam: Camera
  setCam: Dispatch<SetStateAction<Camera>>
  tool: ToolId
  setTool: (t: ToolId) => void
  color: string
  setColor: (c: string) => void
  width: number
  setWidth: (w: number) => void
  spaceDown: boolean

  chat: ChatMsg[]
  activity: ActivityItem[]
  toast: Toast | null
  /** 我的座位墨量：human/agent 已用，allowance = Agent 当前可用上限 */
  ink: { human: number; agent: number; allowance: number }
  /** 每当按下 Ctrl+K 自增，AgentBar 监听它来聚焦输入框 */
  focusNonce: number

  highlightAgent: boolean
  setHighlightAgent: Dispatch<SetStateAction<boolean>>
  hiddenSeats: Set<number>
  toggleSeatVisible: (seatId: number) => void

  /** 剩余秒数；基础茶绘为 null */
  timeLeft: number | null
  /** 你画我猜：画手已选的词 */
  word: WordOption | null
  wordOptions: WordOption[]
  pickWord: (w: WordOption) => void
  /** 你画我猜：猜词者看到的提示，未揭示的字为 '' */
  hint: string[]
  guessed: boolean
  whisper: string | null
  roundOver: boolean
  answer: string
  /** 图文传话：已提交人数 / 我是否已提交 */
  relayDone: number
  submitted: boolean
  /** 你画我猜：本轮已猜中的座位 id（新增，可选） */
  guessedSeats?: number[]
  /** 当前轮（1 起）；非计轮模式恒为 1 */
  round: number
  /** 总轮数（guess=rules.rounds，其余=1） */
  roundsTotal: number
  isLastRound: boolean
  /** 你画我猜进入下一轮：清场、重置词/计时、猜词视角换题 */
  nextRound: () => void
  /** 收集本局结算数据交给结算屏 */
  collectResult: () => SessionResult

  /** 真实 Agent 桥（teadraw mcp）的连接状态；off/connecting 时走本地模拟 */
  live?: LivePeer

  draw: (el: SvgEl) => void
  erase: (opId: string) => void
  undo: () => void
  redo: () => void
  addMark: (t: DrawTarget) => void
  removeMark: (id: string) => void
  clearMarks: () => void
  askAgent: (text: string) => void
  acceptGhost: () => void
  rejectGhost: () => void
  /** 直接覆盖预览中每个 op 的 tf（用于拖动/缩放手柄，tfs 长度需与 ghost.ops 一致） */
  ghostTf: (tfs: Transform[]) => void
  /** 最近一次的盖章位置（触发印章动画后由 UI 消费） */
  lastStamp: { at: Pt; nonce: number } | null
  sendChat: (text: string) => void
  submitGuess: (text: string) => void
  askWhisper: () => void
  submitRelay: () => void
  replay: () => void
  /** 以画布可视区域中心为锚点缩放 */
  zoomBy: (factor: number) => void
  resetView: () => void
}
