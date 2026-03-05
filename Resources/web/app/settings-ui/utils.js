export const updateSettingsToggle = (element, enabled) => {
    if (element instanceof HTMLInputElement) {
        element.checked = enabled;
    }
};
export const openExternalUrl = (runtime, url) => {
    const normalized = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(normalized)) {
        return;
    }
    runtime.deps.postToNative({ type: "shell:openExternal", url: normalized }, true);
};
export const formatBytes = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return "0 B";
    }
    if (value < 1024) {
        return `${Math.round(value)} B`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }
    if (value < 1024 * 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
