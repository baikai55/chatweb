# chatweb

网页聊天 —— 连接任意 OpenAI 兼容后端，部署在 Cloudflare Workers。

前身是 grok2api 内置的「创作台」，把它从管理后台里抽出来做成独立应用：打开链接、填一次后端地址和密钥就能用，支持配置多个后端随时切换。

## 功能

- **对话**：OpenAI Chat Completions、图片输入、可选的麦克风语音输入、流式输出、推理过程、工具活动、停止生成和会话历史。
- **生图**：图片数量、自适应尺寸或比例、质量、URL/Base64 响应、全屏缩放查看、打开和下载。
- **视频**：文本/图片生成视频，以及视频编辑和延长；支持源媒体上传、异步任务轮询、进度、停止等待和结果播放。
- **语音**：支持 grok2api 原生与 OpenAI Audio 两套 TTS/STT 接口，可分别选择供应商和模型；支持声线、语言、语速、音频格式、播放下载，以及上传文件或直接用麦克风录音转写。

四个面板的历史记录都在左侧栏，刷新不丢。侧边栏显示哪几个面板由设置页手动勾选；
生图、视频、语音历史顶部也有对应的「新图片」「新视频」「新语音」入口。

## 快速开始

项目使用 pnpm。第一次运行先安装依赖，然后分别启动 Worker 和前端：

```bash
pnpm install
pnpm dev:worker       # 终端 1：Worker，默认 http://localhost:8787
pnpm dev              # 终端 2：前端，默认 http://localhost:5173
```

只聊天、生图或调用 TTS/STT 时可以只开前端；函数搜索和视频源文件上传依赖 Worker。Worker 的服务端密钥接口同样需要它，但当前前端尚未接入该模式。开发服务器会把浏览器的 `/__api/*` 请求代理到本地 Worker。

首次使用：

1. 在「设置 → 后端」添加 OpenAI 兼容地址和 API key，并勾选要显示的面板。
2. 点击「获取模型」，勾选常用模型并保存；应用不会在启动时自动拉模型。
3. 需要联网时，在模型列表为模型选择「自动 / 原生 / 函数」，再在聊天工具栏打开「联网」。DeepSeek 等不支持原生搜索形状的模型使用「函数」。
4. 需要语音时，在「设置 → 语音」分别选择已经添加的 STT/TTS 供应商和模型；聊天录音还需打开「聊天框显示麦克风」。

## 不猜，只按你勾的来

早期版本会在添加后端时对 5 个端点各发一次空 `POST {}`，靠「404 就是没这个路由」推断能力。**这个功能已经整个删掉了** —— 密集的小请求会被一些站判定成测活行为，直接封号。

替代方案是不发任何多余请求：

- 侧边栏显示哪几个面板，在设置页的「显示哪些面板」里手动勾。一个都没勾时全部显示，宁可让用户点进去看到真实报错，也别把功能藏了。
- 后端方言在拉模型列表时顺手读取；目前只用 `X-CPA-Version` 等专用响应头确定识别 CPA。通用的 `X-Request-ID` 不再用于识别 grok2api，避免把 OpenAI 兼容网关误导向 `/tts`、`/stt`。
- 模型列表也不再自动拉：进页面只读本地缓存，出网由设置页的「获取模型」按钮触发。

原则是**所有业务出网请求都由用户点出来**。

同一条原则也管着 UI 上的各种「这个模型支不支持 X」：

- **推理档位和联网开关对所有模型开放**。联网方式则可在设置页按模型选「自动 / 原生 / 函数」；自动只把 Gemini/Grok 送到已知的原生搜索，其余走客户端 function tool。模型 id 判断只是默认路由，不会替用户隐藏或禁用按钮。
- **语音面板不看后端方言**，只看你在设置页勾没勾。实测 CPA 那台的 `/tts` `/stt` 全 404，但那是那一台部署的实况，不是 `cpa` 这个方言的定义。`flavor` 只在语音接口格式选「自动」时决定默认协议，不参与能力开关，也不会触发模型或声线请求。
- **功能不支持时给说明，不隐藏**。联网按钮始终可点；原生路径不支持时让上游返回真实错误，函数路径由 Worker 执行搜索。

