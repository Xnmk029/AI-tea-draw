// 测试真实 fastPts 实现；用现有 TypeScript 转译并限时执行，不依赖浏览器或新增依赖。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../src/brush/stroke.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const context = vm.createContext({ require, exports: {}, result: null })
vm.runInContext(compiled, context, { timeout: 1000 })
const sample = d => {
  context.pathData = d
  vm.runInContext("result = fastPts({tag:'path', attrs:{d:pathData}})", context, { timeout: 250 })
  return JSON.parse(JSON.stringify(context.result))
}
for (const d of ['M0 0 Z 1', '1 1 2 2', 'M0', 'M0 0 Q1 2 3', 'M0 0 L2 Q1 2 3 4', 'M0 0 % L1 1', 'M0 0 L1e999 2', 'M0 0 L1 1 M2 2 L3 3']) {
  assert.equal(sample(d), null, `应安全回退 DOM: ${d}`)
}
assert.deepEqual(sample('M10 10 L20 10').pts, [{ x: 10, y: 10 }, { x: 20, y: 10 }])
assert.deepEqual(sample('m10 10 l10 0').pts, [{ x: 10, y: 10 }, { x: 20, y: 10 }])
assert.deepEqual(sample('m10 10 10 0 0 5').pts, [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 15 }])
assert.deepEqual(sample('M10 10 l10 0 q5 5 10 0'), sample('M10 10 L20 10 Q25 15 30 10'))
const curve = sample('M0 0 Q4 8 8 0 L10 0')
assert.equal(curve.pts.length, 10)
assert.deepEqual(curve.pts[4], { x: 4, y: 4 })
assert.deepEqual(curve.pts.at(-1), { x: 10, y: 0 })
assert.equal(curve.closed, false)
assert.equal(sample('M0 0 L1 1 Z').closed, true)
assert.equal(sample('m0 0 l1 1 z').closed, true)
assert.deepEqual(sample('M+.5 -1e1 L2. 3').pts, [{ x: 0.5, y: -10 }, { x: 2, y: 3 }])
console.log('brush-parser-test: malformed fallback, relative semantics and absolute curve regression passed')
