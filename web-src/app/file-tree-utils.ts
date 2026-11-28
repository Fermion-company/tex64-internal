import type { DragPayload, FileNode } from "./types.js";
import { getUiLocale } from "./i18n.js";

export const fileTreeDragDataType = "application/x-tex64-item";

export const normalizeInputPath = (value: string) => {
  return value.trim().replace(/\\/g, "/");
};

export const validatePath = (value: string, kind: "file" | "folder") => {
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

export const getParentPath = (value: string) => {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

const sortNodes = (nodes: FileNode[], collator: Intl.Collator) => {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    // Equivalent case and digit spellings can coexist on disk.
    if (a.name === b.name) return 0;
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
  });
  nodes.forEach((node) => {
    if (node.children.length > 0) {
      sortNodes(node.children, collator);
    }
  });
};

export const buildFileTree = (files: string[], folders: string[]): FileNode[] => {
  const root: FileNode = { name: "", path: "", type: "dir", children: [] };
  folders.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const currentPath = parts.slice(0, index + 1).join("/");
      let child = cursor.children.find((node) => node.name === part);
      if (!child) {
        child = { name: part, path: currentPath, type: "dir", children: [] };
        cursor.children.push(child);
      } else if (child.type !== "dir") {
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
      } else {
        child.type = "dir";
      }
      cursor = child;
    });
  });
  sortNodes(root.children, new Intl.Collator(getUiLocale(), { numeric: true, sensitivity: "base" }));
  return root.children;
};

export const clearDropTargets = () => {
  document
    .querySelectorAll<HTMLElement>(".is-drop-target")
    .forEach((element) => element.classList.remove("is-drop-target"));
};

export const canDropOnFolder = (payload: DragPayload, targetFolder: string) => {
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

export const setDragData = (event: DragEvent, payload: DragPayload) => {
  if (!event.dataTransfer) {
    return;
  }
  event.dataTransfer.clearData();
  event.dataTransfer.setData(fileTreeDragDataType, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = payload.kind === "file" ? "copyMove" : "move";
};

export const getDragData = (event: DragEvent) => {
  const raw = event.dataTransfer?.getData(fileTreeDragDataType);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DragPayload;
    if (!parsed?.path || (parsed.kind !== "file" && parsed.kind !== "dir")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};
