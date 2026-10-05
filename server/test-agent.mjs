#!/usr/bin/env node
/**
 * teadraw 端到端自测：脚本化 MCP 客户端（模拟一个真实 Agent 的行为）。
 * 自己拉起 `teadraw mcp` 子进程，然后按真实 Agent 的节奏工作：
 *   initialize → tools/list → room_state（等浏览器连上）
 *   → 轮询 turn_get_task（等玩家在气泡里吩咐）
 *   → canvas_get_targets / canvas_find_space / canvas_describe
 *   → canvas_draw(preview) → events_poll 等玩家盖章 → chat_send
 *
 *   node server/test-agent.mjs [--port 5190] [--taskwait 45] [--wait 30]
 *
 * 前置：dev server 在跑 + 打开 http://localhost:5180/?screen=game 并连上桥。
 * 浏览器输入框里吩咐一句（比如"画一只猫"），Agent 就会干活。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const opt = {}
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i]
const PORT = opt.port ?? '5190'
const TASK_WAIT_S = Number(opt.taskwait ?? 45)
const WAIT_S = Number(opt.wait ?? 30)

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, 'teadraw.mjs')

const child = spawn('node', [server, 'mcp', '--port', PORT, '--name', 'TestPet', '--model', 'scripted'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
const rl = createInterface({ input: child.stdout })
const pending = new Map()
let seq = 0
const notices = []

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id != null) {
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); p(msg) }
  } else if (msg.method) {
    notices.push(msg)
    const d = msg.params?.data
    console.log(`   ⌐ 通知 ${d?.type ?? msg.method} ${JSON.stringify(d ?? '').slice(0, 110)}`)
  }
})

const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

const tool = async (name, a = {}, quiet = false) => {
  const r = await call('tools/call', { name, arguments: a })
  if (r.error) { console.log(`   ✗ ${name} → RPC错误 ${r.error.message}`); return null }
  const c = r.result
  const text = (c?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
  const imgs = (c?.content ?? []).filter((b) => b.type === 'image')
  if (!quiet) {
    if (c?.isError) console.log(`   ✗ ${name} → ${text}`)
    else console.log(`   ✓ ${name} → ${text.slice(0, 140)}${imgs.length ? ` [image×${imgs.length}]` : ''}`)
  }
  return { text, imgs, raw: c, isError: !!c?.isError }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = (s) => { try { return JSON.parse(s) } catch { return null } }

/** 重试直到游戏页面连上桥 */
const untilGame = async (name, a = {}, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const r = await tool(name, a, i > 0)
    if (r && !r.isError) return r
    if (i === 0) console.log(`   … ${name} 等待游戏页面连上桥`)
    await sleep(1000)
  }
  return null
}

console.log(`── 拉起 teadraw mcp（端口 ${PORT}）`)
await sleep(700)

console.log(`── initialize / tools/list`)
const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-agent', version: '0.1' } })
console.log(`   ✓ ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version} · 协议 ${init.result?.protocolVersion}`)
notify('notifications/initialized')
const list = await call('tools/list')
console.log(`   ✓ 工具 ${list.result?.tools?.length} 个：${(list.result?.tools ?? []).map((t) => t.name).join(' ')}`)

console.log(`── room_state（等游戏连上桥）`)
if (!(await untilGame('room_state'))) { console.log('── 游戏 30s 内没连上，退出'); child.kill(); process.exit(1) }

console.log(`── 轮询 turn_get_task（${TASK_WAIT_S}s 内请在气泡里吩咐一句，如「画一只猫」）`)
let task = null
{
  const t0 = Date.now()
  while (Date.now() - t0 < TASK_WAIT_S * 1000 && !task) {
    const r = await untilGame('turn_get_task', {}, 60)
    task = J(r?.text ?? '')?.task
    if (!task) await sleep(1200)
  }
}
if (!task) console.log('── 没等到任务，Agent 自主作画（canvas_find_space 找空位）')
else console.log(`   · 领到任务「${task.text}」 · 标记 ${task.targets} · 墨量剩 ${task.ink?.remaining}`)

console.log(`── canvas_get_targets / canvas_find_space`)
const tg = await untilGame('canvas_get_targets')
const targets = J(tg?.text ?? '')?.targets ?? []
let frame = null
if (targets.length) {
  frame = { key: 'targetId', id: targets[0].id }
  console.log(`   · 用玩家标记帧 ${targets[0].id}（${targets[0].kind}）`)
} else {
  const sp = await untilGame('canvas_find_space', { w: 240, h: 240 })
  frame = { key: 'spaceId', id: J(sp?.text ?? '')?.space?.id }
  if (frame.id) console.log(`   · 用 find_space 帧 ${frame.id}`)
}

await untilGame('canvas_describe', {})
await untilGame('canvas_snapshot', frame.id ? { targetId: frame.id } : {})

console.log(`── canvas_draw（preview · 五角星，帧局部坐标）`)
const star = `<polygon points="120,18 147,92 226,94 162,141 185,217 120,171 55,217 78,141 14,94 93,92" fill="#E8B33C" stroke="#3B3A36" stroke-width="6" stroke-linejoin="round"/>`
const draw = await untilGame('canvas_draw', { svg: star, ...(frame.id ? { [frame.key]: frame.id } : {}), mode: 'preview' })
const drawRes = J(draw?.text ?? '')

if (drawRes?.previewId) {
  console.log(`── events_poll：等玩家盖章/揉掉（${WAIT_S}s；对局页 Tab 接受 / Esc 拒绝）`)
  const t0 = Date.now()
  let seq0 = 0
  let done = null
  while (Date.now() - t0 < WAIT_S * 1000 && !done) {
    const ev = await untilGame('events_poll', { since: seq0 }, 60)
    for (const e of J(ev?.text ?? '')?.events ?? []) {
      seq0 = Math.max(seq0, e.seq)
      if (e.type === 'preview' && e.data?.previewId === drawRes.previewId && e.data.result !== 'set') done = e.data.result
    }
    if (!done) await sleep(1000)
  }
  console.log(done ? `── 草稿${done === 'accepted' ? '已盖章落定 ✓ 端到端流程通' : '被揉掉（rejected）'}` : `── ${WAIT_S}s 内没人处理草稿（调用链仍是通的）`)
}

console.log(`── chat_send / 收尾`)
await untilGame('chat_send', { text: 'TestPet 自测完成，收工。' })
child.kill()
console.log(`── 结束（捕获通知 ${notices.length} 条）`)
process.exit(0)
