# teadraw · 真实 Agent 接入（T1）

让真实的 AI Agent 通过 **MCP（stdio）** 连接茶绘，在主菜单“我的茶宠”试画纸或正式对局中作画。
零依赖：`teadraw.mjs` 只用 Node 内置模块（Node ≥ 20 即可）。

```
Agent CLI ── stdio NDJSON(MCP JSON-RPC) ──▶ node server/teadraw.mjs mcp ──▶ WebSocket ──▶ App AgentSession
                                               （WS 服务，默认 127.0.0.1:5190）
```

`teadraw mcp` 一个进程同时是：
- **MCP server**：标准输入输出上的换行分隔 JSON-RPC（initialize / tools/list / tools/call / ping / notifications）
- **房间桥**：WebSocket 服务，浏览器连进来执行真实的工具调用

桥已启动只表示 `ready`；MCP 客户端 `initialize` 后才是 `awake`，主菜单允许派发真实试画任务。名称和模型来自桥的配置，不推断模型正在运行。App 保持一条 WebSocket，切换页面只绑定或释放画布，退出对局不会断开 AI。

## 启动

```bash
# 1. 前端（照常）
node node_modules/vite/bin/vite.js --port 5180

# 2. 由 Agent 的 MCP 客户端托管启动，或手动跑
node server/teadraw.mjs mcp --port 5190 --room A7K2 --name Claude --model sonnet

# 3. 浏览器打开 http://localhost:5180/?screen=home （?mcp=5191 可换端口）
#    在“我的茶宠”查看连接状态并派发试画；进入对局继续使用同一连接
```

端到端自测（不需要浏览器输入）：`node server/test-agent.mjs`
会自己拉起 bridge、走完 initialize → tools/list → canvas_get_targets → canvas_find_space → canvas_draw(preview) → events_poll 全流程并打印回执。

## 坐标契约（对 Agent 最重要的一条）

**Agent 永远不写世界坐标。** 一切落笔位置都用「帧」表示：

```json
{ "id": "m-xxx", "frame": { "x": -120, "y": -80, "w": 320, "h": 200 } }
```

- `frame` 是 Host 的世界坐标矩形；Agent 的 SVG 画在**以 frame 左上角为原点的局部坐标** `0..w × 0..h` 里。
- `canvas_draw` 带上 `targetId`（或 `spaceId`），Host 按 1:1 把局部坐标映射回世界；
  内容超出 frame 时按越界策略处理（contain 缩小放入 / clip 允许越界 / strict 拒绝）。
- `repeat: true` 时 Host 把同一份 SVG 落到该目标的每个槽位（引路目标的沿线槽位）。
- 没有标记时可以 `canvas_find_space` 申请一块空白帧，用返回的 `spaceId` 落笔。
- 帧 ID 由当前环境、轮次和任务代次隔离；切屏、取消任务、完成任务后旧 ID 失效。不得缓存给下一次试画使用。

## 常驻连接与任务隔离

`room_state` 返回 `context:'idle'|'sandbox'|'game'`。idle 时 `turn_get_task` 返回 null，绘画工具返回 `no_canvas`；进入“我的茶宠”后绑定独立试画纸，进入正式对局后改绑对局画布，两个环境的 Op 不混用。

`turn_get_task` 的 `task` 包含 `taskId`、`contextId`、`profilePrompt`、任务原文、房规与墨量；风格提示和 `rules.preservePosition` 在派发时冻结。提交时传回 `taskId/contextId`。旧客户端可用本次 `canvas_get_targets/canvas_find_space` 返回的帧 ID 作画；未带任务标识且未指定当前帧的落笔会被拒绝，避免迟到作品落到新画布。`preservePosition=true` 时，引用显式帧且内容完全处于帧局部范围会保留 Agent 的原有留白；溢出仍按既有适配/拒绝流程处理，默认客户端沿用居中适配。

任务事件 `task_status` 包含 `{taskId,contextId,text,stage,at,detail?,previewId?,opIds?,ink?}`。阶段为 queued、claimed、preview、drawing、completed、cancelled、failed。提交因 SVG、墨量或几何被拒绝时会返回明确错误，并以 claimed/detail 回执允许修稿；45 秒未返回有效画作或未取得 Host 落笔确认会取消任务并报告失败。玩家审稿期间不计生成超时。新任务、断开连接或切换环境会清理旧任务、空位缓存和待审草稿。

