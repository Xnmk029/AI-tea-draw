# TeaDraw · design.agent.md（Agent 审阅版）

> 读者：接手开发的 AI Agent。人类阅读版是 `design.md`。
> 状态快照：v0.3 UI demo，2026-10-06。代码是事实来源；本文与代码冲突时**以代码为准，并更新本文**。
> 语言：与用户对话用中文；代码注释保持现有风格（简短中文，按需）。

---

## 0. TL;DR

- 前端 demo：Vite 6 + React 19 + TypeScript strict。其他玩家和 Agent 由 `src/game/simulation.ts` 模拟。
- **真实 Agent 已可接入（T1 完成）**：`node server/teadraw.mjs mcp` = MCP stdio 服务 + WebSocket 桥（127.0.0.1:5190，零依赖）。App 顶层 `AgentSessionProvider` 常驻一条连接，主菜单即可接入；`liveAgent` 只绑定当前试画/对局环境，换屏不关闭连接。茶宠工作台只接受真实 Agent，桥 ready 与 MCP awake 分开。协议与坐标契约见 `server/README.md`。
- 所有笔迹（人和 Agent）都是 `Op { el: SvgEl, tf, author }`。Agent 的 SVG 必须经过 `sanitizeSvg`，再由 `buildBatch` 按笔速生成逐笔动画。
- 游戏状态全部在 `useGame()` 里，UI 只读 `GameState`（契约见 `src/game/gameTypes.ts`）。
- 舞台固定 1920×1080 并整体缩放：**任何 client 坐标都必须先用 `ui/stage.ts` 换算**。
- 层级固定（§4），新代码不得写裸 z-index。

## 1. 命令

| 用途 | 命令（在项目根目录执行） |
|---|---|
| 开发服务器 | `node node_modules/vite/bin/vite.js --port 5180` |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` |
| 构建 | `node node_modules/vite/bin/vite.js build` |
| 截图 / 交互回归 | `node tools/shot.mjs <steps.json> [outDir]`（需要 dev server 已启动；默认输出到 `G:/tmp/tea-shots`） |
| 真实 Agent 桥 | `node server/teadraw.mjs mcp [--port 5190]`（MCP stdio + WS 桥；`bridge` 只开桥；`ping` 测活） |
| Agent 端到端自测 | `node server/test-agent.mjs`（脚本化 MCP 客户端：领任务→找空位→交草稿→等盖章） |

- **不要用 `pnpm dev` / `pnpm typecheck`**：pnpm 会先自动 install，然后因 esbuild 构建脚本未批准报 `ERR_PNPM_IGNORED_BUILDS`。`pnpm-workspace.yaml` 里有一个 `allowBuilds.esbuild` 占位值等待用户决定。**不要自行修改它**，这属于安全策略，交给用户处理。
- 截图要输出到**不被 .gitignore 忽略的目录**，`.shots/` 被忽略了，read 工具读不到。
- `shot.mjs` 的步骤格式：`{go:"?query"}`、`{wait:ms}`、`{drag:[[x,y],...]}`、`{click:[x,y]}`、`{key:"Tab", ctrl?, shift?}`、`{type:"文本"}`、`{js:"表达式"}`（打印返回值）、`{shot:"a.png"}`。视口为 1440×900，舞台缩放约 0.75。
- 深链：`?screen=home|lobby|game|result&mode=tea|relay|guess&role=drawer|guesser`。

## 2. 目录与职责

```
src/
  App.tsx              屏幕路由 + 舞台缩放 + 卷帘转场 go() + LayerRoots/Portal 挂载
  core/
    types.ts           领域类型（ModeId, Seat, Op, SvgEl, RoomRules, ToolId…）
    theme.ts           SEAT_COLORS, PALETTE, WIDTHS, MODES, AGENT_LEVELS, STATUS_TEXT
    geometry.ts        Pt, Rect, STAGE{1920,1080}, pointsToPath, fitBox, tfStr…
    svgPolicy.ts       sanitizeSvg（白名单）/ POLICY_PRESETS / measureLength（墨量）
  mock/
    drawings.ts        Agent 示例 SVG 素材（200×200 盒子）；drawingReport / drawingEls / matchDrawing
    room.ts            座位、默认房规、词库、传话链、排行等模拟数据；judgeGuess
  game/
    gameTypes.ts       ★ UI ↔ 逻辑的契约：GameState / Ghost / Pen / Camera / GuideMode
    useGame.ts         ★ 全部对局状态与动作、快捷键、计时器、我的 Agent 流程
    simulation.ts      远端玩家 / Agent 的脚本（startSimulation(SimCtx)）
    liveAgent.ts       真实 Agent 的 12 个工具处理器（canvas_draw → 描红/落定；坐标契约=帧局部坐标）
    mcpClient.ts       浏览器 ↔ teadraw 桥的 WS 客户端（自动重连；LivePeer 状态）
    useNetRoom.ts      App 常驻房间会话：大厅/对局/结算阶段、完整房规与座位、建房入房及续连
    netSync.ts         session/game 订阅、gameId 隔离、顺序发送、大包分块及切屏消息缓存
    netClient.ts       浏览器 ↔ 每玩家本机联机桥的 WS 客户端
    engine.ts          buildBatch / mergeBatches / animateOps / makePen / uid
    targeting.ts       落笔指引：DrawTarget、手势分类、fitContent、锚定、占用网格、findSpace
    Canvas.tsx         SVG 画布、指针输入、rAF 驱动的远端光标、草稿与标记渲染
    TopBar / ToolDock / AgentBar(GuessBar) / SidePanel / Overlays / TeaPet
  screens/             Home / Lobby / Game / Result（固定构图、键盘导航）
  agent/               AgentSession（常驻连接）、usePetSandbox（独立试画）、PetWorkbench（风格/调试/记录/连接）、preferences（个人绘画偏好）
  ui/
    Shell.tsx          LayerRoots, Portal, useBack, useHotkeys, Key, Curtain
    stage.ts           stageScale(), toStage(cx, cy)
    ui.css             层级 / 锚点 / 游戏控件 / 四个屏幕的构图（最后加载）
  styles/app.css       v1 基础样式（会 @import game.css）
  styles/game.css      v2 游戏化皮肤（木框、笔架、茶宠、指引标记、印章、燃香…）
