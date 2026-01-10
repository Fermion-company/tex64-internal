import { createFileTreeRenderer } from "./file-tree-render.js";
import { canDropOnFolder, clearDropTargets, getDragData, getParentPath, normalizeInputPath, validatePath, } from "./file-tree-utils.js";
export const initFileTreeUi = (context, deps) => {
    const { fileTree, createModal, createModalTitle, createModalSubtitle, createModalParent, createModalLabel, createModalInput, createModalHelp, createModalCancel, createModalSubmit, renameModal, renameModalTitle, renameModalTarget, renameModalInput, renameModalHelp, renameModalCancel, renameModalSubmit, contextMenu: contextMenuEl, } = context.dom;
    let selectedTreePath = null;
    let selectedTreeType = null;
    let treeHasFocus = false;
    let createModalKind = null;
    let renameTargetPath = null;
    let renameTargetType = null;
    let fileClipboard = null;
    let openFolders = new Set();
    let openStateLoaded = false;
    let dragPayload = null;
    const setText = (element, text) => {
        if (element) {
            element.textContent = text;
        }
    };
    const openStateKey = () => {
        const workspaceRootKey = deps.getWorkspaceRootKey();
        if (!workspaceRootKey) {
            return null;
        }
        return `tex64.tree.${workspaceRootKey}`;
    };
    const loadOpenState = () => {
        openFolders = new Set();
        const key = openStateKey();
        if (!key) {
            openStateLoaded = false;
            return;
        }
        const stored = localStorage.getItem(key);
        if (!stored) {
            openStateLoaded = false;
            return;
        }
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                parsed.forEach((entry) => {
                    if (typeof entry === "string") {
                        openFolders.add(entry);
                    }
                });
            }
            openStateLoaded = true;
        }
        catch {
            openFolders = new Set();
            openStateLoaded = false;
        }
    };
    const saveOpenState = () => {
        const key = openStateKey();
        if (!key) {
            return;
        }
        const data = JSON.stringify(Array.from(openFolders));
        localStorage.setItem(key, data);
        openStateLoaded = true;
    };
    const clearFolderSelection = () => {
        if (!(fileTree instanceof HTMLElement)) {
            return;
        }
        fileTree
            .querySelectorAll("summary.is-selected")
            .forEach((summary) => summary.classList.remove("is-selected"));
    };
    const setTreeFocus = (value) => {
        treeHasFocus = value;
        if (fileTree instanceof HTMLElement) {
            fileTree.classList.toggle("is-focused", value);
            if (value) {
                fileTree.focus({ preventScroll: true });
            }
        }
    };
    const setSelection = (path, kind) => {
        selectedTreePath = path;
        selectedTreeType = kind;
    };
    const clearSelection = () => {
        selectedTreePath = null;
        selectedTreeType = null;
    };
    const resolveCreateBasePath = () => {
        if (selectedTreeType === "dir" && selectedTreePath) {
            return selectedTreePath;
        }
        if (selectedTreeType === "file" && selectedTreePath) {
            return getParentPath(selectedTreePath);
        }
        const activePath = deps.getActiveFilePath();
        if (activePath) {
            return getParentPath(activePath);
        }
        return "";
    };
    const resolvePasteTarget = () => {
        if (selectedTreeType === "dir" && selectedTreePath) {
            return selectedTreePath;
        }
        if (selectedTreeType === "file" && selectedTreePath) {
            return getParentPath(selectedTreePath);
        }
        const activePath = deps.getActiveFilePath();
        if (activePath) {
            return getParentPath(activePath);
        }
        return "";
    };
    const setCreateModalOpen = (open) => {
        if (!createModal) {
            return;
        }
        createModal.classList.toggle("is-open", open);
        createModal.setAttribute("aria-hidden", open ? "false" : "true");
    };
    const setCreateModalHelp = (message, isError = false) => {
        if (!createModalHelp) {
            return;
        }
        createModalHelp.textContent = message;
        createModalHelp.classList.toggle("is-error", isError);
    };
    const openCreateModal = (kind) => {
        if (!createModal) {
            return;
        }
        createModalKind = kind;
        const basePath = resolveCreateBasePath();
        setText(createModalTitle, kind === "file" ? "新規ファイルを作成" : "新規フォルダを作成");
        setText(createModalSubtitle, kind === "file"
            ? "作成するファイル名を入力してください。"
            : "作成するフォルダ名を入力してください。");
        setText(createModalParent, basePath ? basePath : "ワークスペース直下");
        setText(createModalLabel, kind === "file" ? "ファイル名（拡張子付き）" : "フォルダ名");
        if (createModalInput instanceof HTMLInputElement) {
            createModalInput.value = "";
            createModalInput.placeholder =
                kind === "file" ? "例: sections/intro.tex" : "例: sections";
            requestAnimationFrame(() => {
                createModalInput.focus();
            });
        }
        setCreateModalHelp("");
        setCreateModalOpen(true);
    };
    const closeCreateModal = () => {
        createModalKind = null;
        setCreateModalHelp("");
        setCreateModalOpen(false);
    };
    const submitCreateModal = () => {
        if (!createModalKind) {
            return;
        }
        if (!deps.getWorkspaceRootKey()) {
            deps.updateIssues(1, "起動時にフォルダを選択してください。", "error", [
                { severity: "error", message: "起動時にフォルダを選択してください。" },
            ]);
            return;
        }
        if (!(createModalInput instanceof HTMLInputElement)) {
            return;
        }
        const rawValue = createModalInput.value.trim();
        if (!rawValue) {
            setCreateModalHelp("名前を入力してください。", true);
            deps.updateIssues(1, "名前を入力してください。", "error", [
                { severity: "error", message: "名前を入力してください。" },
            ]);
            return;
        }
        let value = normalizeInputPath(rawValue);
        if (createModalKind === "folder") {
            value = value.replace(/\/+$/, "");
        }
        const basePath = resolveCreateBasePath();
        const fullPath = basePath ? `${basePath}/${value}` : value;
        const error = validatePath(fullPath, createModalKind === "file" ? "file" : "folder");
        if (error) {
            setCreateModalHelp(error, true);
            deps.updateIssues(1, error, "error", [{ severity: "error", message: error }]);
            return;
        }
        const payload = {
            type: createModalKind === "file" ? "createFile" : "createFolder",
            path: fullPath,
        };
        deps.postToNative(payload);
        closeCreateModal();
    };
    const requestCreate = (kind) => {
        if (!deps.getWorkspaceRootKey()) {
            deps.updateIssues(1, "起動時にフォルダを選択してください。", "error", [
                { severity: "error", message: "起動時にフォルダを選択してください。" },
            ]);
            return;
        }
        if (createModal instanceof HTMLElement) {
            openCreateModal(kind);
            return;
        }
        const title = kind === "file"
            ? "新規ファイル名を入力してください（例: chapter/intro.tex）"
            : "新規フォルダ名を入力してください（例: chapter）";
        const input = window.prompt(title);
        if (!input) {
            return;
        }
        const value = normalizeInputPath(input);
        const error = validatePath(value, kind);
        if (error) {
            deps.updateIssues(1, error, "error", [{ severity: "error", message: error }]);
            return;
        }
        const payload = { type: kind === "file" ? "createFile" : "createFolder", path: value };
        deps.postToNative(payload);
    };
    const setRenameModalOpen = (open) => {
        if (!renameModal) {
            return;
        }
        renameModal.classList.toggle("is-open", open);
        renameModal.setAttribute("aria-hidden", open ? "false" : "true");
    };
    const setRenameModalHelp = (message, isError = false) => {
        if (!renameModalHelp) {
            return;
        }
        renameModalHelp.textContent = message;
        renameModalHelp.classList.toggle("is-error", isError);
    };
    const openRenameModal = (path, kind) => {
        var _a;
        if (!renameModal) {
            return;
        }
        renameTargetPath = path;
        renameTargetType = kind;
        const currentName = (_a = path.split("/").filter(Boolean).pop()) !== null && _a !== void 0 ? _a : "";
        setText(renameModalTitle, "名前の変更");
        setText(renameModalTarget, path);
        if (renameModalInput instanceof HTMLInputElement) {
            renameModalInput.value = currentName;
            renameModalInput.placeholder = "新しい名前";
            requestAnimationFrame(() => {
                renameModalInput.focus();
                renameModalInput.select();
            });
        }
        setRenameModalHelp("");
        setRenameModalOpen(true);
    };
    const closeRenameModal = () => {
        renameTargetPath = null;
        renameTargetType = null;
        setRenameModalHelp("");
        setRenameModalOpen(false);
    };
    const submitRenameModal = () => {
        if (!renameTargetPath || !renameTargetType) {
            return;
        }
        const dirtyPaths = deps.getDirtyPaths();
        const hasDirtyAffected = Array.from(dirtyPaths).some((path) => {
            if (path === renameTargetPath) {
                return true;
            }
            return renameTargetType === "dir" ? path.startsWith(`${renameTargetPath}/`) : false;
        });
        if (hasDirtyAffected) {
            const message = "未保存の変更があります。保存してから名前を変更してください。";
            setRenameModalHelp(message, true);
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return;
        }
        if (!(renameModalInput instanceof HTMLInputElement)) {
            return;
        }
        const rawValue = renameModalInput.value.trim();
        if (!rawValue) {
            setRenameModalHelp("名前を入力してください。", true);
            return;
        }
        if (rawValue.includes("/")) {
            setRenameModalHelp("名前に / は使えません。", true);
            return;
        }
        const payload = { type: "renameItem", path: renameTargetPath, newName: rawValue };
        deps.postToNative(payload);
        closeRenameModal();
    };
    const requestRevealInFinder = (path) => {
        deps.postToNative({ type: "revealInFinder", path });
    };
    const requestDeleteItem = (path, kind) => {
        deps.postToNative({ type: "deleteItem", path });
    };
    const requestCopyItem = (path, destination) => {
        deps.postToNative({ type: "copyItem", path, destination });
    };
    const requestUndoFileOperation = () => {
        deps.postToNative({ type: "undoFileOperation" });
    };
    const requestMoveItem = (payload, targetFolder) => {
        if (!deps.getWorkspaceRootKey()) {
            deps.updateIssues(1, "起動時にフォルダを選択してください。", "error", [
                { severity: "error", message: "起動時にフォルダを選択してください。" },
            ]);
            return;
        }
        const currentParent = getParentPath(payload.path);
        if (currentParent === targetFolder) {
            return;
        }
        if (!canDropOnFolder(payload, targetFolder)) {
            deps.updateIssues(1, "移動先が不正です。", "error", [
                { severity: "error", message: "移動先が不正です。" },
            ]);
            return;
        }
        const dirtyPaths = deps.getDirtyPaths();
        const hasDirtyAffected = Array.from(dirtyPaths).some((path) => {
            if (path === payload.path) {
                return true;
            }
            return payload.kind === "dir" ? path.startsWith(`${payload.path}/`) : false;
        });
        if (hasDirtyAffected) {
            deps.updateIssues(1, "未保存の変更があります。移動前に保存してください。", "error", [
                { severity: "error", message: "未保存の変更があります。移動前に保存してください。" },
            ]);
            return;
        }
        deps.postToNative({ type: "moveItem", path: payload.path, destination: targetFolder });
    };
    const pasteClipboard = () => {
        if (!fileClipboard) {
            return;
        }
        const destination = resolvePasteTarget();
        if (!canDropOnFolder(fileClipboard, destination)) {
            deps.updateIssues(1, "移動先が不正です。", "error", [
                { severity: "error", message: "移動先が不正です。" },
            ]);
            return;
        }
        if (fileClipboard.mode === "cut") {
            requestMoveItem(fileClipboard, destination);
            fileClipboard = null;
            return;
        }
        requestCopyItem(fileClipboard.path, destination);
    };
    const buildFileContextMenu = (path) => [
        {
            type: "action",
            label: "開く",
            action: () => {
                deps.requestOpenFile(path, deps.getActiveEditorGroupKey());
            },
        },
        {
            type: "action",
            label: "新しいファイル...",
            action: () => {
                selectedTreePath = path;
                selectedTreeType = "file";
                requestCreate("file");
            },
        },
        {
            type: "action",
            label: "新しいフォルダー...",
            action: () => {
                selectedTreePath = path;
                selectedTreeType = "file";
                requestCreate("folder");
            },
        },
        {
            type: "action",
            label: "Finderで表示",
            action: () => requestRevealInFinder(path),
        },
        { type: "separator" },
        {
            type: "action",
            label: "名前の変更...",
            action: () => openRenameModal(path, "file"),
        },
        {
            type: "action",
            label: "削除",
            danger: true,
            action: () => requestDeleteItem(path, "file"),
        },
    ];
    const buildFolderContextMenu = (path) => [
        {
            type: "action",
            label: "新しいファイル...",
            action: () => {
                selectedTreePath = path;
                selectedTreeType = "dir";
                requestCreate("file");
            },
        },
        {
            type: "action",
            label: "新しいフォルダー...",
            action: () => {
                selectedTreePath = path;
                selectedTreeType = "dir";
                requestCreate("folder");
            },
        },
        {
            type: "action",
            label: "Finderで表示",
            action: () => requestRevealInFinder(path),
        },
        { type: "separator" },
        {
            type: "action",
            label: "名前の変更...",
            action: () => openRenameModal(path, "dir"),
        },
        {
            type: "action",
            label: "削除",
            danger: true,
            action: () => requestDeleteItem(path, "dir"),
        },
    ];
    const selectFolderSummary = (summary, path) => {
        clearFolderSelection();
        summary.classList.add("is-selected");
        selectedTreePath = path;
        selectedTreeType = "dir";
        setTreeFocus(true);
    };
    const getSelection = () => ({
        path: selectedTreePath,
        kind: selectedTreeType,
    });
    const getInitialFolderOpenState = (path, depth) => openStateLoaded ? openFolders.has(path) : depth < 1;
    const toggleFolderOpen = (path, nextOpen) => {
        if (nextOpen) {
            openFolders.add(path);
        }
        else {
            openFolders.delete(path);
        }
        saveOpenState();
    };
    const getDragPayload = () => dragPayload;
    const setDragPayload = (payload) => {
        dragPayload = payload;
    };
    const { render } = createFileTreeRenderer({
        fileTree: fileTree instanceof HTMLElement ? fileTree : null,
        deps,
        actions: {
            getSelection,
            setSelection,
            setTreeFocus,
            selectFolderSummary,
            getInitialFolderOpenState,
            toggleFolderOpen,
            buildFileContextMenu,
            buildFolderContextMenu,
            requestMoveItem,
            getDragPayload,
            setDragPayload,
        },
    });
    const handleRenameResult = (payload) => {
        const { oldPath, newPath } = payload;
        if (payload.isDirectory) {
            const updated = new Set();
            openFolders.forEach((entry) => {
                if (entry === oldPath || entry.startsWith(`${oldPath}/`)) {
                    updated.add(newPath + entry.slice(oldPath.length));
                }
                else {
                    updated.add(entry);
                }
            });
            openFolders = updated;
            saveOpenState();
            if (selectedTreeType === "dir" && selectedTreePath) {
                if (selectedTreePath === oldPath || selectedTreePath.startsWith(`${oldPath}/`)) {
                    selectedTreePath = newPath + selectedTreePath.slice(oldPath.length);
                }
            }
        }
    };
    if (createModalCancel instanceof HTMLButtonElement) {
        createModalCancel.addEventListener("click", () => {
            closeCreateModal();
        });
    }
    if (createModalSubmit instanceof HTMLButtonElement) {
        createModalSubmit.addEventListener("click", () => {
            submitCreateModal();
        });
    }
    if (createModalInput instanceof HTMLInputElement) {
        createModalInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submitCreateModal();
            }
            else if (event.key === "Escape") {
                event.preventDefault();
                closeCreateModal();
            }
        });
    }
    if (createModal instanceof HTMLElement) {
        createModal.addEventListener("click", (event) => {
            if (event.target === createModal) {
                closeCreateModal();
            }
        });
    }
    if (renameModalCancel instanceof HTMLButtonElement) {
        renameModalCancel.addEventListener("click", () => {
            closeRenameModal();
        });
    }
    if (renameModalSubmit instanceof HTMLButtonElement) {
        renameModalSubmit.addEventListener("click", () => {
            submitRenameModal();
        });
    }
    if (renameModalInput instanceof HTMLInputElement) {
        renameModalInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submitRenameModal();
            }
            else if (event.key === "Escape") {
                event.preventDefault();
                closeRenameModal();
            }
        });
    }
    if (renameModal instanceof HTMLElement) {
        renameModal.addEventListener("click", (event) => {
            if (event.target === renameModal) {
                closeRenameModal();
            }
        });
    }
    if (fileTree instanceof HTMLElement) {
        fileTree.addEventListener("contextmenu", (event) => {
            event.preventDefault();
        });
        fileTree.addEventListener("mousedown", () => {
            setTreeFocus(true);
        });
        fileTree.addEventListener("dragover", (event) => {
            const dragEvent = event;
            const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
            if (!payload) {
                return;
            }
            if (!canDropOnFolder(payload, "")) {
                return;
            }
            const target = dragEvent.target;
            if (target && target.closest(".file-item, summary, .file-folder-children")) {
                return;
            }
            dragEvent.preventDefault();
            clearDropTargets();
            fileTree.classList.add("is-drop-target");
        });
        fileTree.addEventListener("dragleave", () => {
            fileTree.classList.remove("is-drop-target");
        });
        fileTree.addEventListener("drop", (event) => {
            const dragEvent = event;
            const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
            dragEvent.preventDefault();
            fileTree.classList.remove("is-drop-target");
            if (!payload) {
                return;
            }
            const target = dragEvent.target;
            if (target && target.closest(".file-item, summary, .file-folder-children")) {
                return;
            }
            requestMoveItem(payload, "");
        });
    }
    window.addEventListener("keydown", (event) => {
        const targetElement = event.target;
        const isTreeShortcutTarget = treeHasFocus &&
            !!targetElement &&
            ((fileTree instanceof HTMLElement && fileTree.contains(targetElement)) ||
                (contextMenuEl instanceof HTMLElement && contextMenuEl.contains(targetElement)));
        if (event.metaKey && isTreeShortcutTarget) {
            const key = event.key.toLowerCase();
            if ((key === "c" || key === "x") && selectedTreePath && selectedTreeType) {
                event.preventDefault();
                fileClipboard = {
                    path: selectedTreePath,
                    kind: selectedTreeType,
                    mode: key === "x" ? "cut" : "copy",
                };
                return;
            }
            if (key === "v") {
                event.preventDefault();
                pasteClipboard();
                return;
            }
            if (key === "z") {
                event.preventDefault();
                requestUndoFileOperation();
            }
        }
    });
    return {
        render,
        loadOpenState,
        setTreeFocus,
        setSelection,
        clearSelection,
        handleRenameResult,
    };
};
