import { CAPABILITIES, type Capability } from "@/backends/types";

/**
 * 计算一次能力按钮点击后的显式列表。
 *
 * 空数组是旧配置里的「尚未选择 = 全部显示」，所以第一次点击已亮的按钮时必须先
 * 展开成完整列表再移除。最后一个入口不允许关闭，避免工作区变成没有可进入的面板。
 */
export function toggleCapabilitySelection(current: Capability[], capability: Capability): Capability[] {
  const enabled = current.length === 0 ? [...CAPABILITIES] : current;
  if (!enabled.includes(capability)) return [...enabled, capability];
  if (enabled.length === 1) return current;
  return enabled.filter((item) => item !== capability);
}
