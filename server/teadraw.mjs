#!/usr/bin/env node
/**
 * teadraw · 茶绘真实 Agent 桥（零依赖，Node ≥ 20）
 *
 *   node server/teadraw.mjs mcp     默认：MCP stdio 服务 + WebSocket 桥（浏览器连进来）
 *   node server/teadraw.mjs bridge  只开 WebSocket 桥（不接 stdio，挂给长驻进程用）
 *   node server/teadraw.mjs ping    检查端口上的桥是否在跑
 *
 * 协议见 server/README.md。
 */
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { Socket } from 'node:net'

const VERSION = '0.1.0'
const PROTOCOL_VERSION = '2024-11-05'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ---------- CLI ----------
const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'mcp'
const opt = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) opt[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
}
const PORT = Number(opt.port ?? 5190)
const ROOM = opt.room ?? 'A7K2'
const AGENT_NAME = opt.name ?? 'Agent'
const AGENT_MODEL = opt.model ?? 'unknown'

if (cmd === 'help' || opt.help) {
  console.log(`teadraw v${VERSION}
  mcp     MCP stdio 服务 + WebSocket 桥（默认，给 Agent 的 MCP 客户端托管启动）
  bridge  只开 WebSocket 桥（stdio 闲置时用它做常驻桥）
  ping    检查 --port 上的桥
  --port 5190 --room A7K2 --seat 0 --name Claude --model sonnet`)
  process.exit(0)
}

if (cmd === 'ping') {
  const s = new Socket()
  const done = (ok) => { console.log(ok ? `pong · 127.0.0.1:${PORT} 桥在跑` : `无响应 · 127.0.0.1:${PORT}`); process.exit(ok ? 0 : 1) }
  s.setTimeout(1500)
  s.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false))
  s.connect(PORT, '127.0.0.1')
} else if (cmd === 'bridge') {
  startBridge(null)
} else if (cmd === 'mcp') {
  startBridge(startMcp)
} else {
  console.error(`未知命令：${cmd}`)
  process.exit(1)
}

// ---------- 房间桥（手写 WebSocket 服务） ----------
// gameSocket：浏览器；agent 端就是本进程（stdio）。两边通过 call/result/event 互通。
const state = {
  game: null,            // 浏览器 WS
  agentAwake: false,     // MCP initialize 完成
  pending: new Map(),    // id → {resolve, timer}  tools/call 等待游戏回执
  seq: 0,
}
const log = (...a) => console.error('[teadraw]', ...a)

function startBridge(onReady) {
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, name: 'teadraw-bridge', version: VERSION, game: !!state.game, agentAwake: state.agentAwake }))
  })
  http.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) return socket.destroy()
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`,
    )
    wsAttach(socket)
  })
  http.listen(PORT, '127.0.0.1', () => {
    log(`bridge 已就绪 · ws://127.0.0.1:${PORT} · room=${ROOM} agent=${AGENT_NAME}(${AGENT_MODEL})`)
    onReady?.()
  })
}

// ---------- WS 帧编解码 ----------
function wsSend(socket, text) {
  const payload = Buffer.from(text)
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  socket.write(Buffer.concat([header, payload]))
}

function wsAttach(socket) {
  let buf = Buffer.alloc(0)
  let frags = []
  const send = (obj) => { if (!socket.destroyed) wsSend(socket, JSON.stringify(obj)) }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const fin = buf[0] & 0x80
      const op = buf[0] & 0x0f
      const masked = buf[1] & 0x80
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const maskOff = off
      if (masked) off += 4
      if (buf.length < off + len) return
      let payload = buf.subarray(off, off + len)
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      }
      buf = buf.subarray(off + len)

      if (op === 8) { socket.destroy(); return }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue }
      if (op === 10) continue
      if (op === 0 || op === 1 || op === 2) {
        frags.push(payload)
        if (!fin) continue
        const text = Buffer.concat(frags).toString('utf8')
        frags = []
        let msg
        try { msg = JSON.parse(text) } catch { continue }
        onGameMessage(send, socket, msg)
      }
    }
  })
  socket.on('close', onGameClose)
  socket.on('error', () => socket.destroy())
}

// ---------- 游戏侧消息 ----------
function onGameMessage(send, socket, msg) {
  if (msg.t === 'join' && msg.role === 'game') {
    if (state.game && !state.game.destroyed) {
      send({ t: 'joined', ok: false, error: '另一个游戏页面已占用桥（先关掉它）' })
      return
    }
    state.game = socket
    socket._isGame = true
    send({ t: 'joined', ok: true, room: msg.room, seat: msg.seat, peer: state.agentAwake ? { state: 'awake', name: AGENT_NAME, model: AGENT_MODEL } : { state: 'ready', name: AGENT_NAME, model: AGENT_MODEL } })
    log(`游戏接入 · room=${msg.room} seat=${msg.seat}（${msg.me?.name ?? '?'}）`)
    return
  }
  if (msg.t === 'result') {
    const p = state.pending.get(msg.id)
    if (!p) return
    state.pending.delete(msg.id)
    clearTimeout(p.timer)
    p.resolve(msg)
    return
  }
  if (msg.t === 'event') {
    // 游戏事件：推给 MCP 客户端为 notifications/message
    notifyMcp('notifications/message', { level: 'info', logger: 'teadraw', data: msg.ev })
    return
  }
}

function onGameClose() {
  if (this === state.game || this._isGame) {
    state.game = null
    for (const [, p] of state.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: { code: 'host_gone', message: '游戏页面已断开' } }) }
    state.pending.clear()
    log('游戏断开')
  }
}

