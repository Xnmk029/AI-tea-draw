#!/usr/bin/env node
// Windows 便携入口：启动 Steam / SpaceWar，再将本机联机桥留在后台。
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGS = path.join(ROOT, 'logs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const [mode = 'host', ...argv] = process.argv.slice(2)
const options = {}
let room = ''
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) { if (!room) room = argv[i]; else throw new Error('只接受一个房间码'); continue }
  const key = argv[i].slice(2)
  options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
}

function background(exe, args, extra = {}) {
  const child = spawn(exe, args, { cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore', ...extra })
  child.unref()
  return child
}

function findSteam() {
  const candidates = []
  for (const [key, value] of [
    ['HKCU\\Software\\Valve\\Steam', 'SteamExe'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ]) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const found = output.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim()
      if (found) candidates.push(value === 'SteamExe' ? found : path.join(found, 'steam.exe'))
    } catch { /* 注册表位置因安装方式不同可能不存在。 */ }
  }
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
    if (base) candidates.push(path.join(base, 'Steam', 'steam.exe'))
  }
  return candidates.find(candidate => existsSync(candidate))
}

async function startSteam() {
  if (process.platform !== 'win32') throw new Error('本便携包仅支持 Windows x64')
  const steam = findSteam()
  if (!steam) throw new Error('未找到 Steam；请先安装并登录 Steam，再运行本启动器')
  background(steam, ['steam://rungameid/480'])
  console.log('[start] 已请求启动 Steam 和 SpaceWar（480）；如 Steam 提示登录或安装，请在 Steam 中完成。')
  await sleep(5000)
  return steam
}

async function freePort() {
  if (options.port) {
    const port = Number(options.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port 必须为 1024–65535')
    return port
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(20000, 60000)
    const server = createServer()
    const ok = await new Promise(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error('未找到空闲的本机联机端口')
}

function openBrowser(url) {
  background('rundll32.exe', ['url.dll,FileProtocolHandler', url])
}

async function main() {
  if (!['host', 'join'].includes(mode)) throw new Error('用法：runtime\\node.exe scripts\\portable-start.mjs host|join [房间码] [--name 茶名]')
  const transport = options.transport || 'steam'
  if (!['steam', 'mock'].includes(transport)) throw new Error('--transport 仅支持 steam 或 mock')
  if (mode === 'join' && !(transport === 'steam' ? /^\d{15,21}$/ : /^\d{4,8}$/).test(room)) throw new Error('加入房间时请提供有效房间码（Steam 为 15–21 位数字）')
  if (!existsSync(path.join(ROOT, 'index.html'))) throw new Error('请在解压后的便携包中运行本启动器')
  mkdirSync(LOGS, { recursive: true })
  const name = typeof options.name === 'string' ? options.name : mode === 'host' ? '茶主人' : '茶友'
  const latestPath = path.join(LOGS, 'latest-session.json')
  try {
    const previous = JSON.parse(readFileSync(latestPath, 'utf8'))
    if (previous.mode === mode && previous.transport === transport && previous.roomRequested === room && previous.name === name) {
      const health = await fetch(`${previous.bridge}/health`, { signal: AbortSignal.timeout(1000) }).then(res => res.json())
      if (health.ok && health.transport === transport) {
        if (!options['no-open']) openBrowser(previous.url)
        console.log(JSON.stringify({ event: 'reused', pid: previous.pid, bridge: previous.bridge, session: latestPath, log: previous.log }))
        return
      }
    }
  } catch { /* 没有可复用的本机桥。 */ }
  const steam = transport === 'steam' && !options['skip-steam'] ? await startSteam() : null
  const deadline = Date.now() + (transport === 'steam' ? 120000 : 15000)
  let lastError = ''
  let askedInstall = false
  let attempt = 0
  while (Date.now() < deadline) {
    const port = await freePort()
    const runId = `${Date.now()}-${++attempt}`
    const logPath = path.join(LOGS, `net-${runId}.log`)
    const fd = openSync(logPath, 'a')
    const args = [path.join(ROOT, 'server', 'teadraw-net.mjs'), 'net', '--transport', transport, '--port', String(port), '--root', ROOT, '--name', name]
    if (options.hub) args.push('--hub', String(options.hub))
    if (mode === 'join') args.push('--room', room, '--screen', 'lobby')
    else args.push('--lobby', 'public', '--screen', 'home')
    let child
    try { child = background(process.execPath, args, { stdio: ['ignore', fd, fd] }) }
    finally { closeSync(fd) }
    let launchError
    let exited = false
    child.once('error', error => { launchError = error; exited = true })
    child.once('exit', () => { exited = true })
    const attemptDeadline = Math.min(deadline, Date.now() + 20000)
    while (Date.now() < attemptDeadline) {
      const output = readFileSync(logPath, 'utf8')
      const deepLink = output.split(/\r?\n/).map(line => { try { return JSON.parse(line) } catch { return null } }).find(event => event?.event === 'deep-link')
      if (deepLink) {
        const url = new URL(deepLink.url)
        const bridge = url.origin
        const health = await fetch(`${bridge}/health`, { signal: AbortSignal.timeout(3000) }).then(res => res.json())
        if (!health.ok) throw new Error('联机桥健康检查失败')
        const session = { mode, transport, name, roomRequested: room, pid: child.pid, bridge, port, url: url.toString(), log: logPath, startedAt: new Date().toISOString() }
        writeFileSync(latestPath, JSON.stringify(session, null, 2))
        if (!options['no-open']) openBrowser(url.toString())
        console.log(JSON.stringify({ event: 'ready', pid: child.pid, bridge, session: latestPath, log: logPath, roomRequested: room }))
        console.log('[start] 联机桥已在后台运行；关闭当前终端不会退出。完整本机深链仅保存在 logs/latest-session.json。')
        return
      }
      if (exited) { lastError = launchError?.message || output.trim(); break }
      await sleep(300)
    }
    if (!exited) { child.kill(); lastError = '联机桥启动超时' }
    if (transport === 'mock') throw new Error(`${lastError}；查看 ${logPath}`)
    if (steam && !askedInstall && /STEAM_APP_NOT_AVAILABLE/.test(lastError)) {
      askedInstall = true
      background(steam, ['steam://install/480'])
      console.log('[start] Steam 尚未启用 SpaceWar；已打开安装提示，请完成安装。')
    }
    if (/EADDRINUSE|EACCES/.test(lastError) && !options.port) continue
    if (attempt === 1 || attempt % 4 === 0) console.log('[start] 等待 Steam 登录并启用 SpaceWar，自动重试中……')
    await sleep(3000)
  }
  throw new Error(`Steam / SpaceWar 未在两分钟内就绪；请完成登录或安装后重试。诊断日志在 ${LOGS}。${lastError.replace(/token=[^&\s]+/g, 'token=…').slice(0, 240)}`)
}

main().catch(error => { console.error(`[start] ${error.message}`); process.exitCode = 1 })