tools/shot.mjs         无头 Chrome + CDP 截图脚本
server/
  teadraw.mjs          零依赖 CLI：`mcp`（stdio MCP + WS 桥）/ `bridge` / `ping`
  test-agent.mjs       脚本化 MCP 客户端，端到端自测
  README.md            MCP 工具表、帧局部坐标契约、内部 WS 协议
```

样式的加载顺序是 `app.css` → `game.css` → `ui/ui.css`，后加载的覆盖先加载的。新增的布局和层级样式写进 `ui/ui.css`；只属于对局皮肤的细节可以写进 `game.css`。

## 3. 硬性不变量（不要破坏）

1. **单一笔迹模型**：画布上的一切都是 `Op`。人和 Agent 只靠 `author: 'human' | 'agent'` 区分。不要为 Agent 另造一套渲染或存储路径。
2. **Agent 的 SVG 必须过校验**：所有来自 Agent 的 SVG 都要经过 `sanitizeSvg(src, POLICY_PRESETS[rules.svgPreset])`，demo 里通过 `drawingReport` 完成。校验规则：
   - 标签只允许 `path, line, polyline, polygon, rect, circle, ellipse`，`<g>` 会被展开
   - 剥离 `id / class / name / data-name / aria-label`
   - 移除 `text / image / foreignObject / script / use / a / filter / animate` 等标签和所有事件属性
   - 颜色值必须匹配正则 `none | #hex | rgb(a)`
   - 数值保留 1 位小数
   - 严格模式下去掉填充，改成描边
