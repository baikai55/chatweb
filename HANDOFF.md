# 交接说明

给下一个接手会话看的。项目背景、使用和部署方式看 `README.md`。本文件顶部的
「已完成且验证过」「最近完成」和「当前仍需验证」是当前事实来源；后半部分保留的是
按时间追加的历史记录，若旧描述与顶部或代码冲突，以顶部和代码为准。本机的
`C:\Users\99037\.claude\plans\unified-whistling-fox.md` 只是历史资料，不是仓库依赖。

## 2026-08-19 项目审查与整改清单

本轮先做了只读全仓审查。基线结果：`pnpm check`、`pnpm test`（30 个文件、
276 个用例）、`pnpm build` 均通过，`pnpm audit --audit-level moderate` 未发现已知漏洞；
但安全边界、异步数据可靠性和浏览器级测试仍落后于功能增长。整改按下面顺序推进，
不要用组件拆行数或纯样式整理替代高优先级修复。

### 本轮已完成

1. **Worker 访问边界**：未配置 token 时不能再把可伪造的 `Origin` /
   `Sec-Fetch-Site` 当成生产鉴权；服务端密钥代理必须失败关闭；匿名搜索/上传若保留，
   必须是显式部署开关。代理响应也不应对任意来源返回 CORS `*`。
2. **上传内存上限**：不能只信 `Content-Length`，省略或伪造长度时也要按实际流入字节
   截断，避免在 `formData()` / `arrayBuffer()` 完整缓冲后才判断超限。
3. **聊天历史竞态**：IndexedDB 首读完成时要与加载期间的新会话合并，不能用旧快照
   整体覆盖内存状态。持久化失败必须能被上层感知，不能让用户误以为刷新后仍会保留。
4. **首包分割**：聊天保留首屏，设置、生图、视频、语音改为按需加载；以生产构建产物
   为准比较体积，不只消除 Vite 警告。
5. **安全回归与崩溃恢复**：Markdown 清洗新增真实 DOM 的 XSS 回归；顶层 React
   Error Boundary 在组件渲染失败时提供重载入口，不再整页无提示白屏。

最终验证：`pnpm check`、`pnpm test`（32 个文件、291 个用例）、`pnpm build`、
`pnpm audit --audit-level moderate`、`git diff --check` 均通过。生产构建把设置、生图、
视频、语音拆为异步 chunk；首屏 JS 从约 875 KB / gzip 270 KB 降到约 749 KB /
gzip 234 KB。入口仍超过 500 KB，后续需继续拆聊天和共享传输代码，不能靠调高警告阈值掩盖。

### 第二轮已完成

1. **统一请求超时与取消语义**：普通建连/JSON/文本默认每阶段 60 秒，音视频正文默认
   120 秒，图片沿用可配置的 300 秒等待上限，视频轮询增加 30 分钟总上限。超时统一为
   `TimeoutError`（408 / `request_timeout`），用户主动取消仍保留 `AbortError`。聊天和图片
   SSE 建连后继续按静默时间控制，并回归了响应头返回后“停止”仍能中止底层流。
2. **移动端和键盘可访问性**：移动侧栏关闭时移出 Tab 顺序，打开时隔离主内容、聚焦关闭
   按钮，支持 Escape 并在关闭后归还焦点；只在悬停出现的删除/消息操作按钮也会在键盘
   聚焦时显示。关键图标按钮补齐可访问名称。
3. **持续集成基线**：固定 Node 22.23.1、pnpm 11.5.2 和 Node 22 类型定义；GitHub Actions
   使用 frozen lockfile，执行 `check/test/build/audit`，并限制只读仓库权限和并发重复运行。

最终验证：frozen lockfile 安装、`pnpm check`、`pnpm test`（36 个文件、315 个用例）、
`pnpm build`、`pnpm audit --audit-level moderate`、`git diff --check` 均通过。构建仍只有
主聊天包超过 500 KB 的已知提示。

### 后续仍需处理

1. `/__api/auth` 增加部署层或持久化的限流/失败退避；proxy 增加路径、方法、请求体和
   配额白名单。前端 proxy 模式尚未闭环，完成前不能把它当作现有的安全分享方案。
2. Markdown 已补基础 XSS 回归；后续继续扩充浏览器差异与 mXSS 语料，保持无第三方
   脚本，评估 Trusted Types，并尽量收窄 CSP `connect-src`。
3. 增加 Playwright 自动化冒烟，覆盖移动端侧栏焦点、键盘操作、PWA 更新、录音权限、
   流式聊天，以及 Chromium/Safari 的媒体差异；本轮补了移动侧栏组件回归，但真浏览器
   媒体和跨浏览器行为仍需覆盖。
4. 拆分 `settings-view.tsx`、`chat-panel.tsx`、`voice-panel.tsx` 等大组件时，优先提取
   业务 controller hook 和状态机，不要只搬 JSX。整理 transport 的 URL、模板、JSON path
   等共享依赖，并为 `Backend` 配置设计显式 schema 版本迁移。
5. 把 R2 lifecycle、`workers_dev`、密钥强度、部署回滚和可观测性纳入可验证发布清单。

## 已完成且验证过

跑过 `pnpm check`、`pnpm test` 和 `pnpm build`，都干净。Worker 用 `wrangler dev` 实跑过。

| 模块 | 文件 | 状态 |
|---|---|---|
| SSE 解析 | `src/transport/sse.ts` | ✅ 含 90s 静默超时、8MB 缓冲上限 |
| chat/completions 适配 | `src/transport/chat-completions.ts` | ✅ 原生搜索有真实上游证据；函数工具循环和多模态请求体有单测，DeepSeek + Exa 完整循环待最终复核 |
| 错误解析 | `src/transport/errors.ts` | ✅ 兼容四种错误体形状；费解的报错补人话，有单测 |
| 后端配置存储 | `src/backends/backend-store.ts` | ✅ localStorage + zod；语音路由引用已有后端并可引用自定义 TTS 路由，旧 `sttProvider` 保留兼容 |
| 模型目录 | `src/backends/model-catalog.ts` | ✅ IndexedDB 只读与手动刷新分离；曾用 88 个线上模型 ID 回归（CPA 68 + grok2api 20，当时快照） |
| IndexedDB | `src/shared/db/idb.ts` | ✅ 手写封装，无第三方依赖；v2 加了 generations |
| 会话存储 | `src/features/console/chat-store.ts` | ✅ 已从 localStorage 迁到 IndexedDB |
| 生成记录 | `src/features/history/generation-store.ts` | ✅ 图片/视频/语音共用，每后端每面板 50 条；列表 portal 到侧栏 |
| Markdown + XSS 清洗 | `src/features/console/markdown.ts` | ✅ 从 grok2api 移植 |
| 聊天面板 | `src/features/console/chat-panel.tsx` | ✅ 流式/推理/工具/停止/错误/图片输入/可选麦克风转写/单条消息操作 |
| 模型选择器 | `src/features/console/model-picker.tsx` | ✅ 搜索 + 分组 |
| 侧栏 + 四模式 | `src/app/app-shell.tsx` | ✅ 按手勾的面板显隐、移动端抽屉 |
| 会话状态 | `src/features/console/use-chat-sessions.ts` | ✅ 侧栏历史与聊天面板共享 |
| 生图面板 | `src/features/image/image-panel.tsx`、`src/transport/images.ts` | ✅ 自适应尺寸、URL/Base64、流式兼容、全屏缩放查看与下载 |
| 视频面板 | `src/features/video/video-panel.tsx`、`src/transport/videos.ts` | ✅ 生成/编辑/延长、媒体上传、轮询、取消与播放 |
| 语音面板 | `src/features/voice/voice-panel.tsx`、`src/transport/voice.ts` | ✅ TTS/STT 可跨后端，支持 Grok 原生/OpenAI Audio/自定义 TTS 路由；声线仅手动加载 |
| 语音路由 | `src/transport/voice-routing.ts`、`src/transport/tts-routes.ts` | ✅ STT/TTS 各自引用已有后端；支持 MiMo Chat TTS 模板、自动协议、旧配置回退、失效路由与 proxy 错误 |
| 设置页 | `src/features/settings/settings-view.tsx` | ✅ 后端可编辑、面板手勾、模型归类/联网方式覆盖、图片/TTS 路由、联网源、STT/TTS 供应商与模型、行为设置、删除全部记录 |
| 图片路由 | `src/transport/image-routes.ts` | ⚠️ 单测过，未打真后端 |
| 行为设置 | `src/shared/settings/app-settings.ts` | ✅ 提交方式、清空输入、完成通知、图片等待上限、函数搜索源 |
| Worker | `worker/*.ts` | ✅ R2 上传、搜索聚合/鉴权/响应上限、路径穿越、CSP |

