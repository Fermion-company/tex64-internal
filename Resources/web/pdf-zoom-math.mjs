export const clampZoomScale = (value, minScale, maxScale) =>
  Math.min(maxScale, Math.max(minScale, value));

export const calculateZoomChange = (
  currentScale,
  requestedFactor,
  minScale,
  maxScale
) => {
  const safeScale = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1;
  const safeFactor =
    Number.isFinite(requestedFactor) && requestedFactor > 0 ? requestedFactor : 1;
  const scale = clampZoomScale(safeScale * safeFactor, minScale, maxScale);
  return { scale, scaleFactor: scale / safeScale };
};

export const wheelDeltaToZoomFactor = (deltaY, sensitivity = 0.01) => {
  if (!Number.isFinite(deltaY) || !Number.isFinite(sensitivity)) return 1;
  const rawFactor = Math.exp(-deltaY * sensitivity);
  return Math.min(1.06, Math.max(0.94, rawFactor));
};
