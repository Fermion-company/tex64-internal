import type { AppContext } from "./context.js";

export type AlchemyItemKind = "math" | "table" | "figure" | "text";

export type AlchemyPreview =
  | { type: "latex"; value: string }
  | { type: "text"; value: string }
  | { type: "image"; url: string }
  | { type: "table"; headers?: string[]; rows: string[][] };

export type AlchemyItem = {
  id: string;
  kind: AlchemyItemKind;
  tag?: string;
  score?: number | string | null;
  preview: AlchemyPreview;
  snippet?: string;
  formats: string[];
  format: string;
  mode?: string;
  modeOptions?: string[];
  status?: "ready" | "processing" | "error";
};

export type AlchemySettings = {
  defaultMath: string;
  defaultTable: string;
  defaultFigure: string;
  ocrLanguage: string;
  pdfMode: string;
  shortcut: string;
};

type AlchemyPreviewDeps = {
  onApplyItem?: (id: string) => void;
  onDiscardItem?: (id: string) => void;
  onApplyAll?: () => void;
  onDiscardAll?: () => void;
  onClose?: () => void;
  onFormatChange?: (id: string, format: string) => void;
  onModeChange?: (id: string, mode: string) => void;
  onEditItem?: (id: string) => Promise<string>;
  onApplyEditedSnippet?: (id: string, snippet: string) => void;
  onInputPayload?: (payload: {
    html?: string;
    text?: string;
    imageDataUrl?: string;
    pdfBase64?: string;
  }) => void;
  onClipboardImport?: () => void;
  onCaptureRequest?: () => void;
  onOpenChange?: (open: boolean) => void;
  onItemSelect?: (id: string) => void;
  onShortcutSave?: (shortcut: string) => void;
  onSettingsChange?: (settings: AlchemySettings) => void;
  onSettingsToggle?: (open: boolean) => void;
};

export type AlchemyPreviewApi = {
  setOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setItems: (items: AlchemyItem[]) => void;
  clearItems: () => void;
  setActiveItem: (id: string | null) => void;
  setSettings: (settings: Partial<AlchemySettings>) => void;
  getSettings: () => AlchemySettings;
  setHandlers: (handlers: AlchemyPreviewDeps) => void;
};