三个创作面板已经在 `src/app/app.tsx` 接入，原来的 `ComingSoon` 已删除。
同时修正了聊天默认模型候选：聊天会话只使用已保存的 chat 模型，不会误选图片或视频模型。

## 最近完成（自定义 TTS 路由与 MiMo Chat TTS）

- `Backend.customTTSRoutes` 保存供应商自己的 TTS 请求/响应模板；`voiceRouting.tts.routeId` 引用路由。旧配置解析时自动补空数组和空 route id。
- 「设置 → 语音」可选择实际供应商，一键创建 MiMo 模板、编辑 JSON、校验和删除。路由 id 保存后禁止修改；仍被任一后端的 TTS 配置引用时禁止删除。
- TTS 卡片新增“请求路由”：留空使用 `auto` / `grok-native` / `openai-audio` 内置端点；选择自定义路由后优先按模板请求，路由丢失时明确不可用，不静默回退 `/audio/speech`。
- `MIMO_CHAT_TTS_ROUTE` 调用 `POST /chat/completions`，发送 `assistant` 文本与 `audio.voice/format`；默认 `mimo_default` + WAV，兼容 `choices.*.message.audio.data`、`audio.data`、顶层 `data`。
- 模板变量为 `model/text/voice/format/speed/language`。语音页只显示模板实际使用的参数；MiMo 因此显示声线和格式，不显示语言、语速。
- 推荐组合：硅基流动 `FunAudioLLM/SenseVoiceSmall`（备用 `TeleAI/TeleSpeechASR`）走 `openai-audio` 的 `/audio/transcriptions`；小米 `mimo-v2.5-tts` 走上述 MiMo Chat 自定义路由。
- 模型和声线仍严格手动获取：打开设置、切换供应商、选择路由都不会主动请求上游。

本轮验证：`pnpm check`、`pnpm test`（27 个文件、244/244）、`pnpm build`、`git diff --check` 均通过；未向真实语音供应商发请求。Vite 仅保留主包超过 500 KB 的体积提示。

## 最近完成（STT/TTS 复用后端与手动获取模型）

- `Backend.voiceRouting` 为 STT、TTS 分别保存 `{ backendId, model, protocol, routeId? }`。空 `backendId` 表示当前后端；新配置只引用「后端」里已有的地址和 API key，不再复制敏感字段。两条路由可以引用不同供应商。
- 「设置 → 语音」现在有独立的 STT/TTS 卡片。所有后端的模型目录只通过 `readModelCatalog()` 从 IndexedDB 读取；切换供应商只更新本地草稿并清空上一家的模型选择，只有用户点击「获取模型/重新获取」才对指定后端调用 `refreshModelCatalog()`。模型分类只决定推荐排序，目录中的其他模型仍可选。
- 聊天麦克风与语音页 STT 共用 STT 路由，语音页 TTS 使用 TTS 路由；历史记录保存实际请求供应商的 backend id、名称和协议。
- MiMo 自定义路由编辑器只暴露请求格式 `path/method/query/body`；供应商 URL/Key 来自后端绑定，响应取值、MIME、默认声线和路由元数据由内置模板维护。`path` 必须是相对于供应商 Base URL 的路径，完整 URL 会在保存和请求前被拒绝。
- 协议支持 `auto`、`grok-native`、`openai-audio`。`auto` 将 grok2api 解析为原生 `/stt`、`/tts`，其他方言解析为 OpenAI `/audio/transcriptions`、`/audio/speech`；用户可手动覆盖。OpenAI TTS 使用 `model/input/voice/response_format`，OpenAI STT 不发送 Grok 专用的 `format`。
- `/tts/voices` 不再自动请求：Grok 原生模式只有点击「加载声线」才联网；OpenAI Audio 没有通用声线目录，完全不探测未知端点，voice ID 可手填且默认 `alloy`。
- `mode:"proxy"` 的语音引用当前明确不可用，因为前端语音链路尚未接入 Worker 代理。上一版的 `sttProvider` 和 `chatInputSTTModel` 仍保留回退：旧独立 STT 能匹配已有 URL+Key 时复用后端，匹配不到仍沿用旧地址直连；新 `voiceRouting` 一旦保存即优先。

本轮验证：`pnpm check`、`pnpm test`（26 个文件、221/221）、`pnpm build`、`git diff --check` 均通过；没有向真实供应商发请求。真后端与浏览器麦克风仍见下方待验证项。

## 最近完成（生图查看与自适应尺寸，`1a3593c`）

- 生图固定尺寸默认值从 `1024x1024` 改为 `auto`，仍可选择固定尺寸或宽高比；请求模板会原样发送 `size:"auto"`。
- 点击结果图进入全屏查看器，支持 1x–5x 缩放、按钮/滚轮/双击/双指操作、拖动、键盘 `+`/`-`/`0`/方向键/`Escape`、焦点锁定和关闭后还焦。
- 缩放和平移约束抽到 `image-viewer-transform.ts`；新增 1 个测试文件、8 个用例。全套因此增至 20 个测试文件、184 个用例。

## 最近完成（混合联网搜索与 function tool，`da2df55`）

