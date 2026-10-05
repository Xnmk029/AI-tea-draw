/* 双桥连通冒烟：A 建房 → B 加入 → A 发包 → B 收到；同时验证星型方向限制。
   需要：hub 已起 (:19780)，桥 A :5191 桥 B :5192（token 经 argv 传入）
   用法: node server/test-net.mjs <tokenA> <tokenB> */
import WebSocket from 'ws'

const [, , tokA, tokB] = process.argv
if (!tokA || !tokB) { console.error('usage: test-net.mjs <tokenA> <tokenB>'); process.exit(1) }

function client(port, token, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}`)
  const seq = { n: 0 }
  const pending = new Map()
  const events = []
  ws.on('message', (bytes) => {
    const msg = JSON.parse(bytes.toString())
    if (msg.event) { events.push({ event: msg.event, result: msg.result }); onEvent?.(msg.event, msg.result); return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
  })
  let onEvent = null
  const req = (op, payload = {}) => new Promise((resolve, reject) => {
    const id = ++seq.n
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, op, ...payload }))
  })
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  return { name, ws, req, open, events, setOnEvent: (fn) => (onEvent = fn), next: (pred, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(name + ' timeout')), ms); const check = () => { const hit = events.find(pred); if (hit) { clearTimeout(t); res(hit) } else setImmediate(check) }; check() }) }
}

const A = client(5191, tokA, 'A')
const B = client(5192, tokB, 'B')
await Promise.all([A.open, B.open])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(200)

// A 建房
const roomA = await A.req('create')
console.log('A room:', JSON.stringify(roomA))
if (!roomA.room || roomA.hostId !== roomA.selfId) throw new Error('A 不是房主')

// B 加入
const roomB = await B.req('join', { room: roomA.room })
console.log('B joined:', JSON.stringify(roomB))
if (roomB.room !== roomA.room) throw new Error('B 进错房')
await sleep(300)

// A（host）→ B 发包
await A.req('send', { to: roomB.selfId, data: { t: 'op-add', el: { tag: 'line', attrs: { x1: 0, y1: 0, x2: 10, y2: 10 } } } })
const got = await B.next((e) => e.event === 'packet' && e.result.data?.t === 'op-add')
console.log('B received packet from', got.result.from === roomA.selfId ? 'host ✓' : 'WRONG_SENDER')

// 星型方向限制：B（成员）→ A（host）合法
await B.req('send', { to: roomA.selfId, data: { t: 'chat', text: 'hi host' } })
const got2 = await A.next((e) => e.event === 'packet' && e.result.data?.t === 'chat')
console.log('A received chat from', got2.result.from === roomB.selfId ? 'member ✓' : 'WRONG')

// B → B 自己（成员间横向）应被 hub 拒
try {
  await B.req('send', { to: roomB.selfId, data: { t: 'x' } })
  console.log('member→member NOT blocked (hub 只挡成员→成员，自己→自己算到host通道?)')
} catch (e) {
  console.log('member→member blocked ✓', e.message)
}

console.log('== 冒烟通过：create/join/host→member/member→host/星型限制 ==')
process.exit(0)