3. **Agent 落笔必须走笔速动画**：用 `buildBatch(els, { speed: rules.penSpeed })` 生成 `op.anim = {delay, dur}` 和 `timeline`。不允许瞬间贴图，回放除外（`animateOps`）。
4. **墨量配额**：`allowance = r >= 0.99 ? 99999 : max(4000, human * r / (1 - r))`，其中 `r = rules.inkRatio`，位置在 `useGame.ts` 的 ink 计算处。超额时拒绝，并记一条 activity（tone `warn`）。
5. **擦除权限**：`erase` 和 `undo` 只能作用于 `op.seat === me.id` 的 op。
6. **你画我猜的信息隔离**：
   - 猜词者看到的 `word` 永远是 `null`，答案只放在 `answer` 字段
   - 猜词者 Agent 的快照只给光栅图（activity 里标注"仅光栅图，无 SVG 源"）
   - 画手 Agent 的思考文字不能出现在猜词者能看到的地方
   - 画布上禁止出现文字
7. **契约只增不删**：`GameState`（`gameTypes.ts`）是 UI 和逻辑之间的契约。新增字段尽量设为可选，不要删除或改名已有字段。
8. **坐标系**（三套，不要混用）：
   - **client**：浏览器像素。只在事件入口出现，**立即**用 `toStage(cx, cy)` 或除以 `stageScale()` 换算。
   - **stage**：1920×1080 设计坐标。所有绝对定位的 UI 用它。
   - **world**：画布世界坐标，`screen = (world - cam.{x,y}) * cam.z`，其中 screen 指画布内的 stage 像素。Op 的局部坐标需要再经过 `op.tf = {x, y, s}`。
9. **层级**：见 §4。新的弹窗、提示、拖动浮层一律用 `<Portal layer=…>`。
10. **React StrictMode 未启用**，但所有 effect 都必须能正确清理。`useGame` 用 `later()` 统一登记 timeout，卸载时会全部清除。

## 4. 舞台与层级

```
.stage-outer > .stage(1920×1080, translate(-50%,-50%) scale(k))
  .scr.scr-{home|lobby|game|result}
    .l-bg     z0    背景
    .l-world  z10   画布 / 茶桌 / 世界内标记（光标、令旗、草稿、锚定轮盘）
    .l-frame  z50   木框（pointer-events:none）
    .l-hud    z100  .anchor.a-{tl,tc,tr,ml,mr,bl,bc,br}，边距 var(--safe)（对局屏 40px，其余 56px）
    .l-panel  z200  纸页 .sheet / 茶单 / 侧栏
  #layer-popover     z300  跟手元素（拖动中的茶宠）
  #layer-modal       z400  选词 / 等待 / 回合结束（.overlay > .modal）
  #layer-toast       z500
  #layer-transition  z600  卷帘 Curtain（c-idle | c-in | c-out）
  #layer-debug       z700  DemoNav（底边中央）
```

- `.l-hud` 和 `.l-panel` 本身 `pointer-events: none`，它们的直接子元素用 `:where()` 恢复为 auto（特异性为 0，组件自己的 `pointer-events: none` 仍然生效，比如 `.topbar`）。
- **注意类名冲突**：舞台层用 `.stage-layer`，**不能用 `.layer`**，那是侧栏"图层"行的类名（固定 38px 高，曾经导致弹窗塌缩）。
- 换屏统一走 `App.go(screen)`：卷帘落下 420ms → 换屏 → 收起 520ms。转场期间 `busy` 锁住，最新待转屏请求保存在 `pendingScreen`，收起后继续处理，避免联机房间状态变化被吞掉。
- Esc：`useBack(fn, active)` 是一个栈，最后注册的先响应；焦点在输入框时，Esc 只让输入框失焦。对局里的 Esc（拒绝草稿、清除标记）由 `useGame` 处理，**对局屏不注册 useBack**。
- 屏幕快捷键用 `useHotkeys(map)`，输入框内和带 Ctrl/Meta/Alt 时不触发。按键提示用 `<Key k="Enter" />`。

## 5. 对局数据流

