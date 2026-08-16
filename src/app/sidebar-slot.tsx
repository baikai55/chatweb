import { createContext, useContext } from "react";

/**
 * 侧栏下半截的插槽。
 *
 * 聊天的会话列表本来就长在侧栏里，生图/视频/语音的历史一开始做成了面板顶部的
 * 折叠抽屉 —— 同一个东西两个位置，用户反馈"统一在左侧好了"。
 *
 * 但历史的状态（当前选中哪条、点回一条要怎么恢复面板）跟各自的面板绑得很紧，
 * 硬提到 `Console` 去要在三个面板之间来回传 record 和回调。这里换成插槽：
 * `AppShell` 在侧栏留一个 DOM 节点，面板照旧在自己内部渲染 `<GenerationHistory>`，
 * 由它 portal 到侧栏去。面板的内部结构一行都不用动。
 *
 * `element` 为 null 时 `GenerationHistory` 会退回原地渲染（比如被单独用在别处）。
 */
export type SidebarSlot = {
  element: HTMLElement | null;
  /** 移动端点完一条历史要把抽屉关掉，桌面端是空操作。 */
  onNavigate: () => void;
};

const SidebarSlotContext = createContext<SidebarSlot>({ element: null, onNavigate: () => {} });

export const SidebarSlotProvider = SidebarSlotContext.Provider;

export function useSidebarSlot(): SidebarSlot {
  return useContext(SidebarSlotContext);
}
