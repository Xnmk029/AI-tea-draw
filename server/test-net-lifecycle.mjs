import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { startHub } = require('./net/mock-hub.cjs')
const { MockTransport } = require('./net/mock-transport.cjs')
const { createBridge } = require('./net/bridge.cjs')
const { WebSocket } = require('ws')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const bridges = [], clients = []
let hub

async function until(read, label, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`等待失败：${label}`)
}

async function client(bridge) {
  const ws = new WebSocket(`${bridge.base.replace('http:', 'ws:')}/bridge?token=${bridge.token}`)
  const events = [], pending = new Map()
  let seq = 0
  const result = { ws, events, state: null, request, disconnect }
  clients.push(result)
  ws.on('error', () => {})
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    if (message.event) {
      events.push(message)
      if (message.event === 'state' || message.event === 'members') result.state = message.result
      return
    }
    const task = pending.get(message.id)
    if (!task) return
    clearTimeout(task.timer)
    pending.delete(message.id)
    message.error ? task.reject(new Error(message.error)) : task.resolve(message.result)
  })
  ws.on('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('连接关闭')) }
    pending.clear()
  })
  function request(op, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`请求超时：${op}`)) }, 3000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, op, ...payload }))
    })
  }
  async function disconnect() {
    if (ws.readyState === WebSocket.CLOSED) return
    await new Promise(resolve => { ws.once('close', resolve); ws.close() })
  }
  await until(() => result.state, '桥初始状态')
  return result
}

try {
  hub = await startHub({ port: 0 })
  for (let i = 0; i < 2; i++) {
    const transport = await new MockTransport({ project: 'teadraw-lifecycle-test', hub: hub.url }).connect()
    bridges.push(await createBridge({ root, project: 'teadraw-lifecycle-test', transport, reconnectGraceMs: 500 }))
  }
  let host = await client(bridges[0]), peer = await client(bridges[1])
  const room = await host.request('create')
  await peer.request('join', { room: room.room })
  assert.equal(hub.rooms.size, 1)
  assert.equal(bridges[0].transport.info().members.length, 2)
  const same = await host.request('join', { room: room.room })
  assert.equal(same.hostId, room.hostId)
  assert.equal(hub.rooms.size, 1)
  assert.equal(same.members.length, 2)
  console.log('✓ 房主重复加入同一房间保留房间与成员')

  await peer.disconnect()
  assert.equal(bridges[0].transport.info().members.length, 2)
  peer = await client(bridges[1])
  assert.equal(peer.state.room, room.room)
  assert.equal(peer.state.selfId, bridges[1].transport.info().selfId)
  await peer.request('join', { room: room.room })
  assert.equal(bridges[0].transport.info().members.length, 2)
  await peer.request('send', { to: room.hostId, data: { t: 'reconnect-probe' } })
  await until(() => host.events.some(e => e.event === 'packet' && e.result.data.t === 'reconnect-probe'), '客机恢复后发送')
  console.log('✓ 客机刷新恢复相同身份且仍可发送消息')

  await host.disconnect()
  assert.equal(hub.rooms.size, 1)
  host = await client(bridges[0])
  assert.equal(host.state.room, room.room)
  assert.equal(host.state.hostId, room.hostId)
  await host.request('join', { room: room.room })
  await host.request('send', { to: peer.state.selfId, data: { t: 'host-reconnect-probe' } })
  await until(() => peer.events.some(e => e.event === 'packet' && e.result.data.t === 'host-reconnect-probe'), '房主恢复后发送')
  console.log('✓ 房主刷新宽限期内保持房间和房主身份')

  await peer.request('leave')
  await until(() => bridges[0].transport.info().members.length === 1, '显式客机离房')
  assert.equal(hub.rooms.size, 1)
  await peer.request('join', { room: room.room })
  await host.request('leave')
  assert.equal(hub.rooms.size, 0)
  await until(() => peer.events.some(e => e.event === 'closed' && e.result.reason === 'HOST_LEFT'), '显式房主离房通知')
  console.log('✓ 显式离房立即生效，房主离房通知客机')

  await host.request('create')
  await host.disconnect()
  assert.equal(hub.rooms.size, 1)
  await until(() => hub.rooms.size === 0, '宽限期到期释放房间')
  console.log('✓ 超过刷新宽限期自动释放房间')

  host = await client(bridges[0])
  const hubRoom = await host.request('create')
  await peer.request('join', { room: hubRoom.room })
  const activeHub = hub
  hub = null
  await activeHub.close()
  await until(() => host.events.some(e => e.event === 'closed' && e.result.reason === 'MOCK_DISCONNECTED'), '中枢关闭通知房主')
  await until(() => peer.events.some(e => e.event === 'closed' && e.result.reason === 'MOCK_DISCONNECTED'), '中枢关闭通知客机')
  assert.equal(bridges[0].transport.info().room, null)
  assert.deepEqual(bridges[1].transport.info().members, [])
  await assert.rejects(host.request('send', { to: peer.state.selfId, data: { t: 'disconnected-probe' } }), /MOCK_DISCONNECTED/)
  console.log('✓ 中枢断线通知浏览器并立即拒绝发送')
  console.log('PASS：联机桥生命周期回归')
} finally {
  for (const c of clients) await c.disconnect()
  for (const bridge of bridges) await bridge.close()
  await hub?.close()
}
