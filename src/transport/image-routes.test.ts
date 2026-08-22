import { describe, expect, it } from "vitest";

import { createBackend, type Backend, type CustomImageRoute } from "@/backends/types";
import {
  BUILTIN_ROUTE_DEFS,
  imageRouteFor,
  imageRouteSupportsInputImages,
  resolveImageRoute,
  routeVariables,
} from "@/transport/image-routes";

function backend(overrides: Partial<Backend> = {}): Backend {
  return { ...createBackend({ name: "t", baseURL: "https://x.test/v1" }), ...overrides };
}

const CONTEXT = {
  model: "gpt-image-2",
  prompt: "一只猫",
  n: 2,
  size: "1024x1024",
  quality: "high",
  responseFormat: "url" as const,
};

describe("resolveImageRoute", () => {
  it("内置图片路由发标准 OpenAI 请求体", () => {
    const route = resolveImageRoute(backend(), CONTEXT);
    expect(route.url).toBe("https://x.test/v1/images/generations");
    expect(JSON.parse(route.body ?? "")).toEqual({
      model: "gpt-image-2",
      prompt: "一只猫",
      n: 2,
      size: "1024x1024",
      quality: "high",
      response_format: "url",
    });
  });

  it("size 包括 auto 都原样发送，且不与 aspect_ratio 同时出现", () => {
    const route = resolveImageRoute(backend(), { ...CONTEXT, size: "auto", aspectRatio: "16:9" });
    const body = JSON.parse(route.body ?? "");
    expect(body.size).toBe("auto");
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("没给 size 时才发 aspect_ratio", () => {
    const route = resolveImageRoute(backend(), { ...CONTEXT, size: undefined, aspectRatio: "16:9" });
    const body = JSON.parse(route.body ?? "");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body).not.toHaveProperty("size");
  });

  it("内置对话路由发 messages，不带图片端点特有的参数", () => {
    const route = resolveImageRoute(backend({ defaultImageRoute: "chat" }), { ...CONTEXT, model: "nano-banana" });
    expect(route.url).toBe("https://x.test/v1/chat/completions");
    expect(JSON.parse(route.body ?? "")).toEqual({
      model: "nano-banana",
      messages: [{ role: "user", content: "一只猫" }],
      stream: false,
    });
  });

  it("内置对话路由带参考图时发送多模态 content", () => {
    const route = resolveImageRoute(backend({ defaultImageRoute: "chat" }), {
      ...CONTEXT,
      model: "nano-banana",
      inputImages: ["data:image/png;base64,aGVsbG8=", "https://cdn.test/reference.jpg"],
    });
    expect(JSON.parse(route.body ?? "")).toEqual({
      model: "nano-banana",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "一只猫" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" } },
          { type: "image_url", image_url: { url: "https://cdn.test/reference.jpg", detail: "auto" } },
        ],
      }],
      stream: false,
    });
  });

  it("按模型指定的路由优先于默认路由", () => {
    const configured = backend({
      defaultImageRoute: "images",
      imageRouteOverrides: { "nano-banana": "chat" },
    });
    expect(imageRouteFor(configured, "nano-banana").id).toBe("chat");
    expect(imageRouteFor(configured, "gpt-image-2").id).toBe("images");
  });

  it("指向的路由被删掉后回落到内置图片端点，而不是崩掉", () => {
    const configured = backend({ imageRouteOverrides: { m: "route_gone" } });
    expect(imageRouteFor(configured, "m").id).toBe("images");
  });

  it("query 走模板并跳过空值", () => {
    const custom: CustomImageRoute = {
      ...BUILTIN_ROUTE_DEFS.images,
      id: "q",
      name: "q",
      path: "/gen",
      query: { model: "$model", ratio: "$aspectRatio" },
    };
    const route = resolveImageRoute(
      backend({ customImageRoutes: [custom], defaultImageRoute: "q" }),
      CONTEXT,
    );
    expect(route.url).toBe("https://x.test/v1/gen?model=gpt-image-2");
  });

  it("path 写完整 URL 时忽略 baseURL", () => {
    const custom: CustomImageRoute = {
      ...BUILTIN_ROUTE_DEFS.chat,
      id: "abs",
      name: "abs",
      path: "https://other.test/draw",
    };
    const route = resolveImageRoute(
      backend({ customImageRoutes: [custom], defaultImageRoute: "abs" }),
      CONTEXT,
    );
    expect(route.url).toBe("https://other.test/draw");
  });

  it("GET 路由不带请求体", () => {
    const custom: CustomImageRoute = {
      ...BUILTIN_ROUTE_DEFS.images,
      id: "g",
      name: "g",
      path: "/draw",
      method: "GET",
    };
    const route = resolveImageRoute(
      backend({ customImageRoutes: [custom], defaultImageRoute: "g" }),
      CONTEXT,
    );
    expect(route.body).toBeNull();
  });
});

describe("routeVariables", () => {
  it("图片端点用到全部参数", () => {
    expect([...routeVariables(BUILTIN_ROUTE_DEFS.images)].sort()).toEqual(
      ["aspectRatio", "model", "n", "prompt", "quality", "responseFormat", "size"],
    );
  });

  it("对话端点只用到模型和多模态消息 —— 面板据此隐藏其余控件", () => {
    expect([...routeVariables(BUILTIN_ROUTE_DEFS.chat)].sort()).toEqual(["messageContent", "model"]);
  });

  it("下划线写法归一到驼峰", () => {
    const custom: CustomImageRoute = {
      ...BUILTIN_ROUTE_DEFS.chat,
      body: { ratio: "$aspect_ratio", fmt: "${response_format}", images: "$input_images" },
    };
    expect([...routeVariables(custom)].sort()).toEqual(["aspectRatio", "inputImages", "responseFormat"]);
  });

  it("识别内置和自定义参考图路由", () => {
    expect(imageRouteSupportsInputImages(BUILTIN_ROUTE_DEFS.images)).toBe(true);
    expect(imageRouteSupportsInputImages(BUILTIN_ROUTE_DEFS.chat)).toBe(true);
    expect(imageRouteSupportsInputImages({
      ...BUILTIN_ROUTE_DEFS.images,
      id: "plain-json",
    })).toBe(false);
    expect(imageRouteSupportsInputImages({
      ...BUILTIN_ROUTE_DEFS.chat,
      id: "custom-vision",
      body: { images: "$inputImages" },
    })).toBe(true);
  });
});