- 每个已保存的聊天模型在「模型」设置中独立选择「自动 / 原生 / 函数」。自动路由 Gemini 到 `google_search`、Grok 到原生 `web_search`，其他模型走标准 `type:"function"` 的 `web_search`；手动选择会覆盖自动路由。
- 函数路径在 `src/transport/chat-completions.ts` 内维护 `assistant.tool_calls -> /__api/search -> role:tool` 循环，按流式 `index` 拼接参数；每个用户问题最多处理两次搜索调用，重复查询复用结果，搜索失败也回填为工具结果；中间工具消息不写入 IndexedDB 历史。
- `worker/search.ts` 支持 Exa、Bing RSS、DuckDuckGo、SearXNG、Tavily、Serper 和自动兜底。`auto` 有付费 key 时先用 Tavily/Serper，否则从匿名 Exa MCP 的 `web_search_exa` 开始，再按 Bing RSS、SearXNG、DuckDuckGo 兜底；查询只规范 Unicode 和空白，不做语义改写或相关性猜测。入口同时限制查询/请求/响应大小，校验公网地址与重定向，并沿用同源/同站或 token 鉴权。
- 「联网」设置保存函数搜索源、API key 和自定义 SearXNG 地址；原生搜索不读取这些配置。Worker 侧可用 `SEARCH_*` 环境变量提供默认值。

当前联网证据边界：Grok 原生搜索和 DeepSeek 原生工具 400 都有真实上游响应；本地 Worker 已用完整香港天气问题真实调用 Exa，约 3.7 秒返回 6 条结果；浏览器函数工具循环由单测覆盖。Exa 接入后还应只发一次完整自然问题，复核 DeepSeek 从 function call 到最终引用结果的端到端链路，不要用短句或空请求反复探活。

当前工作树运行过 `pnpm check`、`pnpm test` 和 `pnpm build`，均通过；20 个测试文件、184 个用例全过。Vite 仅提示主包超过 500 KB，不影响构建产物。

## 历史记录（浏览器录音与聊天语音输入，`da2df55`；配置层已被上面的语音路由取代）

- 设置页新增独立「语音」标签，集中放聊天麦克风开关，以及当前后端的聊天 STT 模型。聊天麦克风默认关闭；聊天输入框采用微信式的「点麦克风切换、按住整块输入区域说话」交互，语音页录音入口固定为按住说话。
- `BrowserAudioRecorder` 是不依赖 React 的录音状态机，处理权限迟到、重复停止、最短时长、空音频、编码格式、stop watchdog 和所有媒体轨道释放；React Hook 额外在卸载、页面隐藏和 `pagehide` 时清理。
- `AudioRecorderButton` 同时支持 Pointer Events、pointer capture、键盘 Enter/Space 和屏幕阅读器虚拟点击。聊天输入框与语音页共用该组件，录音文件支持 WebM/Opus、Ogg/Opus 和 M4A。
- 聊天录音只使用当前后端明确选择且仍有效的 STT 模型，自动识别语言，结果以函数式更新追加到当前草稿，不自动发送。STT 使用独立的 AbortController 和会话序列号；切会话、切后端、离开聊天页或主动取消时，迟到结果不会写进新会话。
- 语音页录完后复用已有文件校验、预览和手动提交转写流程。实时语音通话仍暂缓。

录音、音频文件、STT 传输、设置迁移和草稿合并等相关 8 个测试文件共 59 项通过；真麦克风交互仍需在 HTTPS/localhost 的浏览器环境做人工冒烟。

## 历史记录（语音现有链路修复；当时麦克风与实时通话暂不实施）

用户当时明确下一阶段想做「语音输入、麦克风录音、实时语音通话」，但要求先把协议和产品
形态沟通清楚，所以该轮没有提前实现。当时也没有语音路由，只有图片支持请求
路线/自定义格式，语音只走 grok2api 原生 `/tts`、`/stt`、`/tts/voices`；当前实现见顶部最新一节。

本轮先修了现有语音页的确定性问题：

- `capabilities=[]` 代表首次未配置、全部显示。此前点击一个亮着的能力会反向变成
  「只开启这一项」；现在会正确按「全部减去该项」处理，并至少保留一个工作区入口。
- STT 选文件和提交前都会校验空文件、100 MB 浏览器安全上限、音频 MIME/扩展名和
  常见容器文件头，页面明确列出接受的格式；这不是上游能力探测，上游更小的限制仍
  以真实响应为准。
- 「返回时间戳」此前只发 `with_timestamps`，但结果类型、解析、UI、历史都不承接，
  且已知部署会 503；本轮从 UI 移除，底层可选参数保留给以后明确协议后使用。
- 语音请求运行时，侧栏历史的新建、打开、删除、清空全部禁用，避免切模式后取消按钮
  消失以及旧请求覆盖历史选择。历史回放会恢复完整 TTS 文本、模型、声线、语言、语速、
  格式、时长，以及 STT 的模型、选择语言、识别语言、时长和词级结果。
- 生成历史异步首读不再覆盖加载期间刚产生的新记录；内存与 IndexedDB 都限制为最新
  50 条。长 TTS 文本仍用 40 字标题显示，但全文单独存在 params，回放不会再截断。
- 传输层修正了 `application/octet-stream` 压过所选 codec、URL/base64 歧义、data URL
  MIME 未规范化的问题，并补齐声线、TTS 多种响应、STT FormData/响应、错误和取消测试。

新增 4 个测试文件、29 个用例；全套现为 9 个测试文件、88 个用例。修复时不需要真实
API Key，也没有读取或写入用户密钥。真后端验证时让用户把 Key 放在本地未跟踪配置或
页面设置，不要在聊天里传明文。

最终验证：`pnpm check`、`pnpm test`（88/88）、`pnpm build`、`git diff --check` 均通过；
构建只有既有的主包超过 500 KB 提示。

## 本轮（对话支持带图）

用户反馈「现在对话不能带图」。已把图片输入完整接进聊天链路，不借用生图面板，
也不依赖 Worker/R2。`pnpm check` / `pnpm build` 干净，`pnpm test` 59 个用例全过。

**1. 根因是协议类型只允许字符串**：`ChatMessage.content` 原来写死成 `string`，
所以 UI 就算选到图片也没有合法形状能发。现在 `src/transport/types.ts` 同时接受旧的
字符串和 OpenAI Vision 内容数组：`{type:"text",text}` +
`{type:"image_url",image_url:{url,detail}}`。没有图片时仍发字符串，旧会话和只认
纯文本的后端不受影响；有图片时 `buildRequestBody` 原样透传内容数组。

`readChatContentText()` 统一从两种形状取文字，聊天标题、复制、Markdown，以及少数
后端返回的流式/非流式 text part 数组都走这一个入口，不会把结构化回复误判成空。

**2. 输入端是移动端也能用的一整套交互**：输入框旁加图片按钮（`multiple` +
`accept="image/*"`），同时支持粘贴截图和拖拽；发送前显示固定尺寸缩略图，可逐张移除。
允许纯图片消息。发送后先把用户消息落到会话再发请求，所以图片立即出现在消息流里，
首个响应片段前停止也不会把它弄丢。历史回看、删除和重新生成直接复用消息里的内容数组。

**3. 图片以内联 data URL 保存**：聊天本来就直连用户配置的后端，data URL 可以直接
进入标准 `image_url.url`，不需要先把私人图片传到 R2 变成公网地址。内容数组随会话
存进 IndexedDB，无需升级数据库；刷新后仍能显示和重发。代价是 Base64 比原图大约
三分之一，所以限制为每条最多 4 张、单张 10 MB、原始文件合计 20 MB。

