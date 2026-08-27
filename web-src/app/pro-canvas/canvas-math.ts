import type { PathSeg, Transform, Vec } from "./scene.js";

export type CanvasViewport = {
  left: number; top: number; width: number; height: number;
  sceneWidth: number; sceneHeight: number; zoom: number;
  panX?: number; panY?: number;
};

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type SnapLine = { value: number; kind: "min" | "center" | "max" };
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** 描画ツール中でも既存オブジェクトをクリックしたら、描画より選択を優先する。 */
export const drawingToolSelectsExistingObject = (tool: string, targetId: string | null | undefined, keepDrawing = false): boolean =>
  Boolean(targetId && !keepDrawing && (tool === "pen" || tool === "line" || tool === "rect" || tool === "ellipse"));

/** 選択モードで直線の両端を変形ハンドルとして扱う。 */
export const straightLineEndpoints = (path: { start: Vec; segments: PathSeg[]; closed: boolean }): [Vec, Vec] | null => {
  const segment = path.segments.length === 1 ? path.segments[0] : null;
  return !path.closed && segment?.type === "line" ? [path.start, segment.to] : null;
};

export const normalizeCanvasMeasurement = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 10000 ? parsed : fallback;
};

/** グリッド線が画面上で密集しすぎるときだけ表示を間引く。吸着間隔は変えない。 */
export const visibleGridStep = (spacing: number, pixelsPerUnit: number, minimumPixels = 3): number => {
  if (!(spacing > 0) || !(pixelsPerUnit > 0)) return spacing;
  return Number((spacing * Math.max(1, Math.ceil(minimumPixels / (spacing * pixelsPerUnit)))).toPrecision(12));
};

