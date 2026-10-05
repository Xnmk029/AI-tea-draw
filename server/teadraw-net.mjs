#!/usr/bin/env node
/* ============================================================
   TeaDraw 联机桥 CLI（T3）
     node server/teadraw-net.mjs hub  --port 19780            # 本地 mock 中枢（替代 Steam，开发用）
     node server/teadraw-net.mjs net  [--port 5191] [--transport mock|steam]
                                    [--hub ws://127.0.0.1:19780] [--appid 480] [--vite 5180]
     node server/teadraw-net.mjs ping [--port 5191]
   每位玩家本机跑一个 net 桥；浏览器经 ?net=<port>&token=<tok> 深链接入。
   星型拓扑：成员消息只到房主（hostId），房主广播给全员。
   ============================================================ */
import { createRequire } from 'node:module'
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
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) break
    out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

async function cmdHub(o) {
  const { startHub } = require('./net/mock-hub.cjs')
  const port = Number(o.port) || HUB_PORT
  const hub = await startHub({ port })
  console.log(JSON.stringify({ event: 'ready', url: hub.url, transport: 'mock' }))
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
    transport = new SteamTransport({ project: PROJECT, appId: Number(o.appid) || 480 })
  }
  const port = Number(o.port) || NET_PORT
  const bridge = await createBridge({ root: ROOT, project: PROJECT, transport, port })
  const vite = Number(o.vite) || VITE_PORT
  console.log(JSON.stringify({ event: 'ready', transport: transport.info().transport, bridge: bridge.base }))
  console.log(`打开游戏（联机深链）：http://localhost:${vite}/?net=${bridge.base.split(':').pop()}&token=${bridge.token}`)
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
  console.log('用法: teadraw-net.mjs hub|net|ping [--port N] [--transport mock|steam] [--hub URL] [--appid N] [--vite N]')
  process.exit(cmd ? 1 : 0)
}
run(args(rest)).catch((e) => { console.error(e.message); process.exit(1) })