## 为什么不需要反向代理

CPA（CLIProxyAPI）和 grok2api 的公开 API 都开了全量 CORS，浏览器可以直连：

| 后端 | CORS | 取证 |
|---|---|---|
| CPA | `Allow-Origin: *`、`Allow-Headers: *`，硬编码不可配 | `internal/api/server_middleware.go:127-141` |
| grok2api | `/v1` 路径全开 | `backend/internal/transport/http/middleware/request.go:93-134` |

而且 CPA 的 CORS 中间件跑在鉴权之前，所以 OPTIONS 预检永不被拦、401/403 响应上也带 CORS 头——浏览器能读到真实错误而不是不透明的跨域失败。

Worker 因此只做四件事：托管静态资源、提供 R2 上传通道、执行函数搜索，以及**可选的**服务端密钥反代。默认情况下聊天、生图和语音请求不经过 Worker。

| 功能 | 请求路径 | 是否依赖 Worker |
|---|---|---|
| 聊天、生图、TTS/STT、原生搜索 | 浏览器 → 已配置后端 | 否 |
| 函数搜索 | 浏览器 → `/__api/search` → 搜索源 | 是 |
| 带源文件的视频编辑/延长 | 浏览器 → `/__api/upload` → R2，再把公网 URL 交给后端 | 是 |
| 服务端持有 API key | 浏览器 → `/__api/proxy/*` → 已配置后端 | Worker 路由已实现，前端尚未接入 |

## 密钥模式现状

| 模式 | 密钥在哪 | 当前状态 |
|---|---|---|
| 直连（默认） | 浏览器 localStorage | 已可用，适合自己使用 |
| 服务端持有 | Worker Secret | Worker 的配置、鉴权和代理接口已实现；前端尚未读取 `/__api/config` 或创建 proxy 后端，暂时不能从 UI 使用 |

CPA 对客户端 key 没有任何配额或限流（`internal/access/config_access/provider.go:92` 就是一次 map 成员检查），key 泄露等于把接进去的所有上游额度公开。在前端完成服务端密钥接线前，不要把带有直连 key 的浏览器配置或可访问设备分享给别人。

## 模型怎么选

CPA 一个部署实测就有 68 个模型（还会继续涨），全塞进下拉根本没法选。所以是两步：

1. **设置页**点「获取模型」拉列表，勾选常用的，点保存
2. **聊天时**的选择器只显示存过的

拉取不是自动的 —— 进页面只读本地缓存，什么都不发。列表缓存在 IndexedDB，改了后端地址会自动失效。

勾选是攒着的，改完点保存才落盘 —— 一勾一存的话列表会跟着刷新、滚动位置丢，68 行里挑十几个体感很差。归类和图片路由的改动也一起攒在这个草稿里，免得同一个页面有的控件即时生效、有的要点保存。草稿状态挂在设置页外面，中途切去别的面板再回来不会白勾。设置页的排序只按提供商和 id，勾选与否不影响位置 —— 那一页是一边扫一边勾的，列表不该在手底下动。

一个都没存时聊天页会直接提示去挑，不做"降级显示全部"——那样分不清眼前这一长串是自己选的还是系统兜底给的。

归类是按模型 id 猜的，猜错了可以在设置页逐个覆盖 —— 勾选保存过的模型下面就有归类下拉。

一次拉取实际是三个请求（`/v1/models` 加两个富字段端点），所以只在你点按钮时才发。超过 24 小时会在列表底部标一句「可能过期了」，但不会自动重拉。

## 混合联网搜索

设置页的「模型」列表会为已保存的对话模型提供三档联网方式：

| 模式 | 请求形状和执行方 | 适用情况 |
|---|---|---|
| 自动 | Gemini 使用 `google_search`，Grok 使用原生 `{type:"web_search"}`，其他模型使用标准 `type:"function"` 的 `web_search` | 推荐默认值 |
| 原生 | 把搜索工具原样交给模型上游执行 | Grok、Gemini 或其他明确支持内置搜索的上游 |
| 函数 | 模型只返回 function call，浏览器调用 Worker 搜索并以 `role:"tool"` 回填 | DeepSeek、Claude 兼容接口等没有内置搜索的模型 |

