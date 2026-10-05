# 茶绘 TeaDraw（UI demo）

> 交接文档：先读 `design.agent.md`（不变量 / 契约 / 待办与验收）；人类阅读版为 `design.md`；素材获取与布置见 `ASSETS.md`。

Vite + React 19 + TypeScript，前端 demo，其他玩家行为本地模拟；**真实 Agent 已可经 `server/` 的 MCP 桥接入**（断线回退模拟）。

## 命令
- 开发：`node node_modules/vite/bin/vite.js --port 5180`（`pnpm dev` 会先触发 install，并因 esbuild 构建脚本未批准报 `ERR_PNPM_IGNORED_BUILDS`；需要用户自行执行 `pnpm approve-builds` 后才能用 pnpm 脚本）
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`
- 构建：`node node_modules/vite/bin/vite.js build`
- 截图/交互回归：`node tools/shot.mjs <steps.json> [outDir]`（无头 Chrome + CDP，步骤格式见脚本头部注释；dev server 需已启动；窗口尺寸用环境变量 `SHOT_SIZE=1920x1080`，此时舞台缩放为 1，步骤坐标即舞台坐标）
- 真实 Agent 桥：`node server/teadraw.mjs mcp`（零依赖，MCP stdio + WS 桥 127.0.0.1:5190；`bridge` 只开桥、`ping` 测活；浏览器端用 `?mcp=<port>` 换端口）
- Agent 端到端自测：`node server/test-agent.mjs`（需 dev server + 对局页已开；脚本化 MCP 客户端走全流程）

## Demo 深链
`?screen=home|lobby|game|result&mode=tea|relay|guess&role=drawer|guesser`；`?resume=1` 恢复误刷新前的画布与比分；`?mcp=<port>` 换桥端口

## UI 骨架（src/ui）
- 舞台固定 1920×1080，整体缩放；鼠标 client 坐标一律用 `ui/stage.ts` 的 `toStage` / `stageScale` 换算
- 层级（z）：bg 0 · world 10 · frame 50 · hud 100 · panel 200 · popover 300 · modal 400 · toast 500 · transition 600 · debug 700
  - 屏幕内用 `.scr > .l-bg / .l-world / .l-frame / .l-hud / .l-panel`
  - 舞台级用 `<Portal layer="popover|modal|toast|transition|debug">`；不要再在组件里写裸 z-index
- HUD 用 `.anchor.a-tl/tc/tr/ml/mr/bl/bc/br`，边距 `--safe`（对局屏为 40px，避开木框）
- Esc 返回走 `useBack`（栈式，最上层优先）；屏幕快捷键用 `useHotkeys`；按键提示用 `<Key k="Enter" />`
- 换屏统一走 App 的 `go()`，自带卷帘转场
- 注意：`.layer` 是侧栏"图层"行的类名，舞台层用 `.stage-layer`

## 目录约定
- `src/core/`：领域类型、主题令牌、几何、SVG 白名单校验器（Host 侧，所有 Agent SVG 必经）
- `src/mock/`：模拟数据；`drawings.ts` 为“Agent 产出”的 SVG 素材（200×200 盒子）
- `src/game/`：`useGame.ts`（全部状态与动作，契约见 `gameTypes.ts`）、`targeting.ts`（落笔指引：`DrawTarget`/`TargetMark`、手势分类、目标矩形、占用网格、路径槽位，纯函数）、`simulation.ts`（远端玩家/Agent 脚本）、`liveAgent.ts`（真实 Agent 的 12 个工具处理器，帧局部坐标契约）、`mcpClient.ts`（WS 客户端 + `GameState.live`）、`engine.ts`（Op 批次与笔速动画）、`TeaPet.tsx`（茶宠 SVG + 墨囊）、其余为对局 UI 组件
- `src/screens/`：主菜单 / 大厅 / 对局 / 结算
- `server/`：`teadraw.mjs`（MCP stdio + WS 桥）、`test-agent.mjs`（自测客户端）、`README.md`（协议：Agent 永远画在 frame 的局部坐标 0..w×0..h）
- 样式：`src/styles/app.css` 为 v1 基础，`src/styles/game.css`（被 app.css `@import`）为游戏化皮肤（固定画幅/木桌/茶宠/指引标记/燃香/灯笼/纸条气泡），设计令牌在 `:root`

## 游戏化与落笔指引
- 固定画幅 1920×1080（`STAGE` in `core/geometry.ts`），App 顶层 `.stage` 整体缩放 + letterbox；相机默认目标不是满屏，用视口扣除侧栏后的可用区计算
- 指引笔（快捷键 V）：手势自动判定——点＝令旗、拖＝区域、圈＝套索、线＝引路、点中已有笔迹＝锚定轮盘；数字键 1-6 切显式模式（auto/pin/box/lasso/path/anchor）；Q 弹九宫格；Esc 清空标记（ghost 存在时优先揉掉草稿）
- 标记最多 3 处；`targetRect` 把每种 `DrawTarget` 折算成落笔矩形；`fitContent` 按房规 `targetFit`（contain/clip/strict）做适配；`avoidOthers` 用占用网格 `nudgeFree` 微挪避让
- 把底部茶宠拖到画布上 = 插令旗（`pet-col` pointerdown → window 派发 `tea:drop-pet` CustomEvent，Canvas 监听转世界坐标）
- 幽灵预览为多 transform（每个 op 自带 tf），ghost-box 覆盖总包围盒，四角 HTML 手柄等比缩放，盖章 = `lastStamp` 触发 `.seal-stamp` 动画
- 房规新增：`targetsPublic`（他人 Agent 思考时公开其落笔标记）、`targetFit`、`avoidOthers`（默认开）；`useGame` 的 `showMark/hideMark` 已接进 `simulation.ts` 的 `SimCtx`
- 快捷键沿用：P/L/R/O/E/H 工具、Ctrl+Z/Y 撤销重做、滚轮缩放、空格平移、Ctrl+K 聚焦吩咐、Tab 盖章、Esc 拒绝/清空

## 视觉约定
- 人与 Agent 的视觉区分：人＝实心（箭头光标、实色笔迹条），Agent＝虚线空心菱形（`AgentGlyph`、斜纹墨量）＋茶宠形象（`TeaPet`，idle 打盹 / thinking 冒茶烟 / review 举草稿 / drawing 抱笔跑）
- 游戏化材质：朱砂 `--seal`（确认/印章/指引）、木 `--wood*`（笔架/桌框）、`--font-disp`（Ma Shan Zheng 标题）、`--font-hand`（手写体，气泡/输入框/toast）；画布核心区域保持干净，装饰只放边框
