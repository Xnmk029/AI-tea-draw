# 茶绘 · 加入房间（给 Agent 的操作单）

你是某个玩家的 Agent。你的玩家刚拿到这份便携包，**目标：进入房主开的茶绘房间**。照本文件操作即可，全程零安装（只需要 Node ≥18，Steam 模式另需 Steam 客户端 + SpaceWar）。

## 包里有什么

```
index.html + assets/            游戏前端（已构建好）
steam_appid.txt                 Spacewar AppID（480，Steam 模式要读它）
server/teadraw-net.mjs          联网桥 CLI（hub / net / ping）
server/teadraw.mjs              MCP Agent 桥（12 个画图工具，可选）
server/net/*.cjs                桥与 transport 实现（mock-hub / steam）
server/node_modules/ws          mock 桥唯一依赖，已随包携带
server/node_modules/steamworks.js  Steam transport 依赖（预编译全平台）
server/JOIN.md                  本文件
server/README.md                MCP 协议文档（如果你要亲自画画）
```

## 两种联机通道

| 通道 | 房主起什么 | 对端要什么 |
|---|---|---|
| `mock`（默认） | `hub` 中枢（ws://IP:19780） | hub 地址 + 4 位房间码 |
| `steam` | 不需要中枢，走 Steam lobby+P2P | Steam 客户端登录中 + 已装 SpaceWar（`steam://install/480`）+ 18 位 lobby 码 |

Steam 模式下 `--hub` 无效，不用 hub。房间码在 Steam 模式是 18 位 lobby id。

## 你需要从房主那拿到的两样东西

1. **hub 地址**：形如 `ws://192.168.x.x:19780`（房主在局网/公网起的中枢）——Steam 模式不需要
2. **房间码**：4 位数字（mock）或 18 位数字（Steam lobby）——房主开局后游戏左上角 `#` 后面的数字

## 加入房间（一条命令）

在本包根目录执行：

**mock 通道**：

```bash
node server/teadraw-net.mjs net --hub ws://<房主IP>:19780 --room <房间码> --root . --name <你的茶名> --open
```

**Steam 通道**：

```bash
node server/teadraw-net.mjs net --transport steam --room <18位lobby码> --root . --name <你的茶名> --open
```

这条命令做的事：

1. 起你本地的联网桥（随机空闲端口）+ 通过 transport 连上 hub/lobby
2. 印出你的专属深链（带本机 token，防同机劫持）——形如：
   ```
   {"event":"deep-link","url":"http://127.0.0.1:5193/index.html?net=5193&token=…&screen=game&room=1024"}
   ```
3. `--open` 自动用默认浏览器打开这条深链 → 直接落进对局页加入房间

不带 `--room` 时深链落主页：「开始茶会」= 自己建房（host），「加入房间」= 输码进房（peer），走真实菜单。

**房间码也可以不写进命令**：只到 `--root . --name … --open`，落主页后手动在「加入房间」面板输码（4–18 位都收）。

**没图形界面 / 不想自动开**（Agent 只读终端）：去掉 `--open`，解析 stdout 里 `deep-link` 行的 `url`，用玩家常用的浏览器打开（或把 url 交给玩家）。

## 如果你自己是 Agent，还想接管游戏里的茶宠

`teadraw.mjs mcp` 是一个标准 MCP stdio server。**你没有 MCP 客户端也能用**：把它 spawn 成子进程，按 MCP 协议往它的 stdin 写 JSON-RPC 行、从 stdout 读响应即可：

```bash
node server/teadraw.mjs mcp --name <你的Agent名> --model <模型名>
```

最小握手（每条消息一行 JSON）：

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"you","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":…,"capabilities":…}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"turn_get_task","arguments":{}}}
```

12 个工具：`canvas_get_targets` / `canvas_find_space` / `canvas_snapshot`（拿到画布 PNG 栅格图可看画面）/ `canvas_describe` / `canvas_draw` / `canvas_commit` / `chat_send` / `guess_submit` / `hint_whisper` / `events_poll` / `room_state` / `turn_get_task`。协议细节见 `server/README.md`。

有 MCP 客户端的话（Claude Code 等）：`claude mcp add teadraw -- node "<包>/server/teadraw.mjs" mcp --name <名>`，配好后工具直接出现在你的工具列表里。

## 自己当房主（建房给别人加）

**mock 通道**（LAN/公网 hub）：

```bash
node server/teadraw-net.mjs hub --host 0.0.0.0     # 中枢对外监听（打印可分享的 ws://IP:19780）
node server/teadraw-net.mjs net --root . --name <茶名> --open   # 落主页 →「开始茶会」→ 建房
```

**Steam 通道**（推荐，无需 hub——Steam 好友/公网都能加）：

```bash
node server/teadraw-net.mjs net --transport steam --lobby public --root . --name <茶名> --open
```

- `--lobby public` 让陌生人也按码进（默认 FriendsOnly 只允许 Steam 好友）
- 房间码是左上角 `#` 后的数字，直接发给对端即可

## 常见问题

- **EADDRINUSE :19780**：hub 已被占了？说明本机已经有中枢在跑，直接用它的地址即可，不用重起
- **刷新或短暂断开**：联网桥会保留房间成员身份 30 秒。在宽限期内重新打开同一个深链可续接房间；对局快照由房主补发。房主页面恢复对局时依赖浏览器保存的本局状态。
- **主动离房**：点击离房后立即退出房间，房主离房会解散房间；这不使用 30 秒宽限期。关闭联网桥进程也会退出房间。
- **token 校验失败 / 409**：token 是桥启动时随机生成的，仅用于连接本机桥；应使用当前桥打印的深链。每桥只允许一个游戏页面，先关闭占用连接的旧页面再续接。
- **页面打开是离线房**：说明连 hub/lobby 失败——查 `--hub` 地址对不对、Steam 登录状态、房主 hub 是否还开着
- **防火墙拦 19780/随机端口**：net 桥是 `127.0.0.1` 纯本地不用放行；hub 用 `--host 0.0.0.0` 对外才要放 19780

## 自测（没有第二台机器时）

同机双开验证：开两个终端各跑一份 `net`（一份 `--room` 一份不带），两个浏览器窗口互相能看到对方笔迹即链路 OK。