const cubicPoint = (from: Vec, seg: Extract<PathSeg, { type: "cubic" }>, t: number): Vec => { const u = 1 - t; return { x: u * u * u * from.x + 3 * u * u * t * seg.c1.x + 3 * u * t * t * seg.c2.x + t * t * t * seg.to.x, y: u * u * u * from.y + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t * t * t * seg.to.y }; };
export const cubicExtremaPoints = (from: Vec, seg: { c1: Vec; c2: Vec; to: Vec }): Vec[] => {
  const roots = (p0: number, p1: number, p2: number, p3: number) => { const a = -p0 + 3 * p1 - 3 * p2 + p3, b = p0 - 2 * p1 + p2, c = p1 - p0, eps = 1e-12; if (Math.abs(a) < eps) return Math.abs(b) < eps ? [] : [-c / (2 * b)]; const d = b * b - a * c; return d < 0 ? [] : [(-b + Math.sqrt(d)) / a, (-b - Math.sqrt(d)) / a]; };
  const cubic = seg as Extract<PathSeg, { type: "cubic" }>, ts = [...roots(from.x, seg.c1.x, seg.c2.x, seg.to.x), ...roots(from.y, seg.c1.y, seg.c2.y, seg.to.y)].filter(t => t > 0 && t < 1);
  return [...ts.map(t => cubicPoint(from, cubic, t)), { ...seg.to }];
};
export const pathTightPoints = (path: { start: Vec; segments: PathSeg[] }): Vec[] => { const points: Vec[] = [{ ...path.start }]; let from = path.start; for (const seg of path.segments) { points.push(...(seg.type === "line" ? [{ ...seg.to }] : cubicExtremaPoints(from, seg))); from = seg.to; } return points; };
export const pathTightBounds = (path: { start: Vec; segments: PathSeg[] }): Bounds => { const points = pathTightPoints(path), xs = points.map(p => p.x), ys = points.map(p => p.y); return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }; };
export const isMirrorPair = (anchor: Vec, a: Vec, b: Vec): boolean => { const ax = a.x - anchor.x, ay = a.y - anchor.y, bx = b.x - anchor.x, by = b.y - anchor.y, al = Math.hypot(ax, ay), bl = Math.hypot(bx, by); return al > 1e-6 && bl > 1e-6 && (ax * bx + ay * by) / (al * bl) < -Math.cos(Math.PI / 18); };
export const mirroredControl = (anchor: Vec, dragged: Vec, oppositeLength: number): Vec => { const dx = dragged.x - anchor.x, dy = dragged.y - anchor.y, length = Math.hypot(dx, dy); return length < 1e-12 ? { ...anchor } : { x: anchor.x - dx / length * oppositeLength, y: anchor.y - dy / length * oppositeLength }; };
export const nearestOnPath = (path: { start: Vec; segments: PathSeg[] }, p: Vec): { segIndex: number; t: number; dist: number; point: Vec } => { let best = { segIndex: 0, t: 0, dist: Infinity, point: { ...path.start } }, from = path.start; path.segments.forEach((seg, segIndex) => { if (seg.type === "line") { const dx = seg.to.x - from.x, dy = seg.to.y - from.y, d = dx * dx + dy * dy, t = d ? Math.max(0, Math.min(1, ((p.x - from.x) * dx + (p.y - from.y) * dy) / d)) : 0, point = { x: from.x + dx * t, y: from.y + dy * t }, dist = Math.hypot(p.x - point.x, p.y - point.y); if (dist < best.dist) best = { segIndex, t, dist, point }; } else for (let i = 0; i <= 32; i++) { const t = i / 32, point = cubicPoint(from, seg, t), dist = Math.hypot(p.x - point.x, p.y - point.y); if (dist < best.dist) best = { segIndex, t, dist, point }; } from = seg.to; }); return best; };
export const bendSegment = (seg: Extract<PathSeg, { type: "cubic" }>, t: number, delta: Vec): void => { const w1 = 3 * (1 - t) * (1 - t) * t, w2 = 3 * (1 - t) * t * t, s = w1 * w1 + w2 * w2; if (!s) return; seg.c1.x += delta.x * w1 / s; seg.c1.y += delta.y * w1 / s; seg.c2.x += delta.x * w2 / s; seg.c2.y += delta.y * w2 / s; };
export const splitSegmentAt = (from: Vec, seg: PathSeg, t: number): [PathSeg, PathSeg] => { if (seg.type === "line") { const mid = { x: from.x + (seg.to.x - from.x) * t, y: from.y + (seg.to.y - from.y) * t }; return [{ type: "line", to: mid }, { type: "line", to: { ...seg.to } }]; } const mix = (a: Vec, b: Vec) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), a = mix(from, seg.c1), b = mix(seg.c1, seg.c2), c = mix(seg.c2, seg.to), d = mix(a, b), e = mix(b, c), mid = mix(d, e); return [{ type: "cubic", c1: a, c2: d, to: mid }, { type: "cubic", c1: e, c2: c, to: { ...seg.to } }]; };
/**
 * パスの向きを反転する（形はそのまま）。始点側から続きを描くために使う。
 * 見た目を変えないよう、呼び出し側は始点/終点の矢頭も入れ替えること。
 */
export const reversePath = (path: { start: Vec; segments: PathSeg[] }): { start: Vec; segments: PathSeg[] } => {
  const anchors = [path.start, ...path.segments.map((seg) => seg.to)];
  const segments: PathSeg[] = [];
  for (let i = path.segments.length - 1; i >= 0; i -= 1) {
    const seg = path.segments[i], to = { ...anchors[i] };
    segments.push(seg.type === "line" ? { type: "line", to } : { type: "cubic", c1: { ...seg.c2 }, c2: { ...seg.c1 }, to });
  }
  return { start: { ...anchors[anchors.length - 1] }, segments };
};

