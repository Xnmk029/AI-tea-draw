// 联机你画我猜双页 e2e：最低可玩闭环验收
// A(host,第1轮画手) 选词画 → B 猜错+猜中 → round-over → 下一轮轮换(B画手,A猜) → 提前结算 → 双端结算屏
// 前置：dev :5180 + hub :19780 + 桥 A :5191 + 桥 B :5192
// 用法：node tools/net-guess-e2e.mjs <tokenA> <tokenB>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const [, , tokenA, tokenB] = process.argv
if (!tokenA || !tokenB) { console.error('usage: net-guess-e2e.mjs <tokenA> <tokenB>'); process.exit(1) }
const OUT = 'G:/tmp/tea-shots'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 400)
const [W, H] = [1920, 1080]
let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name} ${extra}`)
  if (!ok) failed = true
}

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=G:/tmp/tea-chrome-${port}`, 'about:blank'],
  { stdio: 'ignore' },
)
for (let i = 0; i < 160; i++) {
  try { await fetch(`http://127.0.0.1:${port}/json`); break } catch { await sleep(300) }
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
    if (r.exceptionDetails) console.log('[js]', JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result?.value
  }
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' })
  const enter = () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const clickBtn = (text) => evalJs(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('${text}')); if(b){b.click();return 'ok'} return 'no-btn'})()`)
  const typeInto = (sel, text) => evalJs(`(function(){
    const i=document.querySelector(${sel})
    if(!i) return 'no-input'
    i.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${text}')
    i.dispatchEvent(new Event('input',{bubbles:true}))
    return 'ok'
  })()`)
  const shot = async (file) => writeFileSync(`${OUT}/${file}`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  return { evalJs, mouse, enter, clickBtn, typeInto, shot }
}

const base = 'http://localhost:5180/?screen=game&mode=guess'
const A = await newPage(`${base}&net=5191&token=${tokenA}`)
await sleep(4500)
const aBadge = await A.evalJs(`(document.querySelector('.tb-room')?.textContent ?? '').trim()`)
const room = aBadge.match(/#(\w+)/)?.[1]
check('A 是主机', /主机/.test(aBadge), aBadge)

const B = await newPage(`${base}&net=5192&token=${tokenB}&room=${room}&name=${encodeURIComponent('栗子')}`)
await sleep(4500)
const bBadge = await B.evalJs(`(document.querySelector('.tb-room')?.textContent ?? '').trim()`)
check('B 进房', /联机/.test(bBadge), bBadge)

// ---- 第 1 轮：A 画手 ----
check('A 弹选词卡', await A.evalJs(`!!document.querySelector('.word-picker')`) === true)
const word1 = await A.evalJs(`document.querySelector('.word-card b')?.textContent ?? ''`)
await A.evalJs(`document.querySelector('.word-card')?.click()`)
await sleep(800)
check('A 已选词', word1.length > 0, `「${word1}」`)
check('B 是猜词者（有猜测框）', await B.evalJs(`!!document.querySelector('input[placeholder*="猜测"]')`) === true)

// A 画一笔 → B 画布应同步（比较前后 delta，不看绝对值）
const bPaths0 = await B.evalJs(`document.querySelectorAll('.stage svg path').length`)
await A.mouse('mousePressed', 700, 480)
await A.mouse('mouseMoved', 780, 520)
await A.mouse('mouseReleased', 780, 520)
await sleep(1200)
const bPaths = await B.evalJs(`document.querySelectorAll('.stage svg path').length`)
check('A 画笔同步到 B', bPaths > bPaths0, `B paths ${bPaths0}->${bPaths}`)

// B 猜错 → 双端聊天可见
console.log('[B 猜错]', await B.typeInto(`'input[placeholder*="猜测"]'`, '烤面包机'))
await B.enter()
await sleep(1200)
check('A 看到 B 的错猜', await A.evalJs(`document.body.textContent.includes('烤面包机')`) === true)

// B 猜对 → 双端 round-over + 比分
console.log('[B 猜中]', await B.typeInto(`'input[placeholder*="猜测"]'`, word1))
await B.enter()
await sleep(2500)
const aOver = await A.evalJs(`!!document.querySelector('.round-over')`)
const bOver = await B.evalJs(`!!document.querySelector('.round-over')`)
check('双端 round-over', aOver === true && bOver === true)
const aAns = await A.evalJs(`document.querySelector('.round-over .answer')?.textContent ?? ''`)
check('round-over 答案一致', aAns === word1, `A: ${aAns}`)
const bScore = await B.evalJs(`document.body.textContent.match(/栗子[^\\n]*/)`) // 宽松：名单里有栗子即可
console.log('[B 名单]', JSON.stringify(bScore).slice(0, 120))
check('B 面板显示猜中', await B.evalJs(`document.body.textContent.includes('猜中了')`) === true)

// ---- 第 2 轮：轮换，B 画手 ----
console.log('[A 点下一轮]', await A.clickBtn('下一轮'))
await sleep(1500)
const bPicker = await B.evalJs(`!!document.querySelector('.word-picker')`)
check('B 收到词卡（轮换为画手）', bPicker === true)
const word2 = await B.evalJs(`document.querySelector('.word-card b')?.textContent ?? ''`)
await B.evalJs(`document.querySelector('.word-card')?.click()`)
await sleep(800)
check('B 选词', word2.length > 0, `「${word2}」`)
check('A 变猜词者', await A.evalJs(`!!document.querySelector('input[placeholder*="猜测"]')`) === true)

// A 猜中 → round-over
console.log('[A 猜中]', await A.typeInto(`'input[placeholder*="猜测"]'`, word2))
await A.enter()
await sleep(2500)
check('第 2 轮 round-over', await A.evalJs(`!!document.querySelector('.round-over')`) === true)

// ---- 提前结算 → 双端进结算屏 ----
console.log('[A 提前结算]', await A.clickBtn('提前结算'))
await sleep(2000)
const aResult = await A.evalJs(`document.querySelector('.stage')?.dataset.screen ?? document.body.className`)
const bResult = await B.evalJs(`document.querySelector('.stage')?.dataset.screen ?? document.body.className`)
console.log('[A screen]', aResult, '[B screen]', bResult)
check('双端进结算屏', /result/.test(aResult) && /result/.test(bResult))

await A.shot('guess-A.png')
await B.shot('guess-B.png')
console.log(failed ? '== 有断言未过 ==' : '== PASS: 最低可玩闭环 ==')
chrome.kill()
process.exit(failed ? 1 : 0)
