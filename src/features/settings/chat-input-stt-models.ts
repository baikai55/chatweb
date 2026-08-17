import type { CatalogModel } from "@/backends/model-catalog";

/** 聊天录音只允许使用用户明确保存、且归类为语音转写的模型。 */
export function listChatInputSTTModels(models: CatalogModel[]): CatalogModel[] {
  return models.filter((model) => model.saved && model.kind === "stt");
}
