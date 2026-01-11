import { formatSnippetForInsert } from "./blocks/format.js";
import { buildTextSnippet } from "./snippet-builders.js";
import { recognizeImage } from "./ocr.js";
const ensureSelectValue = (select, value) => {
    if (!select)
        return;
    const options = Array.from(select.options);
    if (!options.some((option) => option.value === value)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    }
    select.value = value;
};
export const initAlchemyConvert = (context, deps) => {
    const { alchemyPanel, alchemySettingsButton, alchemySettings, alchemyCaptureButton, alchemyStatusLine, alchemyOcrLanguage, } = context.dom;
    const dropZone = document.getElementById("alchemy-drop-zone");
    const fileInput = document.getElementById("alchemy-file-input");
    const boardList = document.getElementById("alchemy-board-list");
    const itemTemplate = document.getElementById("alchemy-board-item-template");
    let settingsOpen = false;
    let busy = false;
    let captureItems = [];
    const setStatus = (message) => {
        if (alchemyStatusLine instanceof HTMLElement) {
            alchemyStatusLine.textContent = message;
            // Also show in status bar or console if hidden
        }
    };
    const setBusy = (value) => {
        busy = value;
        if (alchemyCaptureButton instanceof HTMLButtonElement) {
            alchemyCaptureButton.disabled = value;
        }
        if (dropZone) {
            dropZone.style.pointerEvents = value ? "none" : "auto";
            dropZone.style.opacity = value ? "0.5" : "1";
        }
    };
    const getSettings = () => ({
        ocrLanguage: (alchemyOcrLanguage instanceof HTMLSelectElement && alchemyOcrLanguage.value) ||
            "jpn+eng",
    });
    const setSettings = (settings) => {
        if (settings.ocrLanguage) {
            ensureSelectValue(alchemyOcrLanguage, settings.ocrLanguage);
        }
    };
    const emitSettingsChange = () => {
        var _a;
        (_a = deps.onSettingsChange) === null || _a === void 0 ? void 0 : _a.call(deps, getSettings());
    };
    // --- Board Logic ---
    const loadItems = () => {
        try {
            const stored = localStorage.getItem("tex64_capture_board");
            if (stored) {
                captureItems = JSON.parse(stored);
            }
        }
        catch (e) {
            console.error("Failed to load capture board", e);
        }
        renderBoard();
    };
    const saveItems = () => {
        try {
            // Limit storage size if needed, for now just save
            localStorage.setItem("tex64_capture_board", JSON.stringify(captureItems));
        }
        catch (e) {
            console.error("Failed to save capture board", e);
            setStatus("保存容量が一杯です。古いアイテムを削除してください。");
        }
    };
    const addItem = (image, text) => {
        const item = {
            id: crypto.randomUUID(),
            image,
            text,
            timestamp: Date.now(),
        };
        captureItems.unshift(item); // Add to top
        saveItems();
        renderBoard();
    };
    const deleteItem = (id) => {
        captureItems = captureItems.filter((i) => i.id !== id);
        saveItems();
        renderBoard();
    };
    const insertSnippet = (snippet) => {
        var _a, _b, _c;
        const activeGroup = deps.editorSession.getActiveGroup();
        if (!activeGroup.editor ||
            !activeGroup.currentFilePath ||
            !activeGroup.currentFilePath.endsWith(".tex")) {
            deps.updateIssues(1, "貼り付けは .tex ファイルで行ってください。", "error", [
                { severity: "error", message: "貼り付けは .tex ファイルで行ってください。" },
            ]);
            return false;
        }
        // Check editor readiness
        const editor = activeGroup.editor;
        const monaco = deps.getMonacoApi();
        if (!(monaco === null || monaco === void 0 ? void 0 : monaco.Range) || !editor.getModel) {
            deps.updateIssues(1, "エディタの準備が完了していません。", "error", []);
            return false;
        }
        const selection = (_a = editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
        const position = (_c = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : { lineNumber: 1, column: 1 };
        const insertPosition = selection
            ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
            : position;
        const model = editor.getModel();
        if (!model)
            return false;
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
        if (!boardList || !itemTemplate)
            return;
        boardList.textContent = "";
        captureItems.forEach((item) => {
            const fragment = itemTemplate.content.cloneNode(true);
            const root = fragment.querySelector(".alchemy-board-item");
            const thumb = root.querySelector(".alchemy-item-thumb");
            thumb.style.backgroundImage = `url("${item.image}")`;
            const textEl = root.querySelector(".alchemy-item-text");
            textEl.textContent = item.text || "(テキストなし)";
            textEl.title = item.text;
            const deleteBtn = root.querySelector(".action-delete");
            deleteBtn === null || deleteBtn === void 0 ? void 0 : deleteBtn.addEventListener("click", () => deleteItem(item.id));
            const insertBtn = root.querySelector(".action-insert");
            insertBtn === null || insertBtn === void 0 ? void 0 : insertBtn.addEventListener("click", () => {
                const snippet = buildTextSnippet(item.text, "plain"); // or detect math
                if (snippet)
                    insertSnippet(snippet);
            });
            boardList.appendChild(fragment);
        });
    };
    // --- Capture & OCR Handler ---
    const handleCaptureImage = (imageDataUrl) => {
        if (busy)
            return;
        if (!imageDataUrl) {
            setStatus("画像がありません。");
            return;
        }
        setBusy(true);
        setStatus("解析中...");
        const settings = getSettings();
        recognizeImage(imageDataUrl, { language: settings.ocrLanguage || "eng" })
            .then((result) => {
            var _a, _b;
            const text = (_b = (_a = result.text) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            if (!text) {
                setStatus("文字を検出できませんでした。");
            }
            else {
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
            var _a;
            e.preventDefault();
            dropZone.style.borderColor = "";
            dropZone.style.background = "";
            const files = (_a = e.dataTransfer) === null || _a === void 0 ? void 0 : _a.files;
            if (files && files.length > 0) {
                handleFile(files[0]);
            }
        });
        dropZone.addEventListener("click", () => {
            fileInput === null || fileInput === void 0 ? void 0 : fileInput.click();
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
    const handleFile = (file) => {
        if (!file.type.startsWith("image/")) {
            setStatus("対応していないファイル形式です（画像のみ）");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            var _a;
            const dataUrl = (_a = e.target) === null || _a === void 0 ? void 0 : _a.result;
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
            var _a;
            (_a = deps.onCaptureRequest) === null || _a === void 0 ? void 0 : _a.call(deps);
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
