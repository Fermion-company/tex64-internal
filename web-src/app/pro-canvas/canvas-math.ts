import type { Vec } from "./scene.js";

export type CanvasViewport = {
  left: number; top: number; width: number; height: number;
  sceneWidth: number; sceneHeight: number; zoom: number;
  panX?: number; panY?: number;
};

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const scaleFor = (view: CanvasViewport) =>
  Math.min(view.width / view.sceneWidth, view.height / view.sceneHeight) * view.zoom;

export const sceneToScreen = (point: Vec, view: CanvasViewport): Vec => {
  const scale = scaleFor(view);
  const originX = view.left + view.width / 2 - view.sceneWidth * scale / 2 + (view.panX || 0);
  const originY = view.top + view.height / 2 + view.sceneHeight * scale / 2 + (view.panY || 0);
  return { x: originX + point.x * scale, y: originY - point.y * scale };
};

export const screenToScene = (point: Vec, view: CanvasViewport): Vec => {
  const scale = scaleFor(view);
  const originX = view.left + view.width / 2 - view.sceneWidth * scale / 2 + (view.panX || 0);
  const originY = view.top + view.height / 2 + view.sceneHeight * scale / 2 + (view.panY || 0);
  return { x: (point.x - originX) / scale, y: (originY - point.y) / scale };
};

export const snapToGrid = (point: Vec, size: number, enabled = true): Vec => {
  if (!enabled || !Number.isFinite(size) || size <= 0) return { ...point };
  return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
};

export const resizeHandlePoint = (bounds: Bounds, handle: ResizeHandle): Vec => {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  const x = handle.includes("w") ? bounds.minX : handle.includes("e") ? bounds.maxX : midX;
  const y = handle.includes("s") ? bounds.minY : handle.includes("n") ? bounds.maxY : midY;
  return { x, y };
};

export const resizePoint = (point: Vec, original: Bounds, resized: Bounds): Vec => {
  const width = original.maxX - original.minX;
  const height = original.maxY - original.minY;
  return {
    x: resized.minX + (width ? (point.x - original.minX) / width : 0.5) * (resized.maxX - resized.minX),
    y: resized.minY + (height ? (point.y - original.minY) / height : 0.5) * (resized.maxY - resized.minY),
  };
};

export const boundsAfterHandleDrag = (bounds: Bounds, handle: ResizeHandle, point: Vec, minSize = 0.01): Bounds => {
  let { minX, minY, maxX, maxY } = bounds;
  if (handle.includes("w")) minX = Math.min(point.x, maxX - minSize);
  if (handle.includes("e")) maxX = Math.max(point.x, minX + minSize);
  if (handle.includes("s")) minY = Math.min(point.y, maxY - minSize);
  if (handle.includes("n")) maxY = Math.max(point.y, minY + minSize);
  return { minX, minY, maxX, maxY };
};