```
玩家指针 ──Canvas.onDown/Move/Up──▶ finalize() → g.draw(el) ──▶ ops[]（human，静态）
玩家指引 ──Canvas(tool='guide')──▶ classifyStroke → g.addMark(DrawTarget) → marks[]（≤ MAX_MARKS=3）
玩家指令 ──AgentBar──▶ g.askAgent(text)
   ├ 真实链路（live.state = awake）：liveRef.pushTask(text)
   │   → Agent 端 tools/call：turn_get_task → canvas_get_targets/find_space → canvas_draw
   │   → liveAgent.canvas_draw：sanitizeSvg → 帧局部坐标→世界 tf → 配额 → preview(ghost)/commit(runBatch)
   │   → 玩家 Tab/Esc → liveRef.previewResult → 事件回执（events_poll / notifications）
   └ 模拟链路（桥不在线）：
     └ matchDrawing(text) → drawingReport(key, preset)  （模拟"Agent 产出 SVG + Host 校验"）
     └ 目标：marks → targetRect/anchorRect/pathSlots/gridRect → fitContent(content, area, rules.targetFit)
             无标记 → buildOccupancy + findSpace 找空白区域
     └ 配额检查 → thinking[]（呼吸圈）→ 1.4s 后：
          assist：ghost = { ops(静态, 各自带 tf), label, ink, notes } ，状态 review
                   Tab / acceptGhost → buildBatch(speed) → runBatch(我的 agent pen) → ops[]（agent，带动画）
                   Esc / rejectGhost → 丢弃
          collab / auto：直接 runBatch
远端 ──simulation.ts──▶ addOps / runBatch(penKey) / say / patchAgent / score
Canvas 的 rAF：读 pens.current，根据 batch.timeline 用 getPointAtLength 让光标跟随笔尖，直接写 DOM（data-state=off|on|inking）
```

- Pen key：远端人类为 `${seatId}-human`，Agent 为 `${seatId}-agent`；我的 Agent 是 `${me.id}-agent`。`pen.batch.end` 是**时长**，不是时间戳。
- 动画用 CSS 类 `.draw`，配合 `pathLength=1`，以及 `--delay`、`--dur`。**注意**：任何祖先元素都不要带 `.draw` 类，`stroke-dasharray` 会被子元素继承，曾经导致相册缩略图整体变成虚线（传话相册卡片现在用 `k-draw`）。
- activity 里的 MCP 工具名与真实 MCP 一致：`turn_get_task`、`canvas_get_targets`、`canvas_find_space`、`canvas_snapshot`、`canvas_describe`、`canvas_draw`、`canvas_commit`、`preview_accept`、`preview_reject`、`chat_send`、`guess_submit`、`hint_whisper`、`events_poll`、`room_state`、`task_push`。模拟链路的日志前缀相同，但真实链路下这些日志是**真实调用发生时**才写入的。
- 联机时人类与 Agent 统一经过 Host 的 `buildAuthorizedOps → applyCommittedOps`，校验当前画手/回合、SVG 属性、几何与墨量，然后广播；Peer 的直接提交和草稿盖章都等待 Host 回显。MCP 角色与座位动态读取，猜词/聊天也向 Host 提交，联机悄悄提示禁用。

### 5.2 主菜单茶宠工作台（2026-10-06）
- `main.tsx` 挂载 `AgentSessionProvider`；`App` 常驻 `usePetSandbox`，首页绑定独立 640×360 试画纸，大厅/结算绑定 idle，`useGame` 绑定当前正式游戏；只在主动断开/改端口/页面关闭时关闭 WS。
- 状态分为连接（off/connecting/ready/awake/down）与任务（queued/claimed/preview/drawing/completed/cancelled/failed）；主菜单 badge 来自实际 peer。MCP 初始化只证明客户端在线，测试成功必须经过真实任务、草稿与动画落笔。
- 五种画法、细节/结构/墨色、配色/构图和可编辑个人提示词存浏览器配置。主菜单任务文本含完整偏好；对局 `turn_get_task.profilePrompt` 冻结发送时偏好。风格不扩大房规权限，不在网页里切换实际 AI 模型。
- 试画调试单独控制助手/协作、SVG 规则、笔速、墨量和越界/避让；复用真实 SVG 校验与 Op 动画。中央/角落/狭长/引路/锚定指引及人类起笔可测试协作。试画 Op 永不导入房间。
- 最近 20 次试画保存在当前 App 会话，记录完整指令、起始画布、偏好/限制、实际作品、阶段、耗时、墨量与接收笔迹 JSON 大小；可重试、同题新纸对比、导出 SVG/诊断 JSON。风格配置跨刷新保存，作品历史不承诺跨刷新保存。
- `contextId + taskId` 及带环境/回合/任务 epoch 的帧标识隔离迟到提交；取消/换屏/换轮废弃旧帧，45 秒无图为失败，工具提交被拒绝允许 Agent 修稿。调用方应把返回标识用于所有修改工具。
- 回归：`node tools/agent-session-test.mjs`（连接/runtime 状态与隔离），`node tools/pet-workbench-e2e.mjs`（真实 stdio MCP、主菜单试画与切屏），`node tools/net-lobby-e2e.mjs`（正式联机）。工作台组件与样式仅打开时加载。

