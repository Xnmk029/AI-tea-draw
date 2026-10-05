// 用无头 Chrome + CDP 跑 UI 场景并截图（真实时间，可模拟鼠标/键盘）
// 用法：node tools/shot.mjs <steps.json> [outDir]
// steps: [{ "go": "?screen=game" }, { "wait": 3000 }, { "drag": [[x,y],[x,y]] }, { "click": [x,y] },
//         { "key": "Tab" }, { "type": "画一棵松树" }, { "js": "..." }, { "shot": "a.png" }]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , stepsFile, outDir = 'G:/tmp/tea-shots'] = process.argv
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 400)
const [W, H] = (process.env.SHOT_SIZE ?? '1440x900').split('x').map(Number)
mkdirSync(outDir, { recursive: true })

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=G:/tmp/tea-chrome-${port}`, 'about:blank'],
  { stdio: 'ignore' },
)

let page
let lastErr
for (let i = 0; i < 120 && !page; i++) {
  await sleep(250)
  try {
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
  } catch (e) {
    lastErr = e
  }
}
if (!page) {
  console.error('Chrome 未就绪', port, lastErr?.cause ?? lastErr)
  chrome.kill()
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    console.log(`[console.${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400))
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' })

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

for (const s of steps) {
  if (s.go !== undefined) {
    await send('Page.navigate', { url: `http://localhost:5180/${s.go}` })
    await sleep(1200)
  } else if (s.wait) await sleep(s.wait)
  else if (s.drag) {
    const [x0, y0] = s.drag[0]
    await mouse('mouseMoved', x0, y0, 0)
    await mouse('mousePressed', x0, y0)
    for (const [x, y] of s.drag.slice(1)) {
      await mouse('mouseMoved', x, y)
      await sleep(16)
    }
    const [x1, y1] = s.drag[s.drag.length - 1]
    await mouse('mouseReleased', x1, y1, 0)
  } else if (s.click) {
    const [x, y] = s.click
    await mouse('mouseMoved', x, y, 0)
    await mouse('mousePressed', x, y)
    await mouse('mouseReleased', x, y, 0)
  } else if (s.key) {
    const mods = (s.ctrl ? 2 : 0) | (s.shift ? 8 : 0)
    const code = s.code ?? (s.key.length === 1 ? `Key${s.key.toUpperCase()}` : s.key)
    const vk = { Tab: 9, Enter: 13, Escape: 27 }[s.key] ?? s.key.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: s.key, code, modifiers: mods, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: s.key, code, modifiers: mods, windowsVirtualKeyCode: vk })
  } else if (s.type) await send('Input.insertText', { text: s.type })
  else if (s.js) {
    const r = await send('Runtime.evaluate', { expression: s.js, awaitPromise: true, returnByValue: true })
    if (r.result?.value !== undefined) console.log('[js]', JSON.stringify(r.result.value))
    if (r.exceptionDetails) console.log('[js-error]', r.exceptionDetails.exception?.description)
  } else if (s.shot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, s.shot), Buffer.from(data, 'base64'))
    console.log('[shot]', join(outDir, s.shot))
  }
}

ws.close()
chrome.kill()
process.exit(0)
