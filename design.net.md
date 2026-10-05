# design.net.md — 茶绘联机（T3）设计与交接

> 配套：`design.agent.md`（总架构/不变量）· `server/README.md`（MCP 协议）
> 本文档记录多人联机的协议与实现路径。状态：**P2 茶绘最小闭环进行中**。

## 0. 架构总览

```
┌──────────┐  vite :5180   ┌──────────┐  ws /bridge?token  ┌────────────┐
│ 浏览器 A │◄──────────────│ netClient│◄───────────────────│ bridge A   │
│ (useGame)│               │  (TS)    │                    │ teadraw-net│
└──────────┘               └──────────┘                    └─────┬──────┘
     ▲ Host 权威                                             transport
     │                                                 mock-hub / Steam P2P
┌──────────┐  vite :5180   ┌──────────┐  ws /bridge?token  ┌─────┴──────┐
│ 浏览器 B │◄──────────────│ netClient│◄───────────────────│ bridge B   │
│ (useGame)│               │  (TS)    │                    │ teadraw-net│
└──────────┘               └──────────┘                    └────────────┘
```

- **每玩家一桥**：浏览器 ↔ 本机 Node 桥 ↔ 房间（mock-hub 或 Steam lobby）
- **星型拓扑**：成员消息只能发 hostId，host 广播全员（transport 层强制 `INVALID_DIRECTION`）
- **Host 权威**：host 的 useGame 是唯一状态源；peer 的一切动作是「意图上行」→ host 校验 → 广播 → 全员（含发起方）按广播落账。本地不回显。

## 1. 文件清单

| 文件 | 角色 |
|---|---|
| `server/net/protocol.cjs` | 包封 `{version, project, room, data}`，768KB 上限 |
| `server/net/bridge.cjs` | HTTP+WS 桥；ops `create/join/leave/send`；事件 `state/packet/members/closed/fault`；token 鉴权；**已打补丁：放行任意 loopback origin**（vite :5180 可连） |
| `server/net/mock-transport.cjs` | 连 mock-hub 的传输（开发/测试用） |
| `server/net/mock-hub.cjs` | 本地房间中枢 :19780；**已打补丁：房间上限 2→8** |
| `server/net/steam-transport.cjs` | 真 Steam lobby/P2P（steamworks.js）；**已打补丁：lobby 上限 2→8** |
| `server/teadraw-net.mjs` | CLI：`hub` / `net` / `ping`；net 打印 `?net=<port>&token=<tok>` 深链 |
| `server/test-net.mjs` | 双桥冒烟（create/join/收发/星型限制） |
| `src/game/netClient.ts` | 浏览器 WS 客户端（bridge-client.js 的 TS 移植） |
| `src/game/netSync.ts` | 房间协议层：意图上行 + 广播下行 + 座位表 + 快照 |

## 2. 命令速查

```powershell
node server/teadraw-net.mjs hub                          # 本地中枢（开发时先起）
node server/teadraw-net.mjs net --transport mock          # 玩家桥，打印联机深链
node server/teadraw-net.mjs net --transport mock --port 5192   # 同机第二玩家
node server/teadraw-net.mjs ping --port 5191              # 测活
node server/test-net.mjs <tokA> <tokB>                    # 双桥冒烟
# 浏览器: http://localhost:5180/?net=<port>&token=<tok>  （桥启动时打印完整深链）
```

## 3. 房间协议（bridge data 载荷，全部 JSON）

### 3.1 成员 → host（意图）

| t | 载荷 | host 校验 |
|---|---|---|
| `hello` | `{name}` | 分配 seat/颜色 → `seat-assign` + `roster` |
| `op` | `{el:SvgEl, tf:Transform}` | svgPolicy + 墨量 + 帧内 → 广播 `ops` |
| `op-erase` | `{id}` | op.seat === 发者 seat → 广播 `op-del` |
| `mark` | `{mark:TargetMark}` | targetsPublic → 广播 `mark` |
| `mark-del` | `{id}` | 广播 `mark-del` |
| `chat` | `{text}` | 盖章 seat/author → 广播 `chat` |
| `guess` | `{text}` | judgeGuess → `chat` + `guess-result` |
| `pick-word` | `{word}` | 属本轮 drawerSeat 且在 wordOptions → 广播 `round-start` |
| `relay-done` | `{}` | 计数 → `relay-progress` |

### 3.2 host → 成员（广播，除非注明定向）

