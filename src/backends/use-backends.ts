import { useCallback, useSyncExternalStore } from "react";

import {
  loadBackendState,
  patchBackend,
  removeBackend,
  setActiveBackend,
  subscribeBackends,
  upsertBackend,
} from "@/backends/backend-store";
import type { Backend, BackendState } from "@/backends/types";

/**
 * 订阅后端配置。用 useSyncExternalStore 而不是 Context，
 * 因为配置的读写点分散（设置页、顶栏切换、探测回填），走外部 store 更直接。
 */
export function useBackendState(): BackendState {
  return useSyncExternalStore(subscribeBackends, loadBackendState, loadBackendState);
}

export function useBackends() {
  const state = useBackendState();
  const active = state.backends.find((backend) => backend.id === state.activeBackendId) ?? null;

  const save = useCallback((backend: Backend) => upsertBackend(backend), []);
  const patch = useCallback((id: string, changes: Partial<Backend>) => patchBackend(id, changes), []);
  const remove = useCallback((id: string) => removeBackend(id), []);
  const activate = useCallback((id: string) => setActiveBackend(id), []);

  return { state, backends: state.backends, active, save, patch, remove, activate };
}