函数搜索的完整路径是：

```text
模型发出 web_search(query)
  → 浏览器 POST /__api/search
  → Worker 调用搜索源
  → 浏览器把结果作为 role:"tool" 回填
  → 模型生成最终回答
```

每个用户问题最多处理两次模型搜索调用；相同查询会复用本轮已有结果。模型给出的查询只做 Unicode 规范化、空白压缩和长度校验，不由 Worker 改写语义或判断“是否相关”。工具结果只存在于当前请求循环，不会写进会话历史；系统提示同时要求模型把网页内容视为不可信资料，不能执行其中的指令。

「设置 → 联网」只影响函数搜索，原生搜索不会读取这里的来源、密钥或地址：

| 搜索源 | 是否需要 key | 说明 |
|---|---|---|
| `auto` | 可选 | 有 key 时先尝试 Tavily/Serper；随后依次尝试 Exa、Bing RSS、SearXNG、DuckDuckGo |
| `exa` | 否 | 直接调用匿名 Exa MCP 的 `web_search_exa`，与 OpenCode 的通用搜索路径一致 |
| `bing-rss` | 否 | Bing RSS 搜索 |
| `duckduckgo` | 否 | DuckDuckGo 即时答案接口 |
| `searxng` | 否 | 可填写自建实例根地址；留空使用项目默认公共实例。只允许公网 HTTP(S)，拒绝本机、内网、保留地址和不安全重定向 |
| `tavily` / `serper` | 是 | key 存在当前浏览器的 localStorage；也可由 Worker 的 `SEARCH_API_KEY` 提供默认值 |

浏览器选择 `auto` 时不会覆盖部署者设置的 `SEARCH_PROVIDER`；Worker 未指定该变量时才使用表中的自动兜底顺序。

部署设置了 `ACCESS_PASSWORD` 和 `TOKEN_SECRET` 后，搜索、上传和代理都要求先在「设置 → 联网」验证 Worker 访问口令。明文口令不会保存；换取的 12 小时 token 只存在当前标签页。两项都不配置时，搜索和上传只接受浏览器可验证的同源/同站请求，或 `Origin` 与 Worker 精确一致的请求；只配置其中一项会失败关闭。

## 语音输入与录音

设置页有独立的「语音」标签：聊天麦克风默认隐藏，可按需打开；录音操作可选「按住说话」（默认）或「点击开始/再次点击停止」，聊天输入框和语音页共用这个选择。

STT 和 TTS 都直接选择「设置 → 后端」里已经添加的供应商，配置只保存供应商 ID、模型、接口格式和可选的自定义路由 ID，不复制一份 URL 或 API key。两者可以选不同供应商，也不要求和顶部当前聊天后端相同；切换顶部聊天后端时，会使用该聊天后端各自保存的语音路由。当前语音请求只支持 `direct` 后端，引用 `proxy` 后端会明确提示尚未接入 Worker 代理。

供应商下拉只读取本地状态，模型下拉只读取 IndexedDB 缓存，切换供应商不会发请求。目录为空时由用户点击「获取模型」；已有缓存时可点「重新获取」。模型归类只决定“推荐的 STT/TTS 模型”排序，目录中的其他模型仍可自行选择。一次获取仍会请求该供应商的模型目录及富字段端点，不会因打开设置、切标签或切供应商而自动执行。

接口格式相对于所选供应商的 Base URL：

| 接口格式 | STT | TTS | 声线目录 |
|---|---|---|---|
| `auto` | 已明确识别为 grok2api 时使用 `grok-native`，其他后端使用 `openai-audio` | 同左 | 取决于解析后的协议；需要 Grok 原生端点时也可手动选择 |
| `grok-native` | `POST /stt`，multipart `file` + `model` | `POST /tts`，发送 `model`、`text`、`voice_id` 等 | 仅点击「加载声线」后 `GET /tts/voices` |
| `openai-audio` | `POST /audio/transcriptions`，multipart `file` + `model` | `POST /audio/speech`，发送 `model`、`input`、`voice`、`response_format` 等 | OpenAI Audio 没有通用的标准目录，不探测；voice ID 可编辑，默认 `alloy` |

