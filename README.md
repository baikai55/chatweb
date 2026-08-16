# chatweb

网页聊天 —— 连接任意 OpenAI 兼容后端，部署在 Cloudflare Workers。

前身是 grok2api 内置的「创作台」，把它从管理后台里抽出来做成独立应用：打开链接、填一次后端地址和密钥就能用，支持配置多个后端随时切换。

## 功能

- **对话**：OpenAI Chat Completions、流式输出、推理过程、工具活动、停止生成和会话历史。
- **生图**：图片数量、尺寸或比例、质量、URL/Base64 响应、预览、打开和下载。
- **视频**：文本/图片生成视频，以及视频编辑和延长；支持源媒体上传、异步任务轮询、进度、停止等待和结果播放。
- **语音**：grok2api 原生 TTS/STT，支持声线列表、语言、语速、音频格式、播放下载和音频转写。

四个面板的历史记录都在左侧栏，刷新不丢。侧边栏显示哪几个面板由设置页手动勾选。

## 不猜，只按你勾的来

早期版本会在添加后端时对 5 个端点各发一次空 `POST {}`，靠「404 就是没这个路由」推断能力。**这个功能已经整个删掉了** —— 密集的小请求会被一些站判定成测活行为，直接封号。

替代方案是不发任何多余请求：

- 侧边栏显示哪几个面板，在设置页的「显示哪些面板」里手动勾。一个都没勾时全部显示，宁可让用户点进去看到真实报错，也别把功能藏了。
- 后端方言（`cpa` / `grok2api` / `generic`）改成拉模型列表时白捡 —— 认方言只需要读 `/models` 的响应头（`X-CPA-Version` 或 `X-Request-ID`），而这个请求本来就要发。
- 模型列表也不再自动拉：进页面只读本地缓存，出网由设置页的「获取模型」按钮触发。

原则是**所有出网请求都由用户点出来**。

同一条原则也管着 UI 上的各种「这个模型支不支持 X」：

- **推理档位和联网搜索对所有模型开放**。判定本来就只是拿模型 id 猜的（`isReasoningModel` / `inferVendor` 都是子串匹配），猜错就把能用的功能锁死，而用户看不出是"锁了"还是"没这功能"。两个控件的默认值都是不发，真发出去一定是你点过的；上游不认就让它报错。
- **语音面板不看后端方言**，只看你在设置页勾没勾。实测 CPA 那台的 `/tts` `/stt` 全 404，但那是那一台部署的实况，不是 `cpa` 这个方言的定义。方言只用来写一句提示，不拦人。
- **功能不支持时给禁用态加说明，不隐藏**。联网搜索按钮吃过这个亏：模型 id 里没写 gemini / grok 时按钮凭空消失，看起来就像功能丢了。

## 为什么不需要反向代理

CPA（CLIProxyAPI）和 grok2api 的公开 API 都开了全量 CORS，浏览器可以直连：

| 后端 | CORS | 取证 |
|---|---|---|
| CPA | `Allow-Origin: *`、`Allow-Headers: *`，硬编码不可配 | `internal/api/server_middleware.go:127-141` |
| grok2api | `/v1` 路径全开 | `backend/internal/transport/http/middleware/request.go:93-134` |

而且 CPA 的 CORS 中间件跑在鉴权之前，所以 OPTIONS 预检永不被拦、401/403 响应上也带 CORS 头——浏览器能读到真实错误而不是不透明的跨域失败。

Worker 因此只做三件事：托管静态资源、提供 R2 上传通道、以及**可选的**服务端密钥反代。默认情况下聊天请求根本不经过 Worker。

## 两种密钥模式

| 模式 | 密钥在哪 | 什么时候用 |
|---|---|---|
| 直连（默认） | 浏览器 localStorage | 自己用 |
| 服务端持有 | Worker Secret | **要把链接分享给别人时必须用这个** |

CPA 对客户端 key 没有任何配额或限流（`internal/access/config_access/provider.go:92` 就是一次 map 成员检查），key 泄露等于把接进去的所有上游额度公开。分享链接前务必切到服务端模式。

## 模型怎么选

CPA 一个部署实测就有 68 个模型（还会继续涨），全塞进下拉根本没法选。所以是两步：

1. **设置页**点「获取模型」拉列表，勾选常用的，点保存
2. **聊天时**的选择器只显示存过的

拉取不是自动的 —— 进页面只读本地缓存，什么都不发。列表缓存在 IndexedDB，改了后端地址会自动失效。

