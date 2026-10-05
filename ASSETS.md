# 茶绘 TeaDraw · 素材获取与布置清单

> 读者：负责获取和布置素材的 Agent。开工前先读 `design.agent.md` 的 §3（不变量）和 §4（层级）。
> 状态：2026-10-05 起草。所有"来源"链接都已在网上核对过页面存在；**授权以下载时页面上的说明为准**，与本文不一致时停下来报告用户。

---

## 0. 执行规则（必须遵守）

1. **只获取"执行者 = Agent"的条目**。标记为「需用户采购」的条目只整理候选和价格，交给用户决定，**不要付款、不要登录用户账号**。标记为「需约稿」的条目只写需求说明。
2. **不使用 AI 生成的素材**。在 itch.io 上，商品页的 AI 声明必须是 "No generative AI was used"；标注了 "AI Assisted" 的一律跳过。
3. **全部本地化**，不允许运行时外链（CDN、Google Fonts 都算）。素材放进 `public/assets/`，按 §1 的规范命名。
4. **每一个素材都要登记授权**，写进 `CREDITS.md`，并把授权原文或页面截图保存到 `licenses/<素材ID>.*`（见 §5）。
5. **不改游戏逻辑**。布置素材只允许做三类改动：
   - 新增样式文件 `src/ui/assets.css`、`src/ui/fonts.css`，在 `main.tsx` 里 `ui.css` 之后引入
   - 删除 `index.html` 里的 Google Fonts 外链
   - 新增音频清单 `public/assets/audio/manifest.json`
   音频播放器不在这次任务范围内，属于 `design.agent.md` 的 T4。
6. **不新增 npm 依赖**。字体子集化这类工具只在本地临时使用，不写进 `package.json`。
7. **原始素材不进仓库**：下载的原始压缩包、WAV、PSD 放在 `assets-src/`，并把这个目录加进 `.gitignore`。仓库里只放压缩后的成品。
8. 完成后按 §7 验收，并回报一份"已完成 / 跳过 / 待用户决定"的列表。

## 1. 目录、命名与格式

```
public/assets/
  textures/   paper/  wood/  fabric/          *.webp（可平铺）
  fonts/                                       *.woff2（子集化后）
  ui/         frames/  buttons/  ornaments/   *.webp 或 *.svg
  icons/                                       *.svg（单色，fill/stroke 改为 currentColor）
  audio/      sfx/  amb/  music/  manifest.json   *.ogg（备用 *.mp3）
  anim/                                        *.riv（茶宠，需约稿）
assets-src/   原始下载文件（被 .gitignore 忽略）
licenses/     每个素材的授权凭证
CREDITS.md    署名与授权总表
```

- **命名**：`<类别>-<来源简称>-<描述>[-<尺寸>].<扩展名>`，全部小写、用短横线连接。例：`paper-ambientcg-paper006-1k.webp`、`sfx-kenney-click-03.ogg`。
- **材质**：1024px 的可平铺 webp，质量 80，单张不超过 300KB。只取 BaseColor（Color）贴图，不需要 normal 等其他贴图。
- **字体**：转成 woff2 并做子集，字符集为 GB2312 一级常用字 3500 个，加上项目源码里出现过的所有字符和 ASCII。正文字体 ≤ 1.2MB，标题字体 ≤ 1.5MB。
- **音效**：OGG Vorbis，48kHz，q5。单声道优先，环境音用立体声。去掉首尾静音，峰值不超过 -1dBFS。
- **音乐**：OGG q6，循环曲要处理好无缝衔接，并在 manifest 里标出 `loopStart` / `loopEnd`（单位秒）。
- **总体积预算**：材质 ≤ 3MB，字体 ≤ 4MB，音效和环境音 ≤ 25MB，音乐 ≤ 40MB。

## 2. 清单

优先级：P0 = 本轮必须完成；P1 = 本轮尽量完成；P2 = 先整理候选。

### A. 材质（全部是 CC0，Agent 可以直接获取）

