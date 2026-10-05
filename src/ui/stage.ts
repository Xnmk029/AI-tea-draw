import { STAGE } from '../core/geometry'

/** 舞台按 1920×1080 设计并整体缩放；鼠标的 client 坐标需要换算回舞台坐标 */
const stageRect = () => document.querySelector('.stage')?.getBoundingClientRect()

export const stageScale = () => {
  const r = stageRect()
  return r ? r.width / STAGE.w : 1
}

export function toStage(cx: number, cy: number) {
  const r = stageRect()
  if (!r) return { x: cx, y: cy }
  const k = r.width / STAGE.w
  return { x: (cx - r.left) / k, y: (cy - r.top) / k }
}
