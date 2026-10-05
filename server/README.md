# teadraw · 真实 Agent 接入（T1）

让真实的 AI Agent 通过 **MCP（stdio）** 连进对局，代替本地模拟的 Agent 行为。
零依赖：`teadraw.mjs` 只用 Node 内置模块（Node ≥ 20 即可）。

```
Agent CLI ── stdio NDJSON(MCP JSON-RPC) ──▶ node server/teadraw.mjs mcp ──▶ WebSocket ──▶ 浏览器 useGame
                                               （WS 服务，默认 127.0.0.1:5190）
```

`teadraw mcp` 一个进程同时是：
- **MCP server**：标准输入输出上的换行分隔 JSON-RPC（initialize / tools/list / tools/call / ping / notifications）
- **房间桥**：WebSocket 服务，浏览器连进来执行真实的工具调用

进程活着 = 茶宠已唤醒；进程退出 = 茶宠离线，浏览器自动回退到本地模拟。

## 启动

```bash
# 1. 前端（照常）
node node_modules/vite/bin/vite.js --port 5180

# 2. 由 Agent 的 MCP 客户端托管启动，或手动跑
node server/teadraw.mjs mcp --port 5190 --room A7K2 --name Claude --model sonnet

# 3. 浏览器打开 http://localhost:5180/?screen=game （?mcp=5191 可换端口）
#    底部茶宠徽章显示「真实连接」即接入成功；活动流里的工具名变成真实调用
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

## MCP 工具表

| 工具 | 参数 → 返回 | 说明 |
|---|---|---|
| `turn_get_task` | → `{ task }` 或 `{ task: null }` | 玩家当前指派的任务（指令原文、模式、轮次、墨量余额、房规）。画手 Agent 可见所选词；猜词方 Agent 永远拿不到答案 |
| `canvas_get_targets` | → `{ targets }` | 玩家插的指引标记：`{id, kind, frame, slots?}`（path 展开为槽位，anchor 已换算成矩形） |
| `canvas_find_space` | `{w, h, near?}` → `{space:{id, frame}}` | 在占用网格上找空白帧，60 秒内有效 |
| `canvas_snapshot` | `{targetId?}` → `image/png`（MCP image 块） | 指定帧（默认当前视口）的光栅图。猜词方同样只有光栅图 |
| `canvas_describe` | `{targetId?}` → `{elements}` | 区域内笔迹的 id/作者/包围盒/标签。你画我猜里**不返回 label**（防借路径递答案） |
| `canvas_draw` | `{svg, targetId?|spaceId?, repeat?, fit?, mode?}` → `{previewId?, opIds?, ink, removed[], stripped}` | 提交 SVG（白名单见下）。`mode:'preview'` 出描红草稿；`'commit'` 直接落笔。「助手」档下 commit 会被降级为 preview |
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
| agent 端 | 进程即 Agent 端点；`initialize` 后桥广播 `{t:'peer', state:'awake', name, model}` 给 game |
| bridge→game | `{t:'call', id, name, args}`（转发 tools/call，30s 超时） |
| game→bridge | `{t:'result', id, ok, data?, error?}`、`{t:'event', ev}`（进事件环 + 推给 MCP 通知） |
| bridge→game | `{t:'peer', state:'down'}` 于 MCP 进程退出/WS 断开时 |

## 文件

- `server/teadraw.mjs` — CLI + MCP stdio + 手写 WS 服务（含 `mcp` / `bridge` / `ping` 三个子命令）
- `server/test-agent.mjs` — 脚本化 MCP 客户端，端到端自测
- `src/game/mcpClient.ts` — 浏览器侧 WS 客户端（断线自动重连）
- `src/game/liveAgent.ts` — 工具处理器，把调用接到 useGame 的状态与动作上