| ID | 用途 / 挂载点 | 来源 | 选取建议 | 目标文件 | 优先级 |
|---|---|---|---|---|---|
| TEX-01 | 宣纸纸纹：替换 `game.css` 里 `.stage` 用 feTurbulence 生成的噪点；同时用于 `.sheet`、`.home-scene`、`.frame-card`、`.curtain-paper` | ambientCG Paper006 https://ambientcg.com/view?id=Paper006 ✅已核实 2026-10-05 | 下载 1K-JPG，只取 Color 贴图，**提亮、降低对比度**，调成米白色（约 #FAF7F1）| `textures/paper/paper-ambientcg-paper006-1k.webp` | P0 |
| TEX-02 | 粗纤维纸：用于卡片、相册卡、座位名牌，作为备选纸纹 | ambientCG Paper002 https://ambientcg.com/view?id=Paper002 ✅已核实 2026-10-05 | 同上，颜色调得比 TEX-01 稍暖（注：该素材标签为 cartonage 纸箱质感，偏暖黄，正合适） | `textures/paper/paper-ambientcg-paper002-1k.webp` | P1 |
| TEX-03 | 木框与笔架：替换 `.table-frame` 的 CSS 斜条纹（`border-image`）和 `.brush-rack` 的渐变 | Poly Haven Wood Table 001 https://polyhaven.com/a/wood_table_001 ✅已核实 2026-10-05 | 取 Diffuse 1K，调成深胡桃色（约 #54402E） | `textures/wood/wood-polyhaven-table001-1k.webp` | P0 |
| TEX-04 | 茶桌桌面：`.tea-table` | Poly Haven Wood Table https://polyhaven.com/a/wood_table ✅已核实 2026-10-05（原备选 ambientCG Wood064 已核，实为青苔湿木质感，不适用，弃用） | 暖棕松木板，调成中棕色（约 #74533A） | `textures/wood/wood-polyhaven-table-1k.webp` | P0 |
| TEX-05 | 大厅和结算的背景墙或地板：`.lobby-floor` | ambientCG WoodFloor051 https://ambientcg.com/view?id=WoodFloor051 ✅已核实 2026-10-05 | 浅色直铺木地板（页面标签含 Light/Clean/Plank/Indoor），透明度控制在 10% 左右，做成很淡的底纹 | `textures/wood/wood-ambientcg-woodfloor051-1k.webp` | P1 |
| TEX-06 | 绢、布质感：用于印章底、茶单页签 | ambientCG Fabric019 https://ambientcg.com/view?id=Fabric019 ✅已核实 2026-10-05 | 白色编织布纹理（标签 White/Woven/Cloth），当浅色亚麻用；只在小面积使用 | `textures/fabric/fabric-ambientcg-fabric019-1k.webp` | P2 |

### B. 字体（OFL 协议，Agent 可以直接获取）

| ID | 用途 | 来源 | 处理 | 目标文件 | 优先级 |
|---|---|---|---|---|---|
| FNT-01 | 正文和界面文字：替换 `--font` 的首选字体 | 霞鹜文楷 https://github.com/lxgw/LxgwWenKai ，OFL 1.1。下载：release v1.522 https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522 资产里**单取** `LXGWWenKai-Regular.ttf` 和 `LXGWWenKai-Medium.ttf`（不必下 77MB 整包），OFL.txt 在仓库根目录 ✅已核实 2026-10-05 | 只取 Regular 和 Medium 两个字重，子集化成 woff2；**保留文件里附带的 OFL.txt** | `fonts/lxgw-wenkai-regular.woff2`、`fonts/lxgw-wenkai-medium.woff2` | P0 |
| FNT-02 | 大标题（主菜单"茶绘"、纸页标题、结算标题）：新增变量 `--font-title` | 思源宋体 CN Heavy https://github.com/adobe-fonts/source-han-serif ，OFL 1.1。下载方式：Releases https://github.com/adobe-fonts/source-han-serif/releases/tag/2.003R → 资产 `Language Specific OTFs Simplified Chinese (简体中文)` zip 内含 `SourceHanSerifCN-Heavy.otf`（也可从 `All Static Region Specific Subset OTFs` 里单取同名文件）✅已核实 2026-10-05 | 子集只取标题会用到的字（从源码里提取），文件可以控制得很小 | `fonts/source-han-serif-cn-heavy.woff2` | P0 |
| FNT-03 | 书法体：**只用于** Logo、印章、"选"字章、卷帘、落款 | 马善政 Ma Shan Zheng（OFL 1.1）。Google Fonts 页 https://fonts.google.com/specimen/Ma+Shan+Zheng 存在；直取单文件用 google/fonts 仓库 `ofl/mashanzheng/MaShanZheng-Regular.ttf`（同目录附 OFL.txt）https://github.com/google/fonts/tree/main/ofl/mashanzheng ✅已核实 2026-10-05。目前是外链加载 | 下载到本地并子集化，然后**删除 `index.html` 里的 Google Fonts 外链** | `fonts/ma-shan-zheng.woff2` | P0 |
| FNT-04 | 智莽行 Zhi Mang Xing（目前是外链） | Google Fonts 页存在，OFL 1.1；仓库路径 `ofl/zhimangxing/ZhiMangXing-Regular.ttf` ✅已核实 2026-10-05 | **先不要下载**，在报告里列出项目中哪些地方用到了它，交给用户决定保留还是替换成 FNT-01 | — | P2 |
| FNT-05 | 数字和等宽文字（房间码、计时、墨量数字） | JetBrains Mono（OFL 1.1，仓库含 OFL.txt）https://github.com/JetBrains/JetBrainsMono ，`fonts/ttf` 目录或 Release zip 取 TTF ✅已核实 2026-10-05 | 只取 Regular 和 Bold，子集为 ASCII | `fonts/jetbrains-mono-{regular,bold}.woff2` | P1 |

