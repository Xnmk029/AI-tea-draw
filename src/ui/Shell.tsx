import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Logo } from '../components/Logo'

/**
 * 舞台层级（自下而上）。所有屏幕共享同一套 z 轴，CSS 变量见 ui.css。
 *   bg 0 · world 10 · frame 50 · hud 100 · panel 200 · popover 300 · modal 400 · toast 500 · transition 600 · debug 700
 * 屏幕内：l-bg / l-world / l-frame / l-hud / l-panel；舞台级：modal / toast / transition / debug（通过 Portal 挂载）
 */
export type StageLayer = 'popover' | 'modal' | 'toast' | 'transition' | 'debug'
const STAGE_LAYERS: StageLayer[] = ['popover', 'modal', 'toast', 'transition', 'debug']

export function LayerRoots() {
  return (
    <>
      {STAGE_LAYERS.map((n) => (
        <div key={n} id={`layer-${n}`} className={`stage-layer layer-${n}`} />
      ))}
    </>
  )
}

export function Portal({ layer, children }: { layer: StageLayer; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => setEl(document.getElementById(`layer-${layer}`)), [layer])
  return el ? createPortal(children, el) : null
}

// ---------- Esc 返回栈：最上层的面板 / 弹窗优先响应 ----------
const backStack: { fn: () => void }[] = []
let installed = false
function installBack() {
  if (installed) return
  installed = true
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      t.blur()
      return
    }
    const top = backStack[backStack.length - 1]
    if (top) {
      e.preventDefault()
      top.fn()
    }
  })
}

/** 注册一个"返回"处理；active 为 false 时不入栈 */
export function useBack(fn: () => void, active = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    installBack()
    const entry = { fn: () => ref.current() }
    backStack.push(entry)
    return () => {
      const i = backStack.indexOf(entry)
      if (i >= 0) backStack.splice(i, 1)
    }
  }, [active])
}

/** 屏幕级快捷键（输入框内不触发） */
export function useHotkeys(map: Record<string, () => void>, active = true) {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) return
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()] ?? ref.current[e.code]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [active])
}

/** 键帽提示 */
export function Key({ k }: { k: string }) {
  return <kbd className="keycap">{k}</kbd>
}

/** 屏幕转场：卷帘落下 → 换屏 → 卷帘收起 */
export function Curtain({ phase }: { phase: 'idle' | 'in' | 'out' }) {
  return (
    <div className={`curtain c-${phase}`} aria-hidden>
      <div className="curtain-paper">
        <Logo size={56} />
        <b>茶绘</b>
      </div>
      <div className="curtain-rod" />
    </div>
  )
}
