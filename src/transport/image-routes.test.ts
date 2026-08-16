import { describe, expect, it } from "vitest";

import { createBackend, type Backend, type CustomImageRoute } from "@/backends/types";
import {
  BUILTIN_ROUTE_DEFS,
  imageRouteFor,
  resolveImageRoute,
  resolveTemplate,
  routeVariables,
  selectByPath,
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

describe("resolveTemplate", () => {
  const values = { prompt: "猫", n: 2, size: undefined, nested: { a: "深" } };

  it("整串引用保留原类型", () => {
    expect(resolveTemplate("$n", values)).toBe(2);
  });

  it("取不到值时返回 undefined，好让调用方剪掉这个键", () => {
    expect(resolveTemplate("$size", values)).toBeUndefined();
    expect(resolveTemplate({ a: "$size", b: "$prompt" }, values)).toEqual({ b: "猫" });
  });

  it("串内插值按字符串拼，缺的补空", () => {
    expect(resolveTemplate("画一只${prompt}，尺寸${size}", values)).toBe("画一只猫，尺寸");
  });

  it("支持点号路径", () => {
    expect(resolveTemplate("$nested.a", values)).toBe("深");
  });

  it("不是引用的字符串原样保留", () => {
    expect(resolveTemplate("user", values)).toBe("user");
    expect(resolveTemplate("$100", values)).toBe("$100");
  });

  it("数组里被剪掉的项不留空洞", () => {
    expect(resolveTemplate(["$prompt", "$size", "$n"], values)).toEqual(["猫", 2]);
  });
});

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

  it("size 有值时不发 aspect_ratio —— 两个一起发多数后端会报冲突", () => {
    const route = resolveImageRoute(backend(), { ...CONTEXT, aspectRatio: "16:9" });
    expect(JSON.parse(route.body ?? "")).not.toHaveProperty("aspect_ratio");
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

  it("对话端点只用到模型和提示词 —— 面板据此隐藏其余控件", () => {
    expect([...routeVariables(BUILTIN_ROUTE_DEFS.chat)].sort()).toEqual(["model", "prompt"]);
  });

  it("下划线写法归一到驼峰", () => {
    const custom: CustomImageRoute = {
      ...BUILTIN_ROUTE_DEFS.chat,
      body: { ratio: "$aspect_ratio", fmt: "${response_format}" },
    };
    expect([...routeVariables(custom)].sort()).toEqual(["aspectRatio", "responseFormat"]);
  });
});

describe("selectByPath", () => {
  const payload = {
    choices: [
      { message: { images: [{ image_url: { url: "a.png" } }, { image_url: { url: "b.png" } }] } },
      { message: { images: [{ image_url: { url: "c.png" } }] } },
    ],
    data: [{ b64_json: "AAA" }],
  };

  it("`*` 展开数组", () => {
    expect(selectByPath(payload, "choices.*.message.images.*.image_url.url"))
      .toEqual(["a.png", "b.png", "c.png"]);
  });

  it("数字下标取单项", () => {
    expect(selectByPath(payload, "choices.1.message.images.0.image_url.url")).toEqual(["c.png"]);
  });

  it("路径不存在时返回空数组而不是抛错", () => {
    expect(selectByPath(payload, "choices.*.nope.url")).toEqual([]);
    expect(selectByPath(payload, "data.9.b64_json")).toEqual([]);
  });
});
