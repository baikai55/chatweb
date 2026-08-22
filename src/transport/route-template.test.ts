import { describe, expect, it } from "vitest";

import { resolveRouteRequest, resolveTemplate, scanTemplateVariables, selectByPath } from "@/transport/route-template";

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

  it("键全被剪掉的对象自己也被剪掉，不留一个空壳", () => {
    expect(resolveTemplate({ image: { url: "$size" }, prompt: "$prompt" }, values))
      .toEqual({ prompt: "猫" });
  });

  it("模板里写死的空对象是用户明确要发的，保留", () => {
    expect(resolveTemplate({ options: {}, prompt: "$prompt" }, values))
      .toEqual({ options: {}, prompt: "猫" });
  });
});

describe("resolveRouteRequest", () => {
  const definition = {
    path: "/gen",
    method: "POST" as const,
    query: { model: "$model", ratio: "$aspectRatio" },
    body: { model: "$model", prompt: "$prompt" },
  };

  it("query 走模板并跳过空值", () => {
    const request = resolveRouteRequest("https://x.test/v1", definition, { model: "m", prompt: "p" });
    expect(request.url).toBe("https://x.test/v1/gen?model=m");
    expect(JSON.parse(request.body ?? "")).toEqual({ model: "m", prompt: "p" });
  });

  it("path 写完整 URL 时忽略 baseURL", () => {
    const request = resolveRouteRequest(
      "https://x.test/v1",
      { ...definition, path: "https://other.test/draw", query: {} },
      { model: "m", prompt: "p" },
    );
    expect(request.url).toBe("https://other.test/draw");
  });

  it("GET 路由不带请求体", () => {
    const request = resolveRouteRequest(
      "https://x.test/v1",
      { ...definition, method: "GET", query: {} },
      { model: "m", prompt: "p" },
    );
    expect(request.body).toBeNull();
  });
});

describe("scanTemplateVariables", () => {
  it("整串引用和串内插值都算，且按调用方给的别名归一", () => {
    const found = scanTemplateVariables(
      [{ ratio: "$aspect_ratio", note: "尺寸${size}" }, { m: "$model" }],
      (name) => (name === "aspect_ratio" ? "aspectRatio" : name),
    );
    expect([...found].sort()).toEqual(["aspectRatio", "model", "size"]);
  });

  it("点号路径只记根变量", () => {
    const found = scanTemplateVariables([{ a: "$params.size" }], (name) => name);
    expect([...found]).toEqual(["params"]);
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
