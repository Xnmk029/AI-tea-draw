#!/usr/bin/env node
/* ============================================================
   TeaDraw 联机桥 CLI（T3）
     node server/teadraw-net.mjs hub  --port 19780 [--host 0.0.0.0]       # 本地 mock 中枢（跨机加 --host 0.0.0.0）
     node server/teadraw-net.mjs net  [--port 5191] [--transport mock|steam]
                                    [--hub ws://127.0.0.1:19780] [--appid 480] [--vite 5180]
                                    [--lobby public|friends|invisible] [--root dist]
                                    [--room CODE] [--name 名字] [--screen game] [--open]
     node server/teadraw-net.mjs ping [--port 5191]
   每位玩家本机跑一个 net 桥；浏览器经 ?net=<port>&token=<tok> 深链接入。
   --root 指向含 index.html 的目录时桥自身发静态页（便携包，无需 vite）；
   --room 时深链直进对局，不带 room 落主页（开始茶会/加入房间走真实菜单）；
   --name 拼进深链；--open 直接拉起默认浏览器。
   星型拓扑：成员消息只到房主（hostId），房主广播给全员。
   ============================================================ */
import { createRequire } from 'node:module'
import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = 'teadraw'
const HUB_PORT = 19780
const NET_PORT = 5191
const VITE_PORT = 5180

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i]?.startsWith('--')) break
    // 无值 flag（如 --open）：下一项是 -- 开头或结尾则按 flag 计
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) { out[argv[i].slice(2)] = ''; continue }
    out[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return out
}

/** 本机首个对外 IPv4（给 host 打印可分享的 hub 地址） */
function lanIp() {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return null
}

async function cmdHub(o) {
  const { startHub } = require('./net/mock-hub.cjs')
  const port = Number(o.port) || HUB_PORT
  const host = o.host || '127.0.0.1'
  const hub = await startHub({ port, host })
  const lan = host === '0.0.0.0' ? lanIp() : null
  console.log(JSON.stringify({ event: 'ready', url: hub.url, lan: lan ? `ws://${lan}:${port}` : null, transport: 'mock' }))
  if (lan) console.log(`分享给对端的 hub 地址：ws://${lan}:${port}`)
  const close = async () => { await hub.close(); process.exit(0) }
  process.once('SIGINT', close); process.once('SIGTERM', close)
}

async function cmdNet(o) {
  const { createBridge } = require('./net/bridge.cjs')
  const transportKind = (o.transport || 'mock').toLowerCase()
  let transport
  if (transportKind === 'mock') {
    const { MockTransport } = require('./net/mock-transport.cjs')
    transport = await new MockTransport({ project: PROJECT, hub: o.hub || `ws://127.0.0.1:${HUB_PORT}` }).connect()
  } else {
    const { SteamTransport } = require('./net/steam-transport.cjs')
    // --lobby public|friends|invisible（ELobbyType：Private=0 FriendsOnly=1 Public=2 Invisible=3）
    const LT = { private: 0, friends: 1, public: 2, invisible: 3 }[(o.lobby || '').toLowerCase()]
    transport = new SteamTransport({ project: PROJECT, appId: Number(o.appid) || 480, lobbyType: LT })
  }
  const port = Number(o.port) || NET_PORT
  // --root：桥自身发静态页（便携包场景）；不给则按 vite dev 印 localhost:5180 链接
  const root = o.root ? path.resolve(process.cwd(), o.root) : ROOT
  const selfServe = !!o.root
  if (selfServe && !fs.existsSync(path.join(root, 'index.html'))) {
    console.error(`--root ${root} 下没有 index.html（先 vite build 或指向 dist）`)
    process.exit(1)
  }
  const bridge = await createBridge({ root, project: PROJECT, transport, port })
  const bPort = bridge.base.split(':').pop()
  const vite = Number(o.vite) || VITE_PORT
  const deep = new URL(selfServe ? `${bridge.base}/index.html` : `http://localhost:${vite}/`)
  deep.searchParams.set('net', bPort)
  deep.searchParams.set('token', bridge.token)
  // --room → 直接进对局；不带 room → 落主页走真实菜单（开始茶会=建房 / 加入房间=输码进房）
  if (o.room || o.screen) {
    deep.searchParams.set('screen', String(o.screen || 'game'))
    if (o.room) deep.searchParams.set('room', String(o.room))
  }
  if (o.name) deep.searchParams.set('name', String(o.name))
  console.log(JSON.stringify({ event: 'ready', transport: transport.info().transport, bridge: bridge.base }))
  console.log(`打开游戏（联机深链）：${deep}`)
  // 机器可读行：Agent 直接解析这一行的 url 即可拉起
  console.log(JSON.stringify({ event: 'deep-link', url: deep.toString() }))
  if (o.open !== undefined) {
    const open = process.platform === 'win32' ? `start "" "${deep}"` : process.platform === 'darwin' ? `open "${deep}"` : `xdg-open "${deep}"`
    exec(open, () => {})
  }
  const close = async () => { await bridge.close(); process.exit(0) }
  process.once('SIGINT', close); process.once('SIGTERM', close)
}

async function cmdPing(o) {
  const port = Number(o.port) || NET_PORT
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    console.log(await res.text())
  } catch {
    console.error(`bridge :${port} 未响应`)
    process.exit(1)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const run = { hub: cmdHub, net: cmdNet, ping: cmdPing }[cmd]
if (!run) {
  console.log('用法: teadraw-net.mjs hub|net|ping [--port N] [--host IP] [--transport mock|steam] [--hub URL] [--appid N] [--vite N] [--lobby T] [--root DIR] [--room CODE] [--name 名字] [--screen S] [--open]')
  process.exit(cmd ? 1 : 0)
}
run(args(rest)).catch((e) => { console.error(e.message); process.exit(1) })
