const scaleFor = (view) => Math.min(view.width / view.sceneWidth, view.height / view.sceneHeight) * view.zoom;
export const sceneToScreen = (point, view) => {
    const scale = scaleFor(view);
    const originX = view.left + view.width / 2 - view.sceneWidth * scale / 2 + (view.panX || 0);
    const originY = view.top + view.height / 2 + view.sceneHeight * scale / 2 + (view.panY || 0);
    return { x: originX + point.x * scale, y: originY - point.y * scale };
};
export const screenToScene = (point, view) => {
    const scale = scaleFor(view);
    const originX = view.left + view.width / 2 - view.sceneWidth * scale / 2 + (view.panX || 0);
    const originY = view.top + view.height / 2 + view.sceneHeight * scale / 2 + (view.panY || 0);
    return { x: (point.x - originX) / scale, y: (originY - point.y) / scale };
};
export const snapToGrid = (point, size, enabled = true) => {
    if (!enabled || !Number.isFinite(size) || size <= 0)
        return { ...point };
    return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
};
export const resizeHandlePoint = (bounds, handle) => {
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midY = (bounds.minY + bounds.maxY) / 2;
    const x = handle.includes("w") ? bounds.minX : handle.includes("e") ? bounds.maxX : midX;
    const y = handle.includes("s") ? bounds.minY : handle.includes("n") ? bounds.maxY : midY;
    return { x, y };
};
export const resizePoint = (point, original, resized) => {
    const width = original.maxX - original.minX;
    const height = original.maxY - original.minY;
    return {
        x: resized.minX + (width ? (point.x - original.minX) / width : 0.5) * (resized.maxX - resized.minX),
        y: resized.minY + (height ? (point.y - original.minY) / height : 0.5) * (resized.maxY - resized.minY),
    };
};
export const boundsAfterHandleDrag = (bounds, handle, point, minSize = 0.01) => {
    let { minX, minY, maxX, maxY } = bounds;
    if (handle.includes("w"))
        minX = Math.min(point.x, maxX - minSize);
    if (handle.includes("e"))
        maxX = Math.max(point.x, minX + minSize);
    if (handle.includes("s"))
        minY = Math.min(point.y, maxY - minSize);
    if (handle.includes("n"))
        maxY = Math.max(point.y, minY + minSize);
    return { minX, minY, maxX, maxY };
};