只接受明确的栅格图片 MIME 和 `data:image/...;base64,`；SVG data URL 被拒绝，避免
把主动内容存进历史再通过原图链接打开。能力仍然**不按模型名猜**：任何聊天模型都能
选图，不支持视觉输入就让上游返回真实错误。

**4. 顺手收紧了请求生命周期**：切会话、删当前会话、清空或切后端会中止并失效旧请求，
旧响应不能再把已删会话写回来；同步请求引用也挡住了 React 状态刷新前的快速双击，
避免视觉请求重复扣额度。停止时不再在 state updater 里做持久化副作用。

**测试**：`chat-completions.test.ts` 新增 3 个多模态用例，覆盖内容数组无损透传、
旧字符串共存、非流式 text part 响应和实际 fetch 请求体；新增
`chat-store.test.ts` 3 个用例，覆盖旧文本标题、多模态标题和纯图片标题。全套 59 个。

## 本轮（侧栏删除确认 + 三个媒体面板新建）

用户反馈「左侧存的消息记录单个删除要点确定」。现在对话、图片、视频、语音四类
侧栏历史的单条删除都使用两步确认：第一次点击垃圾桶变成红色「确定删除」，4 秒内
再次点击才真正删除；超时会自动恢复，误触不会丢记录。标题旁原有的「清空」仍保持
同样的两步确认。

生图、视频、语音的历史列表顶部新增「新图片」「新视频」「新语音」按钮（加号图标），
点击后清空对应表单、结果和当前选中记录，但不删除历史；任务运行中按钮禁用。视频
额外用序列令牌挡住已重置页面被旧请求回写。

语音面板的显示和 TTS/STT 子模式只依据后端设置里的 `capabilities`。当该字段为空时
全部展示，并提示「是否可用以上游实际响应为准」；不再用 `flavor` 或某一台 CPA 的
404 实况推断 generic 后端是否支持语音。该轮 `flavor` 还会决定是否自动加载声线；
**当前行为已被顶部语音路由取代**：方言只参与 `auto` 协议解析，声线一律不自动请求。

本轮本地验证：5174 开发服务已停止，5173 返回项目页面；`pnpm check`、`pnpm test`
（5 个文件、59/59）、`pnpm build`、`git diff --check` 均通过。另用本地临时假后端
实点过三个新建按钮的表单重置、单条删除第一次只进入「确定删除」且 4 秒自动复位，
以及 `capabilities` 为空/明确勾选时的两种语音提示状态；临时服务和测试页已关闭。

## 本轮（语音页移动端顶部布局优化）

用户反馈语音页顶部的能力提示把「文本转语音 / 语音转文字」两个按钮挤变形。
现在顶部在窄屏改为上下两行：模式按钮固定在第一行，不收缩、不换行，空间极窄时
标签列表自身可横向滚动；能力提示独占第二行并完整自然换行。`md` 以上仍保持原来的
单行横排，提示靠右且最多占一半宽度，不改变桌面端的信息密度。

同时给模式组补了 `aria-label`，用 `aria-describedby` 关联能力提示，并把提示标成
`role="note"`。这既让屏幕阅读器能说明「设置中未指定能力」的含义，也没有把某个
后端或某次 CPA 404 实况重新写成运行时能力判断；显示逻辑仍然只看设置里的
`capabilities`。

浏览器实测 390×844：两个模式按钮都是 104×28，文字保持单行；提示完整显示为两行，
页面 `clientWidth/scrollWidth` 均为 390，没有横向溢出。1280×800 下模式组与提示仍在
同一行，页面 `clientWidth/scrollWidth` 均为 1280。测试用后端的能力勾选已恢复为原状，
临时视口覆盖也已重置。`pnpm check`、`pnpm test`（5 个文件、59/59）、`pnpm build`
和 `git diff --check` 均通过；构建只有既有的主包超过 500 KB 提示。

## 历史记录（图片超时可调 + 消息操作改成点开 + 侧栏清空）

用户在真机（移动端）用起来之后的四条反馈。`pnpm check` / `pnpm build` 干净，
`pnpm test` 53 个用例全过。

**1. 那个 HTTP 499 不是我们的 bug** —— 用户看到使用日志里
`Post "https://ai.xmiaom.com/v1/images/generations": context canceled` 一次 499，
紧跟一条成功。`ai.xmiaom.com` 是 CPA 背后的**上游供应商**，`context canceled`
是 Go 的 context —— 这是 CPA 取消了第一家上游又换了第二家，浏览器只发了一次。

但它暴露了一个真隐患：图片如果走 SSE，`readSSE` 的默认静默超时是 90 秒，
而生图本身就要 68–103 秒，加上 CPA 换家重试的静默时间，90 秒会把一次
**本来会成功**的生成掐掉。默认放宽到 300 秒，并按用户要求做成了设置项
（`imageTimeoutSeconds`，30–1800 秒，行为页最后一行）。

**2. DeepSeek 的 400 正是预期内的失败，但报错读不懂** ——
``unknown variant `web_search`, expected `function` ``。这说明上一轮"认不出厂商
也照发 `{type:"web_search"}`"的取舍是对的：**错误确实指得回来**。
但原文全是「deserialize the JSON body into the target type」，用户看不出是自己
点的那个开关引起的，所以 `errors.ts` 的 `annotate()` 里针对 400 + `web_search`
当时补了一句"把工具栏里的「联网」关掉"；当前提示已更新为优先把该模型切到
「函数」搜索，也可临时关闭联网。顺手修了 404 那条 —— 它还在让用户
"去设置里重新探测一次"，而探测早删了。相关行为由 `errors.test.ts` 钉住。

用户还提到「我在 opencode 让模型联网查东西是可以的」。那是两种机制：
opencode 把搜索做成**由客户端执行的 function tool**（模型发调用，opencode 自己
去搜再把结果喂回去），这里发的是 `{type:"web_search"}` 请**上游**用它的内置搜索。
上游没有内置搜索时前者仍然可用。要做到一样得实现工具调用循环 + 一个搜索源，
**当时没做，也没偷偷做；本轮已在顶部「混合联网搜索与 function tool」中完成。**

**3. 消息操作改成点开，加了复制和重新生成**（反馈：「不要一直显示着。
点一下在显示，点别的地方隐藏好了。再加个复制，刷新吧。看的是移动端」）：

上一轮的删除按钮在窄屏是 `max-lg:opacity-60` 常驻的 —— 每条消息挂一个图标很吵。
现在是 `selectedId` 控制：点消息展开，点别处收起（外层 div 一个 onClick，
气泡里 `stopPropagation`）；桌面端 hover 照样能出，两种输入方式各走各的。

按钮行**常驻占位但默认透明**（`h-6` + `opacity-0`），显隐不改变高度，
否则点一下整个列表会往下跳一格。

「重新生成」的语义：点在回复上 = 丢掉这条回复用它前面的上下文重问；
点在提问上 = 从这一问重来、后面全丢。丢掉的部分不进历史。

注意 `group/bubble` 是新加在外层包裹 div 上的，不是复用 `Message` 自带的
`group/message` —— 按钮行是 `Message` 的**兄弟**不是后代，用 `group/message`
选不中。