TTS 还可以选择目标供应商下保存的自定义请求路由。进入「设置 → 语音 → 自定义 TTS 路由」，选择路由所属供应商后，可一键创建“小米 MiMo 对话语音”模板。JSON 编辑器只显示请求格式的 `path`、`method`、`query`、`body`；路由 ID、名称、响应音频取值、MIME 和默认声线由内置模板维护。`path` 只填写相对于该供应商 Base URL 的接口路径（例如 `/chat/completions`），不能填写完整网址；如需调用另一家服务，应先把它添加为独立后端。保存路由后，在「语音合成 TTS」卡片中选择供应商、模型和“请求路由”，最后点保存。路由仍被任一聊天后端的 TTS 配置引用时不能删除，避免请求静默回退到错误端点。

硅基流动 ASR + 小米 MiMo TTS 的推荐配置：

1. 在「后端」中添加实际使用的 NewAPI/硅基流动供应商，使用带 `/v1` 的 Base URL 和对应 API key；不需要重复添加一份语音供应商。
2. STT 选择硅基流动供应商，模型优先 `FunAudioLLM/SenseVoiceSmall`，也可选 `TeleAI/TeleSpeechASR`，接口格式选 `openai-audio`，请求会走 `POST /audio/transcriptions`。
3. 在“自定义 TTS 路由”中选择承载小米模型的 NewAPI 供应商，点击“新建路由”并保存 MiMo 模板。
4. TTS 选择同一 NewAPI 供应商、模型 `mimo-v2.5-tts`，请求路由选择刚创建的“小米 MiMo 对话语音”，然后保存。

MiMo 模板调用 `POST /chat/completions`，不是 `/audio/speech`。正文使用 `assistant` 消息承载待朗读文本，并发送 `audio.voice` 与 `audio.format`；默认声线为 `mimo_default`，默认格式为 WAV。响应依次从 `choices.*.message.audio.data`、`audio.data`、顶层 `data` 读取 base64 音频。模板可用变量为 `model text voice format speed language`，语音页只显示模板实际引用的参数控件。

聊天输入框的麦克风和语音页的“语音转文字”共用 STT 路由：聊天录音结束后立即转写，把文字追加到当前草稿但不自动发送；语音页则在录音或选文件、试听后由用户点击「开始转写」。语音页的“文本转语音”单独使用 TTS 路由。Grok 声线列表也只在用户点击「加载声线」时请求，更换供应商或模型后需要重新手动加载。

上一版曾允许为 STT 单独填写 URL、API key 和模型。旧 `sttProvider` 数据仍会读取：能按地址和 key 匹配到已有后端时复用该后端，匹配不到时仍可沿用旧地址直连；一旦保存新的 STT 路由，就优先使用新配置，不会静默丢掉旧设置。

上传和录音接受 MP3、WAV、M4A、OGG/Opus、AAC、FLAC 和 WebM，浏览器侧上限为 100 MB，并会检查常见容器文件头；短于 300 ms 或没有音频数据的录音会直接拒绝。浏览器麦克风要求 HTTPS 或 localhost。实时语音通话暂未实现。

## 图片路由

生图尺寸默认使用 `auto`，由支持该值的上游自行选择尺寸；也可以手动指定固定尺寸或切换为宽高比。生成结果点击后进入全屏查看器，支持 1x–5x 缩放、拖动、鼠标滚轮、双击、触控双指和键盘操作；关闭后焦点会回到原图片。

「是图片模型」和「这个端点接不接它」是两件事。实测 CPA 上的 Nano Banana 确实是图片模型，但它拒绝 `/images/generations`，只能走 `chat/completions`；grok2api 两条路都通。这个差异从模型 id 上看不出来，所以做成了可配的路由，按模型指定。

内置两条：`images`（`/images/generations`）和 `chat`（`/chat/completions`）。不够用时可以自己写：

