# 交接说明

给下一个接手的会话看的。项目背景和设计取舍看 `README.md`，完整方案看
`C:\Users\99037\.claude\plans\unified-whistling-fox.md`。这里只写「现在到哪了、接下来做什么」。

## 已完成且验证过

跑过 `pnpm check` 和 `pnpm build`，都干净。Worker 用 `wrangler dev` 实跑过。

| 模块 | 文件 | 状态 |
|---|---|---|
| SSE 解析 | `src/transport/sse.ts` | ✅ 含 90s 静默超时、8MB 缓冲上限 |
| chat/completions 适配 | `src/transport/chat-completions.ts` | ✅ 两个后端实测通过 |
| 错误解析 | `src/transport/errors.ts` | ✅ 兼容四种错误体形状 |
| 后端配置存储 | `src/backends/backend-store.ts` | ✅ localStorage + zod |
| 能力探测 | `src/backends/capability-probe.ts` | ✅ 无鉴权 POST `{}`，404=不存在 |
| 模型目录 | `src/backends/model-catalog.ts` | ✅ 85 个真实模型回归验证过 |
| IndexedDB | `src/shared/db/idb.ts` | ✅ 手写封装，无第三方依赖 |
| 会话存储 | `src/features/console/chat-store.ts` | ✅ 已从 localStorage 迁到 IndexedDB |
| Markdown + XSS 清洗 | `src/features/console/markdown.ts` | ✅ 从 grok2api 移植 |
| 聊天面板 | `src/features/console/chat-panel.tsx` | ✅ 流式/推理/工具/停止/错误 |
| 模型选择器 | `src/features/console/model-picker.tsx` | ✅ 搜索 + 分组 |
| 侧栏 + 四模式 | `src/app/app-shell.tsx` | ✅ 按后端能力显隐、移动端抽屉 |
| 会话状态 | `src/features/console/use-chat-sessions.ts` | ✅ 侧栏历史与聊天面板共享 |
| 生图面板 | `src/features/image/image-panel.tsx`、`src/transport/images.ts` | ✅ 参数控制、URL/Base64、流式兼容、预览与下载 |
| 视频面板 | `src/features/video/video-panel.tsx`、`src/transport/videos.ts` | ✅ 生成/编辑/延长、媒体上传、轮询、取消与播放 |
| 语音面板 | `src/features/voice/voice-panel.tsx`、`src/transport/voice.ts` | ✅ TTS/STT、声线、播放下载与转写 |
| 设置页 | `src/features/settings/settings-view.tsx` | ✅ 后端可编辑、能力手勾、模型归类覆盖、图片路由、行为设置 |
| 图片路由 | `src/transport/image-routes.ts` | ⚠️ 单测过，未打真后端 |
| 行为设置 | `src/shared/settings/app-settings.ts` | ✅ 提交方式、清空输入、完成通知 |
| Worker | `worker/*.ts` | ✅ R2 上传往返字节一致、路径穿越已挡、CSP 已下发 |

三个创作面板已经在 `src/app/app.tsx` 接入，原来的 `ComingSoon` 已删除。
同时修正了聊天默认模型候选：聊天会话只使用已保存的 chat 模型，不会误选图片或视频模型。

本轮再次运行过 `pnpm check` 和 `pnpm build`，均通过。Vite 仅提示主包超过
500 KB，不影响构建产物。

## 本轮（设置页重做 + 图片路由）

用户点名要借鉴 `gpt-image-playground`，选了四块全做。都做完了，`pnpm check`、
`pnpm build`、`pnpm test` 干净。设置页从 `app.tsx` 里搬进
`src/features/settings/settings-view.tsx`，拆成四个标签页。

**1. 后端可编辑**：名称 / 地址 / 密钥就地改，有「还原」；能力五个 chip 可手动勾；
「重新探测」按钮。探测那段说明里写明了**别反复点**（会被当测活），
未保存的改动会禁用探测按钮，免得探的是旧地址。

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

**4. 行为设置** —— `src/shared/settings/app-settings.ts`（localStorage + zod，
和 backend-store 同一套路）：提交方式、提交后清空输入框、任务完成通知。
`shouldSubmitOnKey()` 统一四个面板的键盘判定；`enter` 档下 Ctrl/⌘+Enter 也照发，
这一档只是"多一种发送方式"，不该把另一种惯用手势变成哑键。默认 `enter` ——
聊天是主界面，回车发送是那里的通行约定，这样老行为不变。
通知只在 `document.hidden` 时发（人盯着看的时候再弹纯属打扰），
开关前先要权限，拿不到就不拨过去。

顺手修了一个真 bug：模型缓存只按 `backend.id` 存，**改了 baseURL 还会命中旧缓存**
（24 小时 TTL）。缓存记录现在带 `baseURL`，不匹配就重拉。

**测试**：装了 vitest，`pnpm test`。31 个用例覆盖模板展开、路由选择与回落、
`routeVariables`、`selectByPath`、以及各种响应形状的取图（含 markdown 正文、
去重、错误信息里的链接不误报）。这些都是纯函数，不打网络。

## 上一轮（用真实 key 实测后端）

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

1. 部署环境验证视频源文件经 `/__api/upload` 上传到 R2 后，上游能否读取公网 URL。
   （本地没法验，必须真部署一次。）