**4. 侧栏每个列表标题旁都有「清空」**（反馈：「加删除不是在对话上加，
是左侧面板的标题处。我看生图-历史-旁边那个清空就挺合适的」）：

会话列表补了「对话 (N)」标题行 + 清空，和三个生成历史长得一样。
新增 `clearScopeSessions(scope)`（只清当前后端）和 `useChatSessions().clearAll`。

两个清空都换成了 `ConfirmButton`（`src/components/ui/confirm-button.tsx`）：
第一下变「确认清空」，4 秒没有第二下自己变回去。删的都是攒了很久的东西，
而按钮就贴在标题旁，移动端误触没有找补余地；弹确认框对一个列表标题旁的
小按钮又太重。放着不管就是取消，不用另找地方点"否"。

## 更早的历史（不再替用户判断能不能用 + 历史统一到侧栏 + 单条消息可删）

四件用户反馈，都做完了。`pnpm check` / `pnpm build` 干净，`pnpm test` 44 个用例全过。

主线是一句话：**能力判定全交回用户，代码不猜。** 这一轮把上一轮删探测时
没顺手清掉的几处"程序内部替用户判断"也一起拆了。

**1. 联网搜索开关做得更显眼**（反馈：「搜索需要手动开关，也行。但是有点不明显」）——
原来是个光秃秃的地球图标按钮，加了「联网」文字标签，开启态用主色反相
（和发送按钮同一套语言，单色系里最强的"开着"信号）。

顺手修了个没人发现的 bug：原来禁用态是靠 `disabled` 属性，而 `buttonVariants`
基类里带 `disabled:pointer-events-none` —— 鼠标事件全没了，**那句解释"为什么用不了"
的 tooltip 根本弹不出来**。现在压根不禁用了，问题自然没了。

**2. 推理档位和联网搜索对所有模型开放**（反馈：「也都改成所有模型可选吧，
不限制了」）：

- 推理档位下拉不再要求 `activeModel.reasoning`，一直显示。
- 联网搜索按钮任何模型都能点。
- `webSearchSupport()` 改名 `webSearchNote()`，返回 `{known, note}` ——
  **只写 tooltip，不做拦截**。
- `buildTools()` 当时不再对认不出的厂商返回 `[]`。原来那样开关看着生效了其实
  什么都没发出去，是最糟的一种失败；当时 Gemini 发 `google_search`，其余一律发
  `{type:"web_search"}`。**这段已被顶部的按模型「自动 / 原生 / 函数」路由取代。**

风险评估：两个控件的默认值都是不发（`auto` / 关），所以**默认行为一点没变**，
真发出去一定是用户点过的。CPA 的模型名后缀 `model(high)` 在非推理模型上
理论上是安全的（后缀是在模型名解析/路由阶段剥掉的，早于选上游），但没实测过；
真出问题就把 `applyReasoningToModel` 里的 `flavor !== "cpa"` 分支改成全走标准字段。

**3. 语音面板不再按方言拦人**（反馈：「语音点进去显示'当前后端不支持语音面板'。
这个不应该程序内部判断。设置-后端-不是有个显示哪些面板吗？按这个来判断」）：

`isGrok` 那道硬门删了，只看 `backend.capabilities`。实测 CPA 的 `/tts` `/stt`
确实全 404，但那是那一台部署的实况，不是 `cpa` 这个方言的定义。
现在不再在标题栏用方言写「语音端点未必存在」这类提示；面板和两个子模式都按
`backend.capabilities` 展示。该轮方言还用于决定声线列表是否自动拉取，不参与能力判断；
**当前实现只用方言解析 `auto` 协议，不再自动拉取任何声线。**

配套（历史行为，已被顶部新路由替代）：**声线列表只在 grok2api 上自动拉**，别的后端给一个「加载声线」按钮。
门一撤，CPA 用户点进语音面板就会自动打一发必 404 的请求 —— 那正是这个项目
一直在避免的事。不点也能用，上面的输入框可以直接填声线 ID。

**4. 四个面板的历史统一到左侧栏**（反馈：「对话的历史记录在左侧功能下边，
生图/视频/语音在内容区。统一在左侧好了」）：

用插槽而不是把状态提上去 —— `src/app/sidebar-slot.tsx` 里 `AppShell` 在侧栏
留一个 DOM 节点走 context 发下去，`GenerationHistory` portal 过去。
历史的状态（选中哪条、点回一条怎么恢复面板）跟各自面板绑得很紧，
硬提到 `Console` 得在三个面板之间来回传 record 和回调，插槽方案三个面板
内部一行都不用动。拿不到插槽时退回原地渲染。

插槽那个 `<div>` **始终挂载**，聊天模式下只是 `hidden` —— 卸了再挂的话
切到生图那一帧插槽还是 null，历史会先在面板里闪一下再跳到侧栏。

**5. 单条消息可删**（反馈：「单条聊天记录没法删除。需要加个删除」）：

悬停气泡外侧出现删除按钮。`Message` 是 flex 行、align=end 时整行反向，
所以同一个位置的元素在用户消息上落到左边、在回复上落到右边，一套写法两种对齐。
触屏没有 hover，窄屏常驻显示。

只删这一条，不连带删问/答 —— 想删整轮就点两下，比"我以为只删一条结果少了两条"强。
**已知代价**：删掉中间那条 user 之后会出现 assistant 挨着 assistant，
有些上游要求严格交替会 400。这是用户自己剪的，报错指得回来，没在代码里替他挡。

流式过程中不给删：`send()` 里捏着一份发请求那一刻的 messages，结束时会用它
拼上回复整个覆盖回去，这中间删掉的会原样长回来。所以 streaming 时按钮不渲染。

顺手修了个真 bug：删到一条消息都不剩时，`saveSession` 对空会话是直接 return
（本来是为了不给空壳落盘），**结果旧记录还躺在 IndexedDB 里，一刷新整段对话复活**。
`commit` 现在遇到空 messages 会去 `deleteSession`。

**测试**：`chat-completions.test.ts` 扩到 13 个用例，直接盯 `buildRequestBody`
产出的请求体 —— 推理档位（auto 不发 / CPA 后缀 / 标准字段 / 手写后缀不叠加）
和搜索工具（关着不发 / Gemini 特殊形状 / 认不出也照发通用形状）。
全套 44 个。

## 更更早（删掉能力探测 + 获取模型按钮 + 四面板历史记录）

三件用户点名的事，都做完了。`pnpm check`、`pnpm build` 干净，`pnpm test` 35 个用例全过。

**1. 能力探测整个删掉** —— 用户原话：「这个探测功能不要了，有些站发现测活会封号的」。

`src/backends/capability-probe.ts` **已删除**，不是隐藏按钮。原来它对 5 个端点各发一次
无鉴权 `POST {}`，靠「404 就是没这个路由」推断能力 —— 判定逻辑本身是对的
（也确实不能用 OPTIONS，CPA 的 CORS 中间件对任何路径包括不存在的都返 204），
但密集小请求会被一些站判成测活直接封号，这个风险不值得为一个便利功能承担。

探测原本提供两样东西，分别有了替代：

- **侧边栏显示哪几个面板** → 设置页手动勾（`backend.capabilities`）。
  **为空表示「不知道」，此时全部显示** —— 老配置和导入的配置会走到这里。
  宁可让用户点进去看到真实报错，也别把功能藏了。
