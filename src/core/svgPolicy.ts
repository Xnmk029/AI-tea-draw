import type { PresetId, SvgEl, SvgTag } from './types'

/**
 * Host 侧 SVG 校验器：Agent 提交的任何 SVG 都要经过这里才能进入 Op Log。
 * - 标签白名单：只保留基础图元
 * - 属性白名单：只保留几何与描边/填充
 * - 剥离语义属性（id/class/title…），防止在你画我猜里借路径“递答案”
 * - 数值精度截断，减小带宽
 */

const NS = 'http://www.w3.org/2000/svg'

export const ALLOWED_TAGS: SvgTag[] = ['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']
export const BLOCKED_TAGS = ['text', 'image', 'foreignObject', 'script', 'use', 'a', 'filter', 'animate']

const ATTRS: Record<string, string> = {
  d: 'd', points: 'points',
  x: 'x', y: 'y', width: 'width', height: 'height', rx: 'rx', ry: 'ry',
  cx: 'cx', cy: 'cy', r: 'r', x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2',
  fill: 'fill', stroke: 'stroke', 'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin',
  opacity: 'opacity', 'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity',
}
const SEMANTIC = new Set(['id', 'class', 'name', 'data-name', 'aria-label'])
const COLOR_RE = /^(none|#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i

export interface PolicyLimits {
  label: string
  desc: string
  maxElements: number
  maxPathCommands: number
  allowFill: boolean
}

export const POLICY_PRESETS: Record<PresetId, PolicyLimits> = {
  strict: { label: '严格', desc: '仅线条、无填充，单次 ≤ 12 个元素', maxElements: 12, maxPathCommands: 80, allowFill: false },
  standard: { label: '标准', desc: '基础图元 + 纯色填充，单次 ≤ 30 个元素', maxElements: 30, maxPathCommands: 200, allowFill: true },
  loose: { label: '宽松', desc: '适合茶绘大作，单次 ≤ 80 个元素', maxElements: 80, maxPathCommands: 600, allowFill: true },
}

export interface PolicyReport {
  ok: boolean
  elements: SvgEl[]
  /** 被移除的内容摘要，如 "<text>"、"属性 onclick" */
  removed: string[]
  /** 被剥离的语义属性数量 */
  stripped: number
}

const roundNums = (s: string) => s.replace(/-?\d*\.\d+/g, (m) => String(Math.round(parseFloat(m) * 10) / 10))

export function sanitizeSvg(src: string, limits: PolicyLimits): PolicyReport {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${src}</svg>`, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length) return { ok: false, elements: [], removed: ['SVG 解析失败'], stripped: 0 }

  const elements: SvgEl[] = []
  const removed = new Map<string, number>()
  const note = (k: string) => removed.set(k, (removed.get(k) ?? 0) + 1)
  let stripped = 0

  const visit = (parent: Element) => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName
      if (tag === 'g') {
        visit(node)
        continue
      }
      if (!(ALLOWED_TAGS as string[]).includes(tag)) {
        note(`<${tag}>`)
        continue
      }
      if (elements.length >= limits.maxElements) {
        note('超出元素上限')
        continue
      }
      const attrs: Record<string, string | number> = {}
      let drop = false
      for (const { name, value } of Array.from(node.attributes)) {
        if (SEMANTIC.has(name)) {
          stripped++
          continue
        }
        const key = ATTRS[name]
        if (!key) {
          note(`属性 ${name}`)
          continue
        }
        const v = value.trim()
        if ((key === 'fill' || key === 'stroke') && !COLOR_RE.test(v)) {
          note(`颜色 ${v}`)
          continue
        }
        if (key === 'd' && (v.match(/[a-df-z]/gi)?.length ?? 0) > limits.maxPathCommands) {
          note('路径过长')
          drop = true
          break
        }
        attrs[key] = key === 'd' || key === 'points' ? roundNums(v) : v
      }
      if (drop) continue
      if (!limits.allowFill && attrs.fill && attrs.fill !== 'none') {
        if (!attrs.stroke || attrs.stroke === 'none') {
          attrs.stroke = attrs.fill
          attrs.strokeWidth ??= 2
        }
        attrs.fill = 'none'
        note('填充')
      }
      elements.push({ tag: tag as SvgTag, attrs })
    }
  }
  visit(doc.documentElement)

  return {
    ok: true,
    elements,
    removed: [...removed].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)),
    stripped,
  }
}

let measureRoot: SVGSVGElement | null = null
const toKebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** 用浏览器几何引擎测量笔迹长度，作为“墨量” */
export function measureLength(el: SvgEl): number {
  if (!measureRoot) {
    measureRoot = document.createElementNS(NS, 'svg')
    measureRoot.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none')
    document.body.appendChild(measureRoot)
  }
  const node = document.createElementNS(NS, el.tag) as SVGGeometryElement
  for (const [k, v] of Object.entries(el.attrs)) node.setAttribute(toKebab(k), String(v))
  measureRoot.appendChild(node)
  const len = typeof node.getTotalLength === 'function' ? node.getTotalLength() : 0
  node.remove()
  return len
}
