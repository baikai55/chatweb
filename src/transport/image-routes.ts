import { BUILTIN_IMAGE_ROUTES, type Backend, type CustomImageRoute } from "@/backends/types";
import { joinURL } from "@/transport/chat-completions";
import { isRecord } from "@/transport/errors";

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
 */

/** 请求模板能引用的变量。 */
export type ImageRouteContext = {
  model: string;
  prompt: string;
  n: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  responseFormat: "url" | "b64_json";
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
      messages: [{ role: "user", content: "$prompt" }],
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

export type ResolvedImageRoute = {
  id: string;
  name: string;
  url: string;
  method: "POST" | "GET";
  /** GET 时为 null */
  body: string | null;
  imageUrlPaths: string[];
  b64JsonPaths: string[];
};

/** 把路由定义 + 本次参数展开成一个可以直接 fetch 的请求。 */
export function resolveImageRoute(backend: Backend, context: ImageRouteContext): ResolvedImageRoute {
  const definition = imageRouteFor(backend, context.model);
  const values = toTemplateValues(context);

  const url = new URL(absoluteURL(backend.baseURL, definition.path));
  for (const [key, raw] of Object.entries(definition.query)) {
    const value = resolveTemplate(raw, values);
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return {
    id: definition.id,
    name: definition.name,
    url: url.toString(),
    method: definition.method,
    body: definition.method === "GET" ? null : JSON.stringify(resolveTemplate(definition.body, values)),
    imageUrlPaths: definition.imageUrlPaths,
    b64JsonPaths: definition.b64JsonPaths,
  };
}

/**
 * 模板取值。
 *
 * 整串就是 `$foo` / `$foo.bar` 时按**原类型**取值（数字还是数字），
 * 取不到就返回 undefined，调用方会把这个键整个剪掉 —— 可选参数因此不用写条件分支。
 * 其余字符串按 `${foo}` 做插值，取不到的补空串。
 */
const WHOLE_REF = /^\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;
const INLINE_REF = /\$\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g;

export function resolveTemplate(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_REF.exec(value);
    if (whole) return readPath(values, whole[1]);
    return value.replaceAll(INLINE_REF, (_match, path: string) => {
      const found = readPath(values, path);
      return found === undefined ? "" : String(found);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, values)).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const resolved = resolveTemplate(child, values);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  return value;
}

function readPath(values: Record<string, unknown>, path: string): unknown {
  let current: unknown = values;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
    // null 一律当作没有，免得把 null 发上去被后端判成非法值
    if (current === undefined || current === null) return undefined;
  }
  return current;
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
  return {
    model: context.model,
    prompt: context.prompt,
    n: context.n,
    size,
    aspectRatio,
    aspect_ratio: aspectRatio,
    quality,
    responseFormat: context.responseFormat,
    response_format: context.responseFormat,
  };
}

/** 路由 path 允许直接写完整 URL，这时忽略后端的 baseURL。 */
function absoluteURL(baseURL: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : joinURL(baseURL, path);
}

/**
 * 点号路径取值，`*` 展开数组或对象的全部成员。
 * 例：`choices.*.message.images.*.image_url.url`
 *
 * 一个路径可能命中多个值，所以统一返回数组。
 */
export function selectByPath(source: unknown, path: string): unknown[] {
  let current: unknown[] = [source];

  for (const segment of path.split(".")) {
    if (!segment) continue;
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if (segment === "*") {
        if (Array.isArray(value)) next.push(...value);
        else if (isRecord(value)) next.push(...Object.values(value));
        continue;
      }
      if (Array.isArray(value)) {
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < value.length) next.push(value[index]);
        continue;
      }
      if (isRecord(value) && value[segment] !== undefined) next.push(value[segment]);
    }
    if (next.length === 0) return [];
    current = next;
  }

  return current;
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

/**
 * 路由模板实际引用了哪些变量。
 *
 * 面板据此决定显示哪些参数控件 —— 走 chat/completions 时尺寸、质量、返回格式
 * 根本不会被发出去，还摆在那里就是骗人。
 */
export function routeVariables(route: CustomImageRoute): Set<string> {
  const found = new Set<string>();
  // 下划线写法归一到驼峰，调用方只用认一套名字
  const add = (name: string): void => {
    found.add(name === "aspect_ratio" ? "aspectRatio" : name === "response_format" ? "responseFormat" : name);
  };

  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      const whole = WHOLE_REF.exec(value);
      if (whole) {
        add(whole[1].split(".")[0]);
        return;
      }
      for (const match of value.matchAll(INLINE_REF)) add(match[1].split(".")[0]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) scan(child);
    }
  };

  scan(route.body);
  scan(route.query);
  scan(route.path);
  return found;
}
