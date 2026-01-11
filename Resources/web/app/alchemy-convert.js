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
    let settingsOpen = false;
    let busy = false;
    const setStatus = (message) => {
        if (alchemyStatusLine instanceof HTMLElement) {
            alchemyStatusLine.textContent = message;
        }
    };
    const setBusy = (value) => {
        busy = value;
        if (alchemyCaptureButton instanceof HTMLButtonElement) {
            alchemyCaptureButton.disabled = value;
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
    const insertSnippet = (snippet) => {
        var _a, _b, _c, _d, _e, _f;
        const activeGroup = deps.editorSession.getActiveGroup();
        if (!activeGroup.editor ||
            !activeGroup.currentFilePath ||
            !activeGroup.currentFilePath.endsWith(".tex")) {
            deps.updateIssues(1, "貼り付けは .tex ファイルで行ってください。", "error", [
                { severity: "error", message: "貼り付けは .tex ファイルで行ってください。" },
            ]);
            return false;
        }
        const editor = activeGroup.editor;
        const monaco = deps.getMonacoApi();
        if (!(monaco === null || monaco === void 0 ? void 0 : monaco.Range)) {
            deps.updateIssues(1, "エディタの準備が完了していません。", "error", [
                { severity: "error", message: "エディタの準備が完了していません。" },
            ]);
            return false;
        }
        const selection = (_a = editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
        const position = (_c = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : { lineNumber: 1, column: 1 };
        const insertPosition = selection
            ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
            : position;
        const model = (_d = editor.getModel) === null || _d === void 0 ? void 0 : _d.call(editor);
        const formatted = formatSnippetForInsert(snippet, model, insertPosition);
        const range = selection
            ? new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn)
            : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        (_e = editor.executeEdits) === null || _e === void 0 ? void 0 : _e.call(editor, "alchemy-capture-insert", [
            { range, text: formatted, forceMoveMarkers: true },
        ]);
        (_f = editor.focus) === null || _f === void 0 ? void 0 : _f.call(editor);
        return true;
    };
    const handleCaptureImage = (imageDataUrl) => {
        if (busy)
            return;
        if (!imageDataUrl) {
            setStatus("キャプチャ画像がありません。");
            return;
        }
        setBusy(true);
        setStatus("OCR中...");
        const settings = getSettings();
        recognizeImage(imageDataUrl, { language: settings.ocrLanguage || "eng" })
            .then((result) => {
            var _a, _b;
            const text = (_b = (_a = result.text) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
            if (!text) {
                const message = "OCR結果が空でした。";
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                setStatus(message);
                return;
            }
            const snippet = buildTextSnippet(text, "plain");
            if (!snippet) {
                const message = "変換結果がありません。";
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                setStatus(message);
                return;
            }
            const ok = insertSnippet(snippet);
            if (!ok) {
                setStatus("挿入に失敗しました。");
                return;
            }
            setStatus("挿入しました。");
        })
            .catch((error) => {
            const message = error instanceof Error ? error.message : "OCRに失敗しました。";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            setStatus(message);
        })
            .finally(() => {
            setBusy(false);
        });
    };
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
            setStatus("ウィンドウを選択してください。");
            (_a = deps.onCaptureRequest) === null || _a === void 0 ? void 0 : _a.call(deps);
        });
    }
    if (alchemyPanel instanceof HTMLElement) {
        alchemyPanel.classList.toggle("is-open", true);
    }
    return {
        setSettings,
        getSettings,
        handleCaptureImage,
        setStatus,
    };
};
