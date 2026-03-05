const normalizePosixPath = (value) => {
    const parts = value.split("/").filter(Boolean);
    const stack = [];
    for (const part of parts) {
        if (part === ".") {
            continue;
        }
        if (part === "..") {
            if (stack.length > 0 && stack[stack.length - 1] !== "..") {
                stack.pop();
            }
            else {
                stack.push("..");
            }
            continue;
        }
        stack.push(part);
    }
    return stack.join("/");
};
export const resolveGraphicsCandidates = (activeFilePath, rawPath, workspaceFiles) => {
    var _a;
    const normalized = rawPath.trim().split("\\").join("/");
    if (!normalized) {
        return [];
    }
    const activeDir = activeFilePath.split("\\").join("/").split("/").slice(0, -1).join("/");
    const base = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
    const resolved = normalizePosixPath(activeDir ? `${activeDir}/${base}` : base);
    const hasExt = ((_a = resolved.split("/").pop()) !== null && _a !== void 0 ? _a : "").includes(".");
    const allowedExts = ["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"];
    const candidates = [];
    if (hasExt) {
        candidates.push(resolved);
    }
    else {
        candidates.push(resolved);
        allowedExts.forEach((ext) => candidates.push(`${resolved}.${ext}`));
    }
    const workspaceSet = new Set(workspaceFiles.map((p) => p.split("\\").join("/")));
    return candidates.filter((candidate) => workspaceSet.has(candidate));
};
export const resolveTexIncludeCandidates = (activeFilePath, rawPath, workspaceFiles) => {
    var _a;
    const normalized = rawPath.trim().split("\\").join("/");
    if (!normalized) {
        return [];
    }
    const activeDir = activeFilePath.split("\\").join("/").split("/").slice(0, -1).join("/");
    const base = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
    const resolved = normalizePosixPath(activeDir ? `${activeDir}/${base}` : base);
    const hasExt = ((_a = resolved.split("/").pop()) !== null && _a !== void 0 ? _a : "").includes(".");
    const candidates = hasExt ? [resolved] : [resolved, `${resolved}.tex`];
    const workspaceSet = new Set(workspaceFiles.map((p) => p.split("\\").join("/")));
    return candidates.filter((candidate) => workspaceSet.has(candidate));
};
export const isPreviewableImagePath = (pathValue) => {
    var _a, _b, _c;
    const ext = (_c = (_b = ((_a = pathValue.split("/").pop()) !== null && _a !== void 0 ? _a : "").split(".").pop()) === null || _b === void 0 ? void 0 : _b.toLowerCase()) !== null && _c !== void 0 ? _c : "";
    return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico"].includes(ext);
};
