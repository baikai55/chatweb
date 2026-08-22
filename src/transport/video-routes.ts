import { BUILTIN_VIDEO_ROUTES, type Backend, type CustomVideoRoute } from "@/backends/types";
import {
  resolveRouteRequest,
  resolveTemplate,
  scanTemplateVariables,
  absoluteURL,
  type ResolvedRouteRequest,
} from "@/transport/route-template";

/**
 * 视频请求路由。
 *
 * 和图片路由是同一套东西（模板引擎共用 `route-template.ts`），存在的理由也一样：
 * 同一个「视频模型」在不同后端挂在不同端点上，从模型 id 看不出来。
 *
 * 两条内置路由：
 *   videos  提交 `/videos/generations` 拿任务 ID，再轮询 `/videos/{id}`
 *   chat    直接打 `/chat/completions`，视频地址在回复正文里，同步返回
 *
 * 内置路由本身就是用 `CustomVideoRoute` 描述的 —— 执行代码只有一套，
 * 用户要写自己的路由时也就有了现成的例子可抄。
 */

/** 请求模板能引用的变量。 */
export type VideoRouteContext = {
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  /** 源图片的公网 URL（图生视频）。面板会先把本地文件传成公网地址。 */
  sourceUrl?: string;
};

export const BUILTIN_VIDEO_ROUTE_DEFS: Record<(typeof BUILTIN_VIDEO_ROUTES)[number], CustomVideoRoute> = {
  videos: {
    id: "videos",
    name: "视频端点 /videos/generations",
    path: "/videos/generations",
    method: "POST",
    query: {},
    body: {
      model: "$model",
      prompt: "$prompt",
      duration: "$duration",
      aspect_ratio: "$aspectRatio",
      resolution: "$resolution",
      // 没有源图片时整个 image 键被剪掉，模板里不用写条件
      image: { url: "$sourceUrl" },
    },
    videoUrlPaths: [],
    statusPath: "/videos/${requestId}",
  },
  chat: {
    id: "chat",
    name: "对话端点 /chat/completions",
    path: "/chat/completions",
    method: "POST",
    query: {},
    body: {
      model: "$model",
      messages: [{ role: "user", content: "$messageContent" }],
      // 关掉流式：走对话端点生视频时地址一般在最后一条完整消息里，
      // 分片反而要自己拼，没有收益
      stream: false,
    },
    videoUrlPaths: [],
    // 对话端点是同步的，没有任务可轮询
    statusPath: "",
  },
};

const BUILTIN_LIST = BUILTIN_VIDEO_ROUTES.map((id) => BUILTIN_VIDEO_ROUTE_DEFS[id]);

export function isBuiltinVideoRouteId(id: string): boolean {
  return (BUILTIN_VIDEO_ROUTES as readonly string[]).includes(id);
}

/** 内置路由在前，用户自定义的在后。 */
export function listVideoRoutes(backend: Backend): CustomVideoRoute[] {
  return [...BUILTIN_LIST, ...backend.customVideoRoutes];
}

/** 某个模型实际走哪条路由。指定的路由被删掉时回落到内置视频端点。 */
export function videoRouteFor(backend: Backend, modelId: string): CustomVideoRoute {
  const routeId = backend.videoRouteOverrides[modelId] || backend.defaultVideoRoute;
  return listVideoRoutes(backend).find((route) => route.id === routeId)
    ?? BUILTIN_VIDEO_ROUTE_DEFS.videos;
}

export type ResolvedVideoRoute = ResolvedRouteRequest & {
  id: string;
  name: string;
  videoUrlPaths: string[];
  statusPath: string;
};

/** 把路由定义 + 本次参数展开成一个可以直接 fetch 的提交请求。 */
export function resolveVideoRoute(
  baseURL: string,
  definition: CustomVideoRoute,
  context: VideoRouteContext,
): ResolvedVideoRoute {
  const request = resolveRouteRequest(baseURL, definition, toTemplateValues(context));
  return {
    ...request,
    id: definition.id,
    name: definition.name,
    videoUrlPaths: definition.videoUrlPaths,
    statusPath: definition.statusPath,
  };
}

/**
 * 任务状态的查询地址。`statusPath` 为空表示这条路由是同步的，返回空串，
 * 调用方据此决定不去轮询。
 *
 * requestId 在放进模板前就编码好 —— 状态路径是路径片段而不是查询参数，
 * 不经过 URLSearchParams，这里不编码就会被任务 ID 里的斜杠劈开。
 */
export function resolveVideoStatusURL(
  baseURL: string,
  statusPath: string,
  requestId: string,
): string {
  const path = statusPath.trim();
  if (!path) return "";
  const values = { requestId: encodeURIComponent(requestId), request_id: encodeURIComponent(requestId) };
  const resolved = resolveTemplate(path, values);
  return absoluteURL(baseURL, typeof resolved === "string" ? resolved : path);
}

function toTemplateValues(context: VideoRouteContext): Record<string, unknown> {
  const duration = Number.isFinite(context.duration) ? context.duration : undefined;
  const aspectRatio = context.aspectRatio?.trim() || undefined;
  const resolution = context.resolution?.trim() || undefined;
  const sourceUrl = context.sourceUrl?.trim() || undefined;
  // 对话端点用多模态消息带源图片；没有源图时就是一条纯文本
  const messageContent = sourceUrl
    ? [
        { type: "text", text: context.prompt },
        { type: "image_url", image_url: { url: sourceUrl, detail: "auto" } },
      ]
    : context.prompt;

  return {
    model: context.model,
    prompt: context.prompt,
    messageContent,
    message_content: messageContent,
    duration,
    aspectRatio,
    aspect_ratio: aspectRatio,
    resolution,
    sourceUrl,
    source_url: sourceUrl,
  };
}

const VIDEO_VARIABLE_ALIASES: Record<string, string> = {
  aspect_ratio: "aspectRatio",
  message_content: "messageContent",
  source_url: "sourceUrl",
};

/**
 * 路由模板实际引用了哪些变量。
 *
 * 面板据此决定显示哪些参数控件 —— 走 chat/completions 时时长、画面比例、清晰度
 * 根本不会被发出去，还摆在那里就是骗人。
 */
export function videoRouteVariables(route: CustomVideoRoute): Set<string> {
  return scanTemplateVariables(
    [route.body, route.query, route.path],
    (name) => VIDEO_VARIABLE_ALIASES[name] ?? name,
  );
}

/** 这条路由能不能带源图片（图生视频）。 */
export function videoRouteSupportsSource(route: CustomVideoRoute): boolean {
  const variables = videoRouteVariables(route);
  return variables.has("sourceUrl") || variables.has("messageContent");
}

/**
 * 编辑 / 延长只有内置 `videos` 路由支持。
 *
 * 这两个操作打的是 `/videos/edits` 和 `/videos/extensions`，语义由 xAI 那套
 * 任务接口定死；对话端点和自定义路由没有对应概念，硬套只会得到 404。
 */
export function videoRouteSupportsEditing(route: CustomVideoRoute): boolean {
  return route.id === "videos";
}

/** 设置页「新建路由」用的种子，从内置路由复制一份。 */
export function draftCustomVideoRoute(source: CustomVideoRoute, id: string): CustomVideoRoute {
  return {
    ...source,
    id,
    name: `${source.name} 副本`,
    query: { ...source.query },
    body: structuredClone(source.body),
    videoUrlPaths: [...source.videoUrlPaths],
  };
}