## 5.1 局流程（多轮、恢复、结算载荷）

- **轮次**：`round`/`roundsTotal` 在 `useGame`；guess 模式 rounds=rules.rounds。`nextRound()` 清场（ops/ghost/标记/词/计时/whisper/猜中集）、抽新词（画手抽 3 张、猜词换题）、`simRoundStart(ctx, r)` 重启模拟：猜词视角换画手（轮换 seats）、重挂猜词剧本（`armGuessScript`，旧轮 timer 用 `getRound()!==myRound` 防串轮）。画手视角的猜词队列用 `queueRound` 检测换轮重建。**注意**：所有 `ctx.later` 循环必须「isOver 只跳过本轮逻辑、不能 return 自杀」，否则第 2 轮起模拟就死了。
- **词库**：`wordPool(rules)` = `GUESS_WORDS`(10 内置) + `rules.wordBank`（大厅「茶单·回合」可编辑自定义词，顿号/逗号分隔）；`pickOptions`/`pickTarget` 随机抽且排除 `usedWords`；`whisperFor(w)` 按题目生成悄悄提示。
- **主题**：`rules.theme`（茶单·回合可改）→ TopBar 主题、任务文案、结算标题；空则用 `TEA_THEME`。
- **避让**：`rules.avoidOthers !== false`（默认开，茶单有开关）控制 `occOverlap→nudgeFree` 微挪，sim 与 liveAgent 两条链路共用。
- **结算载荷**：`g.collectResult(): SessionResult`（seats/ops/inkStats/guessStats/rounds/theme/durationMs）→ `GameScreen.finish` → `App.lastResult` → `ResultScreen`。**无 result 时结算屏回退演示数据**（深链直达仍可用）。回放用 `OpsView`（真实 op 渲染，复用 `.draw` CSS）；导出 SVG/PNG 是真实下载。
- **持久化**：单机 ops/比分/轮次自动存 `localStorage['teadraw:save:{mode}:{role}']`（800ms 防抖），`?resume=1` 恢复。联机房间配置与阶段存 sessionStorage；Host 核心状态按 `room+gameId` 保存，刷新续连恢复原局；Peer 从 Host 请求快照。联机不会读入单机演示存档，存储不足或桥断开超过 30 秒不保证恢复。
- **错误兜底**：`ErrorBoundary` 包住 .stage 内容，崩溃给纸样式错误卡（提示 ?resume=1）。
- **Agent 感知**：`liveRef.notifyOps/notifyOpsRemoved` 挂在 draw/addOps/runBatch/erase/undo 上 → `events_poll` 的 `ops`/`ops_removed` 事件，真实 Agent 能看到别人落了什么笔。

## 6. 快捷键（实现于 `useGame` 的 keyRef，以及各屏的 useHotkeys）