```json
{
  "id": "my-route",
  "name": "某家的生图端点",
  "path": "chat/completions",
  "method": "POST",
  "query": {},
  "body": {
    "model": "$model",
    "messages": [{ "role": "user", "content": "画：${prompt}" }],
    "size": "$size"
  },
  "imageUrlPaths": ["choices.*.message.images.*.image_url.url"],
  "b64JsonPaths": []
}
```

- `body` 是模板。整串写成 `"$prompt"` 按原类型替换（数字还是数字），**取不到值的键会被整个剪掉**，所以可选参数不用写条件分支；串里的 `${prompt}` 按字符串插值。可用变量 `model prompt n size aspectRatio quality responseFormat`，下划线写法同样认。
- 取图路径点号分隔、`*` 展开数组。**留空就用通用提取**（深挖字段，也认正文里的 `![](url)`），多数后端不用填；填了但一个都没命中时也会回落到通用提取 —— 路径写错一个字就什么都拿不到，而「上游没返回图片」这个报错完全指不到是配置写错了。
- 内置的两条路由本身就是用同一个结构描述的，所以设置页可以「复制改」，执行代码也只有一套。
- 面板会反推模板真正引用了哪些变量，**只显示会被发出去的参数控件**。走 `chat` 路由时尺寸、质量、返回格式直接不显示。

暂不支持异步任务轮询 —— 目前接触到的图片端点都是同步返回的。

## 存储

| 数据 | 存哪 | 为什么 |
|---|---|---|
| 后端配置（含 STT/TTS 供应商 ID、模型、协议和自定义 TTS 路由） | localStorage | 小，且首屏要同步读出来决定渲染引导页还是主界面；语音路由只引用已有后端，不复制 URL/Key |
| 行为设置 | localStorage | 同上，提交方式要在第一次按键前就生效 |
| 会话历史 | IndexedDB | localStorage 只有 5MB，长对话加上推理过程很快撑爆，撑爆只能丢最旧的 |
| 生成记录 | IndexedDB | 存的是图片和音频，量级不是 localStorage 能承的 |
| 模型缓存 | IndexedDB | 同上 |

IndexedDB 没引 idb / dexie —— 访问模式只有 get/put/delete/getAll，手写一百行比多个依赖划算，见 `src/shared/db/idb.ts`。

每条会话是一条独立记录（不是把整个数组序列化成一个键），改一条只写一条。生成记录同理，索引是 `[scope, kind, createdAt]`，一次查询直接拿到「当前后端 + 当前面板」的那批。

生成记录存 URL 还是存字节，按来源分：

- **图片**：`data:` URL 转成 Blob 存（IndexedDB 存二进制比存 base64 文本省约四分之一），远程 URL 原样存字符串
- **视频**：一律远程 URL。链接可能过期，但那是链接本身的性质，把字节抓下来也救不了已经过期的
- **语音合成**：二进制和 `data:` 结果转成 Blob 存，刷新后重新生成对象 URL；如果上游返回的是远程 URL，则保留 URL，其有效期仍由上游决定
- **语音转写**：保存文本以及语言、时长、词级结果等可用元数据，不保存用户上传的原音频

每个后端每个面板留最近 50 条，超了删最旧的。四个面板的历史都长在左侧栏同一个位置 —— 生成记录一开始做成了面板顶部的折叠抽屉，结果对话在左边、其余三个在内容区，同一个东西两个地方找。每条侧栏历史删除都要点两次：第一次变成「确定删除」，第二次才执行，几秒不确认会自动复位。设置页的「行为」页底部有「删除全部记录」，清掉所有后端的对话和生成记录，但不动后端配置、密钥和模型缓存 —— 那些删了得重新填一遍。

生图、视频、语音侧栏的「新图片」「新视频」「新语音」只重置当前表单、结果和选中记录，不删除历史；任务运行中按钮会暂时禁用。

对话里的单条消息有三个操作：复制、重新生成、删除。默认不显示 —— 桌面端悬停出现，移动端点一下消息出现，点别处收起（移动端没有 hover，常驻挂三个图标太吵）。「重新生成」点在回复上是丢掉这条回复重问一次，点在提问上是从这一问重来、后面的全丢。删除只删这一条，不连带删它的问/答；删到一条不剩时整个会话也从库里删掉。流式输出过程中不给删也不给重生成 —— 那会儿请求捏着一份发送时的消息列表，结束时会整个覆盖回去。

