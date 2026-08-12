export const viewportPointToDocumentPoint = (point, viewport) => ({
    x: point.x - viewport.left + viewport.scrollLeft,
    y: point.y - viewport.top + viewport.scrollTop,
});
export const documentRectToViewportRect = (rect, viewport) => ({
    x: rect.x - viewport.scrollLeft + viewport.left,
    y: rect.y - viewport.scrollTop + viewport.top,
    width: rect.width,
    height: rect.height,
});
export const calculateAutoScrollDelta = (pointer, viewportStart, viewportSize, edgeSize = 48, maxStep = 24) => {
    if (![pointer, viewportStart, viewportSize, edgeSize, maxStep].every(Number.isFinite))
        return 0;
    if (viewportSize <= 0 || edgeSize <= 0 || maxStep <= 0)
        return 0;
    const relative = pointer - viewportStart;
    if (relative < edgeSize)
        return -maxStep * Math.min(1, Math.max(0, (edgeSize - relative) / edgeSize));
    if (relative > viewportSize - edgeSize)
        return maxStep * Math.min(1, Math.max(0, (relative - (viewportSize - edgeSize)) / edgeSize));
    return 0;
};
export const calculateCaptureOutputSize = (width, height, pixelRatio = 1, maxLongEdge = 8000) => {
    if (![width, height, pixelRatio, maxLongEdge].every(Number.isFinite) || width <= 0 || height <= 0 || pixelRatio <= 0 || maxLongEdge <= 0)
        return null;
    const naturalWidth = width * pixelRatio;
    const naturalHeight = height * pixelRatio;
    const scale = Math.min(1, maxLongEdge / Math.max(naturalWidth, naturalHeight));
    return {
        width: Math.max(1, Math.round(naturalWidth * scale)),
        height: Math.max(1, Math.round(naturalHeight * scale)),
        scale: pixelRatio * scale,
    };
};