| 场景 | 按键 |
|---|---|
| 对局 | Ctrl/⌘+K 聚焦茶宠指令；有草稿时 Tab 接受、Esc 拒绝（输入框里同样生效）；Esc 清除标记；Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做；按住 Space 抓手；Q 切换九宫格；V 指引笔，B 画笔，L 直线，R 矩形，O 椭圆，E 橡皮，H 抓手；指引笔下 1–6 切换子模式（auto / pin / box / lasso / path / anchor）；A 高亮 Agent 笔迹 |
| 主菜单 | ↑↓ / W S 移动，Enter 确认，1–6 直达，Esc 关闭纸页；在"开始茶会"里 ←→ / A D 切换玩法 |
| 大厅 | Q / E 切换玩法，Space 准备，Enter 开始，Esc 返回 |
| 结算 | Q / E 切换（demo），Enter 再来一局，Esc 回到茶桌 |

## 7. 已知问题与坑

| 编号 | 问题 | 位置 | 备注 |
|---|---|---|---|
| K1 | 样式分散在三个文件里，存在相互覆盖 | `styles/app.css`、`game.css`、`ui/ui.css` | 收拢时先截图对比，不要一次性大改 |
| K2 | `useGame` 的初始相机用固定的 `SIDEBAR=324`，而对局屏侧栏的实际宽度变量是 344px | `useGame.ts` 顶部 | 不影响功能，只是视口中心略偏 |
| K3 | 素材库 `drawings.ts` 故意带了 `<title>`、`<text>`、`id`、`class` | 用于演示校验器 | 不要"修掉"这些，修掉就看不到校验效果了 |
| K4 | 主页、大厅、结算仍然使用 lucide 线性图标和 `Segmented` 分段按钮 | 多处 | 后续替换成定制的手绘图标和令牌组件 |
| K5 | 设置面板只有界面，没有接入任何功能 | `HomeScreen.SettingsPanel` | 等音频管理器做好后再接 |
| K6 | 茶宠是程序生成的 SVG，有 5 个状态 | `game/TeaPet.tsx` | 计划替换为 Rive 状态机，由 `agent.status` 驱动 |
| K7 | 两个会话曾经并行改动同一批文件 | — | 开始工作前先确认没有其他会话同时在写 |
| K8 | 桥只允许一个游戏页面接入；第二个会被拒绝 | `server/teadraw.mjs` join | 多 Agent/多座位是后续工作 |
| K9 | 助手档下 `canvas_draw(mode:'commit')` 被降级为 preview，Agent 只能等玩家盖章 | `liveAgent.ts` | `canvas_commit` 工具仅协作/托管档可用 |
| K10 | 真实链路下「重新吩咐」会取消旧任务；有草稿时仍阻塞 | `useGame.askAgent` / `liveAgent` | 45s 无图清理任务并报告失败；废弃旧任务帧 |

## 8. 待办任务（按优先级，每项都有验收标准）

### T1 真实 MCP 服务 + CLI —— ✅ 已完成（2026-10-05）
- 落地为 `server/teadraw.mjs`（零依赖，`mcp`/`bridge`/`ping` 三个子命令；stdio NDJSON MCP + 手写 WebSocket 桥 127.0.0.1:5190），协议见 `server/README.md`。
- 12 个工具：turn_get_task / canvas_get_targets / canvas_find_space / canvas_snapshot(PNG image 块) / canvas_describe / canvas_draw / canvas_commit / chat_send / guess_submit / hint_whisper / events_poll / room_state。
- `canvas_draw` 返回 `{ previewId?, opIds?, ink, removed[], stripped }`；助手档 commit 降级为 preview（K9）。
- 坐标契约落地：**帧（frame）局部坐标 0..w×0..h**，canvas_get_targets/find_space 返回帧，draw 带 targetId/spaceId。
- 浏览器侧：`mcpClient.ts`（WS 客户端）+ `liveAgent.ts`（工具处理器）+ `GameState.live` + 茶宠"真实"徽章；断线回退模拟。
- **验收已过**：`node server/test-agent.mjs` + 无头浏览器完成「连接→领任务→找空位→描红→盖章→落定」，非法 SVG 会被剥离并写活动流。
- 已知边界：K8 单页面、无鉴权（本地桥）、快照栅格化只在浏览器侧实现。

