# design.net.md — 茶绘联机（T3）设计与交接

> 配套：`design.agent.md`（总架构/不变量）· `server/README.md`（MCP 协议）
> 本文档记录多人联机的协议与实现路径。状态：**2026-10-06 已修复大厅开局、常驻会话、Host 校验与刷新恢复；茶绘/猜词支持联机，传话及真实 Steam 双账号验收待完成**。

## 0. 架构总览

```
┌──────────┐  vite :5180   ┌──────────┐  ws /bridge?token  ┌────────────┐
│ 浏览器 A │◄──────────────│ netClient│◄───────────────────│ bridge A   │
│   App    │               │  (TS)    │                    │ teadraw-net│
└──────────┘               └──────────┘                    └─────┬──────┘
     ▲ Host 权威                                             transport
     │                                                 mock-hub / Steam P2P
┌──────────┐  vite :5180   ┌──────────┐  ws /bridge?token  ┌─────┴──────┐
│ 浏览器 B │◄──────────────│ netClient│◄───────────────────│ bridge B   │
│   App    │               │  (TS)    │                    │ teadraw-net│
└──────────┘               └──────────┘                    └────────────┘
```

- **每玩家一桥**：浏览器 ↔ 本机 Node 桥 ↔ 房间（mock-hub 或 Steam lobby）
- **星型拓扑**：成员消息只能发 hostId，host 广播全员（transport 层强制 `INVALID_DIRECTION`）
- **Host 权威**：App 的 `useNetRoom` 管理房间阶段、房规和座位，Host 的 `useGame` 管理对局状态。Peer 绘图/擦除/猜词先发意图，由 Host 校验并回显落账；本地草稿和指引标记可以预览。

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
| `src/game/netSync.ts` | 房间协议层：session/game 订阅、gameId 隔离、顺序发送、分块重组及切屏消息缓存 |
| `src/game/useNetRoom.ts` | App 常驻房间：完整大厅快照、权威座位、玩法/房规、开局/结算/再开与重连 |
| `server/test-net-lifecycle.mjs` | 隔离 Mock 桥生命周期回归（无需预先启动服务） |
| `tools/net-lobby-e2e.mjs` | 从真实首页建房/入房到绘图、MCP、刷新、猜词轮换、结算与再开的双浏览器回归 |

## 2. 命令速查

```powershell
node server/teadraw-net.mjs hub                          # 本地中枢（开发时先起）
node server/teadraw-net.mjs net --transport mock          # 玩家桥，打印联机深链
node server/teadraw-net.mjs net --transport mock --port 5192   # 同机第二玩家
node server/teadraw-net.mjs ping --port 5191              # 测活
node server/test-net.mjs <tokA> <tokB>                    # 双桥冒烟
node server/test-net-lifecycle.mjs                        # 隔离生命周期回归
node server/test-net-client.mjs                           # TS 客户端重连、大包分块与局隔离回归
node tools/net-lobby-e2e.mjs                              # 完整菜单双端回归；可用 NET_TEST_URL 换 Vite 地址
# 浏览器: http://localhost:5180/?net=<port>&token=<tok>  （桥启动时打印完整深链）
```

## 3. 房间协议（bridge data 载荷，全部 JSON）

所有对局消息自动携带 `gameId`。`lobby-*` 与 `session-chunk` 属于常驻会话通道；`session-over` 同时交由对局和会话处理。大载荷分为 `{t:'session-chunk', id, index, total, chunk}`，每片最多 48,000 个字符串字符，最多 400 片；总载荷、重组缓存及切屏缓存分别限制为 16 Mi 个字符，重组最多 8 组、15 秒过期。数值是字符串字符上限，不是 UTF-8 字节数。底层包仍受 768 KiB 限制。

### 3.1 成员 → host（意图）

