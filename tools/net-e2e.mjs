// 联机双页 e2e：A 建房（host）→ B 进房（peer）→ 双向 ops/chat 断言
// 前置：dev server :5180 + hub :19780 + 桥 A :5191 + 桥 B :5192（各自 teadraw-net net）
// 用法：node tools/net-e2e.mjs <tokenA> <tokenB>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const [, , tokenA, tokenB] = process.argv
if (!tokenA || !tokenB) { console.error('usage: net-e2e.mjs <tokenA> <tokenB>'); process.exit(1) }
const OUT = 'G:/tmp/tea-shots'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 400)
const [W, H] = [1920, 1080]

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=G:/tmp/tea-chrome-${port}`, 'about:blank'],
  { stdio: 'ignore' },
)
for (let i = 0; i < 80; i++) {
  try { await fetch(`http://127.0.0.1:${port}/json`); break } catch { await sleep(250) }
}

async function newPage(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let seq = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) console.log('[js err]', JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result?.value
  }
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' })
  const enter = () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const typeInto = (placeholderRe, text) => evalJs(`(function(){
    const i=[...document.querySelectorAll('input')].find(i=>${placeholderRe}.test(i.placeholder||''))
    if(!i) return 'no-input'
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(i,'${text}')
    i.dispatchEvent(new Event('input',{bubbles:true}))
    return 'ok'
  })()`)
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'))
  }
  return { evalJs, mouse, enter, typeInto, shot }
}

const base = 'http://localhost:5180/?screen=game&mode=tea'
const A = await newPage(`${base}&net=5191&token=${tokenA}`)
await sleep(4500)

const aBadge = await A.evalJs(`(document.querySelector('.tb-room')?.textContent ?? '').trim()`)
console.log('[A badge]', aBadge)
const roomMatch = aBadge.match(/#(\w+)/)
if (!roomMatch || !/主机/.test(aBadge)) { console.error('FAIL: A 不是主机'); chrome.kill(); process.exit(1) }
const room = roomMatch[1]
console.log('room =', room)

const B = await newPage(`${base}&net=5192&token=${tokenB}&room=${room}&name=${encodeURIComponent('栗子')}`)
await sleep(4500)
const bBadge = await B.evalJs(`(document.querySelector('.tb-room')?.textContent ?? '').trim()`)
console.log('[B badge]', bBadge)
if (!/联机/.test(bBadge) || !/2人/.test(bBadge)) { console.error('FAIL: B 徽章应为「联机 · 2人」'); chrome.kill(); process.exit(1) }

const pathCount = (pg) => pg.evalJs(`document.querySelectorAll('.stage svg path').length`)
const aPaths0 = await pathCount(A)
const bPaths0 = await pathCount(B)

// A 画一笔 → B 应经广播收到
await A.mouse('mousePressed', 700, 480)
await A.mouse('mouseMoved', 760, 520)
await A.mouse('mouseMoved', 830, 540)
await A.mouse('mouseReleased', 830, 540)
await sleep(1500)
const aPaths1 = await pathCount(A)
const bPaths1 = await pathCount(B)
console.log(`paths after A draws: A ${aPaths0}->${aPaths1}  B ${bPaths0}->${bPaths1}`)
const opSyncAB = bPaths1 > bPaths0

// B 画一笔 → A 应经 成员→host→广播 收到
await B.mouse('mousePressed', 600, 620)
await B.mouse('mouseMoved', 660, 650)
await B.mouse('mouseMoved', 720, 640)
await B.mouse('mouseReleased', 720, 640)
await sleep(1500)
const aPaths2 = await pathCount(A)
const bPaths2 = await pathCount(B)
console.log(`paths after B draws: A ${aPaths1}->${aPaths2}  B ${bPaths1}->${bPaths2}`)
const opSyncBA = aPaths2 > aPaths1

// 聊天双向：先点「聊天」页签露出输入框（badge 数字会让 textContent 不精确匹配 → 用 includes）
const clickChatTab = (pg) => pg.evalJs(`(function(){const b=[...document.querySelectorAll('.side-tabs button')].find(x=>x.textContent.includes('聊天')); if(b){b.click();return 'ok'} return 'no-tab'})()`)
console.log('[A chat tab]', await clickChatTab(A))
console.log('[B chat tab]', await clickChatTab(B))
await sleep(400)
const typeChat = (pg, text) => pg.evalJs(`(function(){
  const i=document.querySelector('.chat-input input')
  if(!i) return 'no-input'
  i.focus()
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
  setter.call(i,'${text}')
  i.dispatchEvent(new Event('input',{bubbles:true}))
  return 'ok'
})()`)
console.log('[B chat]', await typeChat(B, '栗子报到'))
await B.enter()
await sleep(1200)
const aSeesB = await A.evalJs(`document.body.textContent.includes('栗子报到')`)
console.log('[A chat]', await typeChat(A, '青柠收到'))
await A.enter()
await sleep(1200)
const bSeesA = await B.evalJs(`document.body.textContent.includes('青柠收到')`)
console.log('[B sees A chat]', bSeesA)

// 座位表：B 侧应显示「栗子」+「青柠」两个真人
const bNames = await B.evalJs(`document.body.textContent.includes('栗子') && document.body.textContent.includes('青柠')`)

console.log('--- 断言 ---')
console.log('opSync A→B:', opSyncAB, ' opSync B→A:', opSyncBA)
console.log('chat B→A:', aSeesB, ' chat A→B:', bSeesA, ' roster(B 见两人):', bNames)
await A.shot('net-A.png')
await B.shot('net-B.png')
const ok = opSyncAB && opSyncBA && aSeesB && bSeesA
console.log(ok ? '== PASS ==' : '== 部分未过，看上方日志 ==')
chrome.kill()
process.exit(ok ? 0 : 1)