- 子集化可以用 Python 的 fonttools（只装在临时虚拟环境里），命令示例：`pyftsubset in.ttf --text-file=chars.txt --flavor=woff2 --output-file=out.woff2`。字符表用脚本从 `src/**/*.{ts,tsx}` 里提取汉字，再并入 GB2312 一级字表。
- 需要的话，候选字体可以在猫啃网 https://www.maoken.com/ 核对授权。

### C. 界面素材（用来提取笔触和边框，不要整套直接搬用）

| ID | 用途 | 来源 | 授权 / 价格 | 执行者 | 优先级 |
|---|---|---|---|---|---|
| UI-01 | 水墨笔触的面板边框、按钮底、分隔线：用于 `.sheet` 边缘、`.gbtn` 底纹、`.mm-mark`（菜单项的墨迹下划线） | Ink Style RPG UI Kit (FREE)（OnebeanUI）https://onebeanui.itch.io/ink-style-rpg-ui-kit ✅已核实 2026-10-05 | 免费下载、声明未使用 AI。**注意授权为 "Free Learning Edition"**：仅允许学习/参考/个人项目，禁止转售和再分发，**商用需联系作者**——本项目 demo 属个人项目可用，商用前须再确认 | Agent | P1 |
| UI-02 | 冷压水彩纸质感的面板和纸签 | Paper GUI（ErinBrume）https://erinbrume.itch.io/paper-gui ✅已核实 2026-10-05 | **itch 现售价 £3.25（付费）**。授权允许商用和修改，**不能转售或二次分发（修改后也不行）**；声明未使用 AI | **用户（付费）** | P1 |
| UI-03 | 手绘墨线的进度条、勾选框、滑块 | Hand-drawn Modular Ink UI（Iuliana）https://iuliana-u.itch.io/hand-drawn-modular-ink-ui ✅已核实 2026-10-05 | $12.99（价格已核实） | **需用户采购** | P2 |
| UI-04 | 古风界面的版式参考 | Chinese Style VN GUI（Smileflower）https://wningningw.itch.io/visual-novel-gui-pack-019 ✅已核实 2026-10-05 | 只作参考，不放进仓库。注：页面现为付费（约 $3.4–6.8，首发限免已结束），参考截图可先看页面预览图 | Agent（只截图存进 `assets-src/ref/`） | P2 |

### D. 图标（临时方案，最终要约稿定制手绘版）

| ID | 用途 | 来源 | 授权 | 优先级 |
|---|---|---|---|---|
| ICO-01 | 替换 lucide 线性图标 | game-icons.net https://game-icons.net/ ✅已核实 2026-10-05 | **CC BY 3.0（首页页脚明示），必须署名作者**，每个图标的作者都要逐一写进 CREDITS | P1 |

需要的图标（导出为 SVG，统一成 `currentColor`，文件命名为 `icons/ico-<名称>.svg`）：

- **笔架工具**：`brush`（画笔）、`flag`（指引笔 / 令旗）、`line`、`square`、`circle`、`eraser`、`hand`、`undo`、`redo`
- **HUD**：`zoom-in`、`zoom-out`、`replay`、`sparkle`（高亮 Agent 笔迹）、`fullscreen`、`share`、`exit-door`、`gear`、`people`、`chat-scroll`、`layers`、`eye`、`eye-off`、`lock`、`crown`
- **玩法相关**：`teapot`、`lantern`、`incense`、`scroll`、`envelope`、`stamp-seal`、`trophy`、`lasso`、`path`、`grid-3x3`

**这次只放文件，不改组件**。在报告里附上"lucide 图标名 → 新图标文件"的对照表，替换工作留到后续的样式收拢任务（T5）。

### E. 音效（按事件命名，供后续的 AudioManager 使用）

