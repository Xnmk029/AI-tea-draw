import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(import.meta.url)('typescript')
const out = path.join(root, 'test-output', 'agent-session', `unit-${process.pid}`)
const seen = new Set()
function compile(relative) {
  if (seen.has(relative)) return
  seen.add(relative)
  const destination = path.join(out, relative.replace(/\.tsx?$/, '.mjs'))
  mkdirSync(path.dirname(destination), { recursive: true })
  let source = readFileSync(path.join(root, 'src', relative), 'utf8')
  if (relative === 'agent/AgentSession.tsx') source = source.replace('function createController(', 'export function createController(')
  let compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  compiled = compiled.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (whole, before, specifier, after) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
    const dependency = existsSync(path.join(root, 'src', `${base}.ts`)) ? `${base}.ts` : `${base}.tsx`
    compile(dependency)
    return `${before}${specifier}.mjs${after}`
  })
  writeFileSync(destination, compiled)
}
compile('agent/AgentSession.tsx')

const oldGlobals = { WebSocket: globalThis.WebSocket, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, location: globalThis.location, localStorage: globalThis.localStorage, document: globalThis.document, DOMParser: globalThis.DOMParser }
let timerSeq = 0
const timers = new Map()
globalThis.setTimeout = (callback, delay) => { const id = ++timerSeq; timers.set(id, { callback, delay }); return id }
globalThis.clearTimeout = id => timers.delete(id)
globalThis.location = { search: '?mcp=5193' }
const saved = new Map()
globalThis.localStorage = { setItem: (key, value) => saved.set(key, value), getItem: key => saved.get(key) }
globalThis.DOMParser = class {
  parseFromString(source) {
    const children = [...source.matchAll(/<(circle|rect|line)\b([^>]*?)\/?\s*>/g)].map(([, tagName, attributes]) => ({ tagName, children: [], attributes: [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => ({ name, value })) }))
    return { getElementsByTagName: () => [], documentElement: { children } }
  }
}
globalThis.document = {
  body: { appendChild() {} },
  createElementNS(_namespace, tag) {
    const attrs = {}
    return { setAttribute: (key, value) => { attrs[key] = value }, appendChild() {}, remove() {}, getTotalLength: () => tag === 'circle' ? 2 * Math.PI * Number(attrs.r) : 20 }
  },
}
class FakeSocket {
  static OPEN = 1
  static sockets = []
  readyState = 0
  sent = []
  constructor(url) { this.url = url; FakeSocket.sockets.push(this) }
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  receive(message) { return this.onmessage?.({ data: JSON.stringify(message) }) }
}
globalThis.WebSocket = FakeSocket
let checks = 0
function check(label, run) { run(); checks++; console.log(`✓ ${label}`) }
const { createController } = await import(pathToFileURL(path.join(out, 'agent/AgentSession.mjs')).href)
let controller
try {
  const updates = []
  controller = createController({ peer: { state: 'off' }, port: 5193, enabled: true, error: null }, state => updates.push(state))
  controller.connect()
  const socket = FakeSocket.sockets.at(-1)
  socket.open()
  await socket.receive({ t: 'joined', ok: true, peer: { state: 'ready', name: '真实茶宠', model: 'reported-model' } })
  check('桥 ready 与 Agent awake 分开', () => assert.equal(updates.at(-1).peer.state, 'ready'))
  let callSeq = 0
  const tool = async (name, args = {}) => {
    const id = `call-${++callSeq}`
    await socket.receive({ t: 'call', id, name, args })
    return socket.sent.find(message => message.t === 'result' && message.id === id)
  }
  check('主菜单 idle 已连接且不伪造画布', () => assert.equal(socket.sent[0].context, 'idle'))
  const idle = await tool('room_state')
  check('idle 可查房间状态', () => assert.equal(idle.data.context, 'idle'))
  const noCanvas = await tool('canvas_draw', { svg: '<circle/>' })
  check('idle 落笔返回 no_canvas', () => assert.equal(noCanvas.error.code, 'no_canvas'))
  await socket.receive({ t: 'peer', state: 'awake', name: '真实茶宠', model: 'reported-model' })
  check('只展示 Agent 实际上报身份', () => assert.deepEqual(updates.at(-1).peer, { state: 'awake', name: '真实茶宠', model: 'reported-model' }))

  const contexts = []
  const makeContext = () => {
    const statuses = [], logs = [], snapshot = {
      seats: [{ id: 1, name: '试画', color: '#888', online: true, ready: true }], ops: [], ghost: null,
      marks: [{ id: 'mark-1', target: { kind: 'box', rect: { x: 0, y: 0, w: 200, h: 200 } } }], cam: { x: 0, y: 0, z: 1 },
      word: null, guessed: false, roundOver: false, submitted: false, timeLeft: null,
      ink: { human: 0, agent: 0, allowance: 4000 }, round: 1, roundTarget: { word: '测试' },
    }
    const ctx = {
      context: 'sandbox', mode: 'tea', role: 'drawer', rules: { agentLevel: 'off', svgPreset: 'standard', targetFit: 'contain', penSpeed: 900 }, meId: 1,
      state: () => snapshot, later: () => {}, log: (...args) => logs.push(args), say: () => {}, think: () => {}, patchAgent: (_seat, status) => { snapshot.agentStatus = status }, score: () => {}, markGuessed: () => {},
      setGhost: ghost => { snapshot.ghost = ghost }, markUsed: () => {}, clearMarks: () => {}, showToast: message => logs.push(['toast', message]), commitOps: batch => { snapshot.ops.push(...batch.ops); return batch.ops.map(op => op.id) }, acceptGhost: () => [], getPen: () => undefined,
      drawerSeat: () => 1, relayTitle: '', profilePrompt: () => '水墨写意，少量线条，留白', onTaskStatus: status => statuses.push(status),
    }
    contexts.push({ ctx, snapshot, statuses, logs })
    return contexts.at(-1)
  }
  const first = makeContext()
  const handleA = controller.bind('pet', first.ctx)
  check('bind 不重建 WebSocket', () => assert.equal(FakeSocket.sockets.length, 1))
  const taskA = handleA.pushTask('画茶壶')
  const task = await tool('turn_get_task')
  check('真实任务携带风格和上下文标识', () => { assert.equal(task.data.task.taskId, taskA); assert.match(task.data.task.contextId, /^pet:/); assert.match(task.data.task.profilePrompt, /水墨/) })
  await tool('turn_get_task')
  check('重复领取不重复 claimed 回执', () => assert.equal(first.statuses.filter(status => status.stage === 'claimed').length, 1))
  const targetsA = await tool('canvas_get_targets')
  const targetA = targetsA.data.targets[0].id
  const blockedByRule = await tool('canvas_draw', { targetId: targetA, svg: '<circle/>' })
  check('当前帧通过隔离检查后仍遵守房规', () => assert.match(blockedByRule.error.message, /关闭/))
  const second = makeContext()
  const handleB = controller.bind('game', second.ctx, peer => { second.snapshot.agentStatus = peer.state === 'awake' ? 'idle' : 'offline' })
  check('切换画布取消旧任务', () => assert.equal(first.statuses.at(-1).stage, 'cancelled'))
  check('切屏仍只保留原 socket', () => assert.equal(FakeSocket.sockets.length, 1))
  handleA.dispose()
  const game = await tool('room_state')
  check('旧 handle.dispose 不解绑新画布', () => assert.match(game.data.contextId, /^game:/))
  const staleFrame = await tool('canvas_draw', { targetId: targetA, svg: '<circle/>' })
  check('旧画布 frame 不能落到新画布', () => assert.equal(staleFrame.error.code, 'stale_context'))
  const noFrame = await tool('canvas_draw', { svg: '<circle/>' })
  check('无标识无帧旧提交不能污染新画布', () => assert.equal(noFrame.error.code, 'stale_context'))
  const staleTask = await tool('chat_send', { text: '迟到', contextId: task.data.task.contextId, taskId: taskA })
  check('旧任务修改工具被拒绝', () => assert.equal(staleTask.error.code, 'stale_context'))
  const taskB = handleB.pushTask('画松树')
  const currentTargets = await tool('canvas_get_targets')
  handleB.cancelTask('取消调试')
  const cancelledFrame = await tool('canvas_draw', { targetId: currentTargets.data.targets[0].id, svg: '<circle/>' })
  check('取消任务后原帧立即过期', () => assert.equal(cancelledFrame.error.code, 'stale_context'))
  const taskC = handleB.pushTask('画纸飞机')
  const timeout = [...timers.values()].find(timer => timer.delay === 45000)
  timeout.callback()
  check('45 秒超时取消任务并报告 failed', () => { assert.equal(second.statuses.at(-1).taskId, taskC); assert.equal(second.statuses.at(-1).stage, 'failed'); assert.match(second.statuses.at(-1).detail, /45/); assert.notEqual(taskB, taskC) })
  const cancelledTask = await tool('turn_get_task')
  check('超时任务不会被再次领取', () => assert.equal(cancelledTask.data.task, null))
  const taskD = handleB.pushTask('画小猫')
  handleB.completeTask(taskD)
  handleB.cancelTask('已完成后的取消')
  check('完成任务后清理运行态且不被取消覆盖', () => assert.equal(second.statuses.at(-1).stage, 'completed'))
  let profile = '水墨写意，少量线条，留白'
  let preserve = true
  second.ctx.rules.agentLevel = 'collab'
  second.ctx.rules.avoidOthers = false
  second.ctx.profilePrompt = () => profile
  second.ctx.preservePosition = () => preserve
  const preservedTask = handleB.pushTask('画靠右的圆')
  profile = '后来改成卡通'; preserve = false
  const frozenTask = await tool('turn_get_task')
  check('任务派发时冻结风格和构图规则', () => { assert.match(frozenTask.data.task.profilePrompt, /水墨/); assert.equal(frozenTask.data.task.rules.preservePosition, true) })
  const preservedTargets = await tool('canvas_get_targets')
  const draw = await tool('canvas_draw', { targetId: preservedTargets.data.targets[0].id, svg: '<circle cx="150" cy="50" r="20" stroke="#333" fill="none"/>', mode: 'commit' })
  check('保留显式帧内非零局部坐标和留白', () => { assert.equal(draw.ok, true); assert.deepEqual(second.snapshot.ops.at(-1).tf, { x: 0, y: 0, s: 1 }); assert.equal(second.snapshot.ops.at(-1).el.attrs.cx, '150') })
  handleB.completeTask(preservedTask)
  const legacyTask = handleB.pushTask('默认居中圆')
  const legacyTargets = await tool('canvas_get_targets')
  await tool('canvas_draw', { targetId: legacyTargets.data.targets[0].id, svg: '<circle cx="150" cy="50" r="20" stroke="#333" fill="none"/>', mode: 'commit' })
  check('未开启保留位置仍沿用已有居中行为', () => assert.deepEqual(second.snapshot.ops.at(-1).tf, { x: -50, y: 50, s: 1 }))
  handleB.completeTask(legacyTask)
  second.ctx.frame = { x: 0, y: 0, w: 200, h: 200 }
  second.ctx.rules.avoidOthers = true
  const boundTask = handleB.pushTask('重叠区域仍在纸内')
  const boundedTargets = await tool('canvas_get_targets')
  await tool('canvas_draw', { targetId: boundedTargets.data.targets[0].id, svg: '<circle cx="150" cy="50" r="20" stroke="#333" fill="none"/>', mode: 'commit' })
  check('避让候选超出试画纸时保留用户原帧', () => assert.deepEqual(second.snapshot.ops.at(-1).tf, { x: -50, y: 50, s: 1 }))
  handleB.completeTask(boundTask)
  preserve = true
  const fixedTask = handleB.pushTask('精准靠右位置不被避让挪动')
  const fixedTargets = await tool('canvas_get_targets')
  await tool('canvas_draw', { targetId: fixedTargets.data.targets[0].id, svg: '<circle cx="150" cy="50" r="20" stroke="#333" fill="none"/>', mode: 'commit' })
  check('保留位置时避让不会移动显式帧', () => assert.deepEqual(second.snapshot.ops.at(-1).tf, { x: 0, y: 0, s: 1 }))
  handleB.completeTask(fixedTask)
  handleB.pushTask('断线中的任务')
  await socket.receive({ t: 'peer', state: 'down' })
  check('桥断线任务失败后最终座位保持离线', () => { assert.equal(second.statuses.at(-1).stage, 'failed'); assert.equal(second.snapshot.agentStatus, 'offline') })
  handleB.dispose()
  check('解绑只改 idle，socket 保持 OPEN', () => assert.equal(socket.readyState, 1))
  const afterRelease = await tool('room_state')
  check('解绑后仍可调用 idle 状态', () => assert.equal(afterRelease.data.context, 'idle'))

  const obsoleteOpen = socket.onopen, obsoleteMessage = socket.onmessage
  controller.reconnect()
  const newSocket = FakeSocket.sockets.at(-1)
  const count = updates.length
  obsoleteOpen()
  await obsoleteMessage({ data: JSON.stringify({ t: 'peer', state: 'awake', name: '旧身份' }) })
  check('旧 socket 延迟回调不会覆盖重连状态', () => assert.equal(updates.length, count))
  newSocket.open()
  newSocket.close()
  check('断线仅登记一个重试计时', () => assert.equal(timers.size, 1))
  controller.disconnect()
  check('断开清理重试计时且 enabled=false', () => { assert.equal(timers.size, 0); assert.equal(updates.at(-1).enabled, false) })
  controller.connect(80)
  check('端口输入验证不产生新连接', () => { assert.match(updates.at(-1).error, /1024/); assert.equal(FakeSocket.sockets.length, 2) })
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ passed: checks, type: 'actual runtime/controller/geometry/validator with fake socket, clock and basic XML/geometry DOM; no SVG visual claim' }, null, 2))
  console.log(`Agent 会话回归：${checks} 项通过`)
} finally {
  controller?.dispose()
  Object.assign(globalThis, oldGlobals)
}
