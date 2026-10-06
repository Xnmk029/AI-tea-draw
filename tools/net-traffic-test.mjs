import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixture, root, output, sleep, until } from './net-test-helpers.mjs'

// 独立 Mock 房间，覆盖重复握手、结算与迟到成员的实际字节/发送次数。
const require = createRequire(import.meta.url)
const { MockTransport } = require('../server/net/mock-transport.cjs')
const { createBridge } = require('../server/net/bridge.cjs')
const f = await fixture()
const checks = []
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`✓ ${name}`) }
const latest = (page, type) => page.messages.filter(m => m.direction === 'received' && m.data.t === type).at(-1)?.data
const sent = (page, from, type) => page.messages.slice(from).filter(m => m.direction === 'sent' && m.data.t === type)
const received = (page, from, type) => page.messages.slice(from).filter(m => m.direction === 'received' && m.data.t === type)
const bytes = messages => messages.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m.data)), 0)
let report
try {
  const A = await f.newPage('traffic-host', f.bridges[0], { name: '流量房主' })
  await A.waitScreen('home')
  await A.click('开始茶会', '.main-menu button')
  await A.click('创建房间', '.sheet-actions button')
  await A.waitScreen('lobby')
  const room = await until(() => f.bridges[0].transport.info().room, '流量测试房间')
  const B = await f.newPage('traffic-peer', f.bridges[1], { room, screen: 'lobby', name: '流量客机' })
  await B.waitScreen('lobby')
  await until(() => latest(B, 'lobby-state')?.members.length === 2, '流量测试客机入座')
  await A.click('开始', '.anchor.a-br button.primary')
  await Promise.all([A.waitScreen('game'), B.waitScreen('game')])
  await until(() => latest(B, 'snapshot'), '初次完整快照')
  await sleep(300)
  check('进入对局只收到一次完整快照', received(B, 0, 'snapshot').length === 1)
  const gameId = latest(B, 'lobby-state').gameId
  for (let i = 0; i < 12; i++) await B.inject({ t: 'op', gameId, round: 1, author: 'human', el: { tag: 'circle', attrs: { cx: 150 + i * 40, cy: 200, r: 12, fill: 'none', stroke: '#3b3a36', 'stroke-width': 3 } } })
  await until(async () => (await A.opIds()).length === 12 && (await B.opIds()).length === 12, '流量测试十二笔同步')

  const helloMark = A.messages.length
  const hello = { t: 'hello', gameId, name: '流量客机', requestId: 'traffic-identical-request' }
  for (let i = 0; i < 5; i++) await B.inject(hello)
  await until(() => sent(A, helloMark, 'snapshot').length === 1, '重复握手快照')
  await sleep(300)
  const helloTraffic = A.messages.slice(helloMark).filter(m => m.direction === 'sent')
  check('五次相同游戏握手只补一次定向快照', sent(A, helloMark, 'snapshot').length === 1)
  check('名单未变时游戏握手不广播大厅或座位表', sent(A, helloMark, 'lobby-state').length === 0 && sent(A, helloMark, 'roster').length === 0)

  const endMark = A.messages.length
  await A.click('结束本局', '.tb-right button')
  await Promise.all([A.waitScreen('result'), B.waitScreen('result')])
  const result = latest(B, 'session-over')?.result
  check('结算完整笔迹只广播一次', sent(A, endMark, 'session-over').length === 1 && result?.ops.length === 12)
  check('结算大厅状态没有重复夹带完整结果', sent(A, endMark, 'lobby-state').length === 1 && !sent(A, endMark, 'lobby-state')[0].data.result)

  const transport = await new MockTransport({ project: 'teadraw-browser-test', hub: f.hub.url }).connect()
  const bridge = await createBridge({ root, project: 'teadraw-browser-test', transport })
  f.bridges.push(bridge)
  const bBeforeLate = B.messages.length
  const C = await f.newPage('traffic-late-peer', bridge, { room, screen: 'lobby', name: '迟到客机' })
  await C.waitScreen('result')
  await until(() => latest(C, 'session-over')?.result?.ops.length === 12, '迟到客机真实结算注水')
  const lateResult = latest(C, 'session-over').result
  check('第三人结算阶段加入收到同局完整笔迹和比分', JSON.stringify(lateResult.ops) === JSON.stringify(result.ops) && JSON.stringify(lateResult.seats.map(s => s.score)) === JSON.stringify(result.seats.map(s => s.score)) && latest(C, 'session-over').gameId === gameId)
  check('迟到成员加入不向已有玩家重复发送完整结算', received(B, bBeforeLate, 'session-over').length === 0)

  const cBeforeReconnect = C.messages.length
  await B.reload()
  await B.waitScreen('result')
  await until(() => latest(B, 'session-over')?.result?.ops.length === 12, '结算刷新真实结果注水')
  check('结算刷新恢复同局笔迹和比分', latest(B, 'session-over').gameId === gameId && JSON.stringify(latest(B, 'session-over').result.ops) === JSON.stringify(result.ops) && JSON.stringify(latest(B, 'session-over').result.seats.map(s => s.score)) === JSON.stringify(result.seats.map(s => s.score)))
  check('结算刷新只向刷新者补发结果', received(C, cBeforeReconnect, 'session-over').length === 0)

  const lobbyMark = A.messages.length, cBeforeHello = C.messages.length
  await B.inject({ t: 'lobby-hello', name: '流量客机' })
  await until(() => sent(A, lobbyMark, 'session-over').length === 1, '定向结果重发')
  await sleep(300)
  check('名单未变的大厅重握手仅回复请求者', sent(A, lobbyMark, 'lobby-state').length === 1 && received(C, cBeforeHello, 'lobby-state').length === 0 && received(C, cBeforeHello, 'session-over').length === 0)
  const smallState = sent(A, endMark, 'lobby-state')[0].data
  const fullResult = { t: 'session-over', gameId, result }
  const oldState = { ...smallState, result }
  const endPackets = A.messages.slice(endMark).filter(m => m.direction === 'sent' && ['session-over', 'lobby-state'].includes(m.data.t)).slice(0, 2)
  const oldEndBytes = Buffer.byteLength(JSON.stringify(fullResult)) + Buffer.byteLength(JSON.stringify(oldState))
  const newEndBytes = bytes(endPackets)
  const snapshot = sent(A, helloMark, 'snapshot')[0].data
  const oldHelloBytes = 5 * (Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(smallState)) + Buffer.byteLength(JSON.stringify({ t: 'roster', gameId, seats: snapshot.seats })) + Buffer.byteLength(JSON.stringify({ t: 'seat-assign', gameId, seat: 2, color: '#668B81' })))
  report = { checks, comparison: '旧行为按同一实测载荷重复发送推算；新行为统计实际发送应用JSON的UTF-8字节，不含WS/Steam包头', repeatedHello: { oldBytes: oldHelloBytes, newBytes: bytes(helloTraffic), savedPercent: +(100 * (1 - bytes(helloTraffic) / oldHelloBytes)).toFixed(1) }, finish: { oldBytes: oldEndBytes, newBytes: newEndBytes, savedPercent: +(100 * (1 - newEndBytes / oldEndBytes)).toFixed(1) } }
  check('所有页面无React运行异常', [A, B, C].every(p => p.errors.length === 0))
  report.checks = checks
  console.log(JSON.stringify(report, null, 2))
} finally {
  writeFileSync(path.join(output, 'traffic-summary.json'), JSON.stringify(report ?? { checks }, null, 2))
  await f.close()
}