勾选是攒着的，改完点保存才落盘 —— 一勾一存的话列表会跟着刷新、滚动位置丢，68 行里挑十几个体感很差。归类和图片路由的改动也一起攒在这个草稿里，免得同一个页面有的控件即时生效、有的要点保存。草稿状态挂在设置页外面，中途切去别的面板再回来不会白勾。设置页的排序只按提供商和 id，勾选与否不影响位置 —— 那一页是一边扫一边勾的，列表不该在手底下动。

一个都没存时聊天页会直接提示去挑，不做"降级显示全部"——那样分不清眼前这一长串是自己选的还是系统兜底给的。

归类是按模型 id 猜的，猜错了可以在设置页逐个覆盖 —— 勾选保存过的模型下面就有归类下拉。

一次拉取实际是三个请求（`/v1/models` 加两个富字段端点），所以只在你点按钮时才发。超过 24 小时会在列表底部标一句「可能过期了」，但不会自动重拉。

## 图片路由

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
| 后端配置 | localStorage | 小，且首屏要同步读出来决定渲染引导页还是主界面，走异步会闪 |
| 行为设置 | localStorage | 同上，提交方式要在第一次按键前就生效 |
| 会话历史 | IndexedDB | localStorage 只有 5MB，长对话加上推理过程很快撑爆，撑爆只能丢最旧的 |
| 生成记录 | IndexedDB | 存的是图片和音频，量级不是 localStorage 能承的 |
| 模型缓存 | IndexedDB | 同上 |

IndexedDB 没引 idb / dexie —— 访问模式只有 get/put/delete/getAll，手写一百行比多个依赖划算，见 `src/shared/db/idb.ts`。

每条会话是一条独立记录（不是把整个数组序列化成一个键），改一条只写一条。生成记录同理，索引是 `[scope, kind, createdAt]`，一次查询直接拿到「当前后端 + 当前面板」的那批。

生成记录存 URL 还是存字节，按来源分：

- **图片**：`data:` URL 转成 Blob 存（IndexedDB 存二进制比存 base64 文本省约四分之一），远程 URL 原样存字符串
- **视频**：一律远程 URL。链接可能过期，但那是链接本身的性质，把字节抓下来也救不了已经过期的
- **语音合成**：**必须存字节** —— TTS 只有二进制响应，`blob:` URL 一刷新就失效，不转成 Blob 就等于没存
- **语音转写**：只有文本

每个后端每个面板留最近 50 条，超了删最旧的。四个面板的历史都长在左侧栏同一个位置 —— 生成记录一开始做成了面板顶部的折叠抽屉，结果对话在左边、其余三个在内容区，同一个东西两个地方找。设置页的「行为」页底部有「删除全部记录」，清掉所有后端的对话和生成记录，但不动后端配置、密钥和模型缓存 —— 那些删了得重新填一遍。

对话里的单条消息可以逐条删（悬停气泡外侧出现删除按钮）。只删这一条，不连带删它的问/答。删到一条不剩时整个会话也从库里删掉。流式输出过程中不给删 —— 那会儿请求捏着一份发送时的消息列表，结束时会整个覆盖回去。

## 开发

```bash
pnpm install
pnpm dev              # Vite，端口 5173
pnpm dev:worker       # wrangler，端口 8787（测上传和反代时才需要）
pnpm check            # 类型检查
pnpm test             # vitest，纯函数单测，不打网络
pnpm build            # 产出 dist/
```

前端开发时 `/__api` 会被 Vite 代理到本地 wrangler；聊天请求直接打你配置的后端，不经过任何代理。
生图和语音请求同样直连后端。视频的纯文本生成可以直连；涉及图片或视频源文件时，
需要同时运行 `pnpm dev:worker`，否则 `/__api/upload` 不可用。

## 部署

```bash
# 1. R2 桶（wrangler.toml 里已填 chatweb）
wrangler r2 bucket create chatweb

# 2. 只在需要「分享给别人」时才配这些
wrangler secret put UPSTREAM_API_KEY
wrangler secret put ACCESS_PASSWORD
wrangler secret put TOKEN_SECRET       # openssl rand -hex 32

pnpm deploy
```

`dist/` 不进仓库，构建挂在 `wrangler.toml` 的 `[build]` 钩子上，
所以 `wrangler deploy` 会自己先跑 `pnpm build`。接 Cloudflare Workers Builds
（Git 自动部署）时也因此不用在面板里额外配置构建命令 —— 它默认执行的
`npx wrangler deploy` 会连带触发构建。