### T2 笔触渲染器（已做 v1，剩余位图缓存 + 风格房规）
- 纯显示层：数据仍然是 SVG Op，只改渲染方式——全部走 `renderEl`（`src/components/renderEl.tsx`），凡是"有可见描边且非虚线"的元素自动笔墨化：
  - `src/brush/stroke.ts`：中心线重采样（detached SVG 几何引擎，~1.8px 步长）→ 压力曲线（`envAt` 起收笔包络 + `snoise` 种子抖动；`data-pp` 属性承载人手真实笔压）→ `perfect-freehand.getStroke` 变宽轮廓 → SVG 填充路径（`path.bs`）
  - 运笔动画：`<mask>` 里放白色中线描边，沿用 `.draw` 的 dashoffset 揭幕；`data-op` 命中线另做透明克隆（elementFromPoint / pointOf 不受影响）
  - `src/game/InkWash.tsx`：画布下垫 `p5.brush/standalone` 洇散层，每笔落定后 `polygon(out.pts)` 水彩晕染；`seed(hash(op.id))` 逐笔播种；相机移动用 CSS transform 假跟随、240ms 防抖重染
  - 人手输入：lazy-brush 牵绳平滑 + `e.pressure` 存入 `data-pp`（SVG attrs 带前缀属性，经校验器自然剥离，不影响 Agent 契约）
- 人和 Agent 的笔迹走同一个渲染器 ✓；结算回放、首页画作、幽灵预览自动生效（共用 renderEl）
- **剩余**：笔墨风格房规（工笔/写意，引擎接口已留）、`.myb` 笔刷生态（reserve：reearth/hokusai Rust/WASM，libmypaint 兼容）
- **性能（v2 已落地）**：
  - 糙边不用 SVG 滤镜（`feTurbulence` 逐像素太重），改为轮廓顶点种子抖动写进几何——SVG 与位图两套渲染同一份数据
  - `src/game/InkBake.tsx`：落定 op 烘焙进 Canvas2D 位图（人/Agent 两块，供 A 键高亮滤镜），SVG 只留透明命中线（`renderEl` 的 `hitOnly`）→ DOM 不随对局膨胀
  - `sampleCenterline` 快路径：`M..Q..L` path 与 `points` 属性直接解析，免 DOM `getPointAtLength`
  - `OpNode` memo：draft 拖动不再整树重渲全部笔迹
  - InkWash/InkBake 平移缩放都用 CSS transform 假跟随 + 240ms 防抖重烘焙，避免每帧重算水彩/位图
- **验收已过**：手画线与 Agent 素材同渲染、mask 揭幕逐笔、洇散底衬可见；tsc/build 通过，笔迹层独立 chunk（78KB 按需加载）
- **2026-10-06 性能与墨晕对齐修复**：轮廓以不可变 `SvgEl` + seed 的 WeakMap 缓存，元素/轮廓的 Path2D 复用，超过 900 笔不再全清；1200 笔本机重复查找约 0.6–0.7ms（Node CPU 基准，不代表浏览器帧率）。InkBake/InkWash 只在 ops/相机/隐藏座位变化时同步，待落定动画每笔只登记一个计时器，相机/尺寸重建保留原截止时间；位图上报与水彩 render 每帧合并一次。
- `p5.brush/standalone` 默认以画布中心为原点；墨晕抵消半幅原点后再应用 `(world-cam)*zoom`，stageScale 只影响像素密度，修复右下墨印偏移。回归：`tools/brush-parser-test.mjs`、`tools/brush-cache-test.mjs`、`tools/ink-layers-test.mjs`、`tools/ink-layers-visual-test.mjs`。

