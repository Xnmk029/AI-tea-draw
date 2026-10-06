import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const { startHub } = require('../server/net/mock-hub.cjs')
const { MockTransport } = require('../server/net/mock-transport.cjs')
const { createBridge } = require('../server/net/bridge.cjs')
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const output = path.join(root, 'test-output', 'net-regression')
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  for (let i = 0; i < 32; i++) {
    const port = randomInt(20000, 60000), server = createServer()
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      await new Promise(resolve => server.close(resolve))
      return port
    } catch {}
  }
  throw new Error('未找到测试空闲端口')
}

export async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`等待失败：${label}`)
}

export async function fixture() {
  mkdirSync(output, { recursive: true })
  const base = process.env.NET_TEST_URL || 'http://127.0.0.1:5180/'
  const pages = [], bridges = [], transcript = [], children = []
  let hub
  const close = async () => {
    for (const pg of pages) pg.socket.close()
    for (const child of children) child.kill()
    for (const bridge of bridges) await bridge.close()
    await hub?.close()
  }
  try {
    hub = await startHub({ port: 0 })
    for (let i = 0; i < 2; i++) {
      const transport = await new MockTransport({ project: 'teadraw-browser-test', hub: hub.url }).connect()
      bridges.push(await createBridge({ root, project: 'teadraw-browser-test', transport }))
    }
    let available = false
    try { available = (await fetch(base, { signal: AbortSignal.timeout(2000) })).ok } catch {}
    if (!available) {
      const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', new URL(base).port || '5180', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' })
      children.push(vite)
      await until(async () => { try { return (await fetch(base)).ok } catch { return false } }, 'Vite 启动')
    }
    const profile = path.join(output, `chrome-${process.pid}-${Date.now()}`)
    mkdirSync(profile, { recursive: true })
    const chromePath = process.env.CHROME_PATH || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ].find(p => existsSync(p))
    if (!chromePath) throw new Error('未找到 Chrome；设置 CHROME_PATH')
    const chromePort = await freePort()
    const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${chromePort}`, '--window-size=1920,1080', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
    children.push(chrome)
    const debuggerBase = `http://127.0.0.1:${chromePort}`
    await until(async () => { try { return (await fetch(`${debuggerBase}/json`)).ok } catch { return false } }, 'Chrome 调试接口就绪')
    const newPage = async (name, bridge, query = {}) => {
      const tab = await until(async () => {
        try { return await (await fetch(`${debuggerBase}/json/new?about:blank`, { method: 'PUT' })).json() } catch { return null }
      }, `Chrome 打开 ${name} 页面`)
      const socket = new WebSocket(tab.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      let seq = 0
      const pending = new Map(), messages = [], errors = []
      socket.on('error', () => {})
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString())
        if (message.id) {
          const task = pending.get(message.id)
          if (!task) return
          pending.delete(message.id)
          clearTimeout(task.timer)
          message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
          return
        }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
        if (message.method === 'Network.webSocketFrameReceived' || message.method === 'Network.webSocketFrameSent') {
          try {
            const payload = JSON.parse(message.params.response.payloadData)
            const data = payload.op === 'send' ? payload.data : payload.event === 'packet' ? payload.result?.data : null
            if (data) {
              const record = { page: name, direction: message.method.endsWith('Sent') ? 'sent' : 'received', data }
              messages.push(record)
              transcript.push(record)
            }
          } catch {}
        }
      })
      socket.on('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Chrome 连接关闭')) }; pending.clear() })
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 20000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
      const js = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw new Error(`浏览器执行错误：${result.exceptionDetails.text}`)
        return result.result?.value
      }
      const page = {
        name, socket, send, js, messages, errors,
        screen: () => js("document.querySelector('.stage')?.dataset.screen"),
        waitScreen: screen => until(async () => await page.screen() === screen && await js("document.querySelector('.curtain')?.className.includes('c-idle') ?? true"), `${name} 进入 ${screen}`),
        click: async (text, selector = 'button') => {
          const ok = await js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!button||button.disabled)return false;button.click();return true})()`)
          if (!ok) throw new Error(`找不到可点击按钮：${name} ${text}`)
        },
        setInput: async (selector, value) => {
          const ok = await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled)return false;input.focus();const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
          if (!ok) throw new Error(`找不到可输入字段：${name} ${selector}`)
          await sleep(100)
        },
        key: async (key, code = key, virtual = key === 'Enter' ? 13 : key === 'Tab' ? 9 : 27) => {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual })
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual })
        },
        draw: async points => {
          const [first, ...rest] = points
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first[0], y: first[1], button: 'left', buttons: 1, clickCount: 1 })
          for (const [x, y] of rest) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
          const [x, y] = points.at(-1)
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
        },
        opIds: () => js("[...document.querySelectorAll('.scr-game [data-op]')].map(e=>e.dataset.op).filter((x,i,a)=>a.indexOf(x)===i).sort()"),
        shot: async label => writeFileSync(path.join(output, `${label}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')),
        inject: data => js(`window.__netTestSockets.find(s=>s.url.includes('/bridge?')&&s.readyState===1).send(${JSON.stringify(JSON.stringify({ id: 900000 + seq, op: 'send', to: bridges[0].transport.info().selfId, data }))})`),
        reload: () => send('Page.reload', { ignoreCache: true }),
      }
      pages.push(page)
      await send('Runtime.enable')
      await send('Network.enable')
      await send('Page.enable')
      await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
      await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__netTestSockets=[];window.WebSocket=new Proxy(window.WebSocket,{construct(T,args){const socket=new T(...args);window.__netTestSockets.push(socket);return socket;}})" })
      const url = new URL(base)
      url.searchParams.set('net', new URL(bridge.base).port)
      url.searchParams.set('token', bridge.token)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      await send('Page.navigate', { url: url.toString() })
      return page
    }
    const newAgent = async name => {
      const port = await freePort()
      const child = spawn(process.execPath, [path.join(root, 'server/teadraw.mjs'), 'mcp', '--port', String(port), '--name', name, '--model', 'regression'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      children.push(child)
      let seq = 0
      const pending = new Map()
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        try {
          const message = JSON.parse(line), task = pending.get(message.id)
          if (!task) return
          pending.delete(message.id)
          clearTimeout(task.timer)
          message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
        } catch {}
      })
      const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 超时：${method}`)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
      const health = async () => {
        try { return await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).json() } catch { return null }
      }
      await until(async () => (await health())?.ok, `${name} MCP 启动`)
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'net-regression', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const tool = async (name, args = {}) => {
        const result = await call('tools/call', { name, arguments: args })
        const value = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')
        if (result.isError) throw new Error(`MCP ${name}：${value}`)
        try { return JSON.parse(value) } catch { return value }
      }
      return { port, tool, waitGame: () => until(async () => (await health())?.game, `${name} MCP 接入游戏`) }
    }
    return { hub, bridges, pages, transcript, newPage, newAgent, close }
  } catch (error) { await close(); throw error }
}