- **后端方言** → 挪到拉模型列表时白捡：`readFlavor(headers)` 只读 `/models` 的响应头
  （`X-CPA-Version` / `X-Request-ID`），而这个请求本来就要发，不额外出网。

`Backend.probedAt` 字段一并删了，i18n 里的 probe* 文案也清了。

**2. 模型列表改成手动拉** —— `model-catalog.ts` 拆成两个函数：

- `readModelCatalog(backend)` —— **只读 IndexedDB 缓存，一个请求都不发**。进页面走这条。
- `refreshModelCatalog(backend, signal?)` —— 真正出网，只有点设置页的「获取模型」按钮才调。
  一次拉取实际是三个请求（`/v1/models` 加两个富字段端点）。

`isCatalogStale(fetchedAt)` 超过 24 小时返回 true，列表底部标一句「可能过期了」，
**但不自动重拉**。原则是所有出网请求都由用户点出来。

**3. 联网搜索按钮**（用户问「联网搜索我看怎么没有了」）—— 它其实没被删，是被
vendor 推断挡住了：模型 id 里没写 gemini / grok 时整个按钮凭空消失，看起来像功能丢了。
新增 `webSearchSupport(model)` 返回 `{supported, reason}`，按钮**一直渲染**，
不支持时是禁用态 + tooltip 说明原因（Claude 得走 `/v1/messages`，还没做）。
注释里写死了「不要用它决定按钮显不显示」，免得下次又被改回隐藏。

**4. 生图/视频/语音的历史记录** —— 用户原话：「只有聊天有记录保存，这个都得有比较好一点」。

新增 `src/features/history/`：

- `generation-store.ts` —— IndexedDB `generations` 表（DB_VERSION 1→2），
  索引 `[scope, kind, createdAt]`，一次查询直接拿到「当前后端 + 当前面板」那批。
  每后端每面板留最近 50 条，超了删最旧的。
- `use-generation-history.ts` —— `useGenerationHistory(scope, kind)`。
- `generation-history.tsx` —— 面板顶部的折叠抽屉，逐条删 + 清空本面板。

**存 URL 还是存字节，按来源分**（`toAsset()` 里的判断）：

| 来源 | 存法 | 为什么 |
|---|---|---|
| 图片 `data:` URL | 转 Blob | IndexedDB 存二进制比存 base64 文本省约四分之一 |
| 图片远程 URL | 原样存字符串 | 抓字节没必要 |
| 视频 | 一律远程 URL | 链接会过期，但那是链接本身的性质，抓字节也救不了已经过期的 |
| TTS 音频 | **必须转 Blob** | TTS 只有二进制响应，`blob:` URL 一刷新就失效，不转就等于没存 |
| STT | 只有文本 | —— |

读取时 `hydrateAssets(record)` 把 Blob 现造成 `blob:` URL 并返回 `release()`，
面板用 `releaseRef` 在切换记录和卸载时撤销，否则每点一条历史泄一个 object URL。

**5. 删除全部记录** —— 设置页「行为」标签底部，两步确认。
清掉所有后端的对话和生成记录，**但不动后端配置、密钥和模型缓存** ——
那些删了得重新填一遍，跟「清历史」不是一回事。清完通过 `historyToken` 让会话 hook 重载。

## 更更更早（设置页重做 + 图片路由）

用户点名要借鉴 `gpt-image-playground`，选了四块全做。都做完了，`pnpm check`、
`pnpm build`、`pnpm test` 干净。设置页从 `app.tsx` 里搬进
`src/features/settings/settings-view.tsx`，拆成四个标签页。

**1. 后端可编辑**：名称 / 地址 / 密钥就地改，有「还原」；能力五个 chip 可手动勾；
当时还有个「重新探测」按钮 —— **下一轮已整个删除**，见上面的「本轮」。

**2. 图片路由**（核心）—— `src/transport/image-routes.ts`：

同一个图片模型在不同后端认的端点不一样（CPA 上 Nano Banana 拒绝
`/images/generations`），这事从模型 id 看不出来，所以做成可配路由：

- 内置 `images`（`/images/generations`）和 `chat`（`/chat/completions`），
  **两条本身就是用 `CustomImageRoute` 描述的** —— 执行代码只有一套，
  用户写自定义路由时也就有了现成例子可抄（设置页有「复制改」按钮）。
- 请求体是模板：整串 `"$prompt"` 按原类型替换，**取不到值的键整个剪掉**，
  可选参数因此不用写条件分支；串内 `${prompt}` 按字符串插值。
  `size` 有值时自动丢掉 `aspectRatio`（一起发多数后端报冲突），
  这个取舍做在 `toTemplateValues` 里，模板不用表达"二选一"。
- 取图路径 `imageUrlPaths` / `b64JsonPaths`：点号分隔、`*` 展开数组。
  **留空就用通用提取，填了但没命中也回落到通用提取** —— 路径写错一个字
  就什么都拿不到，而"上游没返回图片"这个报错完全指不到是配置写错了。
- `routeVariables()` 反推模板真正引用了哪些变量，**面板据此隐藏用不上的控件**。
  走 chat 路由时尺寸/质量/返回格式直接不显示 —— 摆在那里但不会被发出去就是骗人。
- 通用提取新增 `readImagesDeep()`：在原 `readImages()` 之外还扫正文里的
  `![](url)`、裸图片链接和 data URL。走 chat/completions 生图时图片经常只在
  正文 markdown 里，原来的字段扫描扫不到。裸链接只认带图片扩展名的，
  且只扫 `content`/`text`/`output_text`/`markdown` 这几个键 ——
  否则错误信息里的链接也会被当成图片。

**3. 模型归类覆盖**：勾选保存后的模型行下面多一行控件，归类下拉（`auto` 表示
用推断结果）+ 图片模型额外一个路由下拉。只对已保存的模型显示 —— 没保存的模型
改归类没有意义，68 行全塞控件也没法看。被覆盖过的 kind 徽章会变色。

**3.5 模型页改成攒着改、点保存**（用户反馈：勾一下就刷新回顶部，体感不好）：

- 根因是 `savedModels` 和 `modelOverrides` 进了 react-query 的 query key，
  每勾一下都算一次新查询，列表整段变 loading 再挂回来，滚动位置直接丢。
  key 现在只留 `backend.id` + `baseURL`（真正影响网络结果的东西），
  勾选/归类这些只影响标注，用 `applyBackendConfig()` 在查询外面重算。
- 勾选、归类、图片路由三样一起进一个 `ModelDraft`，底部「保存 / 放弃」。
  `null` 表示没改动，干净时永远跟着后端配置走，不用写同步逻辑。
- 草稿 state 放在 `Console` 而不是设置页 —— 设置页一关就卸载，
  勾了一半跳去看一眼对话再回来不该白勾。
- 设置页排序换成 `sortForBrowsing()`，只按提供商和 id，勾选与否不影响位置。
  「已保存的排最前」那个排序只对模型选择器有意义，在这一页会让列表在手底下动。

