# chatweb

网页聊天 —— 连接任意 OpenAI 兼容后端，部署在 Cloudflare Workers。

前身是 grok2api 内置的「创作台」，把它从管理后台里抽出来做成独立应用：打开链接、填一次后端地址和密钥就能用，支持配置多个后端随时切换。

## 功能

- **对话**：OpenAI Chat Completions、流式输出、推理过程、工具活动、停止生成和会话历史。
- **生图**：图片数量、尺寸或比例、质量、URL/Base64 响应、预览、打开和下载。
- **视频**：文本/图片生成视频，以及视频编辑和延长；支持源媒体上传、异步任务轮询、进度、停止等待和结果播放。
- **语音**：grok2api 原生 TTS/STT，支持声线列表、语言、语速、音频格式、播放下载和音频转写。

四个面板只展示用户在设置页保存过的对应模型。语音入口仅在后端具有 TTS 或 STT
能力时显示。视频源文件通过 Worker 的 `/__api/upload` 上传到 R2，再把公网 URL
交给视频接口。

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

1. **设置页**列出后端的全部模型，你勾选常用的存下来
2. **聊天时**的选择器只显示存过的

一个都没存时聊天页会直接提示去挑，不做"降级显示全部"——那样分不清眼前这一长串是自己选的还是系统兜底给的。

模型列表本身缓存在 IndexedDB，24 小时内不重复请求（一次拉取实际是三个请求：`/v1/models` 加两个富字段端点）。设置页有手动刷新。改了后端地址会自动失效重拉。

归类是按模型 id 猜的，猜错了可以在设置页逐个覆盖 —— 勾选保存过的模型下面就有归类下拉。

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
| 模型缓存 | IndexedDB | 同上 |

IndexedDB 没引 idb / dexie —— 访问模式只有 get/put/delete/getAll，手写一百行比多个依赖划算，见 `src/shared/db/idb.ts`。

每条会话是一条独立记录（不是把整个数组序列化成一个键），改一条只写一条。

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
- **能力探测不能用 OPTIONS**：CPA 的 CORS 中间件对任何路径（包括不存在的）都返回 204。改用无鉴权 `POST {}`，404 = 路由不存在
- **推理字段有两条路径，必须都认**。CPA 对官方凭证上游（Gemini/Claude/Codex/Kimi）会翻译成 `delta.reasoning_content`；但 `openai-compatibility` 类型的第三方上游是**原样透传不翻译**的，上游叫什么就是什么。实测 `cpa.yueming.uk` 上的第三方 DeepSeek 源返回 `delta.reasoning`。解析器三个字段都认
- **推理档位**：CPA 支持模型名后缀 `model(high)` / `model(8192)`，优先级高于 `reasoning_effort`，且 Gemini 的 token 预算模式只能靠它
- **联网搜索不对称**：Gemini 走 `tools:[{google_search:{}}]` 可用；Claude 经 chat/completions 会被 `type=="function"` 过滤静默丢弃，必须走 `/v1/messages`
- **模型分类顺序敏感**：video 规则必须在 image 之前，否则 `grok-imagine-video` 会被 `imagine` 抢先匹配成图片模型
- **归类对了不等于端点能用**：Nano Banana 系列确实是图片模型，但 CPA 不允许它们走 `/images/generations`（上游报错会列出该部署实际支持的模型，面板原样展示）。这类"模型存在但此端点不接"的情况靠分类规则解决不了 —— 解法是把端点做成可配的图片路由，把这个模型单独切到 `chat/completions`
- **走 chat 生图时图片经常只在正文里**：不是任何结构化字段，而是回复文本里的 `![](url)`。所以通用提取除了扫字段还扫正文 markdown。裸链接只认带图片扩展名的，且只扫 `content`/`text`/`output_text`/`markdown` 几个键 —— 否则错误信息里的链接也会被当成图片
- **语音端点只有 grok2api 有**：CPA 的 `/tts`、`/stt`、`/audio/speech`、`/audio/transcriptions` 全是 404，尽管它的模型表里有 8 个 TTS 模型。语音入口因此还要看 `flavor`，不能只看模型分类
- **grok2api 的 TTS 参数比文档窄**：`speed` 只接受 0.7–1.5，编码只有 mp3/wav/opus（aac 和 flac 返回 422）；opus 的响应头写 `audio/opus` 但负载是 Ogg 容器，得改成 `audio/ogg` 才好交给 `<audio>`
- **STT 的 `format` 和 `language` 是绑定的**：`format=true`（数字规范化，`十一万五千六百九十九` → `115,699`）必须同时给 `language`，否则 400。语言选自动识别时只能两个都不发