| key | 事件 | 声音描述 | 推荐来源 | 执行者 | 优先级 |
|---|---|---|---|---|---|
| `ui.hover` | 鼠标悬停在菜单项或按钮上 | 很轻的纸面摩擦或木头轻触 | Kenney UI Audio https://kenney.nl/assets/ui-audio （CC0，页面 License 字段明示，50 个文件）✅已核实 2026-10-05 | Agent | P0 |
| `ui.click` | 按下按钮 | 木头轻敲 | Kenney Interface Sounds https://kenney.nl/assets/interface-sounds （CC0，页面 License 字段明示，100 个文件）✅已核实 2026-10-05 | Agent | P0 |
| `ui.back` | Esc 返回 | 比 click 低沉一点 | 同上（Interface Sounds，CC0）✅已核实 2026-10-05 | Agent | P0 |
| `ui.tab` | 切换页签 / 玩法（Q / E） | 翻纸角的声音 | 纸张音效包（见下方 E2） | Agent / 用户 | P1 |
| `screen.curtain_down` / `screen.curtain_up` | 换屏卷帘 | 卷轴落下 / 收起，加上木轴碰撞 | Sonniss GDC 游戏音频包 https://gdc.sonniss.com/ （当前为 GDC 2026 包：7.47GB / 347+ 文件；EULA 见 https://sonniss.com/gdc-bundle-license/ ：免版税、可商用、无需署名、**明文禁止 AI 训练**）✅已核实 2026-10-05 | Agent | P1 |
| `sheet.in` / `sheet.out` | 纸页滑出 / 收回 | 纸张滑过桌面 | E2 | Agent / 用户 | P0 |
| `pen.human` | 人在作画（循环播放，音量跟随笔速） | **铅笔或钢笔划过纸面** | Miotto《Pages & Books》（有钢笔、铅笔、羽毛笔）https://miotto-sounds.itch.io/pages-books-complete-audio-collection （**付费 $9.99**，促销时 $4.99）✅已核实 2026-10-05；thesoundrack《Reading & Writing》https://thesoundrack.itch.io/reading-writing-sound-pack （266 个文件，授权 **CC BY 4.0 需署名 Leonardo Calvo**，未见最低购买价提示，下载前再以页面为准）✅已核实 2026-10-05 | 用户（Miotto 付费）/ Agent（thesoundrack 若免费）| P0 |
| `pen.agent` | Agent 在作画（循环播放） | **毛笔划过宣纸**，音色要和 `pen.human` 明显不同，更柔、更湿 | 同上，或在 Sonniss 包里搜 "brush" / "paint" | Agent / 用户 | P0 |
| `draft.appear` | 描红草稿出现 | 轻微的沙沙声 | E2 | Agent / 用户 | P1 |
| `stamp.seal` | 盖章接受草稿 | **沉闷的一声印章落纸**，带一点木头共鸣 | Sonniss（搜 "stamp"）| Agent | P0 |
| `draft.crumple` | 拒绝草稿 | 揉纸团 | Stormwave《Paper Sound Effects Vol. I》（有 Paper Page Crush）https://stormwave-audio.itch.io/paper-sound-effects-vol-i （**付费 $9.99**，免版税，98 个文件）✅已核实 2026-10-05 | **用户（付费）** | P0 |
| `mark.flag` | 插令旗 | 小木签插进纸面 | Sonniss / Kenney | Agent | P1 |
| `mark.weight` | 放镇纸（区域框） | 石块或木块落在纸上 | Sonniss | Agent | P1 |
| `cup.ready` | 准备（翻茶杯） | **瓷器轻碰** | Sonniss（搜 "porcelain" / "cup" / "ceramic"）| Agent | P0 |
| `round.start` | 回合开始 | 小锣或磬，余音不超过 2 秒 | Sonniss（搜 "gong" / "bell"）| Agent | P1 |
| `timer.urgent` | 最后 10 秒，每秒一下 | 木鱼或心跳 | Sonniss | Agent | P1 |
| `guess.correct` | 有人猜中 | 风铃，明亮 | Sonniss / Shapeforms 免费音效包 https://shapeforms.itch.io/shapeforms-audio-free-sfx （免费，免版税可商用无需署名，声明未使用 AI；含 Future UI 等 180 个音效）✅已核实 2026-10-05 | Agent | P0 |
| `guess.close` | 猜得很接近 | 短促的铃声，音调偏低 | 同上（Shapeforms，免费）✅已核实 2026-10-05 | Agent | P1 |
| `chat.pop` | 收到消息 / 纸条 | 轻微的纸片声 | E2 | Agent / 用户 | P1 |
| `pet.wake` / `pet.think` / `pet.happy` | 茶宠的三种状态 | 可爱的短叫声、茶壶轻轻冒气的嘶声 | Sonniss / Kenney；不合适就标"需约稿" | Agent | P2 |
| `relay.fold` | 传话作品提交（折信） | 折纸 | E2 | Agent / 用户 | P1 |
| `amb.rain` | 主题"雨天的茶馆"的环境音（循环） | 室内听到的窗外雨声 | Freesound AderuMoro #845591 https://freesound.org/people/AderuMoro/sounds/845591/ —— 已核实为 **CC0**（页面 License 字段为 "Creative Commons 0"），"Stereo Interior Rain on Window (loopable)"，4:46 立体声 WAV；备选 OpenGameArt "Rain on Window Loop" https://opengameart.org/content/rain-on-window-loop （作者 alxl，约 11 秒循环；页面 License 栏同时勾选 CC-BY 4.0 / CC-BY 3.0 / OGA-BY 3.0 / CC0 四项，署名说明写 "Available under CC0"，作者评论确认多授权任选 → **按 CC0 用即可，仍建议署名 alxl**）✅已核实 2026-10-05 | Agent | P0 |
| `amb.teahouse` | 茶馆底噪（循环） | 远处人声、杯盘的轻响，压得很低 | Sonniss（搜 "restaurant" / "cafe" / "room tone"；gdc.sonniss.com 页面有 Track List 可查，**下载前先在曲目表确认含餐厅/室内环境音**，没有则改用 OpenGameArt / Freesound 搜 cafe ambience）✅已核实 2026-10-05 | Agent | P1 |