建议给 R2 桶配一条 lifecycle rule 自动清理 7 天前的对象。

## 已知的坑（都已在代码里处理）

- **SSE 约定各后端不一致**，甚至同一后端内 chat 和 images 两条线相反（一个有 `event:` 行没 `[DONE]`，一个反过来）。解析器一律只读 `data:` 行按 payload 派发，但**错误判定看 `event:` 名**——否则 `event: error` 帧会被当成正常结束吞掉。见 `src/transport/sse.ts`
- **CPA 的错误体是 `{"error": "字符串"}`**，不是 OpenAI 标准的 `{"error": {"message"}}`。见 `src/transport/errors.ts`
- **CPA safe-mode**：服务端 config 里还是模板 key 时所有 `/v1` 返 403 `unsafe_example_api_key`，用户会误以为是自己 key 错了，已做专门提示
- **能力探测这条路整个废了**：曾经用无鉴权 `POST {}` 靠 404 判断路由是否存在（不能用 OPTIONS —— CPA 的 CORS 中间件对任何路径包括不存在的都返回 204）。判定逻辑本身是对的，但**密集小请求会被一些站判成测活封号**，所以功能删了，改成手动勾。见上面「不做能力探测」
- **推理字段有两条路径，必须都认**。CPA 对官方凭证上游（Gemini/Claude/Codex/Kimi）会翻译成 `delta.reasoning_content`；但 `openai-compatibility` 类型的第三方上游是**原样透传不翻译**的，上游叫什么就是什么。实测 `cpa.yueming.uk` 上的第三方 DeepSeek 源返回 `delta.reasoning`。解析器三个字段都认
- **推理档位**：CPA 支持模型名后缀 `model(high)` / `model(8192)`，优先级高于 `reasoning_effort`，且 Gemini 的 token 预算模式只能靠它
- **联网搜索不对称**：Gemini 走 `tools:[{google_search:{}}]` 可用；Claude 经 chat/completions 会被 `type=="function"` 过滤静默丢弃，必须走 `/v1/messages`
- **模型分类顺序敏感**：video 规则必须在 image 之前，否则 `grok-imagine-video` 会被 `imagine` 抢先匹配成图片模型
- **归类对了不等于端点能用**：Nano Banana 系列确实是图片模型，但 CPA 不允许它们走 `/images/generations`（上游报错会列出该部署实际支持的模型，面板原样展示）。这类"模型存在但此端点不接"的情况靠分类规则解决不了 —— 解法是把端点做成可配的图片路由，把这个模型单独切到 `chat/completions`
- **走 chat 生图时图片经常只在正文里**：不是任何结构化字段，而是回复文本里的 `![](url)`。所以通用提取除了扫字段还扫正文 markdown。裸链接只认带图片扩展名的，且只扫 `content`/`text`/`output_text`/`markdown` 几个键 —— 否则错误信息里的链接也会被当成图片
- **语音端点只有 grok2api 有**：CPA 的 `/tts`、`/stt`、`/audio/speech`、`/audio/transcriptions` 全是 404，尽管它的模型表里有 8 个 TTS 模型。**但这不作为拦人的依据** —— 语音面板早先硬判 `flavor === "grok2api"`，CPA 用户点进去只能看到一句"当前后端不支持语音面板"；换一台配了语音的 CPA 就被冤枉了。现在只看设置页勾了什么，方言只用来在标题栏写一句提醒。声线列表也因此改成只在 grok2api 上自动拉，别的后端给一个「加载声线」按钮
- **联网搜索按钮不支持时禁用而不是隐藏**：早先是隐藏的，结果模型 id 里没写 gemini / grok 时按钮凭空消失，看起来像功能丢了。后来连禁用也去掉了 —— 判定只是猜的，猜错就把能用的功能锁死。现在任何模型都能点，Gemini 发 `google_search`，其余一律发 `{type:"web_search"}`，tooltip 说明大概会发生什么。**特别注意别再回到"不支持就发空 tools"** —— 那样开关看着生效了其实什么都没发出去
- **grok2api 的 TTS 参数比文档窄**：`speed` 只接受 0.7–1.5，编码只有 mp3/wav/opus（aac 和 flac 返回 422）；opus 的响应头写 `audio/opus` 但负载是 Ogg 容器，得改成 `audio/ogg` 才好交给 `<audio>`
- **STT 的 `format` 和 `language` 是绑定的**：`format=true`（数字规范化，`十一万五千六百九十九` → `115,699`）必须同时给 `language`，否则 400。语言选自动识别时只能两个都不发