对话支持一次带多张图片：可以点输入框旁的图片按钮、直接粘贴截图，或把图片拖进输入框。图片会转成 OpenAI Vision 的 `image_url` data URL 内容片段，与文字一起随会话存进 IndexedDB，所以刷新、重新生成和历史回看都不会丢。旧的纯文本消息仍发送 `content: string`，没有图片时请求形状不变。当前限制为最多 4 张、单张 10 MB、合计 20 MB；SVG 等可执行图片内容不会进入 data URL。图片输入不按模型名猜能力，模型不支持时由上游返回真实错误。

侧栏每个列表的标题旁都有「清空」，点两下才真执行（第一下变成「确认清空」，几秒不管就自己变回去）。

## 开发

```bash
pnpm install
pnpm dev              # Vite，端口 5173
pnpm dev:worker       # wrangler，端口 8787（函数搜索、上传和反代需要）
pnpm check            # 类型检查
pnpm test             # vitest，测试会 mock 网络，不访问真实服务
pnpm build            # 产出 dist/
```

前端开发时 `/__api` 会被 Vite 代理到本地 wrangler；聊天请求（包括内联图片）直接打你配置的后端，不经过任何代理，也不依赖 R2 上传。生图和语音请求同样直连后端。函数搜索调用 `/__api/search`；涉及图片或视频源文件的视频任务调用 `/__api/upload`，这两种情况都要同时运行 `pnpm dev:worker`。

## 部署

先确认 `wrangler.toml` 里的 Worker 名称和 R2 桶名，再执行：

```bash
wrangler r2 bucket create chatweb
pnpm deploy
```

免费函数搜索不需要 secret。按部署方式补充配置：

| 配置 | 类型 | 用途 |
|---|---|---|
| `UPSTREAM_BASE_URL`、`UPSTREAM_NAME` | Worker variable | `/__api/config` 和代理使用的后端地址/名称；等待前端接入 |
| `UPSTREAM_CAPABILITIES` | Worker variable | `/__api/config` 返回的面板列表；等待前端接入，不会自动探测 |
| `UPSTREAM_API_KEY` | secret | Worker 代用户持有的上游 API key |
| `ACCESS_PASSWORD` + `TOKEN_SECRET` | secret | 保护搜索、上传和代理；必须同时配置 |
| `SEARCH_PROVIDER` | Worker variable | 函数搜索默认来源，默认 `auto` |
| `SEARCH_API_KEY` | secret | Tavily 或 Serper key；使用免费来源时不需要 |
| `SEARCH_BASE_URL` | Worker variable | 自建 SearXNG 根地址 |
| `SEARCH_TIMEOUT_MS` | Worker variable | 整个搜索兜底链路的总预算，限制为 1000–15000 ms |
| `MAX_UPLOAD_BYTES`、`MEDIA_CACHE_SECONDS` | Worker variable | 上传大小和公开媒体缓存时间 |

需要保护搜索/上传接口时可先配置访问口令。下面的 `UPSTREAM_API_KEY` 只是在 Worker 端准备代理，当前 UI 还不能选择预置后端：

```bash
wrangler secret put ACCESS_PASSWORD
wrangler secret put TOKEN_SECRET       # 建议使用 openssl rand -hex 32 生成
wrangler secret put UPSTREAM_API_KEY   # 仅服务端持有上游 key 时需要
wrangler secret put SEARCH_API_KEY     # 仅 Tavily/Serper 时需要
```

本地 Worker 配置复制 `.dev.vars.example` 为 `.dev.vars` 后填写；该文件已被 gitignore。公开部署应同时配置 `ACCESS_PASSWORD` 和 `TOKEN_SECRET`，访问者随后在「设置 → 联网」验证口令。

`dist/` 不进仓库，构建挂在 `wrangler.toml` 的 `[build]` 钩子上，
所以 `wrangler deploy` 会自己先跑 `pnpm build`。接 Cloudflare Workers Builds
（Git 自动部署）时也因此不用在面板里额外配置构建命令 —— 它默认执行的
`npx wrangler deploy` 会连带触发构建。

