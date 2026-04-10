import type { AppContext } from "./context.js";
import type { ContextMenuApi, ContextMenuItem } from "./context-menu.js";
import { uiText } from "./i18n.js";
import type { CreateKind, DragPayload, IssueItem, IssuesStatus } from "./types.js";
import { createFileTreeRenderer } from "./file-tree-render.js";
import {
  canDropOnFolder,
  clearDropTargets,
  getDragData,
  getParentPath,
  normalizeInputPath,
  validatePath,
} from "./file-tree-utils.js";

type EditorGroupKey = "primary" | "secondary";

type FileTreeDeps = {
  contextMenu: ContextMenuApi;
  getWorkspaceRootKey: () => string | null;
  getWorkspaceName: () => string;
  getWorkspaceFiles: () => string[];
  getWorkspaceFolders: () => string[];
  getActiveFilePath: () => string | null;
  getActiveEditorGroupKey: () => EditorGroupKey;
  requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  isAnyGroupComposing: () => boolean;
  postToNative: (payload: { type: string; [key: string]: unknown }) => boolean;
  getDirtyPaths: () => Set<string>;
};

export type FileTreeUiApi = {
  render: () => void;
  loadOpenState: () => void;
  setTreeFocus: (value: boolean) => void;
  setSelection: (path: string | null, kind: "file" | "dir" | null) => void;
  clearSelection: () => void;
  handleRenameResult: (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => void;
};

export const initFileTreeUi = (
  context: AppContext,
  deps: FileTreeDeps
): FileTreeUiApi => {
  const {
    fileTree,
    createModal,
    createModalTitle,
    createModalSubtitle,
    createModalParent,
    createModalLabel,
    createModalInput,
    createModalHelp,
    createModalCancel,
    createModalSubmit,
    renameModal,
    renameModalTitle,
    renameModalTarget,
    renameModalInput,
    renameModalHelp,
    renameModalCancel,
    renameModalSubmit,
    deleteModal,
    deleteModalTitle,
    deleteModalTarget,
    deleteModalHelp,
    deleteModalCancel,
    deleteModalSubmit,
    contextMenu: contextMenuEl,
  } = context.dom;

  let selectedTreePath: string | null = null;
  let selectedTreeType: "file" | "dir" | null = null;
  let treeHasFocus = false;
  let createModalKind: CreateKind | null = null;
  let renameTargetPath: string | null = null;
  let renameTargetType: "file" | "dir" | null = null;
  let deleteTargetPath: string | null = null;
  let deleteTargetType: "file" | "dir" | null = null;
  let fileClipboard: { path: string; kind: "file" | "dir"; mode: "copy" | "cut" } | null =
    null;
  let openFolders = new Set<string>();
  let openStateLoaded = false;
  let dragPayload: DragPayload | null = null;

  const setText = (element: HTMLElement | null, text: string) => {
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
    openFolders = new Set<string>();
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
    } catch {
      openFolders = new Set<string>();
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
      .querySelectorAll<HTMLElement>("summary.is-selected")
      .forEach((summary) => summary.classList.remove("is-selected"));
  };

  const setTreeFocus = (value: boolean) => {
    treeHasFocus = value;
    if (fileTree instanceof HTMLElement) {
      fileTree.classList.toggle("is-focused", value);
      if (value) {
        fileTree.focus({ preventScroll: true });
      }
    }
  };

  const setSelection = (path: string | null, kind: "file" | "dir" | null) => {
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

  const setCreateModalOpen = (open: boolean) => {
    if (!createModal) {
      return;
    }
    createModal.classList.toggle("is-open", open);
    createModal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const setCreateModalHelp = (message: string, isError = false) => {
    if (!createModalHelp) {
      return;
    }
    createModalHelp.textContent = message;
    createModalHelp.classList.toggle("is-error", isError);
  };

  const openCreateModal = (kind: CreateKind) => {
    if (!createModal) {
      return;
    }
    createModalKind = kind;
    const basePath = resolveCreateBasePath();
    setText(createModalTitle, kind === "file" ? uiText("Create New File", "create new file") : uiText("Create New Folder", "Create new folder"));
    setText(createModalSubtitle, "");
    setText(createModalParent, basePath ? basePath : uiText("Workspace root", "Directly below the workspace"));
    setText(createModalLabel, kind === "file" ? uiText("File name (with extension)", "ファイル名（拡張子付き）") : uiText("Folder name", "folder name"));
    if (createModalInput instanceof HTMLInputElement) {
      createModalInput.value = "";
      createModalInput.placeholder =
        kind === "file" ? uiText("Example: sections/intro.tex", "例: sections/intro.tex") : uiText("Example: sections", "例: sections");
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
      const message = uiText("Please select a folder at startup.", "起動時にフォルダを選択してください。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    if (!(createModalInput instanceof HTMLInputElement)) {
      return;
    }
    const rawValue = createModalInput.value.trim();
    if (!rawValue) {
      const message = uiText("Please enter a name.", "Please enter your name.");
      setCreateModalHelp(message, true);
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
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

  const requestCreate = (kind: CreateKind) => {
    if (!deps.getWorkspaceRootKey()) {
      const message = uiText("Please select a folder at startup.", "起動時にフォルダを選択してください。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    if (createModal instanceof HTMLElement) {
      openCreateModal(kind);
      return;
    }
    const title =
      kind === "file"
        ? uiText("New file name (e.g. chapter/intro.tex)", "新規ファイル名（例: chapter/intro.tex）")
        : uiText("New folder name (e.g. chapter)", "新規フォルダ名（例: chapter）");
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

  const setRenameModalOpen = (open: boolean) => {
    if (!renameModal) {
      return;
    }
    renameModal.classList.toggle("is-open", open);
    renameModal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const setRenameModalHelp = (message: string, isError = false) => {
    if (!renameModalHelp) {
      return;
    }
    renameModalHelp.textContent = message;
    renameModalHelp.classList.toggle("is-error", isError);
  };

  const openRenameModal = (path: string, kind: "file" | "dir") => {
    if (!renameModal) {
      return;
    }
    renameTargetPath = path;
    renameTargetType = kind;
    const currentName = path.split("/").filter(Boolean).pop() ?? "";
    setText(renameModalTitle, uiText("Rename", "rename"));
    setText(renameModalTarget, path);
    if (renameModalInput instanceof HTMLInputElement) {
      renameModalInput.value = currentName;
      renameModalInput.placeholder = uiText("New name", "new name");
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
      const message = uiText(
        "There are unsaved changes. Please save before renaming.",
        "There are unsaved changes. Please save and rename."
      );
      setRenameModalHelp(message, true);
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      return;
    }
    if (!(renameModalInput instanceof HTMLInputElement)) {
      return;
    }
    const rawValue = renameModalInput.value.trim();
    if (!rawValue) {
      setRenameModalHelp(uiText("Please enter a name.", "Please enter your name."), true);
      return;
    }
    if (rawValue.includes("/")) {
      setRenameModalHelp(uiText("Names cannot contain /.", "/ cannot be used in the name."), true);
      return;
    }
    const payload = { type: "renameItem", path: renameTargetPath, newName: rawValue };
    deps.postToNative(payload);
    closeRenameModal();
  };

  const requestRevealInFinder = (path: string) => {
    deps.postToNative({ type: "revealInFinder", path });
  };

  const requestOpenInTerminal = (path: string) => {
    deps.postToNative({ type: "openInTerminal", path });
  };

  const setDeleteModalOpen = (open: boolean) => {
    if (!deleteModal) {
      return;
    }
    deleteModal.classList.toggle("is-open", open);
    deleteModal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const openDeleteModal = (path: string, kind: "file" | "dir") => {
    deleteTargetPath = path;
    deleteTargetType = kind;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    setText(deleteModalTitle, kind === "dir" ? uiText("Delete Folder", "delete folder") : uiText("Delete File", "delete file"));
    setText(deleteModalTarget, name);
    if (deleteModalHelp instanceof HTMLElement) {
      deleteModalHelp.textContent =
        kind === "dir"
          ? uiText("The folder and all files inside it will be deleted. This cannot be undone.", "The folder and all files within it will be deleted. This operation cannot be undone.")
          : uiText("This action cannot be undone.", "This operation cannot be undone.");
      deleteModalHelp.classList.remove("is-error");
    }
    setDeleteModalOpen(true);
  };

  const closeDeleteModal = () => {
    deleteTargetPath = null;
    deleteTargetType = null;
    setDeleteModalOpen(false);
  };

  const submitDeleteModal = () => {
    if (!deleteTargetPath) {
      return;
    }
    deps.postToNative({ type: "deleteItem", path: deleteTargetPath });
    closeDeleteModal();
  };

  const requestDeleteItem = (path: string, kind: "file" | "dir") => {
    const dirtyPaths = deps.getDirtyPaths();
    const hasDirtyAffected = Array.from(dirtyPaths).some((entryPath) => {
      if (entryPath === path) {
        return true;
      }
      return kind === "dir" ? entryPath.startsWith(`${path}/`) : false;
    });
    if (hasDirtyAffected) {
      const message = uiText(
        "There are unsaved changes. Please save before deleting.",
        "There are unsaved changes. Please save before deleting."
      );
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    if (deleteModal instanceof HTMLElement) {
      openDeleteModal(path, kind);
      return;
    }
    deps.postToNative({ type: "deleteItem", path });
  };

  const requestCopyItem = (path: string, destination: string) => {
    deps.postToNative({ type: "copyItem", path, destination });
  };

  const requestUndoFileOperation = () => {
    deps.postToNative({ type: "undoFileOperation" });
  };

  const requestMoveItem = (payload: DragPayload, targetFolder: string) => {
    if (!deps.getWorkspaceRootKey()) {
      const message = uiText("Please select a folder at startup.", "起動時にフォルダを選択してください。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    const currentParent = getParentPath(payload.path);
    if (currentParent === targetFolder) {
      return;
    }
    if (!canDropOnFolder(payload, targetFolder)) {
      const message = uiText("The destination is invalid.", "移動先が不正です。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
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
      const message = uiText(
        "There are unsaved changes. Please save before moving.",
        "There are unsaved changes. Please save before moving."
      );
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
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
      const message = uiText("The destination is invalid.", "移動先が不正です。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
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

  const buildFileContextMenu = (path: string): ContextMenuItem[] => [
    {
      type: "action",
      label: uiText("Open", "open"),
      action: () => {
        deps.requestOpenFile(path, deps.getActiveEditorGroupKey());
      },
    },
    {
      type: "action",
      label: uiText("New file...", "新しいファイル..."),
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "file";
        requestCreate("file");
      },
    },
    {
      type: "action",
      label: uiText("New folder...", "新しいフォルダー..."),
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "file";
        requestCreate("folder");
      },
    },
    {
      type: "action",
      label: uiText("Show in Finder", "Finderで表示"),
      action: () => requestRevealInFinder(path),
    },
    {
      type: "action",
      label: uiText("Open in terminal", "open in terminal"),
      action: () => requestOpenInTerminal(path),
    },
    { type: "separator" },
    {
      type: "action",
      label: uiText("Rename...", "名前の変更..."),
      action: () => openRenameModal(path, "file"),
    },
    {
      type: "action",
      label: uiText("Delete", "削除"),
      danger: true,
      action: () => requestDeleteItem(path, "file"),
    },
  ];

  const buildFolderContextMenu = (path: string): ContextMenuItem[] => [
    {
      type: "action",
      label: uiText("New file...", "新しいファイル..."),
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "dir";
        requestCreate("file");
      },
    },
    {
      type: "action",
      label: uiText("New folder...", "新しいフォルダー..."),
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "dir";
        requestCreate("folder");
      },
    },
    {
      type: "action",
      label: uiText("Show in Finder", "Finderで表示"),
      action: () => requestRevealInFinder(path),
    },
    {
      type: "action",
      label: uiText("Open in terminal", "open in terminal"),
      action: () => requestOpenInTerminal(path),
    },
    { type: "separator" },
    {
      type: "action",
      label: uiText("Rename...", "名前の変更..."),
      action: () => openRenameModal(path, "dir"),
    },
    {
      type: "action",
      label: uiText("Delete", "削除"),
      danger: true,
      action: () => requestDeleteItem(path, "dir"),
    },
  ];

  const selectFolderSummary = (summary: HTMLElement, path: string) => {
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

  const getInitialFolderOpenState = (path: string, depth: number) =>
    openStateLoaded ? openFolders.has(path) : depth < 1;

  const toggleFolderOpen = (path: string, nextOpen: boolean) => {
    if (nextOpen) {
      openFolders.add(path);
    } else {
      openFolders.delete(path);
    }
    saveOpenState();
  };

  const getDragPayload = () => dragPayload;

  const setDragPayload = (payload: DragPayload | null) => {
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

  const handleRenameResult = (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => {
    const { oldPath, newPath } = payload;
    if (payload.isDirectory) {
      const updated = new Set<string>();
      openFolders.forEach((entry) => {
        if (entry === oldPath || entry.startsWith(`${oldPath}/`)) {
          updated.add(newPath + entry.slice(oldPath.length));
        } else {
          updated.add(entry);
        }
      });
      openFolders = updated;
      saveOpenState();
      if (selectedTreePath) {
        if (selectedTreePath === oldPath || selectedTreePath.startsWith(`${oldPath}/`)) {
          selectedTreePath = newPath + selectedTreePath.slice(oldPath.length);
        }
      }
    }
    if (!payload.isDirectory && selectedTreePath === oldPath) {
      selectedTreePath = newPath;
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
      } else if (event.key === "Escape") {
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
      } else if (event.key === "Escape") {
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

  if (deleteModalCancel instanceof HTMLButtonElement) {
    deleteModalCancel.addEventListener("click", () => {
      closeDeleteModal();
    });
  }

  if (deleteModalSubmit instanceof HTMLButtonElement) {
    deleteModalSubmit.addEventListener("click", () => {
      submitDeleteModal();
    });
  }

  if (deleteModal instanceof HTMLElement) {
    deleteModal.addEventListener("click", (event) => {
      if (event.target === deleteModal) {
        closeDeleteModal();
      }
    });
    deleteModal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDeleteModal();
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
      const dragEvent = event as DragEvent;
      const payload = dragPayload ?? getDragData(dragEvent);
      if (!payload) {
        return;
      }
      if (!canDropOnFolder(payload, "")) {
        return;
      }
      const target = dragEvent.target as HTMLElement | null;
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
      const dragEvent = event as DragEvent;
      const payload = dragPayload ?? getDragData(dragEvent);
      dragEvent.preventDefault();
      fileTree.classList.remove("is-drop-target");
      if (!payload) {
        return;
      }
      const target = dragEvent.target as HTMLElement | null;
      if (target && target.closest(".file-item, summary, .file-folder-children")) {
        return;
      }
      requestMoveItem(payload, "");
    });
  }

  window.addEventListener("keydown", (event) => {
    const targetElement = event.target as HTMLElement | null;
    const isTreeShortcutTarget =
      treeHasFocus &&
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
