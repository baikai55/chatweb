import { describe, expect, it } from "vitest";

import { createBackend } from "@/backends/types";
import { resolveSTTConnection } from "@/transport/stt-provider";

describe("resolveSTTConnection", () => {
  it("默认沿用当前后端的 /stt 和聊天转写模型", () => {
    const connection = resolveSTTConnection(createBackend({
      name: "CPA",
      baseURL: "https://cpa.example/v1",
      apiKey: " cpa-key ",
      chatInputSTTModel: " whisper-large-v3 ",
    }));

    expect(connection).toEqual({
      protocol: "grok-stt",
      baseURL: "https://cpa.example/v1",
      apiKey: "cpa-key",
      model: "whisper-large-v3",
      source: "backend",
      ready: true,
    });
  });

  it("独立供应商规范化地址并走 OpenAI Audio Transcriptions", () => {
    const connection = resolveSTTConnection(createBackend({
      name: "CPA + 独立 ASR",
      baseURL: "https://cpa.example/v1",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "asr.example.com/",
        apiKey: " sk-asr ",
        model: " custom-asr ",
      },
    }));

    expect(connection).toEqual({
      protocol: "openai-transcriptions",
      baseURL: "https://asr.example.com/v1",
      apiKey: "sk-asr",
      model: "custom-asr",
      source: "independent",
      ready: true,
    });
  });

  it("独立配置缺地址或模型时未就绪，但允许免鉴权服务", () => {
    const noModel = resolveSTTConnection(createBackend({
      name: "缺模型",
      baseURL: "https://cpa.example/v1",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "asr.example/v1",
        apiKey: "",
        model: "",
      },
    }));
    const noURL = resolveSTTConnection(createBackend({
      name: "缺地址",
      baseURL: "https://cpa.example/v1",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "",
        apiKey: "sk-asr",
        model: "custom-asr",
      },
    }));

    expect(noModel.ready).toBe(false);
    expect(noURL.ready).toBe(false);
  });
});
