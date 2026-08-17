import { Minus, Plus, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  constrainImageTransform,
  panImage,
  resetImageTransform,
  zoomImageAtPoint,
  zoomImageBetweenPoints,
  type ImageTransform,
  type ImageViewerLayout,
  type Point,
} from "@/features/image/image-viewer-transform";
import type { ImageResult } from "@/transport/types";

const ZOOM_STEP = 0.5;
const DRAG_THRESHOLD_PX = 3;
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type PinchGesture = {
  distance: number;
  center: Point;
};

export function ImageViewer({
  image,
  index,
  total,
  onClose,
  returnFocus,
}: {
  image: ImageResult;
  index: number;
  total: number;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const [transform, setTransform] = useState<ImageTransform>(() => resetImageTransform());
  const transformRef = useRef(transform);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const lastPanPointRef = useRef<Point | null>(null);
  const pinchRef = useRef<PinchGesture | null>(null);
  const movedRef = useRef(false);
  const dragDistanceRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  transformRef.current = transform;

  const getLayout = useCallback((): ImageViewerLayout => {
    const stage = stageRef.current;
    const target = imageRef.current;
    return {
      viewport: {
        width: stage?.clientWidth ?? 0,
        height: stage?.clientHeight ?? 0,
      },
      image: {
        width: target?.offsetWidth ?? 0,
        height: target?.offsetHeight ?? 0,
      },
    };
  }, []);

  const applyTransform = useCallback((next: ImageTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const reset = useCallback(() => {
    applyTransform(resetImageTransform());
  }, [applyTransform]);

  const zoomAt = useCallback((targetScale: number, point: Point) => {
    applyTransform(zoomImageAtPoint(
      transformRef.current,
      targetScale,
      point,
      getLayout(),
    ));
  }, [applyTransform, getLayout]);

  const zoomBy = useCallback((delta: number) => {
    const layout = getLayout();
    zoomAt(transformRef.current.scale + delta, {
      x: layout.viewport.width / 2,
      y: layout.viewport.height / 2,
    });
  }, [getLayout, zoomAt]);

  useEffect(() => {
    reset();
    pointersRef.current.clear();
    lastPanPointRef.current = null;
    pinchRef.current = null;
  }, [image.url, reset]);

  useEffect(() => {
    const previousFocus = returnFocus ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    const backgroundElements = dialog
      ? Array.from(document.body.children).filter((element): element is HTMLElement => (
        element instanceof HTMLElement && element !== dialog
      ))
      : [];
    const backgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));

    for (const element of backgroundElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));

    function keepFocusInside(event: FocusEvent) {
      const target = event.target;
      if (target instanceof Node && dialogRef.current?.contains(target)) return;
      dialogRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("focusin", keepFocusInside);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", keepFocusInside);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of backgroundState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      previousFocus?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomBy(-ZOOM_STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        reset();
        return;
      }
      if (event.key.startsWith("Arrow") && transformRef.current.scale > MIN_IMAGE_SCALE) {
        event.preventDefault();
        const delta = event.shiftKey ? 80 : 32;
        const movement = event.key === "ArrowLeft"
          ? { x: -delta, y: 0 }
          : event.key === "ArrowRight"
            ? { x: delta, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -delta }
              : { x: 0, y: delta };
        applyTransform(panImage(transformRef.current, movement, getLayout()));
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyTransform, getLayout, reset, zoomBy]);

  useEffect(() => {
    const stage = stageRef.current;
    const target = imageRef.current;
    if (!stage || !target || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        applyTransform(constrainImageTransform(transformRef.current, getLayout()));
      });
    });
    observer.observe(stage);
    observer.observe(target);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [applyTransform, getLayout]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const layout = getLayout();
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * layout.viewport.height
          : event.deltaY;
      const targetScale = transformRef.current.scale * Math.exp(-delta * 0.0015);
      zoomAt(targetScale, localPoint(event.clientX, event.clientY));
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [getLayout, zoomAt]);

  function localPoint(clientX: number, clientY: number): Point {
    const bounds = stageRef.current?.getBoundingClientRect();
    return {
      x: clientX - (bounds?.left ?? 0),
      y: clientY - (bounds?.top ?? 0),
    };
  }

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 老浏览器不支持 pointer capture 时，后续 pointercancel 仍会清理状态。
    }
    const startsGesture = pointersRef.current.size === 0;
    const point = localPoint(event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, point);
    if (startsGesture) {
      movedRef.current = false;
      dragDistanceRef.current = 0;
    }

    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      pinchRef.current = pinchGesture(points[0], points[1]);
      lastPanPointRef.current = null;
    } else {
      lastPanPointRef.current = point;
      pinchRef.current = null;
    }
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    const point = localPoint(event.clientX, event.clientY);
    const previous = pointersRef.current.get(event.pointerId);
    pointersRef.current.set(event.pointerId, point);

    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      const previousPinch = pinchRef.current ?? pinchGesture(points[0], points[1]);
      const nextPinch = pinchGesture(points[0], points[1]);
      if (previousPinch.distance > 0) {
        const targetScale = transformRef.current.scale * (nextPinch.distance / previousPinch.distance);
        applyTransform(zoomImageBetweenPoints(
          transformRef.current,
          targetScale,
          previousPinch.center,
          nextPinch.center,
          getLayout(),
        ));
      }
      pinchRef.current = nextPinch;
      lastPanPointRef.current = null;
      movedRef.current = true;
      return;
    }

    const lastPoint = lastPanPointRef.current ?? previous ?? point;
    const delta = { x: point.x - lastPoint.x, y: point.y - lastPoint.y };
    dragDistanceRef.current += Math.hypot(delta.x, delta.y);
    if (dragDistanceRef.current >= DRAG_THRESHOLD_PX) movedRef.current = true;
    applyTransform(panImage(transformRef.current, delta, getLayout()));
    lastPanPointRef.current = point;
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 浏览器可能已在 pointercancel 前释放。
    }

    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      pinchRef.current = pinchGesture(points[0], points[1]);
      lastPanPointRef.current = null;
    } else if (points.length === 1) {
      pinchRef.current = null;
      lastPanPointRef.current = points[0];
    } else {
      pinchRef.current = null;
      lastPanPointRef.current = null;
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    zoomAt(
      transformRef.current.scale > MIN_IMAGE_SCALE ? MIN_IMAGE_SCALE : 2,
      localPoint(event.clientX, event.clientY),
    );
  }

  function handleStageClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) onCloseRef.current();
  }

  if (typeof document === "undefined") return null;

  const canReset = transform.scale > MIN_IMAGE_SCALE
    || transform.offsetX !== 0
    || transform.offsetY !== 0;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`图片 ${index + 1} 查看器`}
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex h-dvh flex-col bg-black/95 text-white outline-none"
    >
      <div className="grid h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-end gap-2 px-3 pb-2 pt-[env(safe-area-inset-top)]">
        <span className="pb-2 text-center text-xs tabular-nums text-white/70" aria-label={`第 ${index + 1} 张，共 ${total} 张`}>
          {index + 1}/{total}
        </span>
        <div className="mx-auto flex min-w-0 items-center justify-center gap-1 rounded-md bg-white/10 p-1 backdrop-blur-sm">
          <ViewerButton
            label="缩小"
            disabled={transform.scale <= MIN_IMAGE_SCALE}
            onClick={() => zoomBy(-ZOOM_STEP)}
          >
            <Minus />
          </ViewerButton>
          <span
            className="w-12 text-center text-[11px] tabular-nums text-white/80"
            aria-label={`缩放比例 ${Math.round(transform.scale * 100)}%`}
          >
            {Math.round(transform.scale * 100)}%
          </span>
          <ViewerButton
            label="放大"
            disabled={transform.scale >= MAX_IMAGE_SCALE}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <Plus />
          </ViewerButton>
          <ViewerButton label="复位" disabled={!canReset} onClick={reset}>
            <RotateCcw />
          </ViewerButton>
        </div>
        <ViewerButton label="关闭" onClick={() => onCloseRef.current()}>
          <X />
        </ViewerButton>
      </div>

      <div
        ref={stageRef}
        className={transform.scale > MIN_IMAGE_SCALE
          ? "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
          : "relative flex min-h-0 flex-1 touch-none cursor-default items-center justify-center overflow-hidden"}
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onLostPointerCapture={endGesture}
        onDoubleClick={handleDoubleClick}
        onClick={handleStageClick}
      >
        <img
          ref={imageRef}
          src={image.url}
          alt={image.revisedPrompt || `生成图片 ${index + 1}`}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
          style={{
            transform: `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0) scale(${transform.scale})`,
            transformOrigin: "center",
          }}
          onLoad={() => {
            applyTransform(constrainImageTransform(transformRef.current, getLayout()));
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function ViewerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="size-10 rounded-md text-white hover:bg-white/15 hover:text-white disabled:text-white/40 sm:size-8"
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="z-[90]">{label}</TooltipContent>
    </Tooltip>
  );
}

function pinchGesture(first: Point, second: Point): PinchGesture {
  return {
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    center: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
  };
}