**4. 行为设置** —— `src/shared/settings/app-settings.ts`（localStorage + zod，
和 backend-store 同一套路）：提交方式、提交后清空输入框、任务完成通知。
`shouldSubmitOnKey()` 统一四个面板的键盘判定；`enter` 档下 Ctrl/⌘+Enter 也照发，
这一档只是"多一种发送方式"，不该把另一种惯用手势变成哑键。默认 `enter` ——
聊天是主界面，回车发送是那里的通行约定，这样老行为不变。
通知只在 `document.hidden` 时发（人盯着看的时候再弹纯属打扰），
开关前先要权限，拿不到就不拨过去。

顺手修了一个真 bug：模型缓存只按 `backend.id` 存，**改了 baseURL 还会命中旧缓存**
（24 小时 TTL）。缓存记录现在带 `baseURL`，不匹配就重拉。

**测试**：装了 vitest，`pnpm test`。当轮 31 个用例覆盖模板展开、路由选择与回落、
`routeVariables`、`selectByPath`、以及各种响应形状的取图（含 markdown 正文、
去重、错误信息里的链接不误报）。这些都是纯函数，不打网络。
（下一轮加了 `chat-completions.test.ts` 的 4 个 `webSearchSupport` 用例，现在共 35 个。）

## 最早（用真实 key 实测后端）

两个后端的 key 都验证可用。实测发现并修掉了三个语音的真 bug —— 都是「UI 允许但
上游拒绝」，不实跑发现不了：

| 问题 | 上游原话 | 改在哪 |
|---|---|---|
| STT 默认「自动识别」必然 400 | `Field 'language' is required when 'format' is true` | `voice.ts` 只在有 language 时才发 `format=true` |
| 语速范围写错了 | `speed must be between 0.7 and 1.5` | 面板原来允许 0.25–4，改成 0.7–1.5 |
| aac / flac 编码不支持 | `422 Console 媒体上游返回 422` | 从格式下拉里删掉，只留 mp3/wav/opus |

`format=true` 的作用是把数字规范化（实测 `十一万五千六百九十九` → `115,699`），
所以选「自动识别」时会失去这个格式化 —— 选项标签已经写明了，不是静默降级。

另外把 opus 的 MIME 归一化了：响应头写 `audio/opus`，但负载魔数是 `OggS`（Ogg 容器），
`audio/opus` 不是浏览器认的 MIME，统一改成 `audio/ogg` 再建 Blob。

**模型分类回归**：把线上全部 88 个 id（CPA 68 + grok2api 20）喂给真实的
`classifyModel` / `isReasoningModel`，全部正确 —— 包括新出现的
`grok-imagine-video-1.5`（没被 image 抢走）和 `grok-4.20-0309-non-reasoning`
（没被反向误报成推理）。CPA 的模型数已经从 65 涨到 68，README 里的数字同步更新了。

## 当前仍需验证/继续做

1. 用 DeepSeek 函数搜索只发一次完整自然问题，复核 `function call -> Exa -> role:tool -> 最终回答与引用`。不要用 `hi`、空请求或连续低 token 问题测活。
2. 函数搜索的候选源共享 `SEARCH_TIMEOUT_MS` 总预算。Exa 若占满默认 7 秒，后面的 Bing RSS、SearXNG、DuckDuckGo 可能没有机会；当前网络下后三者曾超时，部署环境和匿名 Exa 的长期稳定性仍需观察。
3. **服务端持有密钥只完成了 Worker 端**：`/__api/config`、`/__api/auth`、`/__api/proxy/*` 已有实现和测试，但前端尚未读取预置配置、创建 `mode:"proxy"` 后端或改写请求。README 已明确标成未接入。
4. 用一个确定支持视觉输入的聊天模型各发一次「单图 + 文字」和纯图片，确认 CPA / grok2api 对 data URL 的实际接受形状；再在移动端检查相册选择、粘贴、缩略图移除、停止和刷新历史。不要扫模型或参数矩阵。另观察几轮大图后的 IndexedDB 占用；当前有 4 张 / 单张 10 MB / 合计 20 MB 保护，但 data URL 仍比原图大约三分之一。
5. 部署环境验证视频源文件经 `/__api/upload` 上传到 R2 后，上游能否读取公网 URL。（本地没法验，必须真部署一次。）
6. 检查图片、视频面板的移动端布局、暗色模式、取消操作和错误状态；语音顶部已在 390x844 和 1280x800 验过。全屏图片查看器的真机双指缩放也应补一次人工冒烟。设置页现有六个标签，横向滚动已实现，仍可在真机复核。
7. **图片路由只做过单测，没打过真后端**。特别是这两条：
   - CPA 上把 Nano Banana 的路由切成 `chat`，看能不能真出图、图片在响应的哪个位置
     （通用提取够不够，还是得填 `imageUrlPaths`）。
   - grok2api 走 `chat` 路由生图。用户说它支持这个格式，但没验过响应形状。
   验的时候记住下面那条红线，一次一个请求，不要扫参数。
8. **本轮语音路由尚未打真供应商**：分别用一个 Grok 原生和一个 OpenAI Audio 后端各做一次 STT/TTS，确认 CORS、请求字段和响应形状；同时人工确认切供应商不联网、模型只在点「获取」后请求、Grok 声线只在点「加载声线」后请求。远程音频下载的 CORS、STT 大文件上限也还没测。`proxy` 语音是已知未接入，不要把它当成待测直连能力。
9. **此前新增，未实测**：IndexedDB 从 v1 升到 v2 的迁移只在全新库上跑过，
   带着旧会话数据的库升级没验；生成记录攒满 50 条后的裁剪也只是代码层面正确。
   还有 `hydrateAssets` 的 `blob:` URL 释放 —— 逻辑对，但没在真实使用中观察过内存。
10. **可选**：Responses 协议适配器（`src/transport/responses.ts`）。
   CPA 的 `/responses` 和 `/messages` 都确认存在（上一轮实测：无鉴权 401、带 key 400），
   要做的话有端点可打。目前只实现了 chat/completions；Claude 的客户端函数搜索已不依赖它，只有接 Claude 原生搜索才需要 `/v1/messages`。
11. **可选**：自定义路由暂不支持异步任务轮询。目前接触到的图片端点都是同步返回的，
   真需要时参照 `src/transport/videos.ts` 的轮询实现再加。

## ⚠️ 联调时的红线

**不要连续发大量低 token 的探测请求** —— 会被上游判定成测活行为，导致 API 被封。
上一轮就是这么踩到的，能力探测功能也因此被整个删掉。要验证协议行为时：
想清楚一次请求要回答哪几个问题，合并成尽量少的请求，不要写 for 循环扫参数矩阵。

配套的产品原则：**所有出网请求都由用户点出来**。进页面只读本地缓存，
模型列表、方言识别一概不自动触发。加新功能时守住这条。

## 设计约束（用户明确说过的）

- **配色已对齐** `https://not2api.yueming.uk/`：纯单色系，无彩色强调，
  发送按钮纯黑（深色模式反相）。已写进 `src/index.css`，只有 `--destructive` 保留红色。
- **不要按时段变化的问候语**（参考站有 "Lunch break thinking." / "Coffee and code."
  那一套，用户明确说不要）。空状态用朴素一句话。
