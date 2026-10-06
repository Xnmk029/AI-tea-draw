import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const stroke = require('perfect-freehand')
let builds = 0
let paths = 0
class TestPath2D {
  constructor(d) { paths++; this.commands = d ? [['path', d]] : [] }
  moveTo(...args) { this.commands.push(['move', ...args]) }
  lineTo(...args) { this.commands.push(['line', ...args]) }
  closePath() { this.commands.push(['close']) }
  rect(...args) { this.commands.push(['rect', ...args]) }
  arc(...args) { this.commands.push(['arc', ...args]) }
  ellipse(...args) { this.commands.push(['ellipse', ...args]) }
}
const source = readFileSync(new URL('../src/brush/stroke.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const context = vm.createContext({ exports: {}, Path2D: TestPath2D, require: name => name === 'perfect-freehand' ? { getStroke: (...args) => { builds++; return stroke.getStroke(...args) } } : require(name) })
vm.runInContext(compiled, context, { timeout: 1000 })
const { brushOutline, elToPath2D, outlineToPath2D } = context.exports
const elements = Array.from({ length: 1200 }, (_, i) => ({ tag: 'path', attrs: { d: 'M0 0 ' + Array.from({ length: 80 }, (_, n) => `L${n * 3} ${Math.sin((n + i) / 9) * 20}`).join(' '), stroke: '#000', strokeWidth: 4, 'data-pp': '0.2,0.7,0.3' } }))
const started = performance.now()
const outlines = elements.map((el, i) => brushOutline(el, `stroke-${i}`))
const coldMs = performance.now() - started
const buildsAfterCold = builds
const warmStart = performance.now()
for (let pass = 0; pass < 3; pass++) elements.forEach((el, i) => assert.equal(brushOutline(el, `stroke-${i}`), outlines[i]))
const warmMs = (performance.now() - warmStart) / 3
assert.equal(builds, buildsAfterCold, '超过900笔后重绘不能重新生成已有轮廓')
const out = outlines[0]
assert.notEqual(brushOutline(elements[0], 'another-seed'), out, '同一元素的不同种子必须分别缓存')
assert.equal(elToPath2D(elements[0]), elToPath2D(elements[0]))
assert.equal(outlineToPath2D(out), outlineToPath2D(out))
assert.equal(paths, 2, '元素和轮廓Path2D各构建一次')
assert.equal(outlineToPath2D(out).commands.length, out.pts.length + 1)
const cloned = { tag: elements[0].tag, attrs: { ...elements[0].attrs } }
assert.equal(brushOutline(cloned, 'stroke-0').d, out.d, '缓存不改变确定性轮廓几何')
const result = { count: elements.length, coldMs: Number(coldMs.toFixed(2)), warmMsPerPass: Number(warmMs.toFixed(2)), repeatedBuilds: builds - buildsAfterCold - 2, pathBuilds: paths, scope: '真实笔刷实现的 Node CPU 基准；不代表浏览器帧率' }
mkdirSync(new URL('../test-output/performance/', import.meta.url), { recursive: true })
writeFileSync(new URL('../test-output/performance/brush-cache.json', import.meta.url), JSON.stringify(result, null, 2))
console.log('PASS：1200笔轮廓缓存、Path2D复用、种子隔离和几何一致性', JSON.stringify(result))
