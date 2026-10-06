import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixture, output, sleep, until } from './net-test-helpers.mjs'

const checks = []
const check = (name, condition, detail) => {
  assert.ok(condition, name)
  checks.push({ name, detail })
  console.log(`✓ ${name}`)
}
const latest = (page, type, direction = 'received') => page.messages.filter(m => m.direction === direction && m.data.t === type).at(-1)?.data
const f = await fixture()
let A, B
try {
  const hostAgent = await f.newAgent('HostTestPet'), peerAgent = await f.newAgent('PeerTestPet')
  A = await f.newPage('host', f.bridges[0], { name: '回归房主', mcp: hostAgent.port })
  await A.waitScreen('home')
  await A.click('开始茶会', '.main-menu button')
  await A.click('创建房间', '.sheet-actions button')
  await A.waitScreen('lobby')
  const room = await until(() => f.bridges[0].transport.info().room, '菜单创建房间')
  await A.click('协作', '.level-list button')
  await A.click('回合', '.rules-sheet .g-tabs button')
  await A.setInput('.rule-input', '联机回归茶馆')
  B = await f.newPage('peer', f.bridges[1], { name: '回归客机', mcp: peerAgent.port })
  await B.waitScreen('home')
  await B.click('加入房间', '.main-menu button')
  await B.setInput('.code-boxes input', room)
  await B.click('入座', '.home-sheet button')
  await B.waitScreen('lobby')
  await until(() => f.bridges[0].transport.info().members.length === 2 && latest(B, 'lobby-state')?.members.length === 2, '真实菜单入座')
  check('真实菜单建房与输入房间码入座', f.hub.rooms.size === 1 && f.bridges[1].transport.info().room === room)
  const lobby = latest(B, 'lobby-state')
  check('新成员立即收到完整玩法和房规', lobby.mode === 'tea' && lobby.rules.agentLevel === 'collab' && lobby.rules.theme === '联机回归茶馆')
  check('大厅两端显示真实名字', await B.js("document.body.textContent.includes('回归房主') && document.body.textContent.includes('回归客机')"))
  await B.click('回合', '.rules-sheet .g-tabs button')
  check('客机不能修改房规', await B.js("document.querySelector('.rule-input')?.disabled || !!document.querySelector('.rule-input')?.closest('fieldset[disabled]')"))
  await A.shot('01-lobby-host')
  await B.shot('01-lobby-peer')
  const startMark = A.messages.length
  await A.js("const start = document.querySelector('.anchor.a-br button.primary'); start.click(); start.click()")
  await Promise.all([A.waitScreen('game'), B.waitScreen('game')])
  await until(async () => /2人/.test(await B.js("document.querySelector('.tb-room')?.textContent")), '对局连接两人')
  check('大厅切换对局保持房间和双端连接', f.hub.rooms.size === 1 && f.bridges[0].transport.info().room === room && f.bridges[1].transport.info().room === room)
  check('连续开局输入只创建一局', new Set(A.messages.slice(startMark).filter(m => m.direction === 'sent' && m.data.t === 'lobby-state' && m.data.phase === 'game').map(m => m.data.gameId)).size === 1)
  check('游戏使用同步主题', await B.js("document.querySelector('.mh-theme')?.textContent === '联机回归茶馆'"))

  async function drawSync(page, other, points, label) {
    const before = (await other.opIds()).length
    await page.js("document.querySelector('.tool-dock button[data-tip^=\"画笔\"]')?.click()")
    await page.draw(points)
    await until(async () => (await other.opIds()).length > before, label)
    await until(async () => JSON.stringify(await A.opIds()) === JSON.stringify(await B.opIds()), '双端笔迹集合一致')
    check(label, true)
  }
  await drawSync(A, B, [[700, 460], [760, 490], [820, 470]], '房主人类笔迹同步至客机')
  await drawSync(B, A, [[620, 570], [680, 610], [730, 590]], '客机人类笔迹经房主落账同步')
  for (const [sender, receiver, message] of [[A, B, '房主聊天同步'], [B, A, '客机聊天同步']]) {
    await sender.click('聊天', '.side-tabs button')
    await sender.setInput('.chat-input input', message)
    await sender.key('Enter')
    await until(() => receiver.js(`document.body.textContent.includes(${JSON.stringify(message)})`), message)
    check(message, true)
  }
  await Promise.all([hostAgent.waitGame(), peerAgent.waitGame()])

  async function agentDraw(agent, page, preview, label) {
    await until(() => page.js("!!document.querySelector('.agent-bar.s-idle')"), `${label}等待前一笔动画结束`)
    await page.setInput('.pb-input input', label)
    await page.key('Enter')
    const task = await agent.tool('turn_get_task')
    check(`${label}由真实MCP领取任务`, task.task?.text === label)
    const self = await agent.tool('room_state')
    check(`${label}座位同步保留真实Agent身份`, self.seats.find(seat => seat.id === self.me.seat)?.agent?.name === (page === A ? 'HostTestPet' : 'PeerTestPet'))
    const space = await agent.tool('canvas_find_space', { w: 120, h: 120 })
    const before = page.messages.length
    const draw = await agent.tool('canvas_draw', { svg: '<circle cx="50" cy="50" r="30" fill="none" stroke="#3B3A36" stroke-width="4"/>', spaceId: space.space.id, mode: preview ? 'preview' : 'commit' })
    if (preview) {
      assert.ok(draw.previewId, '真实 Agent 返回草稿')
      await page.key('Tab')
    }
    await until(() => page.messages.slice(before).some(m => m.data.t === 'ops' && m.data.ops?.some(o => o.author === 'agent')), label)
    await until(async () => JSON.stringify(await A.opIds()) === JSON.stringify(await B.opIds()), `${label}双端笔迹一致`)
    const ops = page.messages.slice(before).filter(m => m.data.t === 'ops' && m.data.ops).flatMap(m => m.data.ops)
    check(label, ops.some(o => o.author === 'agent' && o.anim?.dur > 0))
  }
  await agentDraw(hostAgent, A, false, '房主真实Agent直接提交保持动画与作者')
  await agentDraw(peerAgent, B, false, '客机真实Agent直接提交保持动画与作者')
  await agentDraw(peerAgent, B, true, '客机真实Agent草稿盖章同步')

  const gameId = latest(B, 'lobby-state').gameId
  const beforeProbe = A.messages.length
  await B.inject({ t: 'op', gameId, round: 1, author: 'human', el: { tag: 'circle', attrs: { cx: 20, cy: 20, r: 10, stroke: '#000', fill: 'none', 'data-name': '不得泄漏', onclick: 'alert(1)', href: 'https://invalid.example/' } } })
  await until(() => A.messages.slice(beforeProbe).some(m => m.data.t === 'ops' || m.data.t === 'op-rejected'), '非法属性校验回执')
  const sanitized = A.messages.slice(beforeProbe).filter(m => m.data.t === 'ops').flatMap(m => m.data.ops || [])
  check('Host剥离或拒绝非法SVG属性', sanitized.every(o => !('data-name' in o.el.attrs) && !('onclick' in o.el.attrs) && !('href' in o.el.attrs)))
  const beforeScript = (await A.opIds()).length
  await B.inject({ t: 'op', gameId, round: 1, el: { tag: 'script', attrs: { value: 'alert(1)' } } })
  await sleep(500)
  check('Host拒绝禁止的SVG标签', (await A.opIds()).length === beforeScript)
  await A.shot('02-game-host')
  await B.shot('02-game-peer')

  const expectedIds = await A.opIds(), oldPeerId = f.bridges[1].transport.info().selfId
  await B.reload()
  await B.waitScreen('game')
  await until(async () => JSON.stringify(await B.opIds()) === JSON.stringify(expectedIds), '刷新客机恢复完整画布')
  check('客机刷新恢复原座位、房间和完整画布', f.bridges[1].transport.info().selfId === oldPeerId && f.bridges[1].transport.info().room === room && f.hub.rooms.size === 1)
  await drawSync(B, A, [[950, 510], [1000, 535], [1040, 505]], '客机刷新后仍可绘图同步')
  await B.shot('03-peer-restored')

  const expectedHostIds = await A.opIds(), oldHostId = f.bridges[0].transport.info().selfId
  await A.reload()
  await A.waitScreen('game')
  await until(async () => JSON.stringify(await A.opIds()) === JSON.stringify(expectedHostIds) && JSON.stringify(await B.opIds()) === JSON.stringify(expectedHostIds), '刷新房主恢复权威画布')
  check('房主刷新保持身份、同局房间和完整画布', f.bridges[0].transport.info().selfId === oldHostId && f.bridges[0].transport.info().room === room && latest(B, 'lobby-state').gameId === gameId)
  await drawSync(A, B, [[1000, 650], [1050, 680], [1090, 650]], '房主刷新后仍可落账同步')
  await A.shot('03-host-restored')

  await A.click('结束本局', '.tb-right button')
  await Promise.all([A.waitScreen('result'), B.waitScreen('result')])
  check('结束本局双端进入真实结算且房间保留', f.hub.rooms.size === 1 && (latest(B, 'session-over')?.result?.ops.length || latest(B, 'lobby-state')?.result?.ops.length) > 0)
  await A.click('回到茶桌')
  await Promise.all([A.waitScreen('lobby'), B.waitScreen('lobby')])
  check('结算回大厅继续复用同一房间', f.hub.rooms.size === 1 && f.bridges[0].transport.info().room === room)

  await A.click('你画我猜', '.mode-switch button')
  await A.click('回合', '.rules-sheet .g-tabs button')
  await A.setInput('input[type="number"]', '45')
  await until(() => latest(B, 'lobby-state')?.mode === 'guess' && latest(B, 'lobby-state')?.rules.roundTime === 45, '大厅玩法与修改房规同步')
  check('大厅修改玩法和房规同步至客机', true)
  await A.click('开始', '.anchor.a-br button.primary')
  await Promise.all([A.waitScreen('game'), B.waitScreen('game')])
  await until(() => A.js("!!document.querySelector('.word-card')"), '房主选词')
  const word1 = await A.js("document.querySelector('.word-card b')?.textContent")
  await A.js("document.querySelector('.word-card').click()")
  await until(() => B.js("!!document.querySelector('input[placeholder*=" + JSON.stringify('猜测') + "]')"), '客机成为猜词者')
  const guessId = latest(B, 'lobby-state').gameId
  const guessCount = (await A.opIds()).length, guessMark = A.messages.length
  await B.inject({ t: 'op', gameId: guessId, round: 1, el: { tag: 'circle', attrs: { cx: 50, cy: 50, r: 10, stroke: '#000' } } })
  await B.inject({ t: 'ops', gameId: guessId, round: 1, items: [{ author: 'agent', el: { tag: 'line', attrs: { x1: 0, y1: 0, x2: 20, y2: 20, stroke: '#000' } } }] })
  await until(() => A.messages.slice(guessMark).filter(m => m.direction === 'sent' && m.data.t === 'op-rejected').length === 2, '猜词者绘图拒绝回执')
  check('Host拒绝猜词者人类和Agent绘图', (await A.opIds()).length === guessCount && !A.messages.slice(guessMark).some(m => m.direction === 'sent' && m.data.t === 'ops'))
  await drawSync(A, B, [[700, 470], [790, 530]], '你画我猜画手笔迹同步')
  await B.setInput('input[placeholder*="猜测"]', '回归错误答案')
  await B.key('Enter')
  await until(() => A.js("document.body.textContent.includes('回归错误答案')"), '错猜同步')
  await B.setInput('input[placeholder*="猜测"]', word1)
  await B.key('Enter')
  await until(async () => await A.js("!!document.querySelector('.round-over')") && await B.js("!!document.querySelector('.round-over')"), '猜中结束双端回合')
  check('猜词双端回合结束且答案一致', await B.js(`document.querySelector('.round-over .answer')?.textContent === ${JSON.stringify(word1)}`))
  await A.click('下一轮')
  await until(() => B.js("!!document.querySelector('.word-card')"), '第二轮客机成为画手')
  const word2 = await B.js("document.querySelector('.word-card b')?.textContent")
  await B.js("document.querySelector('.word-card').click()")
  await until(() => B.js("!document.querySelector('.word-picker')"), '第二轮词卡关闭')
  await until(() => A.js("!!document.querySelector('input[placeholder*=\"猜测\"]')"), '第二轮房主成为猜词者')
  await drawSync(B, A, [[680, 470], [760, 510]], '第二轮客机画手落笔正常')
  await B.shot('04-guess-round-two')
  const roundTwoIds = await A.opIds()
  await A.reload()
  await A.waitScreen('game')
  await until(async () => JSON.stringify(await A.opIds()) === JSON.stringify(roundTwoIds) && JSON.stringify(await B.opIds()) === JSON.stringify(roundTwoIds), '猜词房主刷新恢复轮次和画布')
  await A.setInput('input[placeholder*="猜测"]', word2)
  await A.key('Enter')
  await until(() => B.js("!!document.querySelector('.round-over')"), '刷新房主仍能猜中客机题目')
  check('房主刷新保留轮次、答案、猜词权限和累计比分', latest(B, 'round-over')?.answer === word2 && latest(B, 'scores')?.map.every(([, score]) => score > 0))
  await A.click('结束本局', '.tb-right button')
  await Promise.all([A.waitScreen('result'), B.waitScreen('result')])
  await A.shot('05-result')
  await A.click('再来一局')
  await Promise.all([A.waitScreen('game'), B.waitScreen('game')])
  check('结算再来一局双端清场且房间不销毁', f.hub.rooms.size === 1 && (await A.opIds()).length === 0 && (await B.opIds()).length === 0 && latest(B, 'lobby-state').gameId !== guessId)
  await A.shot('06-again')
  check('全流程无React运行异常', A.errors.length === 0 && B.errors.length === 0, { host: A.errors, peer: B.errors })
  console.log(`PASS：${checks.length} 项联机回归，产物 ${output}`)
} catch (error) {
  for (const page of f.pages) { try { await page.shot(`failure-${page.name}`) } catch {} }
  throw error
} finally {
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checks }, null, 2))
  writeFileSync(path.join(output, 'protocol.json'), JSON.stringify(f.transcript, null, 2))
  await f.close()
}
