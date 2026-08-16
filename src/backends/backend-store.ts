import { backendStateSchema, type Backend, type BackendState } from "@/backends/types";

/**
 * 后端配置的本地持久化。
 *
 * 存 localStorage 而不是 IndexedDB：数据量很小（几个后端配置），
 * 而且需要同步读取来决定首屏渲染什么（有没有配过后端 → 引导页 or 创作台）。
 *
 * ⚠️ direct 模式下 apiKey 明文存在这里。这是刻意的设计取舍 ——
 * 纯静态部署没有服务端可以托管密钥。要分享链接给别人时应该用 proxy 模式。
 */

const STORAGE_KEY = "chatweb:backends";

const EMPTY_STATE: BackendState = {
  version: 1,
  backends: [],
  activeBackendId: null,
};

type Listener = (state: BackendState) => void;

const listeners = new Set<Listener>();
let cache: BackendState | null = null;

export function loadBackendState(): BackendState {
  if (cache) return cache;
  cache = readFromStorage();
  return cache;
}

function readFromStorage(): BackendState {
  if (typeof localStorage === "undefined") return EMPTY_STATE;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常
    return EMPTY_STATE;
  }
  if (!raw) return EMPTY_STATE;

  try {
    const parsed = backendStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return EMPTY_STATE;
    return normalizeActive(parsed.data);
  } catch {
    return EMPTY_STATE;
  }
}

/** 保证 activeBackendId 一定指向一个真实存在的后端。 */
function normalizeActive(state: BackendState): BackendState {
  if (state.backends.length === 0) {
    return { ...state, activeBackendId: null };
  }
  const exists = state.backends.some((backend) => backend.id === state.activeBackendId);
  return exists ? state : { ...state, activeBackendId: state.backends[0].id };
}

function commit(next: BackendState): BackendState {
  const normalized = normalizeActive(next);
  cache = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // 存储配额满或隐私模式。内存里的状态仍然有效，只是刷新后会丢。
  }
  for (const listener of listeners) listener(normalized);
  return normalized;
}

export function subscribeBackends(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveBackend(): Backend | null {
  const state = loadBackendState();
  return state.backends.find((backend) => backend.id === state.activeBackendId) ?? null;
}

export function setActiveBackend(id: string): BackendState {
  return commit({ ...loadBackendState(), activeBackendId: id });
}

export function upsertBackend(backend: Backend): BackendState {
  const state = loadBackendState();
  const index = state.backends.findIndex((item) => item.id === backend.id);
  const backends = index >= 0
    ? state.backends.map((item, i) => (i === index ? backend : item))
    : [...state.backends, backend];
  return commit({
    ...state,
    backends,
    // 第一个添加的后端自动设为当前
    activeBackendId: state.activeBackendId ?? backend.id,
  });
}

export function removeBackend(id: string): BackendState {
  const state = loadBackendState();
  return commit({
    ...state,
    backends: state.backends.filter((backend) => backend.id !== id),
    activeBackendId: state.activeBackendId === id ? null : state.activeBackendId,
  });
}

export function patchBackend(id: string, patch: Partial<Backend>): BackendState {
  const state = loadBackendState();
  const target = state.backends.find((backend) => backend.id === id);
  if (!target) return state;
  return upsertBackend({ ...target, ...patch });
}

/** 导出配置。默认脱敏，方便贴到别处求助时不泄露 key。 */
export function exportBackends(options: { includeKeys: boolean }): string {
  const state = loadBackendState();
  const backends = state.backends.map((backend) =>
    options.includeKeys ? backend : { ...backend, apiKey: "" },
  );
  return JSON.stringify({ ...state, backends }, null, 2);
}

export function importBackends(json: string, options: { replace: boolean }): BackendState {
  const parsed = backendStateSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error("配置格式不对，无法导入");
  }
  const current = loadBackendState();
  if (options.replace) return commit(parsed.data);

  // 合并：同 id 覆盖，新 id 追加
  const byId = new Map(current.backends.map((backend) => [backend.id, backend]));
  for (const backend of parsed.data.backends) byId.set(backend.id, backend);
  return commit({ ...current, backends: Array.from(byId.values()) });
}
