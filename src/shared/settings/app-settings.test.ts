import { describe, expect, it } from "vitest";

import { SEARCH_PROVIDERS, appSettingsSchema } from "@/shared/settings/app-settings";

describe("appSettingsSchema", () => {
  it("新安装默认隐藏聊天麦克风并使用按住说话", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      showChatMicrophone: false,
      recordingMode: "hold",
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
      recordingMode: "hold",
      searchProvider: "auto",
      searchApiKey: "",
      searchBaseUrl: "",
      notifyOnComplete: true,
      imageTimeoutSeconds: 600,
    });
  });

  it("接受用户选择显示麦克风和点击录音模式", () => {
    expect(appSettingsSchema.parse({
      showChatMicrophone: true,
      recordingMode: "toggle",
    })).toMatchObject({
      showChatMicrophone: true,
      recordingMode: "toggle",
    });
  });

  it("拒绝未知录音模式", () => {
    expect(appSettingsSchema.safeParse({ recordingMode: "automatic" }).success).toBe(false);
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