export const removeAnchor =(path: { start: Vec; segments: PathSeg[]; closed: boolean }, index: number): boolean => { const n = path.segments.length; if (index < 0 || index > n) return false; if (!n) return false; if (index === 0) { path.start = { ...path.segments[0].to }; path.segments.shift(); if (path.closed && path.segments.length) path.segments[path.segments.length - 1].to = { ...path.start }; return path.segments.length > 0; } if (!path.closed && index === n) { path.segments.pop(); return path.segments.length > 0; } const prev = path.segments[index - 1], next = path.segments[index]; if (!next) return false; const from = index === 1 ? path.start : path.segments[index - 2].to, lineC1 = (a: Vec, b: Vec) => ({ x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }), lineC2 = (a: Vec, b: Vec) => ({ x: a.x + (b.x - a.x) * 2 / 3, y: a.y + (b.y - a.y) * 2 / 3 }); path.segments.splice(index - 1, 2, { type: "cubic", c1: prev.type === "cubic" ? { ...prev.c1 } : lineC1(from, prev.to), c2: next.type === "cubic" ? { ...next.c2 } : lineC2(prev.to, next.to), to: { ...next.to } }); return path.segments.length > 0; };

export const zoomAtPoint = (
  view: { panX: number; panY: number; zoom: number },
  cursorOffset: Vec,
  newZoom: number,
): { panX: number; panY: number } => {
  const ratio = newZoom / view.zoom;
  return {
    panX: cursorOffset.x - (cursorOffset.x - view.panX) * ratio,
    panY: cursorOffset.y - (cursorOffset.y - view.panY) * ratio,
  };
};

export const marqueeHits = (
  rect: Bounds,
  objects: Array<{ id: string; bounds: Bounds }>,
): string[] => objects
  .filter(({ bounds }) => bounds.maxX >= rect.minX && bounds.minX <= rect.maxX
    && bounds.maxY >= rect.minY && bounds.minY <= rect.maxY)
  .map(({ id }) => id);

export const mirrorInstanceTransform = (artboardWidth: number): Transform =>
  ({ tx: artboardWidth, ty: 0, rotate: 0, sx: -1, sy: 1 });

export const cornerInstanceTransforms = (
  bounds: Bounds,
  artboardWidth: number,
  artboardHeight: number,
  inset: number,
): [Transform, Transform, Transform, Transform] => {
  const left = inset - bounds.minX;
  const right = artboardWidth - inset + bounds.minX;
  const bottom = inset - bounds.minY;
  const top = artboardHeight - inset + bounds.minY;
  return [
    { tx: left, ty: bottom, rotate: 0, sx: 1, sy: 1 },
    { tx: right, ty: bottom, rotate: 0, sx: -1, sy: 1 },
    { tx: left, ty: top, rotate: 0, sx: 1, sy: -1 },
    { tx: right, ty: top, rotate: 0, sx: -1, sy: -1 },
  ];
};

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

/**
 * グリッド吸着。`pull`（グリッド幅に対する比、既定 1 = 常に最寄りへ）を小さくすると
 * 格子線の近くだけ引き寄せる磁石式になり、格子から外れた位置にも素直に置ける。
 * 軸ごとに独立して判定する（x だけ格子に乗せたい、が普通に起きるため）。
 */
export const snapToGrid = (point: Vec, size: number, enabled = true, pull = 1): Vec => {
  if (!enabled || !Number.isFinite(size) || size <= 0) return { ...point };
  const axis = (value: number) => {
    const snapped = Math.round(value / size) * size;
    return Math.abs(snapped - value) <= size * pull ? snapped : value;
  };
  return { x: axis(point.x), y: axis(point.y) };
};

/**
 * ペンのクリック 1 回をどう解釈するか（閉じる / 確定 / スキップ / 頂点追加）。
 *
 * 閉じる・確定はジェスチャ（「始点そのものをクリックしたか」）なので、判定は
 * **吸着前の生カーソル × 画面ピクセル**で行う。ユーザーは画面に見えている印に
 * 向かってクリックするのだから、ズーム率や格子幅（無関係な設定）で「閉じやすさ」が
 * 変わってはいけない。既存の頂点追加 8px・端点再開 12px と同じ流儀。
 * 吸着後の点は「どこに置くか」だけに使う（add の point）。ただし吸着が最終
 * アンカーの真上に載せた場合だけは、長さ 0 のセグメントになるので置かない（skip）。
 * 優先順位: close > finish > skip > add。境界は inclusive。
 * pointerdown もプレビュー（閉形予告・仮ノード）も必ずこの関数を通し、
 * 「予告と違うことが起きる」を作らない。
 */
