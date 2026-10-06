// 实际 TSX + React hook/Canvas/时钟替身：验证调度与坐标契约，不复制组件逻辑。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')

async function fixture(name, props, scale = 1) {
  let now = 0, nextId = 1, refCursor = 0, effectCursor = 0
  const refs = [], effects = [], runs = [], timers = new Map(), frames = new Map(), observers = []
  const metrics = { timeoutCreates: 0, frameCreates: 0, clockReads: 0, outlines: 0, reports: [], renders: 0, points: [] }
  const host = { clientWidth: 1920, clientHeight: 1080, appendChild() {} }
  const canvas = () => ({ style: {}, remove() {}, getContext: () => ({ save() {}, restore() {}, translate() {}, scale() {}, fill() {}, stroke() {}, setTransform() {}, clearRect() {}, setLineDash() {} }) })
  let transform = { x: 0, y: 0, s: 1 }, width = 0, height = 0
  const stack = []
  const brush = {
    createCanvas(w, h) { width = w; height = h; return canvas() },
    render() { metrics.renders++ }, clear() {}, seed() {}, noiseSeed() {},
    push() { stack.push({ ...transform }) }, pop() { transform = stack.pop() },
    translate(x, y) { transform.x += x * transform.s; transform.y += y * transform.s },
    scale(s) { transform.s *= s }, noStroke() {}, fill() {}, fillBleed() {}, fillTexture() {},
    // p5.brush 的真实填充层隐式加半幅偏移（fill.js）；点以逻辑舞台像素记录。
    polygon(pts) { metrics.points.push(pts.map(([x, y]) => [x * transform.s + transform.x + width / 2, y * transform.s + transform.y + height / 2])) },
  }
  const hooks = {
    useRef(value) { const i = refCursor++; return refs[i] ??= { current: value } },
    useEffect(run, deps) {
      const i = effectCursor++, previous = effects[i]
      if (!previous || !deps || deps.some((dep, j) => !Object.is(dep, previous.deps?.[j]))) {
        runs.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: run() } })
      }
    },
  }
  const stroke = {
    brushOutline() { metrics.outlines++; return { pts: [[0, 0], [30, 20], [40, 0]] } },
    elToPath2D() { return {} }, outlineToPath2D() { return {} }, hashSeed() { return 42 }, sampleCenterline() { return { pts: [] } },
  }
  const source = readFileSync(new URL(`../src/game/${name}.tsx`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const setTimeout = (run, delay) => { const id = nextId++; metrics.timeoutCreates++; timers.set(id, { at: now + delay, run }); return id }
  const clearTimeout = id => timers.delete(id)
  const requestAnimationFrame = run => { const id = nextId++; metrics.frameCreates++; frames.set(id, run); return id }
  const context = vm.createContext({
    exports: {}, performance: { now: () => { metrics.clockReads++; return now } },
    window: { setTimeout, devicePixelRatio: 1 }, clearTimeout, requestAnimationFrame, cancelAnimationFrame: id => frames.delete(id),
    document: { createElement: canvas }, ResizeObserver: class { constructor(run) { this.run = run; observers.push(this) } observe() {} disconnect() {} },
    require: name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }) } : name.includes('/brush/stroke') ? stroke : name.includes('/ui/stage') ? { stageScale: () => scale } : name === 'p5.brush/standalone' ? brush : require(name),
  })
  vm.runInContext(compiled, context)
  const render = async nextProps => {
    props = nextProps ?? props
    refCursor = effectCursor = 0
    const node = context.exports[name]({ ...props, onBaked: ids => metrics.reports.push([...ids].sort()) })
    node.props.ref.current = host
    for (const run of runs.splice(0)) run()
    // 动态 import 的 CommonJS 转译需要几个微任务。
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  const advance = ms => {
    const end = now + ms
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timers.delete(due[0]); due[1].run()
    }
    now = end
  }
  const frame = () => { const queue = [...frames.values()]; frames.clear(); for (const run of queue) run(now) }
  await render()
  return { render, advance, frame, metrics, timers, frames, host, resize: () => observers[0].run(), unmount: () => effects.forEach(effect => effect.cleanup?.()), state: refs[1].current }
}

