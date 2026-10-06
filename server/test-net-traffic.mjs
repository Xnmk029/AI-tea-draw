import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const { WebSocket } = require('ws')
const { startHub } = require('./net/mock-hub.cjs')
const { MockTransport } = require('./net/mock-transport.cjs')
const { createBridge } = require('./net/bridge.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compiled = path.join(root, 'test-output', 'net-regression', `traffic-client-${process.pid}`)
mkdirSync(compiled, { recursive: true })
for (const name of ['netClient', 'netSync']) {
  const result = ts.transpileModule(readFileSync(path.join(root, 'src/game', `${name}.ts`), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
  writeFileSync(path.join(compiled, `${name}.mjs`), result.outputText.replace("from './netClient'", "from './netClient.mjs'"))
}
const oldWindow = globalThis.window, oldWebSocket = globalThis.WebSocket
globalThis.window = globalThis
globalThis.WebSocket = WebSocket
const { connectNet } = await import(pathToFileURL(path.join(compiled, 'netSync.mjs')).href)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label) {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (read()) return; await sleep(10) }
  throw new Error(`等待失败：${label}`)
}
const bridges = [], links = [], packets = [[], [], []], errors = []
let hub
try {
  hub = await startHub({ port: 0 })
  for (let i = 0; i < 3; i++) {
    const transport = await new MockTransport({ project: 'teadraw-traffic-test', hub: hub.url }).connect()
    bridges.push(await createBridge({ root, project: 'teadraw-traffic-test', transport }))
    const link = await connectNet({ port: Number(new URL(bridges[i].base).port), token: bridges[i].token, room: links[0]?.room }, { onPacket: (from, msg) => packets[i].push(msg), onError: e => errors.push(e) })
    links.push(link)
    link.setGame('traffic-broadcast')
  }
  assert.equal(packets[0].length, 0)
  console.log('✓ 连接层不提前发送重复游戏hello，由页面订阅者负责握手')
  const wire = []
  const originalSend = bridges[0].transport.send.bind(bridges[0].transport)
  bridges[0].transport.send = async (to, data) => { wire.push({ to, data }); return originalSend(to, data) }
  let encodings = 0
  const text = '茶绘🌱"\\'.repeat(60000)
  const large = { t: 'snapshot', text, marker: { toJSON: () => { encodings++; return '编码计数' } } }
  links[0].broadcast(large)
  links[0].broadcast({ t: 'after-snapshot' })
  await until(() => packets[1].at(-1)?.t === 'after-snapshot' && packets[2].at(-1)?.t === 'after-snapshot', '两位成员的大包广播')
  assert.equal(encodings, 1)
  for (const messages of packets.slice(1)) {
    assert.deepEqual(messages.map(m => m.t), ['snapshot', 'after-snapshot'])
    assert.equal(messages[0].text, text)
    assert.equal(messages[0].marker, '编码计数')
  }
  const chunks = wire.filter(m => m.data.t === 'session-chunk')
  assert.ok(chunks.length > 2)
  assert.equal(new Set(chunks.map(m => m.data.id)).size, 1)
  for (let i = 0; i < chunks.length / 2; i++) assert.deepEqual(chunks[i].data, chunks[i + chunks.length / 2].data)
  assert.deepEqual(errors, [])
  console.log(`✓ ${Buffer.byteLength(JSON.stringify({ ...large, marker: '编码计数' }))}字节Unicode广播只编码/分片一次，两位成员收到同一内容及有序后续包`)

  packets[1].length = 0
  packets[2].length = 0
  let failed = false
  bridges[0].transport.send = async (to, data) => {
    if (!failed && to === links[1].selfId) { failed = true; throw new Error('TRAFFIC_TEST_MEMBER_SEND_FAILED') }
    return originalSend(to, data)
  }
  links[0].broadcast({ t: 'snapshot', text, name: 'first-member-fault' })
  links[0].broadcast({ t: 'after-fault' })
  await until(() => packets[2].at(-1)?.t === 'after-fault', '首成员故障后另一成员完整接收')
  assert.deepEqual(packets[2].map(m => m.t), ['snapshot', 'after-fault'])
  assert.equal(packets[2][0].text, text)
  assert.deepEqual(packets[1].map(m => m.t), ['after-fault'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /TRAFFIC_TEST_MEMBER_SEND_FAILED/)
  console.log('✓ 首位接收者发送失败不阻断后续成员完整快照，后续广播继续且错误可见')
  console.log('PASS：3项联机编码复用与故障隔离回归')
} finally {
  for (const link of links.reverse()) await link.disconnect()
  for (const bridge of bridges) await bridge.close()
  await hub?.close()
  globalThis.window = oldWindow
  globalThis.WebSocket = oldWebSocket
}
