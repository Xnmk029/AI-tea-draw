# TeaDraw · design.agent.md（Agent 审阅版）

> 读者：接手开发的 AI Agent。人类阅读版是 `design.md`。
> 状态快照：v0.3 UI demo，2026-10-05。代码是事实来源；本文与代码冲突时**以代码为准，并更新本文**。
> 语言：与用户对话用中文；代码注释保持现有风格（简短中文，按需）。

---

## 0. TL;DR

- 前端 demo：Vite 6 + React 19 + TypeScript strict。其他玩家和 Agent 由 `src/game/simulation.ts` 模拟。
- **真实 Agent 已可接入（T1 完成）**：`node server/teadraw.mjs mcp` = MCP stdio 服务 + WebSocket 桥（127.0.0.1:5190，零依赖），浏览器经 `src/game/mcpClient.ts` + `src/game/liveAgent.ts` 把"我的 Agent"交给真实 MCP 客户端；桥不在时自动回退本地模拟。协议与坐标契约见 `server/README.md`。
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
    engine.ts          buildBatch / mergeBatches / animateOps / makePen / uid
    targeting.ts       落笔指引：DrawTarget、手势分类、fitContent、锚定、占用网格、findSpace
    Canvas.tsx         SVG 画布、指针输入、rAF 驱动的远端光标、草稿与标记渲染
    TopBar / ToolDock / AgentBar(GuessBar) / SidePanel / Overlays / TeaPet
  screens/             Home / Lobby / Game / Result（固定构图、键盘导航）
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
- 换屏统一走 `App.go(screen)`：卷帘落下 420ms → 换屏 → 收起 520ms。转场期间 `busy` 锁住，重复调用会被忽略。
- Esc：`useBack(fn, active)` 是一个栈，最后注册的先响应；焦点在输入框时，Esc 只让输入框失焦。对局里的 Esc（拒绝草稿、清除标记）由 `useGame` 处理，**对局屏不注册 useBack**。
- 屏幕快捷键用 `useHotkeys(map)`，输入框内和带 Ctrl/Meta/Alt 时不触发。按键提示用 `<Key k="Enter" />`。

## 5. 对局数据流

```
玩家指针 ──Canvas.onDown/Move/Up──▶ finalize() → g.draw(el) ──▶ ops[]（human，静态）
玩家指引 ──Canvas(tool='guide')──▶ classifyStroke → g.addMark(DrawTarget) → marks[]（≤ MAX_MARKS=3）
玩家指令 ──AgentBar──▶ g.askAgent(text)
   ├ 真实链路（live.state = ready|awake）：liveRef.pushTask(text)
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

## 5.1 局流程（多轮、恢复、结算载荷）

- **轮次**：`round`/`roundsTotal` 在 `useGame`；guess 模式 rounds=rules.rounds。`nextRound()` 清场（ops/ghost/标记/词/计时/whisper/猜中集）、抽新词（画手抽 3 张、猜词换题）、`simRoundStart(ctx, r)` 重启模拟：猜词视角换画手（轮换 seats）、重挂猜词剧本（`armGuessScript`，旧轮 timer 用 `getRound()!==myRound` 防串轮）。画手视角的猜词队列用 `queueRound` 检测换轮重建。**注意**：所有 `ctx.later` 循环必须「isOver 只跳过本轮逻辑、不能 return 自杀」，否则第 2 轮起模拟就死了。
- **词库**：`wordPool(rules)` = `GUESS_WORDS`(10 内置) + `rules.wordBank`（大厅「茶单·回合」可编辑自定义词，顿号/逗号分隔）；`pickOptions`/`pickTarget` 随机抽且排除 `usedWords`；`whisperFor(w)` 按题目生成悄悄提示。
- **主题**：`rules.theme`（茶单·回合可改）→ TopBar 主题、任务文案、结算标题；空则用 `TEA_THEME`。
- **避让**：`rules.avoidOthers !== false`（默认开，茶单有开关）控制 `occOverlap→nudgeFree` 微挪，sim 与 liveAgent 两条链路共用。
- **结算载荷**：`g.collectResult(): SessionResult`（seats/ops/inkStats/guessStats/rounds/theme/durationMs）→ `GameScreen.finish` → `App.lastResult` → `ResultScreen`。**无 result 时结算屏回退演示数据**（深链直达仍可用）。回放用 `OpsView`（真实 op 渲染，复用 `.draw` CSS）；导出 SVG/PNG 是真实下载。
- **持久化**：ops/比分/轮次自动存 `localStorage['teadraw:save:{mode}:{role}']`（800ms 防抖）；`?resume=1` 恢复并提示。
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
| K10 | 真实链路下「重新吩咐」会覆盖未消费的任务；有草稿时仍阻塞 | `useGame.askAgent` | 45s 无响应会自动把状态灯拨回 idle |

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

### T3 联网（Host 权威）
- Op 广播格式：`{ op:'add'|'remove', id, seat, author, layer, el, tf, ink, t }`。由 Host 统一排序、校验、扣墨量，然后广播。
- 中途加入：先下发快照，再补增量日志。
- 网络层复用团队已有的 Steam P2P（SpaceWar）组件。
- `simulation.ts` 只保留为离线模式和测试用。
- **验收**：两个客户端完成三种玩法，画面一致；在客户端篡改 SVG 会被 Host 拒绝。

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