## MCP 工具表

| 工具 | 参数 → 返回 | 说明 |
|---|---|---|
| `turn_get_task` | → `{ task }` 或 `{ task: null }` | 玩家当前指派的任务（指令原文、模式、轮次、墨量余额、房规）。画手 Agent 可见所选词；猜词方 Agent 永远拿不到答案 |
| `canvas_get_targets` | → `{ targets }` | 玩家插的指引标记：`{id, kind, frame, slots?}`（path 展开为槽位，anchor 已换算成矩形） |
| `canvas_find_space` | `{w, h, near?}` → `{space:{id, frame}}` | 在占用网格上找空白帧，60 秒内有效 |
| `canvas_snapshot` | `{targetId?}` → `image/png`（MCP image 块） | 指定帧（默认当前视口）的光栅图。猜词方同样只有光栅图 |
| `canvas_describe` | `{targetId?}` → `{elements}` | 区域内笔迹的 id/作者/包围盒/标签。你画我猜里**不返回 label**（防借路径递答案） |
| `canvas_draw` | `{svg, taskId?, contextId?, targetId?|spaceId?, repeat?, fit?, mode?}` → `{previewId?, opIds?, ink, removed[], stripped}` | 提交 SVG（白名单见下）。无帧提交必须带本次任务标识；`mode:'preview'` 出描红草稿；`'commit'` 直接落笔。「助手」档下 commit 会被降级为 preview |
| `canvas_commit` | `{previewId}` → `{opIds}` | 协作/托管档下，Agent 自己把待审草稿落定。助手档返回错误（只能等玩家盖章） |
| `chat_send` | `{text}` | 以 Agent 身份发言（座位色气泡） |
| `guess_submit` | `{text}` → `{result, pts?}` | 猜词方 Agent 提交猜测；通过 Agent 猜中得分 ×0.5 |
| `hint_whisper` | → `{text}` | 猜词方 Agent 给玩家递一条悄悄提示（每轮一次） |
| `events_poll` | `{since?}` → `{events:[{seq,type,data}]}` | 增量事件：`task` 新任务、`preview` 草稿被盖章/揉掉、`round`、`chat` |
| `room_state` | → `{room, mode, seats, rules, me}` | 房间信息、座位表、房规、我绑定的座位 |

## 对局侧限制（Host 强制执行，Agent 无法绕过）

- SVG 白名单：仅 `path line polyline polygon rect circle ellipse` + `<g>`；剥离 `id/class/name/aria-label`；拒绝 text/image/use/script/filter 等；数值保留 1 位小数
- 墨量配额：Agent 累计墨量 ≤ 座位总墨量 × `inkRatio`（默认 50%），超额拒绝并给出剩余额度
- 越界策略：`rules.targetFit`（contain/clip/strict）
- 最多 3 个指引标记；只能擦自己座位的笔迹（Agent 端无擦除工具）

## 事件流（agent 端 `notifications/message`）

游戏侧事件通过 MCP `notifications/message` 主动推送（`data` 字段同 events_poll 的事件），轮询和推送二选一即可。

## 浏览器 ↔ 桥 内部协议（NDJSON over WebSocket）

| 方向 | 消息 |
|---|---|
| game→bridge | `{t:'join', role:'game', room, seat, me}` |
| game→bridge | `{t:'context', context, contextId, room, seat}` 切屏改绑，不关闭 WS |
| agent 端 | 进程即 Agent 端点；`initialize` 后桥广播 `{t:'peer', state:'awake', name, model}` 给 game |
| bridge→game | `{t:'call', id, name, args}`（转发 tools/call，30s 超时） |
| game→bridge | `{t:'result', id, ok, data?, error?}`、`{t:'event', ev}`（进事件环 + 推给 MCP 通知） |
| bridge→game | `{t:'peer', state:'down'}` 于 MCP 进程退出/WS 断开时 |

## 文件

- `server/teadraw.mjs` — CLI + MCP stdio + 手写 WS 服务（含 `mcp` / `bridge` / `ping` 三个子命令）
- `server/test-agent.mjs` — 脚本化 MCP 客户端，端到端自测
- `src/game/mcpClient.ts` — 浏览器侧 WS 客户端（断线自动重连）
- `src/game/liveAgent.ts` — 工具处理器，把调用接到 useGame 的状态与动作上
- `src/agent/AgentSession.tsx` — App 常驻连接、环境绑定与空闲状态处理