/** Agent 的 tools/call → 转发给浏览器，等回执（30s 超时） */
function callGame(name, args) {
  return new Promise((resolve) => {
    if (!state.game || state.game.destroyed) return resolve({ ok: false, error: { code: 'no_game', message: '茶绘页面没有连接 —— 先打开对局并让它连上桥' } })
    const id = `c${++state.seq}`
    const timer = setTimeout(() => {
      state.pending.delete(id)
      resolve({ ok: false, error: { code: 'timeout', message: `工具 ${name} 30s 无回执` } })
    }, 30000)
    state.pending.set(id, { resolve, timer })
    wsSend(state.game, JSON.stringify({ t: 'call', id, name, args }))
  })
}

// ---------- MCP 工具表 ----------
const TOOLS = [
  { name: 'turn_get_task', description: '读取玩家当前派给 Agent 的任务（指令原文、模式、轮次、墨量余额、房规）。没有任务时返回 task:null。', inputSchema: { type: 'object', properties: {} } },
  { name: 'canvas_get_targets', description: '读取玩家插的落笔指引标记（令旗/区域/套索/引路/锚定/九宫格）。返回 [{id,kind,frame,slots?}]；你的 SVG 画在 frame 的局部坐标 0..w×0..h 里。', inputSchema: { type: 'object', properties: {} } },
  { name: 'canvas_find_space', description: '没有标记时申请一块空白落笔帧。', inputSchema: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' }, near: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } }, required: ['w', 'h'] } },
  { name: 'canvas_snapshot', description: '获取指定帧（默认当前视口）的光栅截图，返回 PNG image 块。猜词方同样只能拿到光栅图。', inputSchema: { type: 'object', properties: { targetId: { type: 'string' } } } },
  { name: 'canvas_describe', description: '列出区域内笔迹的元素级信息（id/作者/包围盒）。你画我猜里不返回 label。', inputSchema: { type: 'object', properties: { targetId: { type: 'string' } } } },
  {
    name: 'canvas_draw',
    description: '提交 SVG 作画。svg 画在 targetId/spaceId 帧的局部坐标里；repeat=true 落到引路目标的所有槽位；mode=preview 出描红草稿（助手档强制预览），commit 直接落笔（协作/托管档）。',
    inputSchema: {
      type: 'object',
      properties: {
        svg: { type: 'string', description: 'SVG 片段（只允许 path line polyline polygon rect circle ellipse 与 <g>）' },
        targetId: { type: 'string' }, spaceId: { type: 'string' },
        repeat: { type: 'boolean' }, fit: { type: 'string', enum: ['contain', 'clip', 'strict'] },
        mode: { type: 'string', enum: ['preview', 'commit'] },
      },
      required: ['svg'],
    },
  },
  { name: 'canvas_commit', description: '把待审的描红草稿落定（协作/托管档 Agent 自审用；助手档只能等玩家盖章）。', inputSchema: { type: 'object', properties: { previewId: { type: 'string' } }, required: ['previewId'] } },
  { name: 'chat_send', description: '以 Agent 身份在房间聊天里发言。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'guess_submit', description: '猜词方 Agent 提交猜测文本，返回 correct/close/wrong 与得分（经 Agent 猜中得分减半）。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'hint_whisper', description: '猜词方 Agent 向自己的玩家递一条悄悄提示（每轮一次）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'events_poll', description: '增量拉取游戏事件（新任务、草稿被盖章/揉掉、回合、聊天）。', inputSchema: { type: 'object', properties: { since: { type: 'number' } } } },
  { name: 'room_state', description: '房间信息：模式、座位表、房规、Agent 绑定的座位。', inputSchema: { type: 'object', properties: {} } },
]

// ---------- MCP stdio ----------
let mcpOut = null
function sendMcp(msg) {
  if (mcpOut) mcpOut(JSON.stringify(msg))
}
function notifyMcp(method, params) {
  sendMcp({ jsonrpc: '2.0', method, params })
}

function startMcp() {
  const rl = createInterface({ input: process.stdin, terminal: false })
  const out = (line) => process.stdout.write(line + '\n')
  mcpOut = out
  log('stdio MCP 已就绪，等待 MCP 客户端…')

  rl.on('line', async (line) => {
    const t = line.trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch { return }
    const { id, method, params } = msg
    if (method === 'notifications/initialized') return
    const reply = (result) => id != null && sendMcp({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => id != null && sendMcp({ jsonrpc: '2.0', id, error: { code, message } })

    try {
      if (method === 'initialize') {
        reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'teadraw', version: VERSION } })
        if (!state.agentAwake) {
          state.agentAwake = true
          if (state.game && !state.game.destroyed) wsSend(state.game, JSON.stringify({ t: 'peer', state: 'awake', name: AGENT_NAME, model: AGENT_MODEL }))
          log(`Agent 客户端已唤醒 · ${params?.clientInfo?.name ?? '?'} ${params?.clientInfo?.version ?? ''}`)
        }
        return
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list') return reply({ tools: TOOLS })
      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (!TOOLS.some((x) => x.name === name)) return reply({ content: [{ type: 'text', text: `未知工具：${name}` }], isError: true })
        const res = await callGame(name, args)
        if (!res.ok) return reply({ content: [{ type: 'text', text: `错误[${res.error.code}] ${res.error.message}` }], isError: true })
        return reply({ content: res.content ?? [{ type: 'text', text: JSON.stringify(res.data ?? null) }] })
      }
      if (id != null) fail(-32601, `方法未实现：${method}`)
    } catch (e) {
      if (id != null) fail(-32000, String(e?.message ?? e))
    }
  })

  // 进程退出 → 通知游戏端 Agent 离线
  const bye = () => {
    if (state.game && !state.game.destroyed) wsSend(state.game, JSON.stringify({ t: 'peer', state: 'down' }))
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  rl.on('close', bye)
}
