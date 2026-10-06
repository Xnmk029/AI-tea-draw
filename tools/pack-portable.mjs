#!/usr/bin/env node
/* ============================================================
   teadraw-pack.zip —— 便携联机包打包脚本
     node tools/pack-portable.mjs [--skip-build]
   产出：根目录 teadraw-pack.zip
     Windows x64 自带 Node，解压即可跑（Steam 模式需 Steam 登录 + SpaceWar）
   ============================================================ */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'teadraw-pack.zip')
const SKIP_BUILD = process.argv.includes('--skip-build')
const TEMP = path.join(ROOT, 'test-output')
mkdirSync(TEMP, { recursive: true })
const STAGE = mkdtempSync(path.join(TEMP, 'portable-stage-'))
const TEMP_OUT = `${STAGE}.zip`

// 删除对象必须是本次创建且位于项目内的 staging / zip，不能由参数指定。
function checkedRemove(target, recursive = false) {
  const resolved = path.resolve(target)
  const relative = path.relative(ROOT, resolved)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || ![STAGE, TEMP_OUT, OUT].includes(resolved)) {
    throw new Error(`拒绝删除非打包目标：${resolved}`)
  }
  rmSync(resolved, { recursive, force: true })
}

const has = (p) => existsSync(path.join(ROOT, p))
const copy = (src, dst) => cpSync(src, dst, { recursive: true, dereference: true })  // dereference: pnpm 软链 → 真文件

// ---------- 1. 前端构建 ----------
if (!SKIP_BUILD) {
  console.log('[pack] vite build …')
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' })
}
if (!has('dist/index.html')) {
  console.error('[pack] dist/index.html 不存在，先跑 vite build')
  process.exit(1)
}

// ---------- 2. 组包目录 ----------
mkdirSync(path.join(STAGE, 'server', 'net'), { recursive: true })
mkdirSync(path.join(STAGE, 'server', 'node_modules'), { recursive: true })
mkdirSync(path.join(STAGE, 'runtime'), { recursive: true })
mkdirSync(path.join(STAGE, 'scripts'), { recursive: true })

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请用 Windows x64 Node 打包便携包')
copy(process.execPath, path.join(STAGE, 'runtime', 'node.exe'))
const nodeLicense = [
  path.join(path.dirname(process.execPath), 'LICENSE'),
  path.join(path.dirname(process.execPath), 'LICENSE.txt'),
  path.resolve(ROOT, '..', 'ai-tea-draw', 'licenses', `node-${process.version}.txt`),
].find(existsSync)
if (!nodeLicense) throw new Error(`缺少 ${process.version} 的 Node 许可证，不能分发运行时`)
copy(nodeLicense, path.join(STAGE, 'runtime', 'NODE-LICENSE.txt'))
copy(path.join(ROOT, 'scripts', 'portable-start.mjs'), path.join(STAGE, 'scripts', 'portable-start.mjs'))

// 前端静态页
copy(path.join(ROOT, 'dist'), STAGE)

// server 侧脚本
copy(path.join(ROOT, 'server', 'teadraw-net.mjs'), path.join(STAGE, 'server', 'teadraw-net.mjs'))
copy(path.join(ROOT, 'server', 'teadraw.mjs'), path.join(STAGE, 'server', 'teadraw.mjs'))
for (const f of ['bridge.cjs', 'mock-hub.cjs', 'mock-transport.cjs', 'protocol.cjs', 'steam-transport.cjs']) {
  copy(path.join(ROOT, 'server', 'net', f), path.join(STAGE, 'server', 'net', f))
}
copy(path.join(ROOT, 'server', 'README.md'), path.join(STAGE, 'server', 'README.md'))
copy(path.join(ROOT, 'server', 'JOIN.md'), path.join(STAGE, 'server', 'JOIN.md'))

// Steam 模式需要 steam_appid.txt 在进程 cwd（包根）
if (has('steam_appid.txt')) copy(path.join(ROOT, 'steam_appid.txt'), path.join(STAGE, 'steam_appid.txt'))

// 运行时依赖 vendor（对端零 npm install）
for (const dep of ['ws', 'steamworks.js']) {
  const src = path.join(ROOT, 'node_modules', dep)
  if (existsSync(src)) {
    copy(src, path.join(STAGE, 'server', 'node_modules', dep))
  } else if (dep === 'ws') {
    console.error('[pack] node_modules/ws 不存在（mock 通道必需），先 pnpm install')
    process.exit(1)
  } else throw new Error(`node_modules/${dep} 不存在，Steam 便携包缺少依赖`)
}

