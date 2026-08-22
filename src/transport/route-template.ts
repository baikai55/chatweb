import { joinURL } from "@/transport/url";
import { isRecord } from "@/transport/errors";

/**
 * 自定义路由的模板引擎。图片路由和视频路由共用这一套，两边只在
 * 「有哪些变量」和「怎么从响应里取媒体」上不同，请求侧的展开规则完全一致。
 *
 * 取值规则：
 *   - 整串就是 `$foo` / `$foo.bar` 时按**原类型**取值（数字还是数字），
 *     取不到就返回 undefined，调用方会把这个键整个剪掉 —— 可选参数因此不用写条件分支。
 *   - 其余字符串按 `${foo}` 做插值，取不到的补空串。
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
    // 原本有内容、但每个键都被剪掉的对象，自己也被剪掉。
    // 视频路由的 `image: { url: "$sourceUrl" }` 靠这条在没有源图时整块消失 ——
    // 留一个空的 `image: {}` 发上去，有的后端会判成非法值。
    // 模板里写死的 `{}` 是用户明确要发的，保留。
    if (Object.keys(result).length === 0 && Object.keys(value).length > 0) return undefined;
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

/**
 * 模板里实际引用了哪些变量。
 *
 * 面板据此决定显示哪些参数控件 —— 走 chat/completions 生图时尺寸、质量、返回格式
 * 根本不会被发出去，还摆在那里就是骗人。
 *
 * `normalize` 由调用方提供，用来把下划线写法归一到驼峰，这样用户写模板时不用猜大小写。
 */
export function scanTemplateVariables(
  sources: unknown[],
  normalize: (name: string) => string,
): Set<string> {
  const found = new Set<string>();

  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      const whole = WHOLE_REF.exec(value);
      if (whole) {
        found.add(normalize(whole[1].split(".")[0]));
        return;
      }
      for (const match of value.matchAll(INLINE_REF)) found.add(normalize(match[1].split(".")[0]));
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

  for (const source of sources) scan(source);
  return found;
}

/** 路由 path 允许直接写完整 URL，这时忽略后端的 baseURL。 */
export function absoluteURL(baseURL: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : joinURL(baseURL, path);
}

/** 一条路由的请求侧定义。图片和视频的路由类型都是它的超集。 */
export type RouteRequestDefinition = {
  path: string;
  method: "POST" | "GET";
  query: Record<string, string>;
  body: Record<string, unknown>;
};

export type ResolvedRouteRequest = {
  url: string;
  method: "POST" | "GET";
  /** GET 时为 null */
  body: string | null;
};

/** 把路由定义 + 本次参数展开成一个可以直接 fetch 的请求。 */
export function resolveRouteRequest(
  baseURL: string,
  definition: RouteRequestDefinition,
  values: Record<string, unknown>,
): ResolvedRouteRequest {
  const url = new URL(absoluteURL(baseURL, resolveString(definition.path, values)));
  for (const [key, raw] of Object.entries(definition.query)) {
    const value = resolveTemplate(raw, values);
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return {
    url: url.toString(),
    method: definition.method,
    body: definition.method === "GET" ? null : JSON.stringify(resolveTemplate(definition.body, values)),
  };
}

/** path 这类只能是字符串的字段：模板取不到值时按空串处理，不要变成 "undefined"。 */
function resolveString(value: string, values: Record<string, unknown>): string {
  const resolved = resolveTemplate(value, values);
  return typeof resolved === "string" ? resolved : resolved === undefined ? "" : String(resolved);
}