### T3 联网（Host 权威）
- 大厅/对局/结算由 App 的 `useNetRoom` 常驻会话连接，UI 卸载只取消订阅；`netSync` 区分 session/game 通道，gameId 隔离新局，round 校验旧轮，`game-ready→hello→snapshot` 处理切屏期间补水。
- 茶绘与猜词已接大厅完整玩法/房规/座位同步，Host 统一校验人/Agent 操作并保留 author/笔速动画。传话联机明确禁用，真实 Steam 双账号仍需验收。
- 桥断 socket 保留身份 30 秒，主动 leave 立即离房；Host 按 room+gameId 同步保存 sessionStorage 核心状态供刷新恢复，peer 向 Host 请求快照。断线显示错误并阻止本地分裂，不静默回退单机。
- 验证入口：`node server/test-net-lifecycle.mjs`、`node server/test-net-client.mjs`、`node tools/net-lobby-e2e.mjs`；后一项从真实首页菜单开始，覆盖人/Agent双向绘图、刷新、猜词轮换、结算与再开，输出 `test-output/net-regression/`（忽略提交）。
- 联机流量：连接层不抢先 hello；同一请求只定向补一次游戏快照，名单不变不重复广播 roster，大厅状态不携带整份结算画布。结算结果广播一次，迟到/刷新玩家定向补结果；同次广播只编码/分片一次，个别玩家发送失败不阻断其他玩家。`server/test-net-traffic.mjs` 与 `tools/net-traffic-test.mjs` 验证次数、字节和结算恢复。
- Op 广播格式：`{t:'ops',gameId,round,ops:Op[]}`，删除为 `{t:'op-del',gameId,ids}`。Host 编号、校验、计算墨量及 Agent 动画后广播，详见 `design.net.md`。
- 中途加入：`hello → seat-assign/roster/snapshot` 注水后继续接收增量；尚无独立持久化增量日志或 Host 迁移。
- 网络层复用团队已有的 Steam P2P（SpaceWar）组件。
- `simulation.ts` 只保留为离线模式和测试用。
- **当前验收**：本地 Mock 生命周期 6 项、TS 客户端协议 7 项、完整菜单双浏览器 36 项，共 49 项通过（2026-10-06），含人/Agent 双向同步、SVG 篡改、猜词者绘图拒绝、双方刷新、猜词轮换、结算、再开及真实 Agent 身份保持。茶宠常驻会话另有 31 项状态/隔离回归和 28 项主菜单 MCP 回归；Sol 真实模型已完成主菜单茶壶试画。传话联机与真实 Steam 双账号仍为待验收范围。

### T4 音频
- 新建 `AudioManager`，分 music / sfx / ambient 三条通道，音量接到设置面板。
- 人的笔声和 Agent 的笔声要用不同音色；配乐按游戏状态切换强度。
- **验收**：每一种交互（按钮、落笔、盖章、准备、回合开始、猜中）都有声音；设置里的音量滑块真实生效。

### T5 样式收拢与去网页化
- 把 `app.css` 中已经被覆盖的 v1 页面样式（`.page`、`.home-*`、`.lobby-grid`、`.page-head` 等）删除；组件样式按目录拆分。
- 用游戏控件（`.gbtn`、`.g-tabs`、`.g-toggle`、令牌）替换 `Segmented`。
- **验收**：四个屏幕的截图和改动前一致或更好；CSS 总量下降；不再出现裸 z-index。

### T6 打包
- 用 Electron 或 Tauri 加 steamworks 封装；默认全屏，支持 Steam Deck 的 1280×800（舞台会自动缩放）。
- **验收**：可以产出 Windows 安装包，启动后直接进入标题页。

## 9. 修改代码的工作流

1. 先读 `gameTypes.ts`、`useGame.ts` 和你要改的组件。改契约时同步更新本文 §5。
2. 改完后：先跑 `tsc --noEmit`，再跑 `vite build`；然后启动 dev server，用 `tools/shot.mjs` 截图，并**亲自看截图**。
3. 涉及指针交互的改动，用 `{drag}` 步骤配合 `{js}` 读取最后一个 `[data-op]` 的 `getBoundingClientRect`，确认笔迹落点和鼠标位置一致（缩放后容易出错）。
4. 不加注释、不删已有注释；保持紧凑；不引入新依赖，确实需要时要发布满 7 天以上的版本，并且先问用户。
5. 不要提交、不要推送，除非用户明确要求。

## 10. 待用户决策（不要擅自决定）

美术基调、是否约稿、是否可以采购付费素材、笔墨风格是否做成房规玩法、是否支持 Steam Deck 和手柄、选 Electron 还是 Tauri、`allowBuilds.esbuild` 的取值。详见 `design.md` §10。
