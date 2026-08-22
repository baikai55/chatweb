import { describe, expect, it } from "vitest";

import { createBackend, type Backend, type CustomVideoRoute } from "@/backends/types";
import {
  BUILTIN_VIDEO_ROUTE_DEFS,
  draftCustomVideoRoute,
  resolveVideoRoute,
  resolveVideoStatusURL,
  videoRouteFor,
  videoRouteSupportsEditing,
  videoRouteSupportsSource,
  videoRouteVariables,
} from "@/transport/video-routes";

function backend(overrides: Partial<Backend> = {}): Backend {
  return { ...createBackend({ name: "t", baseURL: "https://x.test/v1" }), ...overrides };
}

const CONTEXT = {
  model: "grok-video",
  prompt: "海边日落",
  duration: 6,
  aspectRatio: "16:9",
  resolution: "720p",
};

describe("resolveVideoRoute", () => {
  it("内置视频端点发标准任务请求体", () => {
    const route = resolveVideoRoute("https://x.test/v1", BUILTIN_VIDEO_ROUTE_DEFS.videos, CONTEXT);
    expect(route.url).toBe("https://x.test/v1/videos/generations");
    expect(JSON.parse(route.body ?? "")).toEqual({
      model: "grok-video",
      prompt: "海边日落",
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "720p",
    });
  });

  it("没有源图片时整个 image 键消失，不留一个空壳", () => {
    const body = JSON.parse(resolveVideoRoute("https://x.test/v1", BUILTIN_VIDEO_ROUTE_DEFS.videos, CONTEXT).body ?? "");
    expect(body).not.toHaveProperty("image");
  });

  it("有源图片时按 image.url 发送", () => {
    const route = resolveVideoRoute("https://x.test/v1", BUILTIN_VIDEO_ROUTE_DEFS.videos, {
      ...CONTEXT,
      sourceUrl: "https://cdn.test/frame.png",
    });
    expect(JSON.parse(route.body ?? "")).toMatchObject({ image: { url: "https://cdn.test/frame.png" } });
  });

  it("内置对话路由发 messages，不带任务端点特有的参数", () => {
    const route = resolveVideoRoute("https://x.test/v1", BUILTIN_VIDEO_ROUTE_DEFS.chat, CONTEXT);
    expect(route.url).toBe("https://x.test/v1/chat/completions");
    expect(JSON.parse(route.body ?? "")).toEqual({
      model: "grok-video",
      messages: [{ role: "user", content: "海边日落" }],
      stream: false,
    });
  });

  it("对话路由带源图片时发送多模态 content", () => {
    const route = resolveVideoRoute("https://x.test/v1", BUILTIN_VIDEO_ROUTE_DEFS.chat, {
      ...CONTEXT,
      sourceUrl: "https://cdn.test/frame.png",
    });
    expect(JSON.parse(route.body ?? "")).toMatchObject({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "海边日落" },
          { type: "image_url", image_url: { url: "https://cdn.test/frame.png", detail: "auto" } },
        ],
      }],
    });
  });
});

describe("videoRouteFor", () => {
  it("按模型指定的路由优先于默认路由", () => {
    const configured = backend({
      defaultVideoRoute: "videos",
      videoRouteOverrides: { "some-chat-video": "chat" },
    });
    expect(videoRouteFor(configured, "some-chat-video").id).toBe("chat");
    expect(videoRouteFor(configured, "grok-video").id).toBe("videos");
  });

  it("指向的路由被删掉后回落到内置视频端点，而不是崩掉", () => {
    expect(videoRouteFor(backend({ videoRouteOverrides: { m: "route_gone" } }), "m").id).toBe("videos");
  });

  it("自定义路由排在内置之后，可以被选为默认", () => {
    const custom: CustomVideoRoute = { ...BUILTIN_VIDEO_ROUTE_DEFS.chat, id: "mine", name: "我的" };
    const configured = backend({ customVideoRoutes: [custom], defaultVideoRoute: "mine" });
    expect(videoRouteFor(configured, "任意模型").id).toBe("mine");
  });
});

describe("resolveVideoStatusURL", () => {
  it("替换 ${requestId} 并按 baseURL 拼绝对地址", () => {
    expect(resolveVideoStatusURL("https://x.test/v1", "/videos/${requestId}", "job-1"))
      .toBe("https://x.test/v1/videos/job-1");
  });

  it("任务 ID 会被编码，斜杠不会劈开路径", () => {
    expect(resolveVideoStatusURL("https://x.test/v1", "/videos/${requestId}", "a/b"))
      .toBe("https://x.test/v1/videos/a%2Fb");
  });

  it("statusPath 为空表示同步路由，返回空串", () => {
    expect(resolveVideoStatusURL("https://x.test/v1", "", "job-1")).toBe("");
  });
});

describe("videoRouteVariables", () => {
  it("视频端点用到全部参数", () => {
    expect([...videoRouteVariables(BUILTIN_VIDEO_ROUTE_DEFS.videos)].sort()).toEqual(
      ["aspectRatio", "duration", "model", "prompt", "resolution", "sourceUrl"],
    );
  });

  it("对话端点只用到模型和消息 —— 面板据此隐藏时长、比例、清晰度", () => {
    expect([...videoRouteVariables(BUILTIN_VIDEO_ROUTE_DEFS.chat)].sort()).toEqual(["messageContent", "model"]);
  });

  it("下划线写法归一到驼峰", () => {
    const custom: CustomVideoRoute = {
      ...BUILTIN_VIDEO_ROUTE_DEFS.chat,
      body: { ratio: "$aspect_ratio", src: "$source_url" },
    };
    expect([...videoRouteVariables(custom)].sort()).toEqual(["aspectRatio", "sourceUrl"]);
  });
});

describe("路由能力", () => {
  it("两条内置路由都能带源图片", () => {
    expect(videoRouteSupportsSource(BUILTIN_VIDEO_ROUTE_DEFS.videos)).toBe(true);
    expect(videoRouteSupportsSource(BUILTIN_VIDEO_ROUTE_DEFS.chat)).toBe(true);
  });

  it("模板里没引用源地址的路由不显示附件按钮", () => {
    expect(videoRouteSupportsSource({
      ...BUILTIN_VIDEO_ROUTE_DEFS.videos,
      id: "text-only",
      body: { model: "$model", prompt: "$prompt" },
    })).toBe(false);
  });

  it("编辑和延长只有内置视频端点支持", () => {
    expect(videoRouteSupportsEditing(BUILTIN_VIDEO_ROUTE_DEFS.videos)).toBe(true);
    expect(videoRouteSupportsEditing(BUILTIN_VIDEO_ROUTE_DEFS.chat)).toBe(false);
    expect(videoRouteSupportsEditing({ ...BUILTIN_VIDEO_ROUTE_DEFS.videos, id: "copy" })).toBe(false);
  });
});

describe("draftCustomVideoRoute", () => {
  it("复制出来的路由是深拷贝，改它不影响内置定义", () => {
    const copy = draftCustomVideoRoute(BUILTIN_VIDEO_ROUTE_DEFS.chat, "mine");
    expect(copy.id).toBe("mine");
    expect(copy.name).toBe("对话端点 /chat/completions 副本");
    (copy.body as { model: string }).model = "改了";
    expect(BUILTIN_VIDEO_ROUTE_DEFS.chat.body.model).toBe("$model");
  });
});