export const PEN_CLOSE_PX = 10;
export const PEN_FINISH_PX = 8;
export const PEN_RESUME_PX = 12;

export type PenClickAction =
  | { action: "close" }
  | { action: "finish" }
  | { action: "skip" }
  | { action: "add"; point: Vec };

export const penClickAction = (input: {
  rawPoint: Vec;
  snappedPoint: Vec;
  start: Vec | null;
  last: Vec | null;
  scaleFactor: number;
  segmentCount: number;
}): PenClickAction => {
  const { rawPoint, snappedPoint, start, last, scaleFactor, segmentCount } = input;
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const screenDistance = (target: Vec) =>
    Math.hypot(rawPoint.x - target.x, rawPoint.y - target.y) * scale;
  if (start && segmentCount > 0 && screenDistance(start) <= PEN_CLOSE_PX) return { action: "close" };
  if (last && screenDistance(last) <= PEN_FINISH_PX) return { action: "finish" };
  if (last && snappedPoint.x === last.x && snappedPoint.y === last.y) return { action: "skip" };
  return { action: "add", point: { ...snappedPoint } };
};

export const collectSnapLines = (
  others: Bounds[],
  artboard: { width: number; height: number },
): { x: SnapLine[]; y: SnapLine[] } => {
  const lines = { x: [] as SnapLine[], y: [] as SnapLine[] };
  for (const bounds of others) {
    lines.x.push({ value: bounds.minX, kind: "min" }, { value: (bounds.minX + bounds.maxX) / 2, kind: "center" }, { value: bounds.maxX, kind: "max" });
    lines.y.push({ value: bounds.minY, kind: "min" }, { value: (bounds.minY + bounds.maxY) / 2, kind: "center" }, { value: bounds.maxY, kind: "max" });
  }
  lines.x.push({ value: 0, kind: "min" }, { value: artboard.width / 2, kind: "center" }, { value: artboard.width, kind: "max" });
  lines.y.push({ value: 0, kind: "min" }, { value: artboard.height / 2, kind: "center" }, { value: artboard.height, kind: "max" });
  return lines;
};

export const snapBoundsToLines = (
  bounds: Bounds,
  lines: { x: SnapLine[]; y: SnapLine[] },
  threshold: number,
): { dx: number; dy: number; guides: { x?: number; y?: number } } => {
  const best = (values: SnapLine[], candidates: SnapLine[]): { delta: number; guide?: number } => {
    let winner: { delta: number; guide: number; center: boolean } | null = null;
    for (const value of values) for (const candidate of candidates) {
      const delta = candidate.value - value.value;
      if (Math.abs(delta) > threshold) continue;
      const center = value.kind === "center" && candidate.kind === "center";
      if (!winner || Math.abs(delta) < Math.abs(winner.delta) || (Math.abs(delta) === Math.abs(winner.delta) && center && !winner.center)) winner = { delta, guide: candidate.value, center };
    }
    return winner ? { delta: winner.delta, guide: winner.guide } : { delta: 0 };
  };
  const x = best([{ value: bounds.minX, kind: "min" }, { value: (bounds.minX + bounds.maxX) / 2, kind: "center" }, { value: bounds.maxX, kind: "max" }], lines.x);
  const y = best([{ value: bounds.minY, kind: "min" }, { value: (bounds.minY + bounds.maxY) / 2, kind: "center" }, { value: bounds.maxY, kind: "max" }], lines.y);
  return { dx: x.delta, dy: y.delta, guides: { ...(x.guide === undefined ? {} : { x: x.guide }), ...(y.guide === undefined ? {} : { y: y.guide }) } };
};

