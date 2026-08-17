export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 5;

export type Point = {
  x: number;
  y: number;
};

export type Size = {
  width: number;
  height: number;
};

export type ImageViewerLayout = {
  /** The viewport size and the image's rendered size at 1x, both in CSS pixels. */
  viewport: Size;
  image: Size;
};

export type ImageTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export const INITIAL_IMAGE_TRANSFORM: Readonly<ImageTransform> = Object.freeze({
  scale: MIN_IMAGE_SCALE,
  offsetX: 0,
  offsetY: 0,
});

export function resetImageTransform(): ImageTransform {
  return { ...INITIAL_IMAGE_TRANSFORM };
}

export function clampImageScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_IMAGE_SCALE;
  return clamp(scale, MIN_IMAGE_SCALE, MAX_IMAGE_SCALE);
}

export function constrainImageTransform(
  transform: ImageTransform,
  layout: ImageViewerLayout,
): ImageTransform {
  const scale = clampImageScale(transform.scale);
  const maxOffsetX = panLimit(layout.image.width, layout.viewport.width, scale);
  const maxOffsetY = panLimit(layout.image.height, layout.viewport.height, scale);

  return {
    scale,
    offsetX: clampFinite(transform.offsetX, -maxOffsetX, maxOffsetX),
    offsetY: clampFinite(transform.offsetY, -maxOffsetY, maxOffsetY),
  };
}

export function panImage(
  transform: ImageTransform,
  delta: Point,
  layout: ImageViewerLayout,
): ImageTransform {
  return constrainImageTransform({
    ...transform,
    offsetX: transform.offsetX + finiteOrZero(delta.x),
    offsetY: transform.offsetY + finiteOrZero(delta.y),
  }, layout);
}

/**
 * Zoom around a viewport point. The content underneath the point remains there
 * unless the pan boundary has to take precedence.
 */
export function zoomImageAtPoint(
  transform: ImageTransform,
  targetScale: number,
  viewportPoint: Point,
  layout: ImageViewerLayout,
): ImageTransform {
  return zoomImageBetweenPoints(
    transform,
    targetScale,
    viewportPoint,
    viewportPoint,
    layout,
  );
}

/**
 * Pinch equivalent of zoomImageAtPoint. Supplying consecutive gesture centers
 * also applies the two-finger pan that happened while the scale changed.
 */
export function zoomImageBetweenPoints(
  transform: ImageTransform,
  targetScale: number,
  previousViewportPoint: Point,
  nextViewportPoint: Point,
  layout: ImageViewerLayout,
): ImageTransform {
  const current = constrainImageTransform(transform, layout);
  const scale = clampImageScale(targetScale);
  const ratio = scale / current.scale;
  const viewportCenter = {
    x: finiteDimension(layout.viewport.width) / 2,
    y: finiteDimension(layout.viewport.height) / 2,
  };
  const previousPoint = relativeToCenter(previousViewportPoint, viewportCenter);
  const nextPoint = relativeToCenter(nextViewportPoint, viewportCenter);

  return constrainImageTransform({
    scale,
    offsetX: nextPoint.x - (previousPoint.x - current.offsetX) * ratio,
    offsetY: nextPoint.y - (previousPoint.y - current.offsetY) * ratio,
  }, layout);
}

function panLimit(imageLength: number, viewportLength: number, scale: number): number {
  const scaledImageLength = finiteDimension(imageLength) * scale;
  return Math.max(0, (scaledImageLength - finiteDimension(viewportLength)) / 2);
}

function relativeToCenter(point: Point, center: Point): Point {
  return {
    x: finiteOrZero(point.x) - center.x,
    y: finiteOrZero(point.y) - center.y,
  };
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampFinite(value: number, min: number, max: number): number {
  return clamp(finiteOrZero(value), min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
