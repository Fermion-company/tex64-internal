const buildScoreLabel = (score) => {
    if (score === null || score === undefined)
        return "";
    if (typeof score === "number") {
        return `${Math.round(score)}%`;
    }
    return String(score);
};
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
export const initAlchemyPreviewUi = (context, deps = {}) => {
    const { alchemyPanel, alchemySettingsButton, alchemySettings, alchemyClose, alchemyCaptureButton, alchemyPasteBox, alchemyPasteRun, alchemyClipboardRun, alchemyPasteStatus, alchemyFileInput, alchemyFilePick, alchemyFileRun, alchemyFileName, alchemyEditModal, alchemyEditTextarea, alchemyEditApply, alchemyEditCancel, alchemyEmpty, alchemyList, alchemyItemTemplate, alchemyDefaultMath, alchemyDefaultTable, alchemyDefaultFigure, alchemyOcrLanguage, alchemyPdfMode, alchemyShortcutInput, alchemyShortcutSave, alchemyDiscard, alchemyApply, alchemyApplyAll, } = context.dom;
    let activeId = null;
    let items = [];
    let settingsOpen = false;
    let panelOpen = false;
    let pendingPastePayload = null;
    let pendingFile = null;
    let editingId = null;
    let handlers = { ...deps };
    const setOpen = (open) => {
        var _a;
        const wasOpen = panelOpen;
        panelOpen = open;
        if (!(alchemyPanel instanceof HTMLElement)) {
            return;
        }
        alchemyPanel.classList.toggle("is-open", open);
        alchemyPanel.setAttribute("aria-hidden", "false");
        if (wasOpen !== open) {
            (_a = handlers.onOpenChange) === null || _a === void 0 ? void 0 : _a.call(handlers, open);
        }
    };
    const setSettingsOpen = (open) => {
        var _a;
        settingsOpen = open;
        if (alchemySettings instanceof HTMLElement) {
            alchemySettings.classList.toggle("is-open", open);
            alchemySettings.setAttribute("aria-hidden", open ? "false" : "true");
        }
        (_a = handlers.onSettingsToggle) === null || _a === void 0 ? void 0 : _a.call(handlers, open);
    };
    const setEditModalOpen = (open) => {
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
    const setActiveItem = (id) => {
        var _a;
        activeId = id;
        if (!(alchemyList instanceof HTMLElement)) {
            return;
        }
        const entries = Array.from(alchemyList.querySelectorAll(".alchemy-item"));
        entries.forEach((entry) => {
            const isActive = entry.dataset.id === id;
            entry.classList.toggle("is-active", isActive);
        });
        if (id) {
            (_a = handlers.onItemSelect) === null || _a === void 0 ? void 0 : _a.call(handlers, id);
        }
    };
    const renderTablePreview = (tableEl, preview) => {
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
    const renderPreview = (root, preview) => {
        const previewNodes = Array.from(root.querySelectorAll("[data-preview]"));
        previewNodes.forEach((node) => {
            node.hidden = true;
        });
        const showNode = (selector, writer) => {
            const node = root.querySelector(selector);
            if (!node)
                return;
            node.hidden = false;
            writer(node);
        };
        switch (preview.type) {
            case "latex":
                showNode('[data-preview="latex"]', (node) => {
                    const text = node.querySelector(".alchemy-preview-latex");
                    if (text)
                        text.textContent = preview.value;
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
                    renderTablePreview(node, preview);
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
            var _a, _b, _c;
            const template = alchemyItemTemplate instanceof HTMLTemplateElement
                ? alchemyItemTemplate
                : null;
            if (!template) {
                return;
            }
            const fragment = template.content.cloneNode(true);
            const root = fragment.querySelector(".alchemy-item");
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
            const kindEl = root.querySelector(".alchemy-item-kind");
            if (kindEl)
                kindEl.textContent = item.kind;
            const tagEl = root.querySelector(".alchemy-item-tag");
            if (tagEl)
                tagEl.textContent = (_a = item.tag) !== null && _a !== void 0 ? _a : "";
            const scoreEl = root.querySelector(".alchemy-item-score");
            if (scoreEl)
                scoreEl.textContent = buildScoreLabel(item.score);
            renderPreview(root, item.preview);
            const snippetEl = root.querySelector("[data-role='snippet']");
            if (snippetEl) {
                if (item.snippet) {
                    snippetEl.value = item.snippet;
                }
                else if (item.status === "processing") {
                    snippetEl.value = "生成中...";
                }
                else {
                    snippetEl.value = "";
                }
            }
            const modeSelect = root.querySelector("[data-role='mode']");
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
                    const fallbackMode = (_b = item.modeOptions[0]) !== null && _b !== void 0 ? _b : "";
                    ensureSelectValue(modeSelect, (_c = item.mode) !== null && _c !== void 0 ? _c : fallbackMode);
                }
                else {
                    modeSelect.hidden = true;
                    modeSelect.textContent = "";
                }
            }
            const select = root.querySelector("[data-role='format']");
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
    const setItems = (nextItems) => {
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
    const setSettings = (settings) => {
        if (settings.defaultMath) {
            ensureSelectValue(alchemyDefaultMath, settings.defaultMath);
        }
        if (settings.defaultTable) {
            ensureSelectValue(alchemyDefaultTable, settings.defaultTable);
        }
        if (settings.defaultFigure) {
            ensureSelectValue(alchemyDefaultFigure, settings.defaultFigure);
        }
        if (settings.ocrLanguage) {
            ensureSelectValue(alchemyOcrLanguage, settings.ocrLanguage);
        }
        if (settings.pdfMode) {
            ensureSelectValue(alchemyPdfMode, settings.pdfMode);
        }
        if (settings.shortcut && alchemyShortcutInput instanceof HTMLInputElement) {
            alchemyShortcutInput.value = settings.shortcut;
        }
    };
    const getSettings = () => ({
        defaultMath: (alchemyDefaultMath instanceof HTMLSelectElement && alchemyDefaultMath.value) ||
            "display",
        defaultTable: (alchemyDefaultTable instanceof HTMLSelectElement && alchemyDefaultTable.value) ||
            "tabular",
        defaultFigure: (alchemyDefaultFigure instanceof HTMLSelectElement && alchemyDefaultFigure.value) ||
            "includegraphics",
        ocrLanguage: (alchemyOcrLanguage instanceof HTMLSelectElement && alchemyOcrLanguage.value) ||
            "jpn+eng",
        pdfMode: (alchemyPdfMode instanceof HTMLSelectElement && alchemyPdfMode.value) || "Auto",
        shortcut: (alchemyShortcutInput instanceof HTMLInputElement && alchemyShortcutInput.value) ||
            "Ctrl+Shift+2",
    });
    if (alchemySettingsButton instanceof HTMLElement) {
        alchemySettingsButton.addEventListener("click", () => {
            setSettingsOpen(!settingsOpen);
        });
    }
    const emitSettingsChange = () => {
        var _a;
        (_a = handlers.onSettingsChange) === null || _a === void 0 ? void 0 : _a.call(handlers, getSettings());
    };
    const setPasteStatus = (message) => {
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
    const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => { var _a; return resolve(String((_a = reader.result) !== null && _a !== void 0 ? _a : "")); };
        reader.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
        reader.readAsDataURL(file);
    });
    const readFileAsText = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => { var _a; return resolve(String((_a = reader.result) !== null && _a !== void 0 ? _a : "")); };
        reader.onerror = () => reject(new Error("テキストの読み込みに失敗しました。"));
        reader.readAsText(file);
    });
    const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
        reader.readAsArrayBuffer(file);
    });
    const arrayBufferToBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    };
    const buildPayloadFromFile = async (file) => {
        const type = file.type.toLowerCase();
        const name = file.name.toLowerCase();
        if (type.startsWith("image/")) {
            const imageDataUrl = await readFileAsDataUrl(file);
            return { imageDataUrl };
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
    const buildPayloadFromClipboard = async (event) => {
        var _a;
        const data = event.clipboardData;
        if (!data)
            return null;
        const html = data.getData("text/html");
        const text = data.getData("text/plain");
        const payload = {};
        if (html)
            payload.html = html;
        if (text)
            payload.text = text;
        const items = Array.from((_a = data.items) !== null && _a !== void 0 ? _a : []);
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
            var _a;
            (_a = handlers.onCaptureRequest) === null || _a === void 0 ? void 0 : _a.call(handlers);
        });
    }
    if (alchemyPasteBox instanceof HTMLElement) {
        alchemyPasteBox.addEventListener("paste", (event) => {
            event.preventDefault();
            void buildPayloadFromClipboard(event).then((payload) => {
                if (!payload) {
                    pendingPastePayload = null;
                    setPasteStatus("貼り付け内容がありません。");
                    return;
                }
                pendingPastePayload = payload;
                const labels = [];
                if (payload.html)
                    labels.push("HTML");
                if (payload.imageDataUrl)
                    labels.push("画像");
                if (payload.pdfBase64)
                    labels.push("PDF");
                if (payload.text && labels.length === 0)
                    labels.push("テキスト");
                setPasteStatus(labels.length ? `${labels.join(" / ")}を取得しました。` : "");
            });
        });
    }
    if (alchemyPasteRun instanceof HTMLElement) {
        alchemyPasteRun.addEventListener("click", () => {
            var _a, _b, _c;
            const payload = { ...(pendingPastePayload !== null && pendingPastePayload !== void 0 ? pendingPastePayload : {}) };
            if (!pendingPastePayload && alchemyPasteBox instanceof HTMLElement) {
                const text = (_b = (_a = alchemyPasteBox.textContent) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
                if (text) {
                    payload.text = text;
                }
            }
            (_c = handlers.onInputPayload) === null || _c === void 0 ? void 0 : _c.call(handlers, payload);
            resetPasteInput();
        });
    }
    if (alchemyClipboardRun instanceof HTMLElement) {
        alchemyClipboardRun.addEventListener("click", () => {
            var _a;
            (_a = handlers.onClipboardImport) === null || _a === void 0 ? void 0 : _a.call(handlers);
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
            var _a, _b, _c;
            pendingFile = (_b = (_a = alchemyFileInput.files) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : null;
            if (alchemyFileName instanceof HTMLElement) {
                alchemyFileName.textContent = (_c = pendingFile === null || pendingFile === void 0 ? void 0 : pendingFile.name) !== null && _c !== void 0 ? _c : "未選択";
            }
        });
    }
    if (alchemyFileRun instanceof HTMLElement) {
        alchemyFileRun.addEventListener("click", () => {
            var _a;
            if (!pendingFile) {
                (_a = handlers.onInputPayload) === null || _a === void 0 ? void 0 : _a.call(handlers, {});
                return;
            }
            void buildPayloadFromFile(pendingFile)
                .then((payload) => {
                var _a;
                (_a = handlers.onInputPayload) === null || _a === void 0 ? void 0 : _a.call(handlers, payload);
                resetFileInput();
            })
                .catch(() => {
                var _a;
                (_a = handlers.onInputPayload) === null || _a === void 0 ? void 0 : _a.call(handlers, {});
            });
        });
    }
    if (alchemyClose instanceof HTMLElement) {
        alchemyClose.addEventListener("click", () => {
            var _a;
            setOpen(false);
            (_a = deps.onClose) === null || _a === void 0 ? void 0 : _a.call(deps);
        });
    }
    if (alchemyList instanceof HTMLElement) {
        alchemyList.addEventListener("click", (event) => {
            var _a, _b, _c, _d;
            const target = event.target;
            if (!target)
                return;
            const actionButton = target.closest("[data-action]");
            if (actionButton) {
                const itemEl = actionButton.closest(".alchemy-item");
                const itemId = itemEl === null || itemEl === void 0 ? void 0 : itemEl.dataset.id;
                if (!itemId)
                    return;
                if (actionButton.dataset.action === "apply") {
                    (_a = handlers.onApplyItem) === null || _a === void 0 ? void 0 : _a.call(handlers, itemId);
                }
                else if (actionButton.dataset.action === "discard") {
                    (_b = handlers.onDiscardItem) === null || _b === void 0 ? void 0 : _b.call(handlers, itemId);
                }
                else if (actionButton.dataset.action === "edit") {
                    (_c = handlers
                        .onEditItem) === null || _c === void 0 ? void 0 : _c.call(handlers, itemId).then((snippet) => {
                        if (!(alchemyEditTextarea instanceof HTMLTextAreaElement)) {
                            return;
                        }
                        editingId = itemId;
                        alchemyEditTextarea.value = snippet;
                        setEditModalOpen(true);
                        alchemyEditTextarea.focus();
                    }).catch(() => { });
                }
                return;
            }
            const itemEl = target.closest(".alchemy-item");
            if (!itemEl)
                return;
            const itemId = (_d = itemEl.dataset.id) !== null && _d !== void 0 ? _d : null;
            setActiveItem(itemId);
        });
        alchemyList.addEventListener("change", (event) => {
            var _a, _b;
            const target = event.target;
            if (!(target instanceof HTMLSelectElement))
                return;
            const itemEl = target.closest(".alchemy-item");
            const itemId = itemEl === null || itemEl === void 0 ? void 0 : itemEl.dataset.id;
            if (!itemId)
                return;
            if (target.dataset.role === "format") {
                (_a = handlers.onFormatChange) === null || _a === void 0 ? void 0 : _a.call(handlers, itemId, target.value);
            }
            else if (target.dataset.role === "mode") {
                (_b = handlers.onModeChange) === null || _b === void 0 ? void 0 : _b.call(handlers, itemId, target.value);
            }
        });
    }
    if (alchemyShortcutSave instanceof HTMLElement) {
        alchemyShortcutSave.addEventListener("click", () => {
            var _a;
            if (!(alchemyShortcutInput instanceof HTMLInputElement))
                return;
            (_a = handlers.onShortcutSave) === null || _a === void 0 ? void 0 : _a.call(handlers, alchemyShortcutInput.value);
        });
    }
    if (alchemyApply instanceof HTMLElement) {
        alchemyApply.addEventListener("click", () => {
            var _a;
            if (!activeId)
                return;
            (_a = handlers.onApplyItem) === null || _a === void 0 ? void 0 : _a.call(handlers, activeId);
        });
    }
    if (alchemyDiscard instanceof HTMLElement) {
        alchemyDiscard.addEventListener("click", () => { var _a; return (_a = handlers.onDiscardAll) === null || _a === void 0 ? void 0 : _a.call(handlers); });
    }
    if (alchemyApplyAll instanceof HTMLElement) {
        alchemyApplyAll.addEventListener("click", () => { var _a; return (_a = handlers.onApplyAll) === null || _a === void 0 ? void 0 : _a.call(handlers); });
    }
    if (alchemyEditCancel instanceof HTMLElement) {
        alchemyEditCancel.addEventListener("click", () => {
            setEditModalOpen(false);
        });
    }
    if (alchemyEditApply instanceof HTMLElement) {
        alchemyEditApply.addEventListener("click", () => {
            var _a;
            if (!editingId) {
                setEditModalOpen(false);
                return;
            }
            if (!(alchemyEditTextarea instanceof HTMLTextAreaElement)) {
                setEditModalOpen(false);
                return;
            }
            (_a = handlers.onApplyEditedSnippet) === null || _a === void 0 ? void 0 : _a.call(handlers, editingId, alchemyEditTextarea.value);
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