export const alignDeltas = (bounds: Bounds[], mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom"): Vec[] => {
  if (!bounds.length) return [];
  const aggregate = { minX: Math.min(...bounds.map(b => b.minX)), minY: Math.min(...bounds.map(b => b.minY)), maxX: Math.max(...bounds.map(b => b.maxX)), maxY: Math.max(...bounds.map(b => b.maxY)) };
  return bounds.map(b => ({
    x: mode === "left" ? aggregate.minX - b.minX : mode === "centerX" ? (aggregate.minX + aggregate.maxX - b.minX - b.maxX) / 2 : mode === "right" ? aggregate.maxX - b.maxX : 0,
    y: mode === "bottom" ? aggregate.minY - b.minY : mode === "centerY" ? (aggregate.minY + aggregate.maxY - b.minY - b.maxY) / 2 : mode === "top" ? aggregate.maxY - b.maxY : 0,
  }));
};

export const distributeDeltas = (bounds: Bounds[], axis: "x" | "y"): Vec[] => {
  const result = bounds.map(() => ({ x: 0, y: 0 }));
  if (bounds.length < 3) return result;
  const min = axis === "x" ? "minX" : "minY", max = axis === "x" ? "maxX" : "maxY";
  const ordered = bounds.map((bounds, index) => ({ bounds, index })).sort((a, b) => a.bounds[min] - b.bounds[min]);
  const occupied = ordered.reduce((sum, item) => sum + item.bounds[max] - item.bounds[min], 0);
  const gap = (ordered[ordered.length - 1].bounds[max] - ordered[0].bounds[min] - occupied) / (ordered.length - 1);
  let cursor = ordered[0].bounds[min];
  for (const item of ordered) {
    const delta = cursor - item.bounds[min];
    result[item.index][axis] = delta;
    cursor += item.bounds[max] - item.bounds[min] + gap;
  }
  return result;
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

export const anchorControlMetrics = (emphasized = false) => ({
  visibleRadiusPx: emphasized ? 4 : 3.5,
  hitRadiusPx: 11,
});

export const anchorPointMetrics = (endpoint = false) => ({
  visibleSizePx: endpoint ? 9 : 7,
  hitSizePx: endpoint ? 18 : 16,
});

export const toggleSegmentKind = (
  path: { start: Vec; segments: PathSeg[] },
  anchorIndex: number,
): void => {
  if (anchorIndex <= 0 || anchorIndex > path.segments.length) return;
  const index = anchorIndex - 1;
  const segment = path.segments[index];
  if (segment.type === "cubic") {
    path.segments[index] = { type: "line", to: { ...segment.to } };
    return;
  }
  const from = index === 0 ? path.start : path.segments[index - 1].to;
  const to = segment.to;
  path.segments[index] = {
    type: "cubic",
    c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    c2: { x: from.x + (to.x - from.x) * 2 / 3, y: from.y + (to.y - from.y) * 2 / 3 },
    to: { ...to },
  };
};

export const samplePathPoints = (path: { start: Vec; segments: PathSeg[] }, count: number): Array<{ point: Vec; angleDeg: number }> => {
  if (!Number.isFinite(count) || count <= 0) return [];
  const wanted = Math.max(1, Math.floor(count));
  const samples: Vec[] = [{ ...path.start }];
  let from = path.start;
  for (const segment of path.segments) {
    if (segment.type === "line") samples.push({ ...segment.to });
    else for (let i = 1; i <= 32; i++) {
      const t = i / 32, u = 1 - t;
      samples.push({
        x: u * u * u * from.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t * t * t * segment.to.x,
        y: u * u * u * from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t * t * t * segment.to.y,
      });
    }
    from = segment.to;
  }
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) lengths.push(lengths[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  const total = lengths[lengths.length - 1];
  if (total === 0 || samples.length === 1) return Array.from({ length: wanted }, () => ({ point: { ...path.start }, angleDeg: 0 }));
  return Array.from({ length: wanted }, (_, index) => {
    const distance = wanted === 1 ? 0 : total * index / (wanted - 1);
    let hi = 1;
    while (hi < lengths.length - 1 && lengths[hi] < distance) hi++;
    const lo = hi - 1, span = lengths[hi] - lengths[lo], ratio = span ? (distance - lengths[lo]) / span : 0;
    const a = samples[lo], b = samples[hi];
    return { point: { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }, angleDeg: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
  });
};
