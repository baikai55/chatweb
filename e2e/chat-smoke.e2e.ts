import { expect, test, type ConsoleMessage } from "@playwright/test";

const APP_ORIGIN = "http://127.0.0.1:4173";
const MOCK_API_PREFIX = "/__mock__/";

test("添加后端、保存模型并完成一次流式聊天", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  const browserErrors: string[] = [];
  let chatRequest: Record<string, unknown> | null = null;
  let releaseChatResponse!: () => void;
  const chatResponseGate = new Promise<void>((resolve) => {
    releaseChatResponse = resolve;
  });

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error: Error) => browserErrors.push(error.message));

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.origin !== APP_ORIGIN) {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }

    if (url.pathname === "/__mock__/v1/models") {
      const isAnthropicCatalog = Boolean(request.headers()["anthropic-version"]);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: isAnthropicCatalog
            ? [{ id: "mock-chat", display_name: "Mock Chat", max_input_tokens: 32_000 }]
            : [{ id: "mock-chat", object: "model", owned_by: "chatweb-test" }],
        }),
      });
      return;
    }

    if (url.pathname === "/__mock__/v1beta") {
      await route.fulfill({ json: { models: [] } });
      return;
    }

    if (url.pathname === "/__mock__/v1/chat/completions") {
      chatRequest = request.postDataJSON() as Record<string, unknown>;
      await chatResponseGate;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
        body: [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}',
          'data: {"choices":[{"index":0,"delta":{"content":"，已收到。"},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      });
      return;
    }

    if (url.pathname.startsWith(MOCK_API_PREFIX) || url.pathname.startsWith("/__api/")) {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }

    const isStaticAsset = url.pathname === "/"
      || url.pathname === "/index.html"
      || url.pathname === "/manifest.webmanifest"
      || url.pathname === "/sw.js"
      || url.pathname.startsWith("/assets/")
      || url.pathname.startsWith("/icons/");
    if (isStaticAsset) {
      await route.continue();
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "先连一个后端" })).toBeVisible();

  await page.getByLabel("名称").fill("本地 Mock");
  await page.getByLabel("API 地址").fill(`${APP_ORIGIN}/__mock__/v1`);
  await page.getByLabel("API Key").fill("mock-api-key");
  await page.getByRole("button", { name: "添加后端" }).click();

  const sidebarTrigger = page.getByRole("button", { name: "打开侧栏" });
  if (await sidebarTrigger.isVisible()) await sidebarTrigger.click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "模型" }).click();
  await page.getByRole("button", { name: "获取模型" }).click();

  const modelRow = page.getByRole("button", { name: /Mock Chat/ });
  await expect(modelRow).toBeVisible();
  await modelRow.click();
  await page.getByRole("button", { name: "保存", exact: true }).click();

  if (await sidebarTrigger.isVisible()) await sidebarTrigger.click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByPlaceholder("说点什么…").fill("浏览器冒烟测试");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  const reasoningSelect = page.locator("main").getByRole("combobox");
  await reasoningSelect.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  releaseChatResponse();

  const messages = page.getByRole("region", { name: "Messages" });
  await expect(messages.getByText("浏览器冒烟测试", { exact: true })).toBeVisible();
  await expect(messages.getByText("你好，已收到。", { exact: true })).toBeVisible();
  await expect(reasoningSelect).toContainText("high");
  expect(chatRequest).toMatchObject({
    model: "mock-chat",
    stream: true,
    messages: [{ role: "user", content: "浏览器冒烟测试" }],
  });
  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
