import { uiText } from "./i18n.js";
import { buildFileTree, canDropOnFolder, clearDropTargets, getDragData, getParentPath, setDragData, } from "./file-tree-utils.js";
export const createFileTreeRenderer = ({ fileTree, deps, actions, }) => {
    const renderFileNodes = (nodes, container, depth) => {
        const activePath = deps.getActiveFilePath();
        const dirtyPaths = deps.getDirtyPaths();
        const selection = actions.getSelection();
        nodes.forEach((node) => {
            if (node.type === "dir") {
                const details = document.createElement("details");
                details.className = "file-folder";
                details.dataset.path = node.path;
                details.open = actions.getInitialFolderOpenState(node.path, depth);
                const summary = document.createElement("summary");
                summary.textContent = node.name;
                summary.style.paddingLeft = `${6 + depth * 12}px`;
                summary.draggable = true;
                summary.classList.toggle("is-open", details.open);
                if (selection.kind === "dir" && selection.path === node.path) {
                    summary.classList.add("is-selected");
                }
                const toggleFolder = (nextOpen) => {
                    details.open = nextOpen;
                    summary.classList.toggle("is-open", nextOpen);
                    actions.toggleFolderOpen(node.path, nextOpen);
                };
                summary.addEventListener("mousedown", (event) => {
                    if (deps.isAnyGroupComposing()) {
                        event.preventDefault();
                    }
                });
                summary.addEventListener("click", (event) => {
                    event.preventDefault();
                    actions.selectFolderSummary(summary, node.path);
                    toggleFolder(!details.open);
                });
                summary.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                    actions.selectFolderSummary(summary, node.path);
                    deps.contextMenu.open(event.clientX, event.clientY, actions.buildFolderContextMenu(node.path));
                });
                summary.addEventListener("dragstart", (event) => {
                    const dragEvent = event;
                    const payload = { path: node.path, kind: "dir" };
                    setDragData(dragEvent, payload);
                    actions.setDragPayload(payload);
                    summary.classList.add("is-dragging");
                });
                summary.addEventListener("dragend", () => {
                    actions.setDragPayload(null);
                    summary.classList.remove("is-dragging");
                    clearDropTargets();
                });
                summary.addEventListener("dragover", (event) => {
                    var _a;
                    const dragEvent = event;
                    dragEvent.stopPropagation();
                    const payload = (_a = actions.getDragPayload()) !== null && _a !== void 0 ? _a : getDragData(dragEvent);
                    if (!payload || !canDropOnFolder(payload, node.path)) {
                        return;
                    }
                    dragEvent.preventDefault();
                    clearDropTargets();
                    summary.classList.add("is-drop-target");
                });
                summary.addEventListener("dragleave", () => {
                    summary.classList.remove("is-drop-target");
                });
                summary.addEventListener("drop", (event) => {
                    var _a;
                    const dragEvent = event;
                    const payload = (_a = actions.getDragPayload()) !== null && _a !== void 0 ? _a : getDragData(dragEvent);
                    dragEvent.stopPropagation();
                    dragEvent.preventDefault();
                    summary.classList.remove("is-drop-target");
                    if (!payload) {
                        return;
                    }
                    actions.requestMoveItem(payload, node.path);
                });
                const children = document.createElement("div");
                children.className = "file-folder-children";
                details.append(summary, children);
                renderFileNodes(node.children, children, depth + 1);
                container.appendChild(details);
            }
            else {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "file-item";
                button.textContent = node.name;
                button.style.paddingLeft = `${18 + depth * 12}px`;
                button.dataset.path = node.path;
                button.draggable = true;
                if (dirtyPaths.has(node.path)) {
                    button.classList.add("is-dirty");
                }
                if (node.path === activePath) {
                    button.classList.add("is-active");
                }
                button.addEventListener("click", () => {
                    const opened = deps.requestOpenFile(node.path, deps.getActiveEditorGroupKey());
                    if (opened) {
                        actions.setSelection(node.path, "file");
                        actions.setTreeFocus(true);
                    }
                });
                button.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                    actions.setSelection(node.path, "file");
                    actions.setTreeFocus(true);
                    deps.contextMenu.open(event.clientX, event.clientY, actions.buildFileContextMenu(node.path));
                });
                button.addEventListener("dragstart", (event) => {
                    const dragEvent = event;
                    const payload = { path: node.path, kind: "file" };
                    setDragData(dragEvent, payload);
                    actions.setDragPayload(payload);
                    button.classList.add("is-dragging");
                });
                button.addEventListener("dragend", () => {
                    actions.setDragPayload(null);
                    button.classList.remove("is-dragging");
                    clearDropTargets();
                });
                button.addEventListener("dragover", (event) => {
                    var _a;
                    const dragEvent = event;
                    dragEvent.stopPropagation();
                    const payload = (_a = actions.getDragPayload()) !== null && _a !== void 0 ? _a : getDragData(dragEvent);
                    const targetFolder = getParentPath(node.path);
                    if (!payload || !canDropOnFolder(payload, targetFolder)) {
                        return;
                    }
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
                    dragEvent.preventDefault();
                    clearDropTargets();
                    if (dropContainer) {
                        dropContainer.classList.add("is-drop-target");
                    }
                    button.classList.add("is-drop-target");
                });
                button.addEventListener("dragleave", () => {
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
                    if (dropContainer) {
                        dropContainer.classList.remove("is-drop-target");
                    }
                    button.classList.remove("is-drop-target");
                });
                button.addEventListener("drop", (event) => {
                    var _a;
                    const dragEvent = event;
                    const payload = (_a = actions.getDragPayload()) !== null && _a !== void 0 ? _a : getDragData(dragEvent);
                    const targetFolder = getParentPath(node.path);
                    dragEvent.stopPropagation();
                    dragEvent.preventDefault();
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
                    if (dropContainer) {
                        dropContainer.classList.remove("is-drop-target");
                    }
                    button.classList.remove("is-drop-target");
                    if (!payload) {
                        return;
                    }
                    actions.requestMoveItem(payload, targetFolder);
                });
                container.appendChild(button);
            }
        });
    };
    const render = () => {
        if (!(fileTree instanceof HTMLElement)) {
            return;
        }
        fileTree.innerHTML = "";
        const workspaceFiles = deps.getWorkspaceFiles();
        const workspaceFolders = deps.getWorkspaceFolders();
        if (workspaceFiles.length === 0 && workspaceFolders.length === 0) {
            const empty = document.createElement("div");
            empty.className = "panel-placeholder";
            empty.textContent = uiText(deps.getWorkspaceName() === uiText("No workspace selected", "ワークスペース未選択")
                ? "Please open a folder."
                : "No files found.", deps.getWorkspaceName() === uiText("No workspace selected", "ワークスペース未選択")
                ? "Please open the folder."
                : "file not found.");
            fileTree.appendChild(empty);
            return;
        }
        const tree = buildFileTree(workspaceFiles, workspaceFolders);
        renderFileNodes(tree, fileTree, 0);
    };
    return { render };
};
