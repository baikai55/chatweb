/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageViewer } from "@/features/image/image-viewer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
}));

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("ImageViewer 多图导航", () => {
  it("未缩放时支持按钮和左右方向键切换图片", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <ImageViewer
          image={{ url: "https://example.test/second.png" }}
          index={1}
          total={3}
          onPrevious={onPrevious}
          onNext={onNext}
          onClose={vi.fn()}
        />,
      );
    });

    const previousButton = document.querySelector<HTMLButtonElement>('button[aria-label="上一张"]');
    const nextButton = document.querySelector<HTMLButtonElement>('button[aria-label="下一张"]');
    expect(previousButton?.disabled).toBe(false);
    expect(nextButton?.disabled).toBe(false);

    await act(async () => {
      nextButton?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });

    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("首尾禁用越界按钮，缩放后方向键只平移图片", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <ImageViewer
          image={{ url: "https://example.test/first.png" }}
          index={0}
          total={2}
          onPrevious={onPrevious}
          onNext={onNext}
          onClose={vi.fn()}
        />,
      );
    });

    expect(document.querySelector<HTMLButtonElement>('button[aria-label="上一张"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="下一张"]')?.disabled).toBe(false);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="放大"]')?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });

    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });
});
