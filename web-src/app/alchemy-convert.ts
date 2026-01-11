import type { AppContext } from "./context.js";
import type { EditorSessionApi } from "./editor-session.js";
import type { IssuesStatus, IssueItem } from "./types.js";
import type { PendingBlockApply } from "./blocks/types.js";
import { formatSnippetForInsert } from "./blocks/format.js";
import { buildTextSnippet } from "./snippet-builders.js";
import { recognizeImage } from "./ocr.js";

export type AlchemySettings = {
  ocrLanguage: string;
};

type CaptureItem = {
  id: string;
  image: string; // Data URL
  text: string;
  timestamp: number;
};

type AlchemyConvertDeps = {
  editorSession: EditorSessionApi;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  getMonacoApi: () => Record<string, unknown> | null;
  onSettingsChange?: (settings: AlchemySettings) => void;
  onCaptureRequest?: () => void;
  setPendingBlockApply: (payload: PendingBlockApply) => void;
  showDiffModal: (
    original: string,
    modified: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => void;
};

export type AlchemyConvertApi = {
  setSettings: (settings: Partial<AlchemySettings>) => void;
  getSettings: () => AlchemySettings;
  handleCaptureImage: (imageDataUrl: string) => void;
  setStatus: (message: string) => void;
};

const ensureSelectValue = (select: HTMLSelectElement | null, value: string) => {
  if (!select) return;
  const options = Array.from(select.options);
  if (!options.some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = value;
};

export const initAlchemyConvert = (
  context: AppContext,
  deps: AlchemyConvertDeps
): AlchemyConvertApi => {
  const {
    alchemyPanel,
    alchemySettingsButton,
    alchemySettings,
    alchemyCaptureButton,
    alchemyStatusLine,
    alchemyOcrLanguage,
  } = context.dom;

  const dropZone = document.getElementById("alchemy-drop-zone");
  const fileInput = document.getElementById("alchemy-file-input") as HTMLInputElement | null;
  const boardList = document.getElementById("alchemy-board-list");
  const itemTemplate = document.getElementById("alchemy-board-item-template") as HTMLTemplateElement | null;

  let settingsOpen = false;
  let busy = false;
  let captureItems: CaptureItem[] = [];

  const setStatus = (message: string) => {
    if (alchemyStatusLine instanceof HTMLElement) {
      alchemyStatusLine.textContent = message;
      // Also show in status bar or console if hidden
    }
  };

  const setBusy = (value: boolean) => {
    busy = value;
    if (alchemyCaptureButton instanceof HTMLButtonElement) {
      alchemyCaptureButton.disabled = value;
    }
    if (dropZone) {
      dropZone.style.pointerEvents = value ? "none" : "auto";
      dropZone.style.opacity = value ? "0.5" : "1";
    }
  };

  const getSettings = (): AlchemySettings => ({
    ocrLanguage:
      (alchemyOcrLanguage instanceof HTMLSelectElement && alchemyOcrLanguage.value) ||
      "jpn+eng",
  });

  const setSettings = (settings: Partial<AlchemySettings>) => {
    if (settings.ocrLanguage) {
      ensureSelectValue(alchemyOcrLanguage as HTMLSelectElement | null, settings.ocrLanguage);
    }
  };

  const emitSettingsChange = () => {
    deps.onSettingsChange?.(getSettings());
  };

  // --- Board Logic ---

  const loadItems = () => {
    try {
      const stored = localStorage.getItem("tex64_capture_board");
      if (stored) {
        captureItems = JSON.parse(stored);
      }
    } catch (e) {
      console.error("Failed to load capture board", e);
    }
    renderBoard();
  };

  const saveItems = () => {
    try {
      // Limit storage size if needed, for now just save
      localStorage.setItem("tex64_capture_board", JSON.stringify(captureItems));
    } catch (e) {
      console.error("Failed to save capture board", e);
      setStatus("保存容量が一杯です。古いアイテムを削除してください。");
    }
  };

  const addItem = (image: string, text: string) => {
    const item: CaptureItem = {
      id: crypto.randomUUID(),
      image,
      text,
      timestamp: Date.now(),
    };
    captureItems.unshift(item); // Add to top
    saveItems();
    renderBoard();
  };

  const deleteItem = (id: string) => {
    captureItems = captureItems.filter((i) => i.id !== id);
    saveItems();
    renderBoard();
  };

  const insertSnippet = (snippet: string) => {
    const activeGroup = deps.editorSession.getActiveGroup();
    if (
      !activeGroup.editor ||
      !activeGroup.currentFilePath ||
      !activeGroup.currentFilePath.endsWith(".tex")
    ) {
      deps.updateIssues(1, "貼り付けは .tex ファイルで行ってください。", "error", [
        { severity: "error", message: "貼り付けは .tex ファイルで行ってください。" },
      ]);
      return false;
    }
    
    // Check editor readiness
    const editor = activeGroup.editor as any;
    const monaco = deps.getMonacoApi() as any;
    if (!monaco?.Range || !editor.getModel) {
       deps.updateIssues(1, "エディタの準備が完了していません。", "error", []);
       return false;
    }

    const selection = editor.getSelection?.();
    const position = editor.getPosition?.() ?? { lineNumber: 1, column: 1 };
    const insertPosition = selection
      ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
      : position;
    const model = editor.getModel();
    if (!model) return false;

    const formatted = formatSnippetForInsert(snippet, model, insertPosition);
    
    // Prepare for Diff Modal
    // We construct the "Modified" text by manually splicing the formatted snippet into the current file content.
    const originalText = model.getValue();
    
    // Calculate offset for splicing
    let offset = 0;
    if (model.getOffsetAt) {
        offset = model.getOffsetAt(insertPosition);
    }
    // If there is a selection, we typically overwrite it.
    // However, for simplicity in diff preview, let's just insert at cursor (or replace selection).
    // If selection exists, we should replace the selected range.
    let endOffset = offset;
    if (selection && model.getOffsetAt) {
         const startOff = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn });
         const endOff = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn });
         offset = Math.min(startOff, endOff);
         endOffset = Math.max(startOff, endOff);
    }

    const modifiedText = originalText.slice(0, offset) + formatted + originalText.slice(endOffset);

    // Set Pending State
    deps.setPendingBlockApply({
        mode: "new",
        draft: { snippet: formatted, content: { raw: snippet } },
        insertPosition: insertPosition,
    });

    // Show Diff Modal
    deps.showDiffModal(originalText, modifiedText, 0, {
        title: "取り込み内容の確認",
        submitLabel: "挿入",
        fileName: activeGroup.currentFilePath.split(/[/\\]/).pop()
    });

    return true;
  };

  const renderBoard = () => {
    if (!boardList || !itemTemplate) return;
    boardList.textContent = "";

    captureItems.forEach((item) => {
      const fragment = itemTemplate.content.cloneNode(true) as DocumentFragment;
      const root = fragment.querySelector(".alchemy-board-item") as HTMLElement;
      
      const thumb = root.querySelector(".alchemy-item-thumb") as HTMLElement;
      thumb.style.backgroundImage = `url("${item.image}")`;

      const textEl = root.querySelector(".alchemy-item-text") as HTMLElement;
      textEl.textContent = item.text || "(テキストなし)";
      textEl.title = item.text;

      const deleteBtn = root.querySelector(".action-delete");
      deleteBtn?.addEventListener("click", () => deleteItem(item.id));

      const insertBtn = root.querySelector(".action-insert");
      insertBtn?.addEventListener("click", () => {
         const snippet = buildTextSnippet(item.text, "plain"); // or detect math
         if (snippet) insertSnippet(snippet);
      });

      boardList.appendChild(fragment);
    });
  };

  // --- Capture & OCR Handler ---

  const handleCaptureImage = (imageDataUrl: string) => {
    if (busy) return;
    if (!imageDataUrl) {
      setStatus("画像がありません。");
      return;
    }
    setBusy(true);
    setStatus("解析中...");
    
    const settings = getSettings();
    recognizeImage(imageDataUrl, { language: settings.ocrLanguage || "eng" })
      .then((result) => {
        const text = result.text?.trim() ?? "";
        if (!text) {
          setStatus("文字を検出できませんでした。");
        } else {
          setStatus(""); // Clear status on success as requested
        }
        // Always add item even if empty text, user might want the image reference or retry
        addItem(imageDataUrl, text);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "解析失敗";
        setStatus(message);
        // Add item with error indication? Or just add image.
        addItem(imageDataUrl, "(解析失敗)");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // --- D&D Handlers ---

  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "var(--accent)";
      dropZone.style.background = "rgba(255,255,255,0.05)";
    });

    dropZone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "";
      dropZone.style.background = "";
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "";
      dropZone.style.background = "";
      
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFile(files[0]);
      }
    });

    dropZone.addEventListener("click", () => {
      fileInput?.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleFile(fileInput.files[0]);
        fileInput.value = ""; // Reset
      }
    });
  }

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setStatus("対応していないファイル形式です（画像のみ）");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (dataUrl) {
        handleCaptureImage(dataUrl);
      }
    };
    reader.readAsDataURL(file);
  };


  // --- Event Listeners ---

  if (alchemySettingsButton instanceof HTMLElement) {
    alchemySettingsButton.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      if (alchemySettings instanceof HTMLElement) {
        alchemySettings.classList.toggle("is-open", settingsOpen);
        alchemySettings.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
      }
    });
  }

  if (alchemyOcrLanguage instanceof HTMLSelectElement) {
    alchemyOcrLanguage.addEventListener("change", emitSettingsChange);
  }

  if (alchemyCaptureButton instanceof HTMLElement) {
    alchemyCaptureButton.addEventListener("click", () => {
      deps.onCaptureRequest?.();
    });
  }

  if (alchemyPanel instanceof HTMLElement) {
    alchemyPanel.classList.toggle("is-open", true);
  }

  // Initial load
  loadItems();

  return {
    setSettings,
    getSettings,
    handleCaptureImage,
    setStatus,
  };
};