- **E2 纸张音效包**（价格已核实 2026-10-05）：Stormwave《Paper Sound Effects Vol. I》**付费 $9.99**；Sound Works 12《Paper SFX》https://sound-works-12.itch.io/paper-sfx **付费**（标价约 $5，促销价见过 $2.50，声明未使用 AI）；Miotto《Pages & Books》**付费 $9.99**。三个包都需要付费 → **全部列给用户采购**。备选：thesoundrack《Reading & Writing》（CC BY 4.0，含 pencil/write/pages 类，未见最低价提示）可由 Agent 在确认页面价格后获取。
- **Sonniss 包有好几个 GB**：不要整包放进 `assets-src/`。先看官方曲目列表（Track List）定位需要的文件，用完就删掉压缩包，只保留选中的那几条原始文件。
- 每个 key 先准备 2–3 个变体，比如 `sfx-...-click-01/02/03.ogg`，在 manifest 里写成数组，播放时随机选一个，避免重复听着发腻。

### F. 音乐

| key | 用于 | 风格 | 来源 | 执行者 | 优先级 |
|---|---|---|---|---|---|
| `music.menu` | 主菜单、茶桌大厅 | 安静的古筝或竹笛，略带 lofi 的感觉 | 小逸Eiyue《Free Traditional Chinese Music Pack I》https://xiaoyi3606.itch.io/free-traditional-chinese-music-pack-i （免费，个人和商用均可；不能转售/再分发音频文件本身、不能冒名；署名非强制，建议写 "Music by 小逸Eiyue"）✅已核实 2026-10-05 | Agent | P0 |
| `music.tea` | 基础茶绘对局 | 轻快、温暖 | 同上；或者 Ovani《Unplugged》系列 https://ovanisound.com/ （每首 3 档强度，$50 左右）| Agent / **用户采购** | P1 |
| `music.guess` | 你画我猜 | 节奏感强，需要能切换强度 | Ovani《Casual Music Pack》（3 档强度，可以随倒计时升档）；Om-Official《Asian/Oriental Game Music Themes Pack》https://om-official.itch.io/asianoriental-game-music-themes-pack （**付费 $19**，免版税，13 首主题 48 轨）✅已核实 2026-10-05 | **用户采购** | P1 |
| `music.result` | 结算典礼的短乐句 | 5–8 秒，扬琴或钟磬 | 从以上曲包里截一段，或者用 Sonniss 里的乐器单音拼出来 | Agent | P2 |

- Li Gen《Gufeng Music Pack》（74 首，MP3 320kbps）https://ligen19910313.itch.io/gufeng-music-pack ✅已核实 2026-10-05：**付费包**（一次购买、永久、全球、免版税、可商用、无需署名）；itch 商品页 AI 声明为 **"No generative AI was used"**；发布于 2026-10-03 前后，非常新。只列为候选，由用户决定。

### G. 需约稿（Agent 不能获取，只输出需求说明）

把每一项的需求单写进 `assets-src/briefs/<ID>.md`，内容包括：用途、尺寸、风格参考、交付格式、代码里的挂载点。

| ID | 内容 | 交付格式 | 挂载点 |
|---|---|---|---|
| ART-01 | Logo 字形："茶绘"两个字加茶杯图形 | SVG | `components/Logo.tsx` |
| ART-02 | 茶宠角色设定，以及 5 个状态的动画（idle / thinking / review / drawing / offline） | Rive `.riv`，状态机输入为 `status` | 替换 `game/TeaPet.tsx`；运行时 `@rive-app/canvas` 是 MIT 协议，**引入这个依赖要先经过用户同意** |
| ART-03 | 茶馆大堂分层插画（前景 / 中景 / 背景，可以做视差） | 分层 PNG 或 webp，3840×2160 | 主菜单的 `.l-bg` |
| ART-04 | 茶桌俯视插画（桌面、茶具、桌布） | PNG 或 webp | 大厅的 `.tea-table` |
| ART-05 | 整套手绘图标，约 40 个，替代 ICO-01 | SVG，统一笔触 | 同 D 节的图标清单 |
| ART-06 | 示例作品库重绘（`mock/drawings.ts` 里的 10 件），笔触画风 | SVG，**只能用白名单内的标签**，200×200 盒子 | `mock/drawings.ts`（**保留**故意加的 `<title>`、`<text>`、`id`，用来演示校验器）|
| ART-07 | 印章字形：每个座位一枚，再加"选""准""赢"等字章 | SVG | `.seal-stamp`、`.mode-tile.on::after` |

## 3. 布置方式（只改样式和清单，不碰组件）