| t | 载荷 | host 校验 |
|---|---|---|
| `lobby-hello` | `{name}` | 同步真实名字与完整 `lobby-state` |
| `lobby-chat` | `{text}` | 按发送者座位盖章，再广播 `lobby-chat{msg}` |
| `hello` | `{name}` | 复用大厅座位 → `seat-assign` + `roster` + `snapshot` |
| `op` / `ops` | `{el, tf?, author?, round}` / `{items:[{el,tf?,author?}], round}` | 当前画手/回合 + SVG 白名单 + 元素/几何上限 + Agent 墨量 → `ops`；失败定向 `op-rejected` |
| `op-erase` | `{id, round}` | 当前回合可作画且 op.seat === 发者 seat → `op-del` |
| `mark` | `{mark:TargetMark, round}` | 当前回合可作画、公开标记、目标几何与数量合法 → `mark` |
| `mark-del` | `{id, round}` | 标记存在且属于发送者 → `mark-del` |
| `chat` | `{text, author?}` | 座位由 Host 确认；未结束的猜词回合拒绝画手发言 |
| `guess` | `{text, author?, round}` | 本轮猜词者、已选词、未猜中且 Agent 权限允许 → `chat` + `guess-result` + 比分 |
| `pick-word` | `{word, round}` | 本轮画手且选自实际发出的词卡 → `round-live`，定向 `word-picked` |

`next-req` / `end-req` 不再授权成员推进或结束对局。`relay-done` 尚未接入。

### 3.2 host → 成员（广播，除非注明定向）

| t | 载荷 | 说明 |
|---|---|---|
| `lobby-state` | `{mode,rules,phase,gameId,members,result?}` | 完整房间状态；新成员与重连立即补发 |
| `lobby-chat` | `{msg}` | 常驻大厅聊天 |
| `game-ready` | `{}` | Host 对局挂载完成，Peer 重发 `hello` 补快照 |
| `seat-assign` | `{seat, color}` | 定向：告诉新员自己的座位 |
| `roster` | `{seats:[{id,name,color,score,online}]}` | 座位表 |
| `snapshot` | `{seats,ops,foreignMarks,round,drawerSeat,hintLen,roundOver,guessedSeats,answer,endsAt}` | 定向恢复；回合未结束时 answer 为空 |
| `ops` | `{ops:Op[], round}` | 落账笔迹（id 由 Host 编），保留 Agent 作者和笔速动画 |
| `op-rejected` | `{reason}` | 定向拒绝回执 |
| `op-del` | `{ids:string[]}` | |
| `mark` / `mark-del` | | 公开指引标记 → foreignMarks |
| `chat` | `{msg}` | seat/author 已盖章，防冒充 |
| `round-start` | `{round, drawerSeat, hintLen, endsAt}` | 全量重置新一轮；词不随广播 |
| `word-offer` | `{options}` | 定向：host→本轮画手发词卡 |
| `word-picked` | `{word:WordOption}` | 定向：仅本轮画手收到选词确认/刷新恢复 |
| `round-live` | `{hintLen, endsAt}` | 画手已选词，计时开走（不清场） |
| `round-over` | `{answer, isLast, scores}` | |
| `guess-result` | `{seat, verdict}` | 单条猜词判定（chat 同步发） |
| `tick` | `{left}` | host 每 5s 纠偏倒计时 |
| `scores` | `{map:[[seat,score]…]}` | 比分表 |
| `session-over` | `{result:SessionResult}` | 全员进结算屏 |

`relay-progress` 与 12 Hz `pen` 光标同步属于待实现协议，不属于当前可用消息。

## 4. useGame 接入点

- `UseGameOptions.net?: NetParams` 保留深链接入兼容；`netLink?: NetLink` 由 App 常驻房间持有。`useGame` 在 game 通道订阅，卸载只取消订阅；正常换屏不会 close/leave。
- 分流点：`draw→op` / Agent `commitOps→ops` / `erase→op-erase` / `sendChat→chat` / `addMark→mark` / `pickWord→pick-word` / `submitGuess→guess`；传话暂不接入。
- Host：`buildAuthorizedOps` 共用人和 Agent 校验，再 `applyCommittedOps` 落账并广播；Peer 发意图后按 Host 回显更新状态。MCP 的猜词、聊天也经过该权威流程，角色与座位按当前回合读取。
- **墨量/op id**：host 侧 Op.id 统一编发（`uid('op')`），peer 不带 id 上行；人和 Agent 共享校验与落账入口，author 及 Agent 运笔动画由 Host 确认。
- 计时：`endsAt` 时间戳下发，本地算 timeLeft；host 每 5s `tick` 纠偏
- sim：联机时不启动远端玩家剧本；未认领座位 bot 填充尚未实现。本地茶宠在 MCP 不在线时可执行自身绘图模拟，产出仍经过 Host 校验。

