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
const containingDirectory = (file) => file.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
const resolveCandidates = (activeFile, input, files, extensions, rootFile) => {
    var _a;
    const raw = input.trim().replace(/\\/g, "/");
    if (!raw)
        return [];
    const base = raw.replace(/^\/+/, "");
    // Ordinary LaTeX inclusions are read from the build directory. Keep
    // source-relative matches as well for imports that change the search path.
    const directories = raw.startsWith("/") ? [""] : ["", containingDirectory(rootFile || ""), containingDirectory(activeFile)];
    const paths = new Set(files.map((file) => file.replace(/\\/g, "/")));
    const matches = [];
    for (const directory of new Set(directories)) {
        const resolved = normalizePosixPath(directory ? `${directory}/${base}` : base);
        const candidates = ((_a = resolved.split("/").pop()) === null || _a === void 0 ? void 0 : _a.includes(".")) ? [resolved] : [resolved, ...extensions.map(ext => `${resolved}.${ext}`)];
        for (const candidate of candidates) {
            if (paths.has(candidate) && !matches.includes(candidate))
                matches.push(candidate);
        }
    }
    return matches;
};
export const resolveGraphicsCandidates = (activeFile, input, files, rootFile = null) => resolveCandidates(activeFile, input, files, ["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"], rootFile);
export const resolveTexIncludeCandidates = (activeFile, input, files, rootFile = null) => resolveCandidates(activeFile, input, files, ["tex"], rootFile);
export const isPreviewableImagePath = (pathValue) => {
    var _a, _b, _c;
    const ext = (_c = (_b = ((_a = pathValue.split("/").pop()) !== null && _a !== void 0 ? _a : "").split(".").pop()) === null || _b === void 0 ? void 0 : _b.toLowerCase()) !== null && _c !== void 0 ? _c : "";
    return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico"].includes(ext);
};
export const isPdfPath = (pathValue) => { var _a, _b, _c; return ((_c = (_b = ((_a = pathValue.split("/").pop()) !== null && _a !== void 0 ? _a : "").split(".").pop()) === null || _b === void 0 ? void 0 : _b.toLowerCase()) !== null && _c !== void 0 ? _c : "") === "pdf"; };