| t | 载荷 | 说明 |
|---|---|---|
| `seat-assign` | `{seat, color}` | 定向：告诉新员自己的座位 |
| `roster` | `{seats:[{id,name,color,score,online}]}` | 座位表 |
| `snapshot` | `{ops, marks, round, drawerSeat, hint, scores, relayDone, relayTitle, theme, endsAt}` | 定向：进房注水 |
| `ops` | `{ops:Op[]}` | 落账笔迹（id 由 host 编） |
| `op-del` | `{ids:string[]}` | |
| `mark` / `mark-del` | | 公开指引标记 → foreignMarks |
| `chat` | `{msg}` | seat/author 已盖章，防冒充 |
| `round-start` | `{round, drawerSeat, hintLen, endsAt}` | 全量重置新一轮；词不随广播 |
| `word-offer` | `{options}` | 定向：host→本轮画手发词卡 |
| `round-live` | `{hintLen, endsAt}` | 画手已选词，计时开走（不清场） |
| `round-over` | `{answer, isLast, scores}` | |
| `guess-result` | `{seat, verdict}` | 单条猜词判定（chat 同步发） |
| `tick` | `{left}` | host 每 5s 纠偏倒计时 |
| `scores` | `{map:[[seat,score]…]}` | 比分表 |
| `session-over` | `{result:SessionResult}` | 全员进结算屏 |
| `relay-progress` | `{done, total}` | |
| `session-over` | `{result:SessionResult}` | 全员进结算屏 |
| `pen` | `{key, seat, pos}` | 远端光标（12Hz 节流） |

## 4. useGame 接入点

- `UseGameOptions.net?: NetLink`：`{role:'host'|'peer', send(to,msg), onEvent}`；`undefined` = 单机现状
- 分流点：`draw→op` / `erase→op-erase` / `sendChat→chat` / `addMark→mark` / `pickWord→pick-word` / `submitGuess→guess` / `submitRelay→relay-done`
- host：意图处理器调原函数（校验在函数内已完成）+ `net.broadcast`；peer：只发意图，handler 按广播落 `setOps/setChat/setSeats` 等
- **墨量/op id**：host 侧 Op.id 统一编发（`op-<seq>`），peer 不带 id 上行
- 计时：`endsAt` 时间戳下发，本地算 timeLeft；host 每 5s `tick` 纠偏
- sim：host 只给「未认领座位」跑剧本（botSeats），P4 做

## 5. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | server/net vendored + 3 补丁 + teadraw-net.mjs | `test-net.mjs` 双桥冒烟 ✓ 已过 |
| P1 | netClient.ts + netSync.ts + `?net=&token=&room=&name=` 深链 + TopBar 徽章 | ✓ 已过 |
| P2 | 茶绘 ops+chat+roster 最小闭环 | `tools/net-e2e.mjs` 双页全绿（ops 双向、chat 双向、roster、sim 自动关闭）✓ 已过 |
| P3 | 大厅：创建/加入真生效、room code=真实码、App 持有 NetLink + sessionStorage 重连 | 大厅两页见同房间 |
| P4a | **最低可玩闭环（MVP）**：guess 双端对局——动态角色（drawerSeat 驱动 readOnly/role）、word-offer 定向词卡、pick-word/round-live/round-over/scores/tick/guess-result 广播、轮换画手、session-over 同步结算、netResult→结算屏 | `tools/net-guess-e2e.mjs` 18/18 全绿 ✓ 已过 |
| P4b | 剩余全量：pens 12Hz、relay 进度同步、botSeats 空座填充 | relay/多端对局 |
| P5 | 真 Steam：`--transport steam --appid 480` 双账号 | 双账号同房间作画 |
| P6 | README 联机节 + design.agent.md + AGENTS.md | |

## 6. 已知边界

- mock-hub 房间 host 离开 → 房间解散（`closed{HOST_LEFT}`），无 host 迁移；真 Steam lobby 同理
- **联机时本地模拟自动关闭**（各端各跑 sim 会分裂画面）；bot 填充座位是 P4 的活
- P2+P4a 已做茶绘/你画我猜：relay 模式下 net 不接入（deep-link 也不生效），等 P4b 全量协议
- 联机时 `readOnly`/`role` 不再来自 URL `?role=` prop，而是按 `drawerSeat` 动态推导（host 首轮恒为画手，成员座位 ≥2）
- 规则（rules）不同步（P3 大厅同步时带上）；peer 的悄悄提示（whisper）联机下禁用；member 离开即房间解散方向不变
- 单机演示路径完全不受影响：`?net` 缺省 = 现有本地模拟
- steamworks.js 需真 Steam 环境时才装（server 端 `npm i steamworks.js`，native binding）
- 房间码：mock=数字（`1001`），steam=15-21 位 lobby id → TopBar 直接显示真实码