const op = (id, anim) => ({ id, seat: 1, author: 'human', tf: { x: 1000, y: 400, s: 1.7 }, el: { tag: 'path', attrs: { d: 'M0 0L30 20L40 0', stroke: '#000', strokeWidth: 4 } }, ...(anim ? { anim } : {}) })
const props = ops => ({ ops, cam: { x: 100, y: -50, z: 1.35 }, hiddenSeats: new Set() })
let checks = 0
for (const name of ['InkBake', 'InkWash']) {
  const p = props(Array.from({ length: 300 }, (_, n) => op(`static-${n}`)))
  const f = await fixture(name, p)
  assert.equal(f.metrics.outlines, 300)
  assert.equal(f.frames.size, 1, `${name} 300 笔只安排一次帧 flush`)
  assert.equal(f.metrics.reports.length + f.metrics.renders, 0)
  f.frame()
  assert.equal(name === 'InkBake' ? f.metrics.reports.length : f.metrics.renders, 1)
  const reads = f.metrics.clockReads
  await f.render(p)
  assert.equal(f.metrics.clockReads, reads, `${name} 无关父组件渲染不能触发同步扫描`)
  assert.equal(f.metrics.outlines, 300)
  checks += 5
  await f.render({ ...p, hiddenSeats: new Set([1]) })
  f.frame()
  assert.equal(f.state.drawn.size, 0, `${name} 隐藏后清除位图`)
  await f.render({ ...p, ops: [] })
  f.unmount()
  assert.equal(f.frames.size + f.timers.size, 0)
  checks += 2

  const animated = op('animated', { delay: 500, dur: 500 })
  const a = props([animated]), t = await fixture(name, a)
  for (let i = 0; i < 20; i++) await t.render({ ...a, ops: [...a.ops] })
  assert.equal(t.state.pending.size, 1)
  assert.equal(t.metrics.timeoutCreates, 1, `${name} 重复同步不重复挂落定 timer`)
  t.advance(200)
  await t.render({ ...a, cam: { x: 250, y: 80, z: 1.6 } })
  t.advance(240)
  assert.equal(t.state.pending.size, 1)
  assert.equal([...t.timers.values()][0].at, 1090, `${name} 重烘焙保留首次动画绝对截止`)
  t.advance(650)
  assert.equal(t.state.drawn.size, 1)
  assert.equal(t.metrics.outlines, 1)
  t.advance(1000)
  await t.render({ ...a, cam: { x: -50, y: 40, z: 1 } })
  t.advance(240)
  assert.equal(t.state.drawn.size, 1, `${name} 已过动画重烘焙立即画回`)
  assert.equal(t.state.pending.size, 0)
  t.unmount()
  checks += 8

  const deleted = await fixture(name, a)
  deleted.frame()
  await deleted.render({ ...a, ops: [] })
  assert.equal(deleted.state.pending.size, 0)
  assert.equal(deleted.state.deadlines.size, 0)
  deleted.advance(2000); deleted.frame()
  assert.equal(deleted.metrics.outlines, 0, `${name} 删除待落定笔迹后没有幽灵落笔`)
  deleted.unmount()
  checks += 3

  const restored = await fixture(name, a)
  restored.advance(150)
  await restored.render({ ...a, ops: [op('animated')] })
  assert.equal(restored.state.pending.size, 0)
  assert.equal(restored.state.drawn.size, 1, `${name} 同 id 静态恢复快照应立即落定`)
  restored.advance(1500)
  assert.equal(restored.metrics.outlines, 1)
  restored.unmount()
  checks += 3

  const hidden = await fixture(name, a)
  await hidden.render({ ...a, hiddenSeats: new Set([1]) })
  assert.equal(hidden.state.pending.size, 0)
  assert.equal(hidden.state.deadlines.size, 1)
  hidden.advance(1500)
  await hidden.render(a)
  assert.equal(hidden.state.drawn.size, 1, `${name} 隐藏后重新显示不重新等待已过动画`)
  hidden.unmount()
  checks += 3

  const resized = await fixture(name, a)
  resized.advance(300)
  resized.host.clientWidth = 1600; resized.host.clientHeight = 900
  resized.resize()
  assert.equal(resized.state.pending.size, 1)
  assert.equal([...resized.timers.values()][0].at, 1090)
  resized.advance(790)
  assert.equal(resized.state.drawn.size, 1)
  await resized.render({ ...a, cam: { x: 80, y: 70, z: 1.9 } })
  resized.unmount()
  assert.equal(resized.frames.size + resized.timers.size, 0, `${name} 卸载清理落笔/相机/flush 调度`)
  resized.advance(2000); resized.frame()
  assert.equal(resized.metrics.outlines, 1)
  checks += 5
}

// 验证同一 op 在 100% / 135% 相机、平移、舞台缩放下与 SVG 映射一致。
for (const scale of [1, 0.75]) {
  for (const cam of [{ x: 0, y: 0, z: 1 }, { x: 100, y: -50, z: 1.35 }, { x: -120, y: 80, z: 1.35 }]) {
    const o = op('alignment'), f = await fixture('InkWash', { ...props([o]), cam }, scale)
    const [[x, y]] = f.metrics.points[0]
    assert.ok(Math.abs(x - (o.tf.x - cam.x) * cam.z) < 1e-9)
    assert.ok(Math.abs(y - (o.tf.y - cam.y) * cam.z) < 1e-9)
    f.unmount()
    checks += 2
  }
}
console.log(`PASS：${checks} 项烘焙/墨晕调度与坐标检查；300 笔静态批次每层只 flush 1 次；20 次同步每笔仅 1 个 timer`)
