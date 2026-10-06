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
const compiled = path.join(root, 'test-output', 'net-regression', `client-${process.pid}`)
mkdirSync(compiled, { recursive: true })
for (const name of ['netClient', 'netSync']) {
  const source = readFileSync(path.join(root, 'src/game', `${name}.ts`), 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
  writeFileSync(path.join(compiled, `${name}.mjs`), result.outputText.replace("from './netClient'", "from './netClient.mjs'"))
}
const oldWindow = globalThis.window, oldWebSocket = globalThis.WebSocket
globalThis.window = globalThis
globalThis.WebSocket = WebSocket
const { connectNet } = await import(pathToFileURL(path.join(compiled, 'netSync.mjs')).href)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`等待失败：${label}`)
}
const bridges = [], links = [], errors = [], hostSession = [], peerSession = []
let hub
const hooks = messages => ({ onPacket: (from, message) => messages.push(message), onError: error => errors.push(error) })
try {
  hub = await startHub({ port: 0 })
  for (let i = 0; i < 2; i++) {
    const transport = await new MockTransport({ project: 'teadraw-client-test', hub: hub.url }).connect()
    bridges.push(await createBridge({ root, project: 'teadraw-client-test', transport }))
  }
  const hostParams = { port: Number(new URL(bridges[0].base).port), token: bridges[0].token, name: '测试房主' }
  const peerParams = { port: Number(new URL(bridges[1].base).port), token: bridges[1].token, name: '测试客机' }
  let host = await connectNet(hostParams, hooks(hostSession))
  links.push(host)
  peerParams.room = host.room
  let peer = await connectNet(peerParams, hooks(peerSession))
  links.push(peer)
  const peerId = peer.selfId, hostId = host.selfId, room = host.room
  for (let i = 0; i < 5; i++) {
    await peer.disconnect()
    peer = await connectNet(peerParams, hooks(peerSession))
    links.push(peer)
    assert.equal(peer.selfId, peerId)
    assert.equal(peer.room, room)
    assert.equal(peer.role, 'peer')
    assert.equal(host.members().length, 2)
  }
  console.log('✓ 客机连续断开并立即重连，原身份与房间保留且无409')
  await peer.close()
  await until(() => host.members().length === 1, '显式离房更新成员')
  peer = await connectNet(peerParams, hooks(peerSession))
  links.push(peer)
  assert.equal(peer.selfId, peerId)
  assert.equal(peer.room, room)
  assert.equal(host.members().length, 2)
  console.log('✓ 客机显式离房后立即重进，桥客户端槽位正确释放')
  await host.disconnect()
  host = await connectNet(hostParams, hooks(hostSession))
  links.push(host)
  assert.equal(host.selfId, hostId)
  assert.equal(host.role, 'host')
  assert.equal(host.room, room)
  assert.equal(hub.rooms.size, 1)
  console.log('✓ 房主立即重连复用已有房间，无意外新建或销毁')

  const first = [], second = [], hostGame = []
  const unFirst = peer.subscribe(hooks(first), 'game')
  const unSecond = peer.subscribe(hooks(second), 'game')
  host.subscribe(hooks(hostGame), 'game')
  hostGame.length = 0
  host.setGame('large-roundtrip')
  peer.setGame('large-roundtrip')
  const text = '茶绘🌱\u0000"\\'.repeat(80000)
  const large = { t: 'snapshot', name: 'large-downstream', text, ops: [{ id: '长笔迹', author: 'agent', el: { tag: 'path', attrs: { d: `M0 0 ${'L1 1 '.repeat(20000)}` } } }] }
  const bytes = Buffer.byteLength(JSON.stringify(large))
  assert.ok(text.length > 80000 && bytes > 768 * 1024)
  host.broadcast(large)
  host.broadcast({ t: 'after-snapshot', name: 'small-after-large' })
  await until(() => first.some(m => m.t === 'after-snapshot') && second.some(m => m.t === 'after-snapshot'), '大快照完整下行及有序后续包')
  for (const messages of [first, second]) {
    assert.deepEqual(messages.map(m => m.t), ['snapshot', 'after-snapshot'])
    assert.deepEqual(messages[0], { ...large, gameId: 'large-roundtrip' })
  }
  assert.equal(peerSession.filter(m => m.name === 'large-downstream').length, 1)
  assert.ok(bridges[0].metrics.sent > 3)
  console.log(`✓ ${bytes}字节Unicode快照透明分块，无截断，两个游戏订阅者均按序收到一次`)

  peer.intent({ t: 'ops', name: 'large-upstream', text })
  peer.intent({ t: 'after-intent', name: 'small-after-upstream' })
  await until(() => hostGame.some(m => m.t === 'after-intent'), '大意图上行及有序后续包')
  assert.deepEqual(hostGame.map(m => m.t), ['ops', 'after-intent'])
  assert.equal(hostGame[0].text, text)
  assert.equal(hostSession.filter(m => m.name === 'large-upstream').length, 1)
  assert.ok(!hostSession.some(m => m.t === 'session-chunk') && !peerSession.some(m => m.t === 'session-chunk'))
  console.log('✓ 大型客机意图完整上行，分块细节不暴露给会话订阅者')

  unFirst()
  unSecond()
  host.setGame('buffered-game')
  peer.setGame('buffered-game')
  host.broadcast({ t: 'snapshot', name: 'late-subscribe', text })
  await until(() => peerSession.some(m => m.name === 'late-subscribe'), '无游戏订阅时接收快照')
  const late = []
  const unLate = peer.subscribe(hooks(late), 'game')
  assert.equal(late.length, 1)
  assert.equal(late[0].text, text)
  host.broadcast({ t: 'new-op', name: 'after-late-subscribe' })
  await until(() => late.length === 2, '晚订阅后续增量')
  assert.deepEqual(late.map(m => m.t), ['snapshot', 'new-op'])
  console.log('✓ 页面切换期间缓冲完整快照，游戏订阅后按序补发一次')

  unLate()
  host.broadcast({ t: 'old-buffered-op', name: 'old-buffer' })
  await until(() => peerSession.some(m => m.name === 'old-buffer'), '旧局缓冲包')
  host.setGame('new-game')
  peer.setGame('new-game')
  const nextGame = [], nextGameOther = []
  peer.subscribe(hooks(nextGame), 'game')
  peer.subscribe(hooks(nextGameOther), 'game')
  assert.equal(nextGame.length, 0)
  await bridges[0].transport.send(peerId, { t: 'ops', gameId: 'buffered-game', name: 'old-in-flight', ops: [] })
  await until(() => peerSession.some(m => m.name === 'old-in-flight'), '旧局在途包到达')
  host.broadcast({ t: 'snapshot', name: 'new-game-snapshot', text })
  await until(() => nextGame.length === 1 && nextGameOther.length === 1, '新局大快照')
  assert.equal(nextGame[0].name, 'new-game-snapshot')
  assert.equal(nextGameOther[0].name, 'new-game-snapshot')
  assert.equal(nextGame[0].gameId, 'new-game')
  assert.equal(nextGame[0].text, text)
  assert.deepEqual(errors, [])
  console.log('✓ 新gameId清理旧局缓冲并过滤在途旧包，新局多订阅者继续完整同步')
  console.log('PASS：7项联机客户端与大包协议回归')
} finally {
  for (const link of links.reverse()) await link.disconnect()
  for (const bridge of bridges) await bridge.close()
  await hub?.close()
  globalThis.window = oldWindow
  globalThis.WebSocket = oldWebSocket
}