- **模型不做「没保存就显示全部」的降级** —— 用户明确否决过。一个都没保存时
  给提示并引导去设置页。
- **不做能力探测**，用户明确否决过（「有些站发现测活会封号的」）。
  面板显隐手动勾，`capabilities` 为空时全显示。
- **别替用户判断"这个模型/后端支不支持 X"**，用户反复说过三次
  （探测、语音面板、推理档位与联网搜索）。判定都只是拿 id / 方言猜的，
  猜错就把能用的功能锁死，而用户看不出是"锁了"还是"没这功能"。
  能力开关一律交给设置页，代码顶多写一句提示。
- **不支持也不要隐藏、不要静默不发**。隐藏 → 用户以为功能没了；
  静默不发 → 开关看着生效其实什么都没做，是最糟的一种失败。
  让它发出去，让上游报错。
- 值得借鉴：`https://github.com/baikai55/gpt-image-playground`（已设为 public，TypeScript，
  142 个文件）。用户说它的设置页功能齐全。**本轮已借鉴**：custom provider 的
  `$` 模板 + 点号取图路径设计进了 `image-routes.ts`；`GeneralSettingsTab` 的
  「标签 + 控件 + 说明」行式布局进了行为设置页。参考源码临时下载在 `.ref/`
  （已 gitignore，只有四个文件：`types.ts`、`openaiCompatibleImageApi.ts`、
  `GeneralSettingsTab.tsx`、`ModelPicker.tsx`）。还没读过的：
  `src/lib/apiProfiles.ts`（914 行，多 API 配置档案的数据模型）、`src/lib/db.ts`。

## 联调需要的东西（不在仓库里）

两个后端的 API key **不在任何文件里**。需要联调时由用户在本地设置页或未跟踪的
`.dev.vars` 中填写，勿在聊天里提供明文（以下模型数量是当时实测快照）：

- CPA：`https://cpa.yueming.uk/v1` —— 68 个模型，全是第三方接入
- grok2api：`https://grok2.yueming.uk/v1` —— 20 个模型，独有 tts/stt

R2 桶名 `chatweb` 已填进 `wrangler.toml`。

### 两个后端的端点实况（上一轮实测记录，404 = 不存在）

这张表是**历史实测结果的留档**，不是运行时行为 —— 现在代码不做任何端点探测，
面板显隐完全看用户在设置页勾了什么。留着是因为下次要接新后端时，
知道这两台的实况能省事。

| 端点 | CPA | grok2api |
|---|---|---|
| `/chat/completions`、`/responses`、`/messages` | ✅ | ✅ |
| `/images/generations`、`/images/edits` | ✅ | ✅ |
| `/videos/generations` | ✅ | ✅ |
| `/tts`、`/stt` | ❌ 404 | ✅ |
| `/audio/speech`、`/audio/transcriptions` | ❌ 404 | ✅ |

当时实测的这台 CPA 部署**没有语音端点**，但它的模型表里有 8 个会被归类成 tts 的模型
（三个 Gemini TTS、`Gemini 2.5 Flash Native Audio Latest`、两个 Lyria、
`Gemini 3.1 Flash Live Preview`、`chatgpt-voice`）。

早先语音面板靠 `backend.flavor === "grok2api"` 把 CPA 整个挡在门外 ——
**本轮已删除**，用户明确否决（「这个不应该程序内部判断」）。上面这张表是
那一台部署的实况，不是 `cpa` 这个方言的定义。现在只看设置页勾了什么；
方言只在语音协议为 `auto` 时选择 Grok 原生或 OpenAI Audio，不会自动拉模型或声线。

grok2api 除了 grok2api 原生的 `/tts` `/stt`，还额外提供 OpenAI 标准的
`/audio/speech` `/audio/transcriptions`。当前 `voice.ts` 两套都支持，由语音路由选择。

## 踩过的坑（别重复踩）

- **聊天带图和生图不是一条链路**。聊天图片是输入，走
  `messages[].content[].image_url.url`；生图面板是输出，走可配的图片路由。
  聊天直连后端，内联 data URL 不需要 `/__api/upload` 或 R2。不要为了复用视频上传
  把私人图片先变成公网 URL。data URL 会膨胀约三分之一，改数量/大小限制时要同时考虑
  `JSON.stringify`、fetch 和 IndexedDB 结构化克隆造成的多份内存；SVG data URL 不放行。
- **Nano Banana 系列在 CPA 上不能走 `/images/generations`**。它们确实是图片模型，
  分类没错，但 CPA 明确拒绝：
  `Model Nano Banana Pro is not supported on /v1/images/generations or /v1/images/edits.
  Use gpt-image-1.5, gpt-image-2, grok-imagine-image, grok-imagine-image-quality,
  or a configured openai-compatibility image model.`
  也就是说这台部署上只有 `gpt-image-2` 和 `grok-imagine-image` 系列能用图片端点，
  Nano Banana 得走 chat/completions。**没有改分类去隐藏它们** —— 换一台 CPA 部署
  只要把它配成 openai-compatibility 就能用，写死会误伤；而且上游这条报错本身
  已经把可用模型列全了，面板会原样显示给用户，比静默隐藏有用。
- **图片生成很慢**：`gpt-image-2` 单张实测 68 秒，加 `quality:"high"` 到 103 秒。
  SSE 的 90 秒静默超时对**非流式** JSON 响应不适用（那是整包等待），但如果以后
  给图片走流式，这个超时要重新评估。
- **CPA 的推理字段是 `delta.reasoning` 不是 `reasoning_content`**。源码分析会告诉你
  它统一成了 `reasoning_content`，那只对官方凭证上游成立；`openai-compatibility`
  类型的第三方上游是原样透传不翻译的。用户接的全是第三方，所以实际是 `reasoning`。
  解析器三个字段都认。
- **模型 id 格式不统一**，CPA 里同时有 `grok-imagine-video`、`Nano Banana Pro`、
  `Gemini 2.5 Flash Preview TTS` 三种风格。匹配前必须归一化分隔符
  （`normalizeModelId`），否则带空格的全漏。
- **`grok-4.20-0309-non-reasoning` 会被 `-reasoning` 规则反向误报**，必须先排除。
- **能力探测这条路整个废了**。曾经用无鉴权 `POST {}` 靠 404 判断路由是否存在
  （不能用 OPTIONS —— CPA 的 CORS 中间件对任何路径包括不存在的都返回 204）。
  判定逻辑本身没错，但密集小请求会被一些站判成测活封号，所以整个模块删了，
  改成手动勾。**别因为「这个逻辑挺聪明」再把它加回来。**
- **块注释里别写 `*/`** —— 上一轮在注释里写路径 `internal/translator/*/openai/...`
  把注释提前闭合了，构建直接炸。
- **`with_timestamps: true` 在这台 grok2api 上拿不到结果** —— 连续两次都返回
  503 `当前没有可用的上游账号`，而同时段不带这个参数的 TTS 正常 200。
  怀疑是时间戳走的上游池没配账号；当前 UI 已移除该开关，底层可选参数仍保留，
  后续若重新开放要先在目标部署复核协议和结果承接。
- pnpm 11 的构建脚本白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`，不是 package.json。
