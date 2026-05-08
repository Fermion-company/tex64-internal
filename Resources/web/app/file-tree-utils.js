import { getUiLocale } from "./i18n.js";
const dragDataType = "application/x-tex64-item";
export const normalizeInputPath = (value) => {
    return value.trim().replace(/\\/g, "/");
};
export const validatePath = (value, kind) => {
    if (!value) {
        return "Please enter your name.";
    }
    if (/^[A-Za-z]:\//.test(value) || value.startsWith("/")) {
        return "Absolute paths cannot be used.";
    }
    if (value.includes("..")) {
        return "Names that include parent directories cannot be used.";
    }
    if (kind === "file" && value.endsWith("/")) {
        return "Trailing / cannot be used in file names.";
    }
    return null;
};
export const getParentPath = (value) => {
    const parts = value.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
};
const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "dir" ? -1 : 1;
        }
        return a.name.localeCompare(b.name, getUiLocale());
    });
    nodes.forEach((node) => {
        if (node.children.length > 0) {
            sortNodes(node.children);
        }
    });
};
export const buildFileTree = (files, folders) => {
    const root = { name: "", path: "", type: "dir", children: [] };
    folders.forEach((path) => {
        const parts = path.split("/").filter(Boolean);
        let cursor = root;
        parts.forEach((part, index) => {
            const currentPath = parts.slice(0, index + 1).join("/");
            let child = cursor.children.find((node) => node.name === part);
            if (!child) {
                child = { name: part, path: currentPath, type: "dir", children: [] };
                cursor.children.push(child);
            }
            else if (child.type !== "dir") {
                child.type = "dir";
            }
            cursor = child;
        });
    });
    files.forEach((path) => {
        const parts = path.split("/").filter(Boolean);
        let cursor = root;
        parts.forEach((part, index) => {
            const isLast = index === parts.length - 1;
            let child = cursor.children.find((node) => node.name === part);
            if (!child) {
                const currentPath = parts.slice(0, index + 1).join("/");
                child = {
                    name: part,
                    path: currentPath,
                    type: isLast ? "file" : "dir",
                    children: [],
                };
                cursor.children.push(child);
            }
            if (isLast) {
                child.type = "file";
                child.children = [];
            }
            else {
                child.type = "dir";
            }
            cursor = child;
        });
    });
    sortNodes(root.children);
    return root.children;
};
export const clearDropTargets = () => {
    document
        .querySelectorAll(".is-drop-target")
        .forEach((element) => element.classList.remove("is-drop-target"));
};
export const canDropOnFolder = (payload, targetFolder) => {
    if (!targetFolder) {
        return true;
    }
    if (payload.kind === "dir") {
        if (payload.path === targetFolder) {
            return false;
        }
        if (targetFolder.startsWith(`${payload.path}/`)) {
            return false;
        }
    }
    return true;
};
export const setDragData = (event, payload) => {
    if (!event.dataTransfer) {
        return;
    }
    event.dataTransfer.clearData();
    event.dataTransfer.setData(dragDataType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
};
export const getDragData = (event) => {
    var _a;
    const raw = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData(dragDataType);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!(parsed === null || parsed === void 0 ? void 0 : parsed.path) || (parsed.kind !== "file" && parsed.kind !== "dir")) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
};