### 3.1 `src/ui/assets.css`（新建，在 `main.tsx` 里排在 `ui.css` 之后引入）
```css
:root {
  --tex-paper: url('/assets/textures/paper/paper-ambientcg-paper006-1k.webp');
  --tex-paper-2: url('/assets/textures/paper/paper-ambientcg-paper002-1k.webp');
  --tex-wood-frame: url('/assets/textures/wood/wood-polyhaven-table001-1k.webp');
  --tex-wood-table: url('/assets/textures/wood/wood-polyhaven-table-1k.webp');
}
/* 要覆盖的选择器（按需设置 background-image / border-image-source） */
.stage { background-image: var(--tex-paper); background-size: 512px; }
.sheet, .home-scene, .frame-card, .curtain-paper { background-image: var(--tex-paper); background-size: 512px; }
.table-frame { border-image: var(--tex-wood-frame) 40 round; }
.brush-rack { background-image: linear-gradient(165deg, rgba(0,0,0,0), rgba(0,0,0,.25)), var(--tex-wood-frame); background-size: cover, 384px; }
.tea-table { background-image: radial-gradient(ellipse at 40% 35%, rgba(255,230,190,.18), rgba(0,0,0,.25)), var(--tex-wood-table); background-size: cover, 512px; }
```
- 纸纹叠加以后，**文字对比度不能下降**：正文和背景的对比度至少要 4.5:1。不够的话就降低纹理透明度，或者在纹理上方叠一层半透明的纯色。
- `.home-scene::before` 里的点阵网格要保留，它是"画布"的语义提示。

### 3.2 `src/ui/fonts.css`（新建）
- 用 `@font-face` 声明 FNT-01、02、03、05，全部加 `font-display: swap`。
- 改写变量：
  - `--font: 'LXGW WenKai', 'MiSans', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif`
  - 新增 `--font-title: 'Source Han Serif CN Heavy', var(--font-disp)`
  - `--font-mono: 'JetBrains Mono', var(--mono)`
- 把 `.home-title h1`、`.sheet-head h2`、`.result-title h2`、`.tt-center b`、`.mt-text b`、`.mm-text b` 的字体改成 `var(--font-title)`。
- `--font-disp`（书法体）只保留在 Logo、印章、`.mode-tile.on::after`、`.curtain-paper b` 这几个地方。

### 3.3 `public/assets/audio/manifest.json`（新建，暂时不接代码）
```json
{
  "version": 1,
  "buses": { "music": 0.6, "sfx": 0.9, "amb": 0.5 },
  "sounds": {
    "ui.click": { "bus": "sfx", "files": ["sfx/sfx-kenney-click-01.ogg", "sfx/sfx-kenney-click-02.ogg"], "volume": 0.7 },
    "pen.agent": { "bus": "sfx", "files": ["sfx/sfx-xxx-brush-loop.ogg"], "loop": true, "volume": 0.5 },
    "amb.rain": { "bus": "amb", "files": ["amb/amb-freesound-rain-window.ogg"], "loop": true, "loopStart": 0, "loopEnd": 0 },
    "music.menu": { "bus": "music", "files": ["music/music-xiaoyi-xxx.ogg"], "loop": true, "intensity": null }
  }
}
```
- key 必须和 E、F 两节表格里的 key 完全一致。缺失的条目也要写进去，`files` 留空数组，并在报告里列出来。

## 4. 处理流程（每个素材都走一遍）

1. 打开来源页面 → 核对授权和 AI 声明 → 截图或保存授权文本，放进 `licenses/<ID>.*`
2. 下载到 `assets-src/<ID>/`
3. 加工：裁剪、调色、做成可平铺、压缩、转格式、子集化
4. 按 §1 命名，放进 `public/assets/...`
5. 在 `CREDITS.md` 里登记一行
6. 按 §3 布置
7. 截图对比（§7）

## 5. CREDITS.md 格式

```markdown
| ID | 文件 | 作品名 | 作者 | 来源 URL | 授权 | 是否需要署名 | 是否修改 | 获取日期 |
|---|---|---|---|---|---|---|---|---|
| TEX-01 | textures/paper/paper-ambientcg-paper006-1k.webp | Paper 006 | ambientCG | https://ambientcg.com/view?id=Paper006 | CC0 1.0 | 否 | 调色、缩放 | 2026-10-xx |
```
CC BY 类素材（game-icons、OpenGameArt 的雨声等）必须把署名文字原样写进去，后续会接到游戏的"制作人员"页面。

## 6. 禁止事项

- 不使用来自淘宝、网盘、"免费素材站"等来源不明的素材，也不使用千库网、包图网这类授权复杂的站点。
- 不在仓库里放原始大文件、付费素材的原始包，以及禁止再分发的源文件（比如 Paper GUI）。只放加工后用于游戏的成品。
- 不修改 `mock/drawings.ts`、`useGame.ts`、`simulation.ts` 这些逻辑文件。
- 不改动 `pnpm-workspace.yaml` 和任何安全相关的配置。

## 6.5 来源核实记录

核实日期：2026-10-05（webfetch 逐页打开核对；itch.io 商品页通过搜索快照核对，价格以页面当日显示为准）。

### 材质（§A，全部 CC0）