2. 检查三个媒体面板的移动端布局、暗色模式、取消操作和错误状态。
   代码层面读过一遍没发现问题，但没有真机/窄视口实测过。
   **本轮新增的设置页四个标签页也在此列** —— 标签栏在窄屏是否需要横向滚动没实测。
3. **图片路由只做过单测，没打过真后端**。特别是这两条：
   - CPA 上把 Nano Banana 的路由切成 `chat`，看能不能真出图、图片在响应的哪个位置
     （通用提取够不够，还是得填 `imageUrlPaths`）。
   - grok2api 走 `chat` 路由生图。用户说它支持这个格式，但没验过响应形状。
   验的时候记住下面那条红线，一次一个请求，不要扫参数。
4. 远程音频下载的 CORS、STT 大文件上限 —— 都还没测。
5. **可选**：Responses 协议适配器（`src/transport/responses.ts`）。
   CPA 的 `/responses` 和 `/messages` 都确认存在（无鉴权 401、带 key 400），
   要做的话有端点可打。目前只实现了 chat/completions。
6. **可选**：自定义路由暂不支持异步任务轮询。目前接触到的图片端点都是同步返回的，
   真需要时参照 `src/transport/videos.ts` 的轮询实现再加。

## ⚠️ 联调时的红线

**不要连续发大量低 token 的探测请求** —— 会被上游判定成测活行为，导致 API 被封。
上一轮就是这么踩到的。要验证协议行为时：想清楚一次请求要回答哪几个问题，
合并成尽量少的请求，不要写 for 循环扫参数矩阵。

## 设计约束（用户明确说过的）

- **配色已对齐** `https://not2api.yueming.uk/`：纯单色系，无彩色强调，
  发送按钮纯黑（深色模式反相）。已写进 `src/index.css`，只有 `--destructive` 保留红色。
- **不要按时段变化的问候语**（参考站有 "Lunch break thinking." / "Coffee and code."
  那一套，用户明确说不要）。空状态用朴素一句话。
- **模型不做「没保存就显示全部」的降级** —— 用户明确否决过。一个都没保存时
  给提示并引导去设置页。
- 值得借鉴：`https://github.com/baikai55/gpt-image-playground`（已设为 public，TypeScript，
  142 个文件）。用户说它的设置页功能齐全。**本轮已借鉴**：custom provider 的
  `$` 模板 + 点号取图路径设计进了 `image-routes.ts`；`GeneralSettingsTab` 的
  「标签 + 控件 + 说明」行式布局进了行为设置页。参考源码临时下载在 `.ref/`
  （已 gitignore，只有四个文件：`types.ts`、`openaiCompatibleImageApi.ts`、
  `GeneralSettingsTab.tsx`、`ModelPicker.tsx`）。还没读过的：
  `src/lib/apiProfiles.ts`（914 行，多 API 配置档案的数据模型）、`src/lib/db.ts`。

## 联调需要的东西（不在仓库里）

两个后端的 API key **不在任何文件里**，需要用户重新提供（上一轮已验证两个 key 都可用）：

- CPA：`https://cpa.yueming.uk/v1` —— 68 个模型，全是第三方接入
- grok2api：`https://grok2.yueming.uk/v1` —— 20 个模型，独有 tts/stt

R2 桶名 `chatweb` 已填进 `wrangler.toml`。

### 两个后端的端点实况（实测状态码，404 = 不存在）

| 端点 | CPA | grok2api |
|---|---|---|
| `/chat/completions`、`/responses`、`/messages` | ✅ | ✅ |
| `/images/generations`、`/images/edits` | ✅ | ✅ |
| `/videos/generations` | ✅ | ✅ |
| `/tts`、`/stt` | ❌ 404 | ✅ |
| `/audio/speech`、`/audio/transcriptions` | ❌ 404 | ✅ |

CPA **完全没有语音端点**，但它的模型表里有 8 个会被归类成 tts 的模型
（三个 Gemini TTS、`Gemini 2.5 Flash Native Audio Latest`、两个 Lyria、
`Gemini 3.1 Flash Live Preview`、`chatgpt-voice`）。语音面板靠
`backend.flavor === "grok2api"` 挡住了，CPA 用户看到的是「当前后端不支持语音面板」
而不是一堆点了必报错的模型 —— 这个行为是对的，别改。

grok2api 除了 grok2api 原生的 `/tts` `/stt`，还额外提供 OpenAI 标准的
`/audio/speech` `/audio/transcriptions`。目前 `voice.ts` 走的是原生那对。

## 踩过的坑（别重复踩）

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
- **能力探测不能用 OPTIONS** —— CPA 的 CORS 中间件对任何路径都返回 204。
- **块注释里别写 `*/`** —— 上一轮在注释里写路径 `internal/translator/*/openai/...`
  把注释提前闭合了，构建直接炸。
- **`with_timestamps: true` 在这台 grok2api 上拿不到结果** —— 连续两次都返回
  503 `当前没有可用的上游账号`，而同时段不带这个参数的 TTS 正常 200。
  怀疑是时间戳走的上游池没配账号。没有下掉这个开关（换个部署可能可用），
  但如果用户报「返回时间戳」不工作，先怀疑这个而不是解析代码。
- pnpm 11 的构建脚本白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`，不是 package.json。
