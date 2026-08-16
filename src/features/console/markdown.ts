import { marked } from "marked";

/**
 * 助手消息的 Markdown 渲染与 XSS 清洗。
 *
 * 这块整体沿用 grok2api 创作台的实现（creative-console-page.tsx:1918-2007），
 * 因为它已经在生产里跑过，而且这是**安全关键路径**——API key 就存在 localStorage 里，
 * 这里破一个 XSS 就等于丢 key。不要为了省事换成裸 dangerouslySetInnerHTML。
 *
 * 策略是白名单 + 属性全清：
 *   1. 危险标签（script/iframe/form/...）直接删除，连同子节点
 *   2. 不在白名单里的标签"脱壳"——移除标签本身但保留文字内容
 *   3. 白名单标签的**所有属性一律清空**，然后只把校验过的几个加回去
 *
 * 第 3 条是关键：不是"过滤掉危险属性"，而是"先全删再按需加回"。
 * 前者需要穷举所有危险属性（onclick/onerror/onload/... 加不完），后者不需要。
 */

const SAFE_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "kbd", "li", "mark", "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

const DISCARDED_TAGS = new Set([
  "applet", "audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "iframe", "input", "link",
  "math", "meta", "object", "picture", "script", "select", "source", "style", "svg", "template", "textarea", "video",
]);

export function renderAssistantMarkup(content: string): string {
  const rendered = marked.parse(content, { async: false, breaks: true, gfm: true });
  return sanitizeAssistantHTML(typeof rendered === "string" ? rendered : "");
}

export function sanitizeAssistantHTML(content: string): string {
  if (typeof DOMParser === "undefined") return "";
  const source = content.trim();
  // 纯文本不含标签时返回空串，让调用方走纯文本渲染分支
  if (!/<\/?[a-z][^>]*>/i.test(source)) return "";

  const parsed = new DOMParser().parseFromString(source, "text/html");
  for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
    // 前面的删除操作可能已经把它从树上摘掉了
    if (!element.isConnected) continue;

    const tag = element.tagName.toLowerCase();
    if (DISCARDED_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!SAFE_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    // 先把校验过的值取出来，因为下一步要清空所有属性
    const href = tag === "a" ? safeLink(element.getAttribute("href")) : "";
    const title = tag === "a" ? element.getAttribute("title")?.slice(0, 512) ?? "" : "";
    const imageSource = tag === "img" ? safeImageSource(element.getAttribute("src")) : "";
    const imageAlt = tag === "img" ? element.getAttribute("alt")?.slice(0, 512) ?? "" : "";
    const colSpan = tag === "td" || tag === "th" ? boundedSpan(element.getAttribute("colspan")) : "";
    const rowSpan = tag === "td" || tag === "th" ? boundedSpan(element.getAttribute("rowspan")) : "";
    const open = tag === "details" && element.hasAttribute("open");

    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);

    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "nofollow noopener noreferrer");
    }
    if (title) element.setAttribute("title", title);
    if (imageSource) {
      element.setAttribute("src", imageSource);
      element.setAttribute("alt", imageAlt);
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
      element.setAttribute("referrerpolicy", "no-referrer");
    } else if (tag === "img") {
      // src 没通过校验的图片直接扔掉，别留个破图占位
      element.remove();
      continue;
    }
    if (colSpan) element.setAttribute("colspan", colSpan);
    if (rowSpan) element.setAttribute("rowspan", rowSpan);
    if (open) element.setAttribute("open", "");
  }
  return parsed.body.innerHTML;
}

/** 只放行 http / https / mailto，挡掉 javascript: 和 data: 。 */
function safeLink(value: string | null): string {
  const link = value?.trim() ?? "";
  if (!link) return "";
  try {
    const parsed = new URL(link);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

/**
 * 图片只放行 https 和自家 Worker 的 R2 回读路径。
 *
 * 跟 grok2api 原版的区别：原版放行的是同源相对路径 /v1/media/images/，
 * 这里改成 /__api/media/ —— 独立部署下后端是跨域的，图片托管在自己的 Worker 上。
 * data: 一律不放行，避免超大 base64 拖死渲染。
 */
function safeImageSource(value: string | null): string {
  const source = value?.trim() ?? "";
  if (!source) return "";
  if (source.startsWith("/__api/media/")) return source;
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function boundedSpan(value: string | null): string {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? String(parsed) : "";
}
