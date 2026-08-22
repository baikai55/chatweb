import { BUILTIN_IMAGE_ROUTES, type Backend, type CustomImageRoute } from "@/backends/types";
import {
  resolveRouteRequest,
  scanTemplateVariables,
  type ResolvedRouteRequest,
} from "@/transport/route-template";

/**
 * 图片请求路由。
 *
 * 同一个「图片模型」在不同后端要走不同端点：实测 CPA 上的 Nano Banana 系列
 * 确实是图片模型，但它拒绝 `/images/generations`，只能走 chat/completions；
 * grok2api 的生图两条路都通。这个差异没法从模型 id 推断出来，所以做成可配的
 * 路由，按模型单独指定。
 *
 * 内置的两条路由本身就是用 `CustomImageRoute` 描述的 —— 执行代码只有一套，
 * 用户要写自己的路由时也就有了现成的例子可抄。
 *
 * 模板展开、点号取值这些通用能力在 `route-template.ts`，和视频路由共用。
 */

/** 请求模板能引用的变量。 */
export type ImageRouteContext = {
  model: string;
  prompt: string;
  /** 参考图 URL；浏览器上传的图片会是 data URL。 */
  inputImages?: string[];
  n: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  /** 不填时模板会把 `response_format` 整个键剪掉，见 `GenerateImagesOptions`。 */
  responseFormat?: "url" | "b64_json";
};

export const BUILTIN_ROUTE_DEFS: Record<(typeof BUILTIN_IMAGE_ROUTES)[number], CustomImageRoute> = {
  images: {
    id: "images",
    name: "图片端点 /images/generations",
    path: "/images/generations",
    method: "POST",
    query: {},
    body: {
      model: "$model",
      prompt: "$prompt",
      n: "$n",
      // size 和 aspect_ratio 谁没值谁被剪掉，模板里不用写条件
      size: "$size",
      aspect_ratio: "$aspectRatio",
      quality: "$quality",
      response_format: "$responseFormat",
    },
    imageUrlPaths: [],
    b64JsonPaths: [],
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
      // 关掉流式：走对话端点生图时图片一般在最后一条完整消息里，
      // 分片反而要自己拼，没有收益
      stream: false,
    },
    imageUrlPaths: [],
    b64JsonPaths: [],
  },
};

const BUILTIN_LIST = BUILTIN_IMAGE_ROUTES.map((id) => BUILTIN_ROUTE_DEFS[id]);

export function isBuiltinRouteId(id: string): boolean {
  return (BUILTIN_IMAGE_ROUTES as readonly string[]).includes(id);
}

/** 内置路由在前，用户自定义的在后。 */
export function listImageRoutes(backend: Backend): CustomImageRoute[] {
  return [...BUILTIN_LIST, ...backend.customImageRoutes];
}

/** 某个模型实际走哪条路由。指定的路由被删掉时回落到内置图片端点。 */
export function imageRouteFor(backend: Backend, modelId: string): CustomImageRoute {
  const routeId = backend.imageRouteOverrides[modelId] || backend.defaultImageRoute;
  return listImageRoutes(backend).find((route) => route.id === routeId) ?? BUILTIN_ROUTE_DEFS.images;
}

export type ResolvedImageRoute = ResolvedRouteRequest & {
  id: string;
  name: string;
  imageUrlPaths: string[];
  b64JsonPaths: string[];
};

/** 把路由定义 + 本次参数展开成一个可以直接 fetch 的请求。 */
export function resolveImageRoute(backend: Backend, context: ImageRouteContext): ResolvedImageRoute {
  const definition = imageRouteFor(backend, context.model);
  const request = resolveRouteRequest(backend.baseURL, definition, toTemplateValues(context));

  return {
    ...request,
    id: definition.id,
    name: definition.name,
    imageUrlPaths: definition.imageUrlPaths,
    b64JsonPaths: definition.b64JsonPaths,
  };
}

/**
 * 下划线和驼峰两种写法都提供，用户写模板时不用猜大小写。
 *
 * size 有值时丢掉 aspectRatio —— 两个一起发多数后端会报冲突，
 * 这个取舍在这里做掉，模板里就不用表达"二选一"。
 */
function toTemplateValues(context: ImageRouteContext): Record<string, unknown> {
  const size = context.size?.trim() || undefined;
  const aspectRatio = size ? undefined : context.aspectRatio?.trim() || undefined;
  const quality = context.quality?.trim() || undefined;
  const inputImages = context.inputImages?.map((url) => url.trim()).filter(Boolean) ?? [];
  const messageContent = inputImages.length === 0
    ? context.prompt
    : [
        { type: "text", text: context.prompt },
        ...inputImages.map((url) => ({
          type: "image_url",
          image_url: { url, detail: "auto" },
        })),
      ];
  return {
    model: context.model,
    prompt: context.prompt,
    messageContent,
    message_content: messageContent,
    inputImages: inputImages.length > 0 ? inputImages : undefined,
    input_images: inputImages.length > 0 ? inputImages : undefined,
    n: context.n,
    size,
    aspectRatio,
    aspect_ratio: aspectRatio,
    quality,
    responseFormat: context.responseFormat,
    response_format: context.responseFormat,
  };
}

/**
 * 标准图片路由会在带参考图时切到 `/images/edits`；对话/自定义路由则要在
 * JSON 模板里引用多模态内容或图片数组。调用方据此决定附件控件是否可用。
 */
export function imageRouteSupportsInputImages(route: CustomImageRoute): boolean {
  if (route.id === "images" || route.id === "chat") return true;
  const variables = routeVariables(route);
  return variables.has("messageContent") || variables.has("inputImages");
}

/** 设置页「新建路由」用的种子，从内置路由复制一份。 */
export function draftCustomRoute(source: CustomImageRoute, id: string): CustomImageRoute {
  return {
    ...source,
    id,
    name: `${source.name} 副本`,
    query: { ...source.query },
    body: structuredClone(source.body),
    imageUrlPaths: [...source.imageUrlPaths],
    b64JsonPaths: [...source.b64JsonPaths],
  };
}

const IMAGE_VARIABLE_ALIASES: Record<string, string> = {
  aspect_ratio: "aspectRatio",
  response_format: "responseFormat",
  message_content: "messageContent",
  input_images: "inputImages",
};

/**
 * 路由模板实际引用了哪些变量。
 *
 * 面板据此决定显示哪些参数控件 —— 走 chat/completions 时尺寸、质量、返回格式
 * 根本不会被发出去，还摆在那里就是骗人。
 */
export function routeVariables(route: CustomImageRoute): Set<string> {
  return scanTemplateVariables(
    [route.body, route.query, route.path],
    (name) => IMAGE_VARIABLE_ALIASES[name] ?? name,
  );
}
