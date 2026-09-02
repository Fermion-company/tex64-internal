const normalizeSeparators = (value) => value.replace(/\\/g, "/");
const isAbsolutePath = (value) => value.startsWith("/") || /^[A-Za-z]:\//.test(value);
export const resolveLivePreviewWorkspacePath = (file, workspaceRoot) => {
    if (!file || !workspaceRoot || /[\0-\x1f]/.test(file))
        return null;
    const normalizedRoot = normalizeSeparators(workspaceRoot);
    const root = normalizedRoot === "/" ? "/" : normalizedRoot.replace(/\/+$/, "");
    const source = normalizeSeparators(file).replace(/^(?:\.\/)+/, "");
    if (!root || !source)
        return null;
    let candidate = source;
    if (isAbsolutePath(source)) {
        const caseInsensitive = /^[A-Za-z]:\//.test(root);
        const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
        const comparableSource = caseInsensitive ? source.toLowerCase() : source;
        const rootPrefix = comparableRoot === "/" ? "/" : `${comparableRoot}/`;
        if (!comparableSource.startsWith(rootPrefix))
            return null;
        candidate = source.slice(rootPrefix.length);
    }
    else if (/^[A-Za-z]:/.test(source)) {
        // A drive-relative Windows path can resolve outside the selected root.
        return null;
    }
    const parts = candidate.split("/");
    if (parts.some((part) => part === ".." || /[\0-\x1f]/.test(part)))
        return null;
    const normalized = parts.filter((part) => part && part !== ".").join("/");
    return normalized || null;
};