## 5. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | server/net vendored + 3 补丁 + teadraw-net.mjs | `test-net.mjs` 双桥冒烟 ✓ 已过 |
| P1 | netClient.ts + netSync.ts + `?net=&token=&room=&name=` 深链 + TopBar 徽章 | ✓ 已过 |
| P2 | 茶绘 ops+chat+roster 最小闭环 | 旧 `tools/net-e2e.mjs` 只覆盖对局深链；当前验收以完整菜单双端回归为准 |
| P3 | 真菜单建房/加入、常驻会话、完整房规与座位、刷新续连 | 生命周期 6 项、TS 客户端 7 项、双浏览器 33 项，共 46 项通过（本地 Mock，2026-10-06） |
| P4a | 猜词动态角色、私密选词、计时/比分、轮换画手、同步结算与再开 | 包含于双浏览器 33 项；覆盖房主与客机刷新恢复、两轮画手轮换；旧 `net-guess-e2e.mjs` 记录不等同完整入口验收 |
| P4b | 剩余全量：pens 12Hz、relay 进度同步、botSeats 空座填充 | relay/多端对局 |
| P5 | 真 Steam：`--transport steam --appid 480` 双账号 | 待验收；本次只做本地 Mock 与注入客户端的传输校验 |
| P6 | README 联机节 + design.agent.md + AGENTS.md | |

## 6. 已知边界

- mock-hub 房间 host 离开 → 房间解散（`closed{HOST_LEFT}`），无 host 迁移；真 Steam lobby 同理
- **联机时本地模拟自动关闭**（各端各跑 sim 会分裂画面）；bot 填充座位是 P4 的活
- P2+P4a 已做茶绘/你画我猜；relay 联机在入口明确禁用，等待 P4b 全量协议。
- 联机时 `readOnly`/`role` 不再来自 URL `?role=` prop，而是按 `drawerSeat` 动态推导（host 首轮恒为画手，成员座位 ≥2）
- 大厅 `lobby-state` 包含 mode/rules/phase/gameId/members/result；新员加入立即补发，只有房主改房规和开局。座位 peerId→seat 在大厅与对局共用 `NetLink.seatRoster`；peer 的悄悄提示（whisper）联机下禁用。
- 浏览器刷新/短暂断 socket 时本机桥保留成员身份 30 秒；同房 join/create 幂等。`NetLink.close()` 显式 leave，`disconnect()` 只断 socket。房主快照按 room+gameId 存入 sessionStorage，含画布/回合/词卡/画手/计时/比分；客机刷新从房主注水。存储容量耗尽、超过宽限期或关闭桥进程不保证恢复。
- 游戏包携带 gameId，绘图/擦除/标记携带 round，旧局/旧轮请求被拒绝。切屏期间 game 通道缓存消息，`game-ready→hello→snapshot` 补齐挂载时序；大包以 session-chunk 分块，顺序发送并限制重组/缓存大小。
- 中枢或房主离开后明确显示联机中断，不静默变成单机。结算回大厅/再开由房主同步驱动，客机不能本地切玩法或重开。
- 单机演示路径完全不受影响：`?net` 缺省 = 现有本地模拟
- steamworks.js 需真 Steam 环境时才装（server 端 `npm i steamworks.js`，native binding）
- 房间码：mock=数字（`1001`），steam=15-21 位 lobby id → TopBar 直接显示真实码
- 传话联机在大厅禁用，relay 深链提示未开放；不以本地演示冒充联机。