| ID | 最终来源 URL | 授权 | 备注 |
|---|---|---|---|
| TEX-01 | https://ambientcg.com/view?id=Paper006 | CC0 | 页面存在，标签 Beige/Brown/Paper，有 1K-JPG 下载 |
| TEX-02 | https://ambientcg.com/view?id=Paper002 | CC0 | 页面存在，标签 Cartonage（纸箱质感） |
| TEX-03 | https://polyhaven.com/a/wood_table_001 | CC0 | 页面存在，红棕染色细木纹漆面 |
| TEX-04 | https://polyhaven.com/a/wood_table | CC0 | **二选一已钉死为 Poly Haven**。备选 ambientCG Wood064 页面存在（CC0）但标签为 Green/Mossy/Wet——青苔湿木，不适合桌面，弃用 |
| TEX-05 | https://ambientcg.com/view?id=WoodFloor051 | CC0 | **从"例如"钉死**。标签含 Light/Clean/Indoor/Plank/Staggered，浅色直铺木地板，适合 10% 淡底纹 |
| TEX-06 | https://ambientcg.com/view?id=Fabric019 | CC0 | **占位已钉死**。标签 White/Woven/Cloth，白色编织布，可当浅色亚麻用 |

### 字体（§B，全部 OFL 1.1）

| ID | 最终来源 | 授权 | 备注 |
|---|---|---|---|
| FNT-01 | https://github.com/lxgw/LxgwWenKai → release `v1.522`（2026-03-17 发布） | OFL 1.1（仓库根目录 OFL.txt） | 仓库与 Releases 页均存在；资产含独立 `LXGWWenKai-Regular.ttf` / `-Medium.ttf` 单文件，无需整包 |
| FNT-02 | https://github.com/adobe-fonts/source-han-serif → release `2.003R` | OFL 1.1（LICENSE.txt） | CN 版 Heavy = 资产包 `Language Specific OTFs Simplified Chinese (简体中文)` 内的 `SourceHanSerifCN-Heavy.otf`；也可从 `All Static Region Specific Subset OTFs` 单取 |
| FNT-03 | https://fonts.google.com/specimen/Ma+Shan+Zheng ；单文件 https://github.com/google/fonts/tree/main/ofl/mashanzheng | OFL 1.1 | Google Fonts 页存在（页面有反爬，经搜索+仓库双重确认）；仓库内有 `MaShanZheng-Regular.ttf` 和 OFL.txt |
| FNT-04 | https://fonts.google.com/specimen/Zhi+Mang+Xing ；`ofl/zhimangxing/ZhiMangXing-Regular.ttf` | OFL 1.1 | 存在；按原清单仍不下载 |
| FNT-05 | https://github.com/JetBrains/JetBrainsMono | OFL 1.1（仓库含 OFL.txt） | 仓库存在，`fonts/` 目录有 TTF；官网 https://www.jetbrains.com/lp/mono/ |

### 音效与环境音（§E）

| 条目 | 最终来源 URL | 授权 / 价格 | 备注 |
|---|---|---|---|
| `amb.rain` 首选 | https://freesound.org/people/AderuMoro/sounds/845591/ | **CC0**（页面 License 字段为 "Creative Commons 0"） | 存在："Stereo Interior Rain on Window (loopable)"，4:46 立体声 WAV 48kHz/24bit |
| `amb.rain` 备选 | https://opengameart.org/content/rain-on-window-loop | 页面勾选 **CC-BY 4.0 + CC-BY 3.0 + OGA-BY 3.0 + CC0** 四项；署名说明写 CC0；作者评论确认任选 → 按 CC0 用，建议署名 alxl | 存在，约 11 秒循环 WAV |
| `amb.teahouse` / `screen.curtain*` / `stamp.seal` 等 Sonniss 条目 | https://gdc.sonniss.com/ （当前为 GDC 2026 包，7.47GB / 347+ 文件） | 免版税、可商用、无需署名；EULA https://sonniss.com/gdc-bundle-license/ 含 "NO AI TRAINING OR USAGE" 条款（2024-01-28 加入） | 站点活着；**Track List 未逐条核对**，cafe/restaurant/room tone 类素材需在曲目表确认 |
| `ui.hover` | https://kenney.nl/assets/ui-audio | CC0（页面明示） | 50 个文件 |
| `ui.click` / `ui.back` | https://kenney.nl/assets/interface-sounds | CC0（页面明示） | 100 个文件 |
| `guess.correct` / `guess.close` | https://shapeforms.itch.io/shapeforms-audio-free-sfx | 免费、免版税可商用、无需署名；No generative AI | 180 个音效 |
| `draft.crumple` / E2 | https://stormwave-audio.itch.io/paper-sound-effects-vol-i | **付费 $9.99**，免版税 | 98 个文件 → 用户采购 |
| E2 | https://sound-works-12.itch.io/paper-sfx | **付费**（约 $5，促销见过 $2.50）；No generative AI | 177 个文件 → 用户采购 |
| `pen.human` / E2 | https://miotto-sounds.itch.io/pages-books-complete-audio-collection | **付费 $9.99**（促销时 $4.99） | → 用户采购 |
| `pen.human` 备选 | https://thesoundrack.itch.io/reading-writing-sound-pack | **CC BY 4.0，需署名 Leonardo Calvo**；No generative AI；未见最低价提示（疑免费/随意定价，下载前再确认） | 266 个文件 96kHz/24bit |