const buildScoreLabel = (score?: number | string | null) => {
  if (score === null || score === undefined) return "";
  if (typeof score === "number") {
    return `${Math.round(score)}%`;
  }
  return String(score);
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

export const initAlchemyPreviewUi = (
  context: AppContext,
  deps: AlchemyPreviewDeps = {}
): AlchemyPreviewApi => {
  const {
    alchemyPanel,
    alchemySettingsButton,
    alchemySettings,
    alchemyClose,
    alchemyCaptureButton,
    alchemyPasteBox,
    alchemyPasteRun,
    alchemyClipboardRun,
    alchemyPasteStatus,
    alchemyFileInput,
    alchemyFilePick,
    alchemyFileRun,
    alchemyFileName,
    alchemyEditModal,
    alchemyEditTextarea,
    alchemyEditApply,
    alchemyEditCancel,
    alchemyEmpty,
    alchemyList,
    alchemyItemTemplate,
    alchemyDefaultMath,
    alchemyDefaultTable,
    alchemyDefaultFigure,
    alchemyOcrLanguage,
    alchemyPdfMode,
    alchemyShortcutInput,
    alchemyShortcutSave,
    alchemyDiscard,
    alchemyApply,
    alchemyApplyAll,
  } = context.dom;

  let activeId: string | null = null;
  let items: AlchemyItem[] = [];
  let settingsOpen = false;
  let panelOpen = false;
  let pendingPastePayload: {
    html?: string;
    text?: string;
    imageDataUrl?: string;
    pdfBase64?: string;
  } | null = null;
  let pendingFile: File | null = null;
  let editingId: string | null = null;
  let handlers: AlchemyPreviewDeps = { ...deps };

  const setOpen = (open: boolean) => {
    const wasOpen = panelOpen;
    panelOpen = open;
    if (!(alchemyPanel instanceof HTMLElement)) {
      return;
    }
    alchemyPanel.classList.toggle("is-open", open);
    alchemyPanel.setAttribute("aria-hidden", "false");
    if (wasOpen !== open) {
      handlers.onOpenChange?.(open);
    }
  };

  const setSettingsOpen = (open: boolean) => {
    settingsOpen = open;
    if (alchemySettings instanceof HTMLElement) {
      alchemySettings.classList.toggle("is-open", open);
      alchemySettings.setAttribute("aria-hidden", open ? "false" : "true");
    }
    handlers.onSettingsToggle?.(open);
  };

  const setEditModalOpen = (open: boolean) => {
    if (!(alchemyEditModal instanceof HTMLElement)) {
      return;
    }
    alchemyEditModal.classList.toggle("is-open", open);
    alchemyEditModal.setAttribute("aria-hidden", open ? "false" : "true");
    if (!open) {
      editingId = null;
      if (alchemyEditTextarea instanceof HTMLTextAreaElement) {
        alchemyEditTextarea.value = "";
      }
    }
  };

  const setActiveItem = (id: string | null) => {
    activeId = id;
    if (!(alchemyList instanceof HTMLElement)) {
      return;
    }
    const entries = Array.from(alchemyList.querySelectorAll<HTMLElement>(".alchemy-item"));
    entries.forEach((entry) => {
      const isActive = entry.dataset.id === id;
      entry.classList.toggle("is-active", isActive);
    });
    if (id) {
      handlers.onItemSelect?.(id);
    }
  };

  const renderTablePreview = (tableEl: HTMLTableElement, preview: AlchemyPreview) => {
    tableEl.innerHTML = "";
    if (preview.type !== "table") {
      return;
    }
    if (preview.headers && preview.headers.length > 0) {
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      preview.headers.forEach((header) => {
        const cell = document.createElement("th");
        cell.textContent = header;
        headerRow.appendChild(cell);
      });
      thead.appendChild(headerRow);
      tableEl.appendChild(thead);
    }
    const tbody = document.createElement("tbody");
    preview.rows.forEach((row) => {
      const rowEl = document.createElement("tr");
      row.forEach((cellText) => {
        const cell = document.createElement("td");
        cell.textContent = cellText;
        rowEl.appendChild(cell);
      });
      tbody.appendChild(rowEl);
    });
    tableEl.appendChild(tbody);
  };

  const renderPreview = (root: HTMLElement, preview: AlchemyPreview) => {
    const previewNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-preview]"));
    previewNodes.forEach((node) => {
      node.hidden = true;
    });
    const showNode = (selector: string, writer: (node: HTMLElement) => void) => {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) return;
      node.hidden = false;
      writer(node);
    };
    switch (preview.type) {
      case "latex":
        showNode('[data-preview="latex"]', (node) => {
          const text = node.querySelector<HTMLElement>(".alchemy-preview-latex");
          if (text) text.textContent = preview.value;
        });
        break;
      case "text":
        showNode('[data-preview="text"]', (node) => {
          node.textContent = preview.value;
        });
        break;
      case "image":
        showNode('[data-preview="image"]', (node) => {
          node.style.backgroundImage = `url("${preview.url}")`;
          node.style.backgroundSize = "cover";
          node.style.backgroundPosition = "center";
        });
        break;
      case "table":
        showNode('[data-preview="table"]', (node) => {
          renderTablePreview(node as HTMLTableElement, preview);
        });
        break;
      default:
        break;
    }
  };

  const renderItems = () => {
    if (!(alchemyList instanceof HTMLElement)) {
      return;
    }
    alchemyList.textContent = "";
    items.forEach((item) => {
      const template =
        alchemyItemTemplate instanceof HTMLTemplateElement
          ? alchemyItemTemplate
          : null;
      if (!template) {
        return;
      }
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      const root = fragment.querySelector<HTMLElement>(".alchemy-item");
      if (!root) {
        return;
      }
      root.dataset.id = item.id;
      root.dataset.kind = item.kind;
      if (item.status === "processing") {
        root.classList.add("is-processing");
      }
      if (item.status === "error") {
        root.classList.add("is-error");
      }
      const kindEl = root.querySelector<HTMLElement>(".alchemy-item-kind");
      if (kindEl) kindEl.textContent = item.kind;
      const tagEl = root.querySelector<HTMLElement>(".alchemy-item-tag");
      if (tagEl) tagEl.textContent = item.tag ?? "";
      const scoreEl = root.querySelector<HTMLElement>(".alchemy-item-score");
      if (scoreEl) scoreEl.textContent = buildScoreLabel(item.score);
      renderPreview(root, item.preview);
      const snippetEl = root.querySelector<HTMLTextAreaElement>("[data-role='snippet']");
      if (snippetEl) {
        if (item.snippet) {
          snippetEl.value = item.snippet;
        } else if (item.status === "processing") {
          snippetEl.value = "生成中...";
        } else {
          snippetEl.value = "";
        }
      }
      const modeSelect = root.querySelector<HTMLSelectElement>("[data-role='mode']");
      if (modeSelect) {
        if (item.modeOptions && item.modeOptions.length > 0) {
          modeSelect.hidden = false;
          modeSelect.textContent = "";
          item.modeOptions.forEach((mode) => {
            const option = document.createElement("option");
            option.value = mode;
            option.textContent = mode;
            modeSelect.appendChild(option);
          });
          const fallbackMode = item.modeOptions[0] ?? "";
          ensureSelectValue(modeSelect, item.mode ?? fallbackMode);
        } else {
          modeSelect.hidden = true;
          modeSelect.textContent = "";
        }
      }
      const select = root.querySelector<HTMLSelectElement>("[data-role='format']");
      if (select) {
        select.textContent = "";
        const formats = item.formats.length > 0 ? item.formats : [item.format];
        formats.forEach((format) => {
          const option = document.createElement("option");
          option.value = format;
          option.textContent = format;
          select.appendChild(option);
        });
        ensureSelectValue(select, item.format);
      }
      if (item.id === activeId) {
        root.classList.add("is-active");
      }
      alchemyList.appendChild(fragment);
    });
    if (alchemyPanel instanceof HTMLElement) {
      alchemyPanel.classList.toggle("has-items", items.length > 0);
    }
    if (alchemyEmpty instanceof HTMLElement) {
      alchemyEmpty.toggleAttribute("hidden", items.length > 0);
    }
  };

  const setItems = (nextItems: AlchemyItem[]) => {
    items = nextItems;
    if (activeId && !items.some((item) => item.id === activeId)) {
      activeId = null;
    }
    if (!activeId && items.length > 0) {
      activeId = items[0].id;
    }
    renderItems();
  };

  const clearItems = () => {
    items = [];
    activeId = null;
    renderItems();
  };

  const setSettings = (settings: Partial<AlchemySettings>) => {
    if (settings.defaultMath) {
      ensureSelectValue(alchemyDefaultMath as HTMLSelectElement | null, settings.defaultMath);
    }
    if (settings.defaultTable) {
      ensureSelectValue(alchemyDefaultTable as HTMLSelectElement | null, settings.defaultTable);
    }
    if (settings.defaultFigure) {
      ensureSelectValue(
        alchemyDefaultFigure as HTMLSelectElement | null,
        settings.defaultFigure
      );
    }
    if (settings.ocrLanguage) {
      ensureSelectValue(alchemyOcrLanguage as HTMLSelectElement | null, settings.ocrLanguage);
    }
    if (settings.pdfMode) {
      ensureSelectValue(alchemyPdfMode as HTMLSelectElement | null, settings.pdfMode);
    }
    if (settings.shortcut && alchemyShortcutInput instanceof HTMLInputElement) {
      alchemyShortcutInput.value = settings.shortcut;
    }
  };

  const getSettings = (): AlchemySettings => ({
    defaultMath:
      (alchemyDefaultMath instanceof HTMLSelectElement && alchemyDefaultMath.value) ||
      "display",
    defaultTable:
      (alchemyDefaultTable instanceof HTMLSelectElement && alchemyDefaultTable.value) ||
      "tabular",
    defaultFigure:
      (alchemyDefaultFigure instanceof HTMLSelectElement && alchemyDefaultFigure.value) ||
      "includegraphics",
    ocrLanguage:
      (alchemyOcrLanguage instanceof HTMLSelectElement && alchemyOcrLanguage.value) ||
      "jpn+eng",
    pdfMode:
      (alchemyPdfMode instanceof HTMLSelectElement && alchemyPdfMode.value) || "Auto",
    shortcut:
      (alchemyShortcutInput instanceof HTMLInputElement && alchemyShortcutInput.value) ||
      "Ctrl+Shift+2",
  });

  if (alchemySettingsButton instanceof HTMLElement) {
    alchemySettingsButton.addEventListener("click", () => {
      setSettingsOpen(!settingsOpen);
    });
  }

  const emitSettingsChange = () => {
    handlers.onSettingsChange?.(getSettings());
  };

  const setPasteStatus = (message: string) => {
    if (alchemyPasteStatus instanceof HTMLElement) {
      alchemyPasteStatus.textContent = message;
    }
  };

  const resetPasteInput = () => {
    pendingPastePayload = null;
    if (alchemyPasteBox instanceof HTMLElement) {
      alchemyPasteBox.textContent = "";
    }
    setPasteStatus("");
  };

  const resetFileInput = () => {
    pendingFile = null;
    if (alchemyFileInput instanceof HTMLInputElement) {
      alchemyFileInput.value = "";
    }
    if (alchemyFileName instanceof HTMLElement) {
      alchemyFileName.textContent = "未選択";
    }
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
      reader.readAsDataURL(file);
    });

  const readFileAsText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("テキストの読み込みに失敗しました。"));
      reader.readAsText(file);
    });

  const readFileAsArrayBuffer = (file: File) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
      reader.readAsArrayBuffer(file);
    });

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const getImageMimeFromName = (name: string) => {
    const match = name.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i);
    if (!match) return null;
    const ext = match[1].toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "svg") return "image/svg+xml";
    return `image/${ext}`;
  };

  const buildPayloadFromFile = async (file: File) => {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();
    const imageMime = type.startsWith("image/") ? type : getImageMimeFromName(name);
    if (imageMime) {
      const buffer = await readFileAsArrayBuffer(file);
      return { imageDataUrl: `data:${imageMime};base64,${arrayBufferToBase64(buffer)}` };
    }
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      const buffer = await readFileAsArrayBuffer(file);
      return { pdfBase64: arrayBufferToBase64(buffer) };
    }
    if (type === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) {
      const html = await readFileAsText(file);
      return { html };
    }
    const text = await readFileAsText(file);
    return { text };
  };

  const processFile = (file: File) => {
    void buildPayloadFromFile(file)
      .then((payload) => {
        handlers.onInputPayload?.(payload);
        resetFileInput();
      })
      .catch(() => {
        handlers.onInputPayload?.({});
      });
  };

  const buildPayloadFromClipboard = async (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return null;
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    const payload: {
      html?: string;
      text?: string;
      imageDataUrl?: string;
      pdfBase64?: string;
    } = {};
    if (html) payload.html = html;
    if (text) payload.text = text;
    const items = Array.from(data.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        payload.imageDataUrl = await readFileAsDataUrl(file);
      }
    }
    const pdfItem = items.find((item) => item.type.includes("pdf"));
    if (pdfItem) {
      const file = pdfItem.getAsFile();
      if (file) {
        const buffer = await readFileAsArrayBuffer(file);
        payload.pdfBase64 = arrayBufferToBase64(buffer);
      }
    }
    return payload;
  };

  if (alchemyDefaultMath instanceof HTMLSelectElement) {
    alchemyDefaultMath.addEventListener("change", emitSettingsChange);
  }

  if (alchemyDefaultTable instanceof HTMLSelectElement) {
    alchemyDefaultTable.addEventListener("change", emitSettingsChange);
  }

  if (alchemyDefaultFigure instanceof HTMLSelectElement) {
    alchemyDefaultFigure.addEventListener("change", emitSettingsChange);
  }

  if (alchemyOcrLanguage instanceof HTMLSelectElement) {
    alchemyOcrLanguage.addEventListener("change", emitSettingsChange);
  }

  if (alchemyPdfMode instanceof HTMLSelectElement) {
    alchemyPdfMode.addEventListener("change", emitSettingsChange);
  }

  if (alchemyCaptureButton instanceof HTMLElement) {
    alchemyCaptureButton.addEventListener("click", () => {
      handlers.onCaptureRequest?.();
    });
  }

  if (alchemyPasteBox instanceof HTMLElement) {
    alchemyPasteBox.addEventListener("paste", (event) => {
      event.preventDefault();
      void buildPayloadFromClipboard(event).then((payload) => {
        if (!payload) {
          return;
        }
        // Auto-submit on paste for "Magic" feel
        handlers.onInputPayload?.(payload);
        resetPasteInput();
      });
    });

    // Handle Drag & Drop
    alchemyPasteBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      alchemyPasteBox.style.background = "rgba(121, 126, 249, 0.1)";
    });

    alchemyPasteBox.addEventListener("dragleave", (e) => {
      e.preventDefault();
      alchemyPasteBox.style.background = "";
    });

    alchemyPasteBox.addEventListener("drop", (e) => {
      e.preventDefault();
      alchemyPasteBox.style.background = "";
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        processFile(files[0]);
      }
    });

    // Handle Enter to submit text / URLs
    alchemyPasteBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = alchemyPasteBox.innerText.trim();
        if (text) {
          handlers.onInputPayload?.({ text });
          resetPasteInput();
        }
      }
    });
  }

  if (alchemyPasteRun instanceof HTMLElement) {
    alchemyPasteRun.addEventListener("click", () => {
      const payload: {
        html?: string;
        text?: string;
        imageDataUrl?: string;
        pdfBase64?: string;
      } = { ...(pendingPastePayload ?? {}) };
      if (!pendingPastePayload && alchemyPasteBox instanceof HTMLElement) {
        const text = alchemyPasteBox.textContent?.trim() ?? "";
        if (text) {
          payload.text = text;
        }
      }
      handlers.onInputPayload?.(payload);
      resetPasteInput();
    });
  }

  if (alchemyClipboardRun instanceof HTMLElement) {
    alchemyClipboardRun.addEventListener("click", () => {
      handlers.onClipboardImport?.();
    });
  }

  if (alchemyFilePick instanceof HTMLElement) {
    alchemyFilePick.addEventListener("click", () => {
      if (alchemyFileInput instanceof HTMLInputElement) {
        alchemyFileInput.click();
      }
    });
  }

  if (alchemyFileInput instanceof HTMLInputElement) {
    alchemyFileInput.addEventListener("change", () => {
      const file = alchemyFileInput.files?.[0];
      if (file) {
        processFile(file);
      }
      // Reset value to allow selecting same file again
      alchemyFileInput.value = "";
    });
  }



  if (alchemyClose instanceof HTMLElement) {
    alchemyClose.addEventListener("click", () => {
      setOpen(false);
      deps.onClose?.();
    });
  }

  if (alchemyList instanceof HTMLElement) {
    alchemyList.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>("[data-action]");
      if (actionButton) {
        const itemEl = actionButton.closest<HTMLElement>(".alchemy-item");
        const itemId = itemEl?.dataset.id;
        if (!itemId) return;
        if (actionButton.dataset.action === "apply") {
          handlers.onApplyItem?.(itemId);
        } else if (actionButton.dataset.action === "discard") {
          handlers.onDiscardItem?.(itemId);
        } else if (actionButton.dataset.action === "edit") {
          handlers
            .onEditItem?.(itemId)
            .then((snippet) => {
              if (!(alchemyEditTextarea instanceof HTMLTextAreaElement)) {
                return;
              }
              editingId = itemId;
              alchemyEditTextarea.value = snippet;
              setEditModalOpen(true);
              alchemyEditTextarea.focus();
            })
            .catch(() => {});
        }
        return;
      }
      const itemEl = target.closest<HTMLElement>(".alchemy-item");
      if (!itemEl) return;
      const itemId = itemEl.dataset.id ?? null;
      setActiveItem(itemId);
    });

    alchemyList.addEventListener("change", (event) => {
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLSelectElement)) return;
      const itemEl = target.closest<HTMLElement>(".alchemy-item");
      const itemId = itemEl?.dataset.id;
      if (!itemId) return;
      if (target.dataset.role === "format") {
        handlers.onFormatChange?.(itemId, target.value);
      } else if (target.dataset.role === "mode") {
        handlers.onModeChange?.(itemId, target.value);
      }
    });
  }

  if (alchemyShortcutSave instanceof HTMLElement) {
    alchemyShortcutSave.addEventListener("click", () => {
      if (!(alchemyShortcutInput instanceof HTMLInputElement)) return;
      handlers.onShortcutSave?.(alchemyShortcutInput.value);
    });
  }

  if (alchemyApply instanceof HTMLElement) {
    alchemyApply.addEventListener("click", () => {
      if (!activeId) return;
      handlers.onApplyItem?.(activeId);
    });
  }

  if (alchemyDiscard instanceof HTMLElement) {
    alchemyDiscard.addEventListener("click", () => handlers.onDiscardAll?.());
  }

  if (alchemyApplyAll instanceof HTMLElement) {
    alchemyApplyAll.addEventListener("click", () => handlers.onApplyAll?.());
  }

  if (alchemyEditCancel instanceof HTMLElement) {
    alchemyEditCancel.addEventListener("click", () => {
      setEditModalOpen(false);
    });
  }

  if (alchemyEditApply instanceof HTMLElement) {
    alchemyEditApply.addEventListener("click", () => {
      if (!editingId) {
        setEditModalOpen(false);
        return;
      }
      if (!(alchemyEditTextarea instanceof HTMLTextAreaElement)) {
        setEditModalOpen(false);
        return;
      }
      handlers.onApplyEditedSnippet?.(editingId, alchemyEditTextarea.value);
      setEditModalOpen(false);
    });
  }

  return {
    setOpen,
    setSettingsOpen,
    setItems,
    clearItems,
    setActiveItem,
    setSettings,
    getSettings,
    setHandlers: (next) => {
      handlers = { ...handlers, ...next };
    },
  };
};
