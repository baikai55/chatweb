import { describe, expect, it } from "vitest";

import {
  INITIAL_IMAGE_TRANSFORM,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  clampImageScale,
  constrainImageTransform,
  panImage,
  resetImageTransform,
  zoomImageAtPoint,
  zoomImageBetweenPoints,
  type ImageViewerLayout,
} from "@/features/image/image-viewer-transform";

const SQUARE_LAYOUT: ImageViewerLayout = {
  viewport: { width: 500, height: 500 },
  image: { width: 500, height: 500 },
};

describe("image viewer transform", () => {
  it("把缩放限制在 1x 到 5x", () => {
    expect(clampImageScale(0.25)).toBe(MIN_IMAGE_SCALE);
    expect(clampImageScale(2.5)).toBe(2.5);
    expect(clampImageScale(8)).toBe(MAX_IMAGE_SCALE);
    expect(clampImageScale(Number.NaN)).toBe(MIN_IMAGE_SCALE);
  });

  it("复位到居中 1x，并且每次返回独立对象", () => {
    const first = resetImageTransform();
    const second = resetImageTransform();

    expect(first).toEqual(INITIAL_IMAGE_TRANSFORM);
    expect(second).toEqual(INITIAL_IMAGE_TRANSFORM);
    expect(first).not.toBe(second);
  });

  it("围绕鼠标位置缩放时保持该位置下的内容焦点", () => {
    const point = { x: 350, y: 150 };
    const next = zoomImageAtPoint(resetImageTransform(), 2, point, SQUARE_LAYOUT);

    expect(next).toEqual({ scale: 2, offsetX: -100, offsetY: 100 });
    expect(contentPointAt(next, point, SQUARE_LAYOUT)).toEqual(
      contentPointAt(resetImageTransform(), point, SQUARE_LAYOUT),
    );
  });

  it("缩放请求越界时仍以钳制后的倍率保持内容焦点", () => {
    const point = { x: 300, y: 250 };
    const next = zoomImageAtPoint(resetImageTransform(), 20, point, SQUARE_LAYOUT);

    expect(next.scale).toBe(MAX_IMAGE_SCALE);
    expect(contentPointAt(next, point, SQUARE_LAYOUT)).toEqual(
      contentPointAt(resetImageTransform(), point, SQUARE_LAYOUT),
    );
  });

  it("双指中心移动时同时完成聚焦缩放和平移", () => {
    const previousCenter = { x: 300, y: 250 };
    const nextCenter = { x: 340, y: 280 };
    const next = zoomImageBetweenPoints(
      resetImageTransform(),
      2,
      previousCenter,
      nextCenter,
      SQUARE_LAYOUT,
    );

    expect(next).toEqual({ scale: 2, offsetX: -10, offsetY: 30 });
    expect(contentPointAt(next, nextCenter, SQUARE_LAYOUT)).toEqual(
      contentPointAt(resetImageTransform(), previousCenter, SQUARE_LAYOUT),
    );
  });

  it("约束平移边界，防止放大后的图片被拖出查看区域", () => {
    const next = panImage(
      { scale: 2, offsetX: 0, offsetY: 0 },
      { x: 1_000, y: -1_000 },
      SQUARE_LAYOUT,
    );

    expect(next).toEqual({ scale: 2, offsetX: 250, offsetY: -250 });
  });

  it("图片缩放后仍小于视口的轴保持居中", () => {
    const portraitLayout: ImageViewerLayout = {
      viewport: { width: 800, height: 600 },
      image: { width: 300, height: 600 },
    };

    expect(constrainImageTransform(
      { scale: 2, offsetX: 500, offsetY: 500 },
      portraitLayout,
    )).toEqual({ scale: 2, offsetX: 0, offsetY: 300 });
  });

  it("钳制旧状态后再缩放，异常数值不会传播", () => {
    expect(zoomImageAtPoint(
      { scale: Number.NaN, offsetX: Number.POSITIVE_INFINITY, offsetY: 5 },
      2,
      { x: Number.NaN, y: 250 },
      SQUARE_LAYOUT,
    )).toEqual({ scale: 2, offsetX: 250, offsetY: 0 });
  });
});

function contentPointAt(
  transform: { scale: number; offsetX: number; offsetY: number },
  viewportPoint: { x: number; y: number },
  layout: ImageViewerLayout,
) {
  return {
    x: (viewportPoint.x - layout.viewport.width / 2 - transform.offsetX) / transform.scale,
    y: (viewportPoint.y - layout.viewport.height / 2 - transform.offsetY) / transform.scale,
  };
}