### 界面 / 图标 / 音乐（§C、§D、§F，顺带核实）

| ID | 最终来源 URL | 授权 / 价格 | 备注 |
|---|---|---|---|
| UI-01 | https://onebeanui.itch.io/ink-style-rpg-ui-kit | 免费，但为 **"Free Learning Edition"**：仅学习/参考/个人项目，禁转售/再分发，商用需联系作者；No generative AI | ⚠️ 授权比清单原描述更严格，商用前须再确认 |
| UI-02 | https://erinbrume.itch.io/paper-gui | **itch 现售价 £3.25（付费）**；可商用可修改，禁转售/再分发（含修改后）；No generative AI | → 用户采购 |
| UI-03 | https://iuliana-u.itch.io/hand-drawn-modular-ink-ui | **付费 $12.99** | 与清单一致 |
| UI-04 | https://wningningw.itch.io/visual-novel-gui-pack-019 | 现为付费（约 $3.4–6.8，首发限免已结束）；允许商用/修改；No generative AI | 仅作参考截图，不进仓库 |
| ICO-01 | https://game-icons.net/ | **CC BY 3.0**（首页页脚明示） | 逐图标署名作者 |
| `music.menu` | https://xiaoyi3606.itch.io/free-traditional-chinese-music-pack-i | 免费，个人+商用；禁转售/再分发音频文件、禁冒名；署名建议 "Music by 小逸Eiyue" | 与清单一致 |
| `music.guess` 候选 | https://om-official.itch.io/asianoriental-game-music-themes-pack | **付费 $19**，免版税 | 48 轨 WAV |
| F 节候选 | https://ligen19910313.itch.io/gufeng-music-pack | **付费**（一次购买永久免版税、可商用、无需署名）；AI 声明 "No generative AI was used" | 2026-10-03 前后发布，很新；候选待用户决定 |

### 核实中发现的问题

1. **授权与清单原文不一致（已按页面改写）**：Freesound #845591 清单写"按单个文件核对授权"，实为 **CC0**；OpenGameArt "Rain on Window Loop" 的 License 栏实际勾选了**四项授权**（CC-BY 4.0/3.0、OGA-BY 3.0、CC0），不只是 CC-BY+CC0 两项，作者评论确认可任选 → 按 CC0 使用、建议署名。
2. **授权收紧**：UI-01 Ink Style RPG UI Kit 免费版实际是 "Free Learning Edition"，仅允许学习/个人用途，商用需联系作者——清单原文只写"免费"，已加注。
3. **价格误判修正**：UI-02 Paper GUI 在 itch 上是**付费 £3.25**（清单原文待确认）；E2 三个纸张音效包（Stormwave $9.99 / Sound Works 12 约$5 / Miotto $9.99）**全部付费**，执行者均转为用户；Om-Official 曲包 **$19**。
4. **备选材质弃用**：ambientCG Wood064 页面存在但为青苔湿木（Green/Mossy/Wet），TEX-04 钉死为 Poly Haven `wood_table`。
5. **未能完全核实**：Sonniss GDC 包的 Track List 内容未逐条核对（cafe/room tone 类条目存在性待下载前确认）；thesoundrack《Reading & Writing》价格状态未见到最低价字段（页面无 "Buy Now" 提示，疑为免费或随意定价）；Ovani 官网价格（约 $50）未核实；itch.io 页面有反爬，价格均来自搜索快照，以下载时页面显示为准。

## 7. 验收

1. `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/vite/bin/vite.js build` 都通过。
2. 启动 dev server，用 `node tools/shot.mjs` 截取以下画面：
   - 主菜单 `?screen=home`
   - 大厅 `?screen=lobby`
   - 对局 `?screen=game&mode=tea`
   - 结算 `?screen=result&mode=relay`
   - 卷帘转场：在大厅按 Esc 后 200ms 截图
   和改动前对比：纹理和字体已经生效，文字清晰可读，布局没有错位。
3. **没有外部网络请求**：在页面里执行 `performance.getEntriesByType('resource').filter(r => !r.name.includes('localhost'))`，结果应该是空数组。
4. 体积符合 §1 的预算，在报告里贴出 `public/assets` 各目录的大小。
5. `CREDITS.md` 和 `licenses/` 能和放进仓库的每一个素材一一对应。
6. 回报以下内容：
   - 已完成的素材 ID
   - 跳过的素材 ID 和原因
   - 「需用户采购」的候选：名称、价格、链接
   - 「需约稿」需求单的位置
   - lucide 图标到新图标的对照表
   - manifest 里还缺失的条目

## 8. 建议的执行顺序

1. P0 材质（TEX-01、03、04）和 P0 字体（FNT-01、02、03）：这一步最能马上改善画面质感
2. P0 音效和环境音：先只放文件、写 manifest
3. P1 素材：TEX-02、05，FNT-05，UI-01、02，ICO-01，以及 P1 音效
4. 整理付费候选清单和约稿需求单（C、D、F、G 节）
5. 按 §7 验收并回报
