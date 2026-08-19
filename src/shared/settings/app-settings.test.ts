/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from "vitest";

import {
  SEARCH_PROVIDERS,
  appSettingsSchema,
  loadAppSettings,
  patchAppSettings,
  subscribeAppSettings,
} from "@/shared/settings/app-settings";

describe("appSettingsSchema", () => {
  it("新安装默认隐藏聊天麦克风", () => {
    expect(appSettingsSchema.parse({})).toMatchObject({
      showChatMicrophone: false,
      chatReplySpeechEnabled: false,
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
      chatReplySpeechEnabled: false,
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

  it("接受用户持久开启回复朗读", () => {
    expect(appSettingsSchema.parse({
      chatReplySpeechEnabled: true,
    })).toMatchObject({
      chatReplySpeechEnabled: true,
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

describe("app settings 跨标签页同步", () => {
  it("只注册一个 storage 监听器", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const unsubscribeFirst = subscribeAppSettings(vi.fn());
    const unsubscribeSecond = subscribeAppSettings(vi.fn());

    loadAppSettings();
    loadAppSettings();

    expect(addEventListener.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
    unsubscribeFirst();
    unsubscribeSecond();
    addEventListener.mockRestore();
  });

  it("接收其它标签页的设置并刷新模块缓存", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppSettings(listener);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:settings",
      newValue: JSON.stringify({ submitMode: "ctrl-enter", showChatMicrophone: true }),
    }));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      submitMode: "ctrl-enter",
      showChatMicrophone: true,
      imageTimeoutSeconds: 300,
    }));
    expect(loadAppSettings()).toMatchObject({
      submitMode: "ctrl-enter",
      showChatMicrophone: true,
    });
    unsubscribe();
  });

  it("其它标签页删除设置或写入坏 JSON 时回到默认值并通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppSettings(listener);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:settings",
      newValue: null,
    }));
    expect(loadAppSettings()).toEqual(appSettingsSchema.parse({}));

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:settings",
      newValue: "{broken",
    }));
    expect(loadAppSettings()).toEqual(appSettingsSchema.parse({}));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("忽略无关的 storage 键", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppSettings(listener);
    const before = loadAppSettings();

    window.dispatchEvent(new StorageEvent("storage", {
      key: "unrelated",
      newValue: JSON.stringify({ submitMode: "enter" }),
    }));

    expect(listener).not.toHaveBeenCalled();
    expect(loadAppSettings()).toBe(before);
    unsubscribe();
  });

  it("localStorage 写失败时不更新缓存，也不通知保存成功", () => {
    const before = loadAppSettings();
    const listener = vi.fn();
    const unsubscribe = subscribeAppSettings(listener);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => patchAppSettings({ submitMode: before.submitMode === "enter" ? "ctrl-enter" : "enter" }))
      .toThrow("浏览器未能保存设置");
    expect(loadAppSettings()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    setItem.mockRestore();
    unsubscribe();
  });
});
