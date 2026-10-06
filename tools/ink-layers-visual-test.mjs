// 隔离 React + 真实 p5.brush WebGL2 像素回归，不连接 Steam 或游戏桥。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url), { WebSocket } = require('ws')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'test-output', 'ink-layers')
const profile = path.join(output, `chrome-${process.pid}-${Date.now()}`)
mkdirSync(profile, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (read, label, timeout = 20000) => {
  const end = Date.now() + timeout
  let error
  while (Date.now() < end) { try { const value = await read(); if (value) return value } catch (e) { error = e } await sleep(100) }
  throw new Error(`等待失败：${label} ${error?.message ?? ''}`)
}
writeFileSync(path.join(output, 'fixture.html'), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>')
writeFileSync(path.join(output, 'fixture.tsx'), `
import React, {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {InkWash} from '/src/game/InkWash'
import {brushOutline} from '/src/brush/stroke'
import '/src/ui/brush.css'
const op={id:'wash-alignment',seat:1,author:'human',tf:{x:130,y:150,s:1.2},el:{tag:'rect',attrs:{x:400,y:200,width:140,height:100,fill:'#101010',stroke:'none'}}}
const strokeOp={id:'brush-alignment',seat:1,author:'human',tf:{x:600,y:480,s:1.2},el:{tag:'path',attrs:{d:'M0 0L100 -40L200 0',stroke:'#101010',strokeWidth:14,'data-pp':'0.5,0.5,0.5'}}}
function Fixture(){
  const [view,setView]=useState({ops:[op],cam:{x:0,y:0,z:1},hiddenSeats:new Set()})
  const [scale,setScale]=useState(1)
  useEffect(()=>{window.__inkTest={
    update:(next)=>flushSync(()=>setView(v=>({...v,...next,hiddenSeats:next.hiddenSeats?new Set(next.hiddenSeats):v.hiddenSeats}))),
    stroke:()=>flushSync(()=>setView(v=>({...v,ops:[strokeOp]}))),
    scale:s=>flushSync(()=>setScale(s)),
    resize:()=>{const h=document.querySelector('.host');h.style.width='1500px';h.style.height='780px'},
    pixels:()=>{
      const cv=document.querySelector('.inkwash-canvas'),host=document.querySelector('.host'),svg=document.querySelector('[data-shape]')
      if(!cv)return null
      const sample=document.createElement('canvas');sample.width=cv.width;sample.height=cv.height
      const ctx=sample.getContext('2d');ctx.drawImage(cv,0,0)
      const bytes=ctx.getImageData(0,0,cv.width,cv.height).data
      let weight=0,sx=0,sy=0,count=0,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity
      for(let y=0;y<cv.height;y++)for(let x=0;x<cv.width;x++){
        const a=bytes[(y*cv.width+x)*4+3];if(a<2)continue
        count++;weight+=a;sx+=x*a;sy+=y*a;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)
      }
      const h=host.getBoundingClientRect(),c=cv.getBoundingClientRect(),s=svg.getBoundingClientRect(),k=document.querySelector('.stage').getBoundingClientRect().width/1920
      const screen=(x,y)=>[(c.left+x/cv.width*c.width-h.left)/k,(c.top+y/cv.height*c.height-h.top)/k]
      // 非对称曲线的包围盒中心不等于墨迹重心；用真实 SVG 路径 + CTM
      // 光栅化得到参考重心，避免把正常水彩形状差异误判成坐标偏移。
      const reference=document.createElement('canvas');reference.width=host.clientWidth;reference.height=host.clientHeight
      const rc=reference.getContext('2d'),m=svg.getCTM();rc.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);rc.fillStyle='#000'
      if(svg.tagName==='path')rc.fill(new Path2D(svg.getAttribute('d')))
      else rc.fillRect(+svg.getAttribute('x'),+svg.getAttribute('y'),+svg.getAttribute('width'),+svg.getAttribute('height'))
      const rb=rc.getImageData(0,0,reference.width,reference.height).data
      let rw=0,rx=0,ry=0,covered=0
      for(let y=0;y<reference.height;y++)for(let x=0;x<reference.width;x++){
        const a=rb[(y*reference.width+x)*4+3];rw+=a;rx+=x*a;ry+=y*a
        if(!a)continue
        const cx=Math.round((h.left+x*k-c.left)/c.width*cv.width),cy=Math.round((h.top+y*k-c.top)/c.height*cv.height)
        if(cx>=0&&cy>=0&&cx<cv.width&&cy<cv.height&&bytes[(cy*cv.width+cx)*4+3]>=2)covered+=a
      }
      return {count,centroid:screen(sx/weight,sy/weight),box:screen((minX+maxX)/2,(minY+maxY)/2),svgCenter:[rx/rw,ry/rw],svgBoxCenter:[(s.left+s.width/2-h.left)/k,(s.top+s.height/2-h.top)/k],coverage:covered/rw,size:[cv.width,cv.height],k,transform:cv.style.transform}
    }
  }},[])
  const {cam}=view
  const drawing=view.ops[0]??op,out=brushOutline(drawing.el,drawing.id)
  return <div className="stage" style={{position:'absolute',left:0,top:0,width:1920,height:1080,transform:'scale('+scale+')',transformOrigin:'0 0',background:'#f5ecd8'}}>
    <div className="host" style={{position:'absolute',left:80,top:100,width:1600,height:880}}>
      <InkWash {...view}/>
      <svg width="100%" height="100%" style={{position:'absolute',inset:0}}>
        <g transform={'translate('+(-cam.x*cam.z)+' '+(-cam.y*cam.z)+') scale('+cam.z+')'}>
          <g transform={'translate('+drawing.tf.x+' '+drawing.tf.y+') scale('+drawing.tf.s+')'}>
            {out?<path data-shape d={out.d} fill={drawing.el.attrs.stroke}/>:<rect data-shape {...drawing.el.attrs}/>}
          </g>
        </g>
      </svg>
    </div>
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`)
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let chrome, socket
const chromeLog = []
try {
  await server.listen()
  const port = server.httpServer.address().port
  const chromePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync)
  if (!chromePath) throw new Error('未找到 Chrome；设置 CHROME_PATH')
  chrome = spawn(chromePath, ['--headless=new', '--hide-scrollbars', '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--window-size=1920,1080', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  chrome.stdout.on('data', bytes => chromeLog.push(bytes.toString()))
  chrome.stderr.on('data', bytes => chromeLog.push(bytes.toString()))
  const chromePort = await until(() => { const file = path.join(profile, 'DevToolsActivePort'); return existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) : null }, 'Chrome 调试端口')
  const tab = await until(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find(t => t.type === 'page'), 'Chrome 页面')
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let seq = 0
  const pending = new Map(), errors = []
  socket.on('message', bytes => {
    const m = JSON.parse(bytes.toString())
    if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); clearTimeout(t.timer); m.error ? t.reject(new Error(m.error.message)) : t.resolve(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
      const message=m.params.args.map(arg=>arg.value??arg.description).join(' ')
      if(message.includes('[p5.brush]'))errors.push(message)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const js = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/test-output/ink-layers/fixture.html` })
  await until(() => js('!!window.__inkTest && !!document.querySelector(".inkwash-canvas")'), '真实墨晕组件初始化')
  const results = []
  const check = async label => {
    const p = await until(async () => { const p = await js('window.__inkTest.pixels()'); return p?.count ? p : null }, label)
    const distance = Math.hypot(p.centroid[0] - p.svgCenter[0], p.centroid[1] - p.svgCenter[1])
    // 细长弯曲轮廓的随机水彩重心会偏向弯道内侧，使用与 SVG 像素
    // 的实际重叠验证位置；实心矩形另用严格重心阈值检出平移/缩放错误。
    if(label.startsWith('real-brush'))assert.ok(p.coverage>0.75, `${label} 真实筆迹墨晕覆盖率不足：${JSON.stringify(p)}`)
    else assert.ok(distance < 16, `${label} 墨晕与SVG中心相差 ${distance.toFixed(2)}px：${JSON.stringify(p)}`)
    results.push({ label, distance: Number(distance.toFixed(3)), ...p })
    return p
  }
  await sleep(150)
  await check('1920x1080-stage1-camera1')
  await js('window.__inkTest.update({cam:{x:100,y:50,z:1.35}})')
  await sleep(30)
  const following = await check('camera1.35-CSS-follow')
  assert.ok(following.transform, '相机变化先用 CSS 假跟随')
  await sleep(300)
  const rebaked = await check('camera1.35-rebaked')
  assert.equal(rebaked.transform, '', '相机停稳后重烘焙')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await js('window.__inkTest.scale(0.75);window.__inkTest.update({cam:{x:-120,y:80,z:1.35}})')
  await sleep(320)
  await check('1440x900-stage0.75-camera1.35-pan')
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(output, 'wash-alignment.png'), Buffer.from(screenshot.data, 'base64'))
  await js('window.__inkTest.resize()'); await sleep(150)
  await check('resized-camera1.35')
  await js('window.__inkTest.update({hiddenSeats:[1]})'); await sleep(80)
  assert.equal((await js('window.__inkTest.pixels()')).count, 0, '隐藏座位清除真实WebGL墨晕')
  await js('window.__inkTest.update({hiddenSeats:[]})'); await sleep(80)
  await check('unhidden-camera1.35')
  await js('window.__inkTest.stroke()'); await sleep(100)
  await check('real-brush-outline-stage0.75-camera1.35')
  writeFileSync(path.join(output, 'brush-alignment.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await js('window.__inkTest.update({ops:[]})'); await sleep(80)
  assert.equal((await js('window.__inkTest.pixels()')).count, 0, '删除笔迹清除真实WebGL墨晕')
  assert.equal(errors.length, 0, errors.join('\n'))
  writeFileSync(path.join(output, 'visual-results.json'), JSON.stringify({ results, errors }, null, 2))
  console.log('PASS：真实 WebGL 墨晕/SVG 对齐、缩放平移、CSS跟随、resize、隐藏/删除；矩形最大中心偏差', Math.max(...results.filter(r=>!r.label.startsWith('real-brush')).map(r => r.distance)).toFixed(3), 'px；真实笔刷墨晕覆盖率', results.at(-1).coverage.toFixed(3))
} finally {
  writeFileSync(path.join(output, 'chrome.log'), chromeLog.join(''))
  socket?.close(); chrome?.kill(); await server.close()
}
