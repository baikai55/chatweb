/**
 * 拼接 baseURL 和路径。
 *
 * 单独一个模块而不是挂在 chat-completions 上：模型目录、语音、路由模板这些
 * 都只需要这四行，跟着 import 整个对话协议模块进来会把它塞进共享 chunk。
 */
export function joinURL(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