建议给 R2 桶配一条 lifecycle rule 自动清理 7 天前的对象。

## 常见问题

| 现象 | 原因和处理 |
|---|---|
| DeepSeek 返回 `unknown variant 'web_search', expected 'function'` | 当前模型走了原生搜索；到「设置 → 模型」把它切成「函数」 |
| 函数搜索显示 401 或“未授权” | 部署启用了访问控制；到「设置 → 联网」验证 Worker 访问口令 |
| 本地函数搜索或上传返回 404 | 只启动了 Vite；同时运行 `pnpm dev:worker`，确认 Vite 的 `/__api` 代理指向 8787 |
| 打开函数搜索但没有工具活动 | 是否搜索由模型决定；明确要求查询最新资料，并确认当前模型的联网方式是「函数」 |
| 显示调用了 `web_search` 但结果为空/超时 | 在 Network 检查 `/__api/search` 的 provider 和错误；可暂时把来源固定为 `exa` 定位。`SEARCH_TIMEOUT_MS` 是整个 auto 兜底链共享的总预算 |
| 模型选择器为空 | 应用不会自动拉取；到设置页点击「获取模型」，勾选后保存 |
| 麦克风按钮不显示 | 在「设置 → 语音」启用聊天麦克风，并为 STT 选择一个有效的供应商和模型 |
| STT/TTS 模型列表为空 | 选择供应商后点击该卡片里的「获取模型」；切换供应商只读 IndexedDB，不会自动联网 |
| OpenAI TTS 没有声线列表 | OpenAI Audio 没有统一的声线目录；直接填写 voice ID，默认是 `alloy`。只有 `grok-native` 提供手动「加载声线」 |
| `mimo-v2.5-tts` 调用 `/audio/speech` 失败 | 在「设置 → 语音」创建 MiMo 自定义 TTS 路由，并在 TTS 的“请求路由”中选中它；该模型需要走 `/chat/completions` |
| 语音提示 proxy 后端不可用 | 当前语音请求尚未接入 Worker 代理；在「设置 → 语音」选择一个 `direct` 后端 |
| 浏览器拒绝录音 | 麦克风只在 HTTPS 或 localhost 可用，同时检查站点麦克风权限 |
| 视频源文件上传失败 | 本地需运行 Worker；部署环境还要正确绑定 `MEDIA` R2 桶 |

## 已知的坑（都已在代码里处理）

