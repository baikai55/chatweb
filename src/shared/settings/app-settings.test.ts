import { describe, expect, it } from "vitest";

import { SEARCH_PROVIDERS, appSettingsSchema } from "@/shared/settings/app-settings";

describe("appSettingsSchema", () => {
  it("新安装默认隐藏聊天麦克风", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      showChatMicrophone: false,
      searchProvider: "auto",
      searchApiKey: "",
      searchBaseUrl: "",
    });
  });

  it("解析旧版设置时保留原值并补齐新的语音设置", () => {
    expect(appSettingsSchema.parse({
      submitMode: "ctrl-enter",
      clearInputAfterSubmit: true,
      notifyOnComplete: true,
      imageTimeoutSeconds: 600,
    })).toEqual({
      submitMode: "ctrl-enter",
      clearInputAfterSubmit: true,
      showChatMicrophone: false,
      searchProvider: "auto",
      searchApiKey: "",
      searchBaseUrl: "",
      notifyOnComplete: true,
      imageTimeoutSeconds: 600,
    });
  });

  it("接受用户选择显示麦克风", () => {
    expect(appSettingsSchema.parse({
      showChatMicrophone: true,
    })).toMatchObject({
      showChatMicrophone: true,
    });
  });

  it("忽略旧版录音操作方式设置", () => {
    expect(appSettingsSchema.parse({ recordingMode: "toggle" })).not.toHaveProperty("recordingMode");
  });

  it.each(SEARCH_PROVIDERS)("接受函数搜索源 %s", (searchProvider) => {
    expect(appSettingsSchema.parse({
      searchProvider,
      searchApiKey: "search-key",
      searchBaseUrl: "https://search.example.com",
    })).toMatchObject({
      searchProvider,
      searchApiKey: "search-key",
      searchBaseUrl: "https://search.example.com",
    });
  });

  it("拒绝未知搜索源", () => {
    expect(appSettingsSchema.safeParse({ searchProvider: "google" }).success).toBe(false);
  });
});
