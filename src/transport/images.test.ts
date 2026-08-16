import { describe, expect, it } from "vitest";

import { readImagesDeep } from "@/transport/images";

const BASE = "https://x.test/v1";

function urls(payload: unknown): string[] {
  return readImagesDeep(payload, BASE).map((image) => image.url);
}

describe("readImagesDeep", () => {
  it("标准 images 端点响应", () => {
    expect(urls({ data: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }] }))
      .toEqual(["https://cdn.test/a.png", "https://cdn.test/b.png"]);
  });

  it("b64_json 转成 data URL，并按魔数认出真实类型", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    expect(urls({ data: [{ b64_json: png }] })).toEqual([`data:image/png;base64,${png}`]);
  });

  it("对话端点把图片放在 message.images 里", () => {
    const payload = {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          images: [{ type: "image_url", image_url: { url: "https://cdn.test/c.png" } }],
        },
      }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/c.png"]);
  });

  it("对话端点只把图片拼在正文 markdown 里时也能取出来", () => {
    const payload = {
      choices: [{ message: { content: "画好了：\n\n![一只猫](https://cdn.test/d.png)\n\n还需要改吗？" } }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/d.png"]);
  });

  it("正文里的裸链接只认带图片扩展名的", () => {
    const payload = {
      choices: [{ message: { content: "看 https://cdn.test/e.webp ，文档在 https://docs.test/guide" } }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/e.webp"]);
  });

  it("正文里的 data URL 也认", () => {
    const payload = { choices: [{ message: { content: "![](data:image/gif;base64,R0lGODlhAQABAAAAdA==)" } }] };
    expect(urls(payload)).toEqual(["data:image/gif;base64,R0lGODlhAQABAAAAdA=="]);
  });

  it("同一张图在结构化字段和正文里各出现一次时只算一张", () => {
    const payload = {
      choices: [{
        message: {
          content: "![](https://cdn.test/f.png)",
          images: [{ image_url: { url: "https://cdn.test/f.png" } }],
        },
      }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/f.png"]);
  });

  it("相对路径按 baseURL 补全", () => {
    expect(urls({ data: [{ url: "/files/g.png" }] })).toEqual(["https://x.test/files/g.png"]);
  });

  it("错误信息里的链接不会被当成图片", () => {
    const payload = { error: { message: "见 https://docs.test/limits.png 说明" }, data: [] };
    expect(urls(payload)).toEqual([]);
  });

  it("没有任何图片时返回空数组", () => {
    expect(urls({ choices: [{ message: { content: "我没法生成图片。" } }] })).toEqual([]);
  });
});
