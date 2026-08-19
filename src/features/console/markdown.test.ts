// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { renderAssistantMarkup, sanitizeAssistantHTML } from "@/features/console/markdown";

function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, "text/html").body;
}

describe("assistant Markdown XSS 清洗", () => {
  it("保留 Markdown 结构并移除危险标签及其内容", () => {
    const html = renderAssistantMarkup([
      "## 标题",
      "",
      "正常 **内容**",
      "",
      "<script>window.stolen = localStorage.getItem('chatweb:backends')</script>",
      "<form><input name=key value=secret><button>提交</button></form>",
      "<svg><a href=javascript:alert(1)>危险</a></svg>",
    ].join("\n"));
    const body = parseBody(html);

    expect(body.querySelector("h2")?.textContent).toBe("标题");
    expect(body.querySelector("strong")?.textContent).toBe("内容");
    expect(body.querySelector("script, form, input, button, svg")).toBeNull();
    expect(body.textContent).not.toContain("window.stolen");
    expect(body.textContent).not.toContain("提交");
    expect(body.textContent).not.toContain("危险");
  });

  it("先清空全部属性，再只恢复允许的链接属性", () => {
    const html = sanitizeAssistantHTML([
      '<a id="secret" class="tracked" style="color:red" onclick="alert(1)"',
      ' href="https://example.com/path?q=1" title="文档">安全链接</a>',
      '<a href="jav&#x61;script:alert(1)" onfocus="alert(2)">危险链接</a>',
    ].join(""));
    const links = parseBody(html).querySelectorAll("a");

    expect(links).toHaveLength(2);
    expect(links[0].getAttributeNames().sort()).toEqual(["href", "rel", "target", "title"]);
    expect(links[0].getAttribute("href")).toBe("https://example.com/path?q=1");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("nofollow noopener noreferrer");
    expect(links[1].getAttributeNames()).toEqual([]);
  });

  it("只允许 HTTPS 和本 Worker 的媒体图片", () => {
    const html = sanitizeAssistantHTML([
      '<img src="https://images.example/a.png" alt="远程图" onerror="alert(1)">',
      '<img src="/__api/media/uploads/20260819/abc.png" alt="上传图">',
      '<img src="http://images.example/insecure.png" alt="不安全">',
      '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="内联图">',
    ].join(""));
    const images = parseBody(html).querySelectorAll("img");

    expect(images).toHaveLength(2);
    expect(Array.from(images, (image) => image.getAttribute("src"))).toEqual([
      "https://images.example/a.png",
      "/__api/media/uploads/20260819/abc.png",
    ]);
    for (const image of images) {
      expect(image.hasAttribute("onerror")).toBe(false);
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
  });

  it("未知标签只脱壳，表格跨度限制在安全范围", () => {
    const html = sanitizeAssistantHTML([
      "<custom-wrapper><p>保留文字</p></custom-wrapper>",
      '<table><tr><td colspan="2" rowspan="101" onclick="alert(1)">单元格</td></tr></table>',
    ].join(""));
    const body = parseBody(html);
    const cell = body.querySelector("td");

    expect(body.querySelector("custom-wrapper")).toBeNull();
    expect(body.querySelector("p")?.textContent).toBe("保留文字");
    expect(cell?.getAttribute("colspan")).toBe("2");
    expect(cell?.hasAttribute("rowspan")).toBe(false);
    expect(cell?.hasAttribute("onclick")).toBe(false);
  });
});
