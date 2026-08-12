export const mirrorInstanceTransform = (artboardWidth) => ({ tx: artboardWidth, ty: 0, rotate: 0, sx: -1, sy: 1 });
export const cornerInstanceTransforms = (bounds, artboardWidth, artboardHeight, inset) => {
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
export const samplePathPoints = (path, count) => {
    if (!Number.isFinite(count) || count <= 0)
        return [];
    const wanted = Math.max(1, Math.floor(count));
    const samples = [{ ...path.start }];
    let from = path.start;
    for (const segment of path.segments) {
        if (segment.type === "line")
            samples.push({ ...segment.to });
        else
            for (let i = 1; i <= 32; i++) {
                const t = i / 32, u = 1 - t;
                samples.push({
                    x: u * u * u * from.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t * t * t * segment.to.x,
                    y: u * u * u * from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t * t * t * segment.to.y,
                });
            }
        from = segment.to;
    }
    const lengths = [0];
    for (let i = 1; i < samples.length; i++)
        lengths.push(lengths[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
    const total = lengths[lengths.length - 1];
    if (total === 0 || samples.length === 1)
        return Array.from({ length: wanted }, () => ({ point: { ...path.start }, angleDeg: 0 }));
    return Array.from({ length: wanted }, (_, index) => {
        const distance = wanted === 1 ? 0 : total * index / (wanted - 1);
        let hi = 1;
        while (hi < lengths.length - 1 && lengths[hi] < distance)
            hi++;
        const lo = hi - 1, span = lengths[hi] - lengths[lo], ratio = span ? (distance - lengths[lo]) / span : 0;
        const a = samples[lo], b = samples[hi];
        return { point: { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }, angleDeg: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
    });
};