writeFileSync(path.join(STAGE, 'start-steam.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\portable-start.mjs" host %*\r\nif errorlevel 1 pause\r\n')
writeFileSync(path.join(STAGE, 'join-steam.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\portable-start.mjs" join %*\r\nif errorlevel 1 pause\r\n')
writeFileSync(path.join(STAGE, 'package-info.json'), JSON.stringify({ name: 'TeaDraw portable', platform: process.platform, arch: process.arch, node: process.version, builtAt: new Date().toISOString() }, null, 2))

// 根说明
writeFileSync(
  path.join(STAGE, 'README.md'),
  `# 茶绘 · 便携联机包

Windows 10/11 x64 解压即用，自带 Node ${process.version} 与依赖，无需 npm / pnpm 安装。Steam 模式需安装并登录 Steam，首次使用 SpaceWar 可能出现安装提示。

不要在 ZIP 内运行：先把整个包解压到一个文件夹。双击 \`start-steam.cmd\` 开启 Steam / SpaceWar 并打开茶绘主页，再点击「开始茶会」建房。加入房间时，让 Agent 在解压目录执行：

\`\`\`powershell
.\\runtime\\node.exe .\\scripts\\portable-start.mjs join <Steam房间码> --name 茶友
\`\`\`

也可执行 \`join-steam.cmd <Steam房间码> --name 茶友\`。启动器自动检测 Steam、请求启动 SpaceWar、选择本机随机空闲高位端口、后台运行联机桥、打开浏览器进入大厅。Steam 的登录 / 安装交互由玩家在 Steam 中完成。

桥进程关闭当前终端后仍会运行。\`logs/latest-session.json\` 含进程 ID、日志路径和本机深链；\`logs/net-*.log\` 记录诊断。**深链里的 token 仅供本机使用，不要分享；给对方只发房间码和便携包。** Agent 应检查游戏页面已经进入联机大厅且看到自己的座位，启动器的 ready 只说明本机桥已就绪。

**你是 Agent 的话：先读 \`server/JOIN.md\`。**

常用命令（在本目录执行）：

\`\`\`bash
# 加入房间（向房主要 hub 地址 + 房间码 / 或 Steam 18 位码）
runtime/node.exe server/teadraw-net.mjs net --hub ws://<房主IP>:19780 --room <码> --root . --screen lobby --name <茶名> --open
runtime/node.exe scripts/portable-start.mjs join <Steam房间码> --name <茶名>

# 当房主
runtime/node.exe server/teadraw-net.mjs hub --host 0.0.0.0
runtime/node.exe server/teadraw-net.mjs net --root . --name <茶名> --open
runtime/node.exe scripts/portable-start.mjs host --name <茶名>

# Agent 接管茶宠（MCP stdio server）
runtime/node.exe server/teadraw.mjs mcp --name <Agent名> --model <模型名>
\`\`\`
`,
)

const joinPath = path.join(STAGE, 'server', 'JOIN.md')
writeFileSync(joinPath, `# 茶绘 · Windows 便携包加入房间

本包已携带 Windows x64 Node ${process.version}，无需安装 Node / npm。先完整解压 ZIP，Steam 模式使用以下入口：

\`\`\`powershell
.\\runtime\\node.exe .\\scripts\\portable-start.mjs join <Steam房间码> --name 茶友
\`\`\`

启动器检测 / 启动 Steam、请求运行 SpaceWar（AppID 480）、选择本机空闲高位端口、后台持久运行联机桥，并在默认浏览器打开联机大厅。首次 Steam 登录或 SpaceWar 安装提示需要玩家在 Steam 中处理；启动器等待两分钟并自动重试，完成后可重跑同一命令。缺少 Steam 时需要先安装 Steam。

Agent 请从 \`logs/latest-session.json\` 获取本机 url、pid 和 log；检查 \`/health\` 返回 \`ok:true\` 与 \`transport:"steam"\`，并在浏览器确认已经加入指定房间、自己的座位存在。桥健康检查不能代替入房确认。深链包含本机 token，不能发给其他玩家；给其他玩家只发便携包和房间码。Steam 房间码是 15–21 位数字，完整复制，不要当 JavaScript Number 处理。

## 开房与关闭

\`\`\`powershell
.\\runtime\\node.exe .\\scripts\\portable-start.mjs host --name 茶主人
\`\`\`

打开主页后点击「开始茶会」，创建允许按码加入的 public Steam lobby。房间码显示在联机大厅，发给好友即可。启动器的 ready 表示本机桥启动完成，尚未表示 Steam 房间已创建。

桥在后台运行，关闭启动终端不会断房。退出联机会话用游戏里的离房按钮；关停桥时读取 session 的 pid 并停止对应进程。桥停止后房间会退出。每个桥只允许一个游戏页面；要重新打开深链先关闭旧页面。

## 诊断和续连

- \`logs/net-*.log\`：本机桥日志；\`logs/latest-session.json\`：启动信息和带 token 的深链。
- Steam 提示登录 / 安装 SpaceWar：在 Steam 中完成，再重跑同一命令。
- 当前桥没有响应：查看日志；不要关闭仍在使用的其他玩家进程。
- 刷新或页面暂时断开：桥保留房间身份 30 秒，原深链在宽限期内可续连；对局状态由房主快照恢复。
- Steam 原生进程尚在运行：本机同一个 Steam 账号不能充当两名不同玩家；真正跨机测试需两台机器各自的 Steam 账号。
- 本地端口不需要向公网放行；Steam 模式不需要 mock hub，不使用 hub 地址。

## 可选：Agent 接管茶宠

\`\`\`powershell
.\\runtime\\node.exe .\\server\\teadraw.mjs mcp --name 我的Agent --model 模型名
\`\`\`

这是标准 MCP stdio server；可由 MCP 客户端启动，也可由 Agent spawn 后经 JSON-RPC 行协议访问。工具包括 \`room_state\`、\`turn_get_task\`、\`canvas_snapshot\`、\`canvas_draw\`、\`canvas_commit\`、\`guess_submit\` 等。完整协议和绘图坐标契约见 \`server/README.md\`。本次加入房间不需要主动接管茶宠。

## 备用 mock 通道

mock 需要可达的 hub 地址和 4 位房间码；Steam 房间不适用下面的命令。

\`\`\`powershell
.\\runtime\\node.exe .\\server\\teadraw-net.mjs net --hub ws://<房主IP>:19780 --room <4位房间码> --root . --screen lobby --name 茶友 --open
\`\`\`
`)

// ---------- 3. 打 zip ----------
try {
  execFileSync('tar.exe', ['-a', '-cf', TEMP_OUT, '.'], { cwd: STAGE, stdio: 'inherit' })
} catch {
  checkedRemove(TEMP_OUT)
  // 固定路径经单引号转义，PowerShell 原生操作同一 shell 内完成。
  const quoted = value => `'${value.replace(/'/g, "''")}'`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path ${quoted(path.join(STAGE, '*'))} -DestinationPath ${quoted(TEMP_OUT)} -Force`], { stdio: 'inherit' })
}
const contents = execFileSync('tar.exe', ['-tf', TEMP_OUT], { encoding: 'utf8' })
for (const required of ['index.html', 'runtime/node.exe', 'runtime/NODE-LICENSE.txt', 'scripts/portable-start.mjs', 'server/node_modules/ws/package.json', 'server/node_modules/steamworks.js/package.json', 'join-steam.cmd']) {
  if (!contents.split(/\r?\n/).some(entry => entry.replace(/^\.\//, '').replace(/\\/g, '/') === required)) throw new Error(`ZIP 缺少 ${required}`)
}
checkedRemove(OUT)
renameSync(TEMP_OUT, OUT)
checkedRemove(STAGE, true)

const size = statSync(OUT).size / 1048576
const sha256 = createHash('sha256').update(readFileSync(OUT)).digest('hex')
console.log(`[pack] ${OUT}  ${size.toFixed(1)} MB`)
console.log(`[pack] sha256 ${sha256}`)
console.log(`[pack] 内容：静态前端 + Windows x64 Node ${process.version} /许可证 + 自动 Steam 启动器 + server / vendored ws / steamworks.js + steam_appid.txt`)
console.log('[pack] 对端：解压 → runtime/node.exe scripts/portable-start.mjs join <Steam房间码> --name 茶友')