- **SSE 约定各后端不一致**，甚至同一后端内 chat 和 images 两条线相反（一个有 `event:` 行没 `[DONE]`，一个反过来）。解析器一律只读 `data:` 行按 payload 派发，但**错误判定看 `event:` 名**——否则 `event: error` 帧会被当成正常结束吞掉。见 `src/transport/sse.ts`
- **CPA 的错误体是 `{"error": "字符串"}`**，不是 OpenAI 标准的 `{"error": {"message"}}`。见 `src/transport/errors.ts`
- **CPA safe-mode**：服务端 config 里还是模板 key 时所有 `/v1` 返 403 `unsafe_example_api_key`，用户会误以为是自己 key 错了，已做专门提示
- **能力探测这条路整个废了**：曾经用无鉴权 `POST {}` 靠 404 判断路由是否存在（不能用 OPTIONS —— CPA 的 CORS 中间件对任何路径包括不存在的都返回 204）。判定逻辑本身是对的，但**密集小请求会被一些站判成测活封号**，所以功能删了，改成手动勾。见上面「不做能力探测」
- **推理字段有两条路径，必须都认**。CPA 对官方凭证上游（Gemini/Claude/Codex/Kimi）会翻译成 `delta.reasoning_content`；但 `openai-compatibility` 类型的第三方上游是**原样透传不翻译**的，上游叫什么就是什么。实测 `cpa.yueming.uk` 上的第三方 DeepSeek 源返回 `delta.reasoning`。解析器三个字段都认
- **推理档位**：CPA 支持模型名后缀 `model(high)` / `model(8192)`，优先级高于 `reasoning_effort`，且 Gemini 的 token 预算模式只能靠它
- **联网搜索不对称**：Gemini 原生路径走 `tools:[{google_search:{}}]`，Grok 原生路径走 `{type:"web_search"}`；Claude 等没有已验证内置搜索的模型默认走浏览器 function tool，只有手动选「原生」才会受 `/v1/messages` 等上游协议限制。
- **模型分类顺序敏感**：video 规则必须在 image 之前，否则 `grok-imagine-video` 会被 `imagine` 抢先匹配成图片模型
- **归类对了不等于端点能用**：Nano Banana 系列确实是图片模型，但 CPA 不允许它们走 `/images/generations`（上游报错会列出该部署实际支持的模型，面板原样展示）。这类"模型存在但此端点不接"的情况靠分类规则解决不了 —— 解法是把端点做成可配的图片路由，把这个模型单独切到 `chat/completions`
- **走 chat 生图时图片经常只在正文里**：不是任何结构化字段，而是回复文本里的 `![](url)`。所以通用提取除了扫字段还扫正文 markdown。裸链接只认带图片扩展名的，且只扫 `content`/`text`/`output_text`/`markdown` 几个键 —— 否则错误信息里的链接也会被当成图片
- **语音路由不能靠模型表猜端点**：当时实测的 CPA 部署在 `/tts`、`/stt`、`/audio/speech`、`/audio/transcriptions` 上全是 404，尽管模型表里有 8 个 TTS 模型。**但这不作为拦人的依据** —— 面板仍只看用户勾选的能力，STT/TTS 可各自选择供应商和 `auto` / `grok-native` / `openai-audio`。`auto` 只把 grok2api 映射到原生端点，其他后端映射到 OpenAI Audio；Grok 声线也必须手动加载，OpenAI Audio 则完全不探测声线目录
- **联网方式按模型单独保存**：自动路由 Gemini/Grok 到原生搜索，其他模型走 function tool；手动切换原生或函数后不再依赖厂商猜测。**特别注意别回到“不支持就发空 tools”** —— 那样开关看着生效其实什么都没发出去
- **浏览器里的「联网」和 opencode 有两条路径**：原生档仍是 `tools:[{type:"web_search"}]`，请上游用自己的内置搜索；函数档则由浏览器执行工具调用循环，Worker 负责实际搜索并把结果回填。两条路径都保留，按模型设置选择。
- **grok2api 原生 TTS 的参数比文档窄**：`speed` 只接受 0.7–1.5，编码只有 mp3/wav/opus（aac 和 flac 返回 422）；opus 的响应头写 `audio/opus` 但负载是 Ogg 容器，得改成 `audio/ogg` 才好交给 `<audio>`
- **grok2api 原生 STT 的 `format` 和 `language` 是绑定的**：`format=true`（数字规范化，`十一万五千六百九十九` → `115,699`）必须同时给 `language`，否则 400。语言选自动识别时只能两个都不发；OpenAI Audio 路径不会发送 `format`
- **图片生成很慢，等待上限做成了设置项**：`gpt-image-2` 单张实测 68 秒，加 `quality:"high"` 到 103 秒。而且 CPA 会在上游失败时自己换一家重试 —— 使用日志里能看到「HTTP 499 `context canceled`」后面紧跟一条成功记录，那是 CPA 取消了第一家上游又打了第二家，**不是浏览器发了两次**。两次加起来的静默时间轻松超过 SSE 通用的 90 秒静默超时，所以图片走流式时默认给 300 秒，并且可以在设置页的「行为」里自由调（30–1800 秒）—— 合适的数字完全取决于你接的是哪家上游，写死多少都会冤枉一部分人
- **有的上游只认 `type: "function"` 的工具**：实测 CPA 转发到 oneapi 上的第三方 DeepSeek，开着联网搜索会 400 ``unknown variant `web_search`, expected `function` ``。原始报文全是「deserialize the JSON body into the target type」这种词，完全指不回是那个开关引起的，所以 `errors.ts` 里对 400 + `web_search` 专门补了一句人话。同一台 CPA 上的 Grok 模型联网搜索是正常的
