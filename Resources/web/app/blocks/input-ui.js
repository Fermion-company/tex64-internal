import { reconstructionBlock } from "./context.js";
import { PLACEHOLDER_LATEX, applyScriptToText, applyTemplateToText, getMathFieldSelectionRange, indexToOffset, offsetToIndex, } from "./math-input-utils.js";
import { initMathWysiwyg } from "../math-wysiwyg.js";
import { DEFAULT_WYSIWYG_PACKS } from "../math-wysiwyg-packs.js";
import { createPlaceholderNavigator, readMathFieldValue, setSelectionRange, writeMathFieldValue, } from "./input-ui-math-field.js";
import { normalizeMatrixSyntax, shouldWrapAligned, stripEmptyAlignedRows, unwrapAligned, wrapAligned, } from "./input-ui-latex-format.js";
import { getFormatLabel, getFormatShortLabel, loadMathInsertSettings, saveMathDisplayWrap, saveMathInlineWrap, saveMathInsertMode, } from "./input-ui-settings.js";
import { ensureMathWysiwygPacks, loadMathWysiwygSettings, saveMathWysiwygAutoSuggest, saveMathWysiwygPacks, } from "./math-wysiwyg-settings.js";
export const initBlockInputUi = (context, deps) => {
    const { blockMathInputContainer, blockSettingsButton, blockCaptureButton, blockSettingsModal, blockSettingsClose, blockSettingsBackButtons, blockSettingsPages, blockSettingsMenuItems, blockSettingsInlineOptions, blockSettingsDisplayOptions, blockFormatButton, blockFormatMenu, blockFormatOptions, blockSuggestButton, blocksPanelBody, } = context.dom;
    const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
    const normalizeMathValueForOutput = (value) => {
        const resolved = mathFieldWrapped ? unwrapAligned(value).value : value;
        return normalizeMatrixSyntax(resolved);
    };
    const prepareMathValueForField = (value) => {
        if (!value) {
            return value;
        }
        if (!shouldWrapAligned(value)) {
            return value;
        }
        return wrapAligned(value);
    };
    let activeBlockType = "math";
    let mathInput = null;
    let mathInputFallback = null;
    let currentMathValue = "";
    let mathFieldWrapped = false;
    let mathKeyboardVisibilityHandler = () => { };
    let mathWysiwygApi = null;
    let openMatrixOpsPaletteForSuggestButton = null;
    let globalWysiwygKeydownBound = false;
    let mathInsertMode = "inline";
    let mathInlineWrap = "inline-dollar";
    let mathDisplayWrap = "display-bracket";
    let blockSettingsOpen = false;
    let activeBlockSettingsPage = "menu";
    let formatMenuOpen = false;
    const defaultWysiwygSettings = {
        autoSuggest: true,
        enabledPacks: [...DEFAULT_WYSIWYG_PACKS],
    };
    let mathWysiwygSettings = loadMathWysiwygSettings(defaultWysiwygSettings);
    const wysiwygAutoOptions = Array.from(document.querySelectorAll("[data-wysiwyg-auto]"));
    const wysiwygPackOptions = Array.from(document.querySelectorAll("[data-wysiwyg-pack]"));
    const setFormatMenuOpen = (open) => {
        formatMenuOpen = open;
        if (blockFormatMenu instanceof HTMLElement) {
            blockFormatMenu.classList.toggle("is-open", open);
            blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockFormatButton instanceof HTMLElement) {
            blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
    };
    const setMathInsertMode = (value) => {
        mathInsertMode = value;
        if (blockFormatButton instanceof HTMLElement) {
            const fullLabel = getFormatLabel(value);
            blockFormatButton.textContent = getFormatShortLabel(value);
            blockFormatButton.setAttribute("title", fullLabel);
            blockFormatButton.setAttribute("aria-label", `挿入形式: ${fullLabel}`);
        }
        if (Array.isArray(blockFormatOptions)) {
            blockFormatOptions.forEach((option) => {
                const isActive = option.dataset.format === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-selected", isActive ? "true" : "false");
            });
        }
        saveMathInsertMode(value);
    };
    const setMathInlineWrap = (value) => {
        mathInlineWrap = value;
        if (Array.isArray(blockSettingsInlineOptions)) {
            blockSettingsInlineOptions.forEach((option) => {
                const isActive = option.dataset.inlineFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        saveMathInlineWrap(value);
    };
    const setMathDisplayWrap = (value) => {
        mathDisplayWrap = value;
        if (Array.isArray(blockSettingsDisplayOptions)) {
            blockSettingsDisplayOptions.forEach((option) => {
                const isActive = option.dataset.displayFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        saveMathDisplayWrap(value);
    };
    const applyMathInsertSettings = () => {
        const resolved = loadMathInsertSettings({
            mode: mathInsertMode,
            inlineWrap: mathInlineWrap,
            displayWrap: mathDisplayWrap,
        });
        setMathInsertMode(resolved.mode);
        setMathInlineWrap(resolved.inlineWrap);
        setMathDisplayWrap(resolved.displayWrap);
    };
    const applyMathWysiwygSettings = () => {
        mathWysiwygSettings = {
            ...mathWysiwygSettings,
            enabledPacks: ensureMathWysiwygPacks(mathWysiwygSettings.enabledPacks),
        };
        const enabledPacks = new Set(mathWysiwygSettings.enabledPacks);
        if (Array.isArray(wysiwygAutoOptions)) {
            wysiwygAutoOptions.forEach((button) => {
                const isAuto = button.dataset.wysiwygAuto === "on";
                const isActive = isAuto === mathWysiwygSettings.autoSuggest;
                button.classList.toggle("is-active", isActive);
                button.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        if (Array.isArray(wysiwygPackOptions)) {
            wysiwygPackOptions.forEach((button) => {
                const packId = button.dataset.wysiwygPack;
                if (!packId) {
                    return;
                }
                const isActive = enabledPacks.has(packId);
                button.classList.toggle("is-active", isActive);
                button.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.updateConfig({
            autoSuggest: mathWysiwygSettings.autoSuggest,
            enabledPacks: mathWysiwygSettings.enabledPacks,
        });
    };
    const setMathWysiwygAutoSuggest = (value) => {
        mathWysiwygSettings = {
            ...mathWysiwygSettings,
            autoSuggest: value,
        };
        saveMathWysiwygAutoSuggest(value);
        applyMathWysiwygSettings();
    };
    const toggleMathWysiwygPack = (packId) => {
        const next = new Set(mathWysiwygSettings.enabledPacks);
        if (next.has(packId)) {
            next.delete(packId);
        }
        else {
            next.add(packId);
        }
        const normalized = ensureMathWysiwygPacks(Array.from(next));
        mathWysiwygSettings = {
            ...mathWysiwygSettings,
            enabledPacks: normalized,
        };
        saveMathWysiwygPacks(normalized);
        applyMathWysiwygSettings();
    };
    const updateMathPreview = () => {
        // preview disabled
    };
    const setMathKeyboardVisibilityHandler = (handler) => {
        mathKeyboardVisibilityHandler = handler;
    };
    const setActiveBlockType = (type) => {
        mathKeyboardVisibilityHandler();
        activeBlockType = type;
        updateMathPreview();
    };
    const isMathInputFocused = () => {
        if (!mathInput) {
            return false;
        }
        if (document.activeElement === mathInput) {
            return true;
        }
        if (mathInput.classList.contains("is-focused")) {
            return true;
        }
        if (typeof mathInput.matches === "function" && mathInput.matches(":focus-within")) {
            return true;
        }
        return false;
    };
    const setMathInputElement = (element) => {
        mathInput = element;
        mathFieldWrapped = false;
        if (!mathInput) {
            return;
        }
        if (!currentMathValue) {
            return;
        }
        const resolvedValue = mathInput instanceof HTMLTextAreaElement
            ? currentMathValue
            : prepareMathValueForField(currentMathValue);
        if (mathInput instanceof HTMLTextAreaElement) {
            mathInput.value = resolvedValue;
            return;
        }
        mathFieldWrapped = resolvedValue !== currentMathValue;
        writeMathFieldValue(mathInput, resolvedValue);
    };
    const setMathInputFallback = (value) => {
        mathInputFallback = typeof value === "string" ? value : null;
    };
    const getMathInputFallback = () => mathInputFallback;
    const getMathInputValue = () => {
        if (mathInputFallback !== null) {
            return normalizeMathValueForOutput(mathInputFallback);
        }
        if (!mathInput) {
            return "";
        }
        if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
            const rawValue = readMathFieldValue(mathInput);
            if (mathFieldWrapped) {
                const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
                if (didUnwrap) {
                    currentMathValue = unwrapped;
                    return unwrapped;
                }
                mathFieldWrapped = false;
            }
            currentMathValue = rawValue;
            return rawValue;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            mathFieldWrapped = false;
            currentMathValue = mathInput.value;
            return currentMathValue;
        }
        mathFieldWrapped = false;
        const value = mathInput.value;
        return typeof value === "string" ? value : "";
    };
    const setMathInputValue = (value) => {
        if (!mathInput) {
            currentMathValue = value;
            mathFieldWrapped = false;
            return;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            mathFieldWrapped = false;
            currentMathValue = value;
            mathInput.value = value;
            return;
        }
        const preparedValue = prepareMathValueForField(value);
        mathFieldWrapped = preparedValue !== value;
        currentMathValue = value;
        writeMathFieldValue(mathInput, preparedValue);
    };
    const attachMathInputListener = () => {
        if (!mathInput) {
            return;
        }
        if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
            return;
        }
        mathInput.addEventListener("input", () => {
            if (mathInput instanceof HTMLTextAreaElement) {
                mathFieldWrapped = false;
                currentMathValue = mathInput.value;
                return;
            }
            mathFieldWrapped = false;
            const value = mathInput.value;
            currentMathValue = typeof value === "string" ? value : "";
        });
    };
    const attachMathFieldEvents = (mathfield) => {
        const closeMathFieldMenu = () => {
            var _a;
            const internalMenu = (_a = mathfield._mathfield) === null || _a === void 0 ? void 0 : _a.menu;
            if (internalMenu && typeof internalMenu.hide === "function") {
                if (internalMenu.state && internalMenu.state !== "closed") {
                    internalMenu.hide();
                    return;
                }
                const element = internalMenu.element;
                if (element === null || element === void 0 ? void 0 : element.isConnected) {
                    internalMenu.hide();
                    return;
                }
            }
            const executeCommand = mathfield
                .executeCommand;
            if (typeof executeCommand === "function") {
                const menuElement = document.querySelector("menu.ui-menu-container");
                if (menuElement) {
                    executeCommand.call(mathfield, "toggleContextMenu");
                }
            }
        };
        const closeWysiwygSuggestions = () => {
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.close();
        };
        let mathFieldNormalizing = false;
        const syncMathFieldValue = () => {
            if (mathFieldNormalizing) {
                return;
            }
            const rawValue = readMathFieldValue(mathfield);
            if (mathFieldWrapped) {
                const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
                if (didUnwrap) {
                    const trimmed = stripEmptyAlignedRows(unwrapped);
                    if (trimmed !== unwrapped) {
                        mathFieldNormalizing = true;
                        writeMathFieldValue(mathfield, wrapAligned(trimmed));
                        currentMathValue = trimmed;
                        mathFieldWrapped = true;
                        mathFieldNormalizing = false;
                        return;
                    }
                    currentMathValue = unwrapped;
                    return;
                }
                mathFieldWrapped = false;
            }
            if (shouldWrapAligned(rawValue)) {
                const preparedValue = wrapAligned(rawValue);
                mathFieldNormalizing = true;
                writeMathFieldValue(mathfield, preparedValue);
                const mathfieldApi = mathfield;
                if (typeof mathfieldApi.lastOffset === "number") {
                    mathfieldApi.position = Math.max(0, mathfieldApi.lastOffset - 1);
                }
                else {
                    mathfieldApi.position = 0;
                }
                currentMathValue = rawValue;
                mathFieldWrapped = true;
                mathFieldNormalizing = false;
                return;
            }
            currentMathValue = rawValue;
        };
        mathfield.addEventListener("input", syncMathFieldValue);
        mathfield.addEventListener("change", syncMathFieldValue);
        const applyStructuredInput = (key) => {
            var _a;
            if (key !== "^" && key !== "_") {
                return false;
            }
            const mathfieldApi = mathfield;
            const insertValue = key === "^" ? `^{${PLACEHOLDER_LATEX}}` : `_{${PLACEHOLDER_LATEX}}`;
            const insertOptions = {
                selectionMode: "placeholder",
                focus: true,
                feedback: false,
            };
            try {
                (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
                if (typeof mathfieldApi.insert === "function") {
                    mathfieldApi.insert(insertValue, insertOptions);
                    if (typeof mathfieldApi.executeCommand === "function") {
                        try {
                            mathfieldApi.executeCommand("moveToPreviousPlaceholder");
                        }
                        catch {
                            // ignore
                        }
                    }
                    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                    return true;
                }
                if (typeof mathfieldApi.executeCommand === "function") {
                    const ok = mathfieldApi.executeCommand("insert", insertValue, insertOptions);
                    if (ok) {
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return true;
                    }
                }
            }
            catch {
                // ignore
            }
            return false;
        };
        const tryWrapSelectionWithFraction = () => {
            var _a;
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                return false;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            if (selection.start === selection.end) {
                return false;
            }
            const selectedLatex = mathfieldApi.getValue(selection.start, selection.end, "latex");
            if (typeof selectedLatex !== "string") {
                return false;
            }
            const insertLatex = `\\frac{${selectedLatex}}{${PLACEHOLDER_LATEX}}`;
            let inserted = false;
            if (typeof mathfieldApi.executeCommand === "function") {
                try {
                    inserted = Boolean(mathfieldApi.executeCommand("insert", insertLatex));
                }
                catch {
                    inserted = false;
                }
            }
            if (!inserted && typeof mathfieldApi.insert === "function") {
                mathfieldApi.insert(insertLatex, { focus: true, feedback: false });
                inserted = true;
            }
            if (!inserted) {
                return false;
            }
            (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        };
        const MATRIX_ENV_NAMES = new Set([
            "matrix",
            "pmatrix",
            "bmatrix",
            "Bmatrix",
            "vmatrix",
            "Vmatrix",
            "smallmatrix",
            "cases",
            "dcases",
            "rcases",
        ]);
        const findMatrixEnvironment = (latex, cursorIndex) => {
            const tokenRegex = /\\(begin|end)\{([A-Za-z*]+)\}/g;
            const stack = [];
            let match = null;
            let found = null;
            while ((match = tokenRegex.exec(latex))) {
                const kind = match[1];
                const name = match[2];
                const tokenStart = match.index;
                const tokenText = match[0];
                if (kind === "begin") {
                    stack.push({
                        name,
                        start: tokenStart,
                        bodyStart: tokenStart + tokenText.length,
                        beginToken: tokenText,
                    });
                    continue;
                }
                for (let i = stack.length - 1; i >= 0; i -= 1) {
                    if (stack[i].name !== name) {
                        continue;
                    }
                    const entry = stack.splice(i, 1)[0];
                    const base = name.replace(/\*$/, "");
                    const bodyEnd = tokenStart;
                    if (cursorIndex >= entry.bodyStart && cursorIndex <= bodyEnd) {
                        if (MATRIX_ENV_NAMES.has(base)) {
                            if (!found || entry.bodyStart >= found.bodyStart) {
                                found = {
                                    name,
                                    start: entry.start,
                                    end: tokenStart + tokenText.length,
                                    bodyStart: entry.bodyStart,
                                    bodyEnd,
                                    beginToken: entry.beginToken,
                                    endToken: tokenText,
                                };
                            }
                        }
                    }
                    break;
                }
            }
            return found;
        };
        const splitRows = (body) => {
            const rows = [];
            let depth = 0;
            let rowStart = 0;
            for (let i = 0; i < body.length; i += 1) {
                const ch = body[i];
                if (ch === "{") {
                    depth += 1;
                }
                else if (ch === "}") {
                    depth = Math.max(0, depth - 1);
                }
                if (ch === "\\" && body[i + 1] === "\\" && depth === 0) {
                    rows.push({ text: body.slice(rowStart, i), start: rowStart, end: i });
                    i += 1;
                    rowStart = i + 1;
                }
            }
            rows.push({ text: body.slice(rowStart), start: rowStart, end: body.length });
            return rows;
        };
        const splitCells = (rowText) => {
            const cells = [];
            let depth = 0;
            let cellStart = 0;
            for (let i = 0; i < rowText.length; i += 1) {
                const ch = rowText[i];
                if (ch === "{") {
                    depth += 1;
                }
                else if (ch === "}") {
                    depth = Math.max(0, depth - 1);
                }
                if (ch === "&" && depth === 0) {
                    cells.push({ text: rowText.slice(cellStart, i), start: cellStart, end: i });
                    cellStart = i + 1;
                }
            }
            cells.push({ text: rowText.slice(cellStart), start: cellStart, end: rowText.length });
            return cells;
        };
        const rebuildMatrixBody = (rows, selectionTarget) => {
            let body = "";
            let selectionIndex = 0;
            rows.forEach((cells, rowIndex) => {
                if (rowIndex > 0) {
                    body += "\\\\";
                }
                let rowOffset = body.length;
                cells.forEach((cell, colIndex) => {
                    if (colIndex > 0) {
                        body += "&";
                    }
                    if (selectionTarget && rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
                        selectionIndex = rowOffset + body.length - rowOffset;
                    }
                    body += cell;
                });
            });
            if (selectionTarget) {
                const targetRow = rows[selectionTarget.row];
                if (targetRow) {
                    let cursor = 0;
                    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                        if (rowIndex > 0) {
                            cursor += 2;
                        }
                        const cells = rows[rowIndex];
                        for (let colIndex = 0; colIndex < cells.length; colIndex += 1) {
                            if (colIndex > 0) {
                                cursor += 1;
                            }
                            if (rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
                                selectionIndex = cursor;
                                return { body, selectionIndex };
                            }
                            cursor += cells[colIndex].length;
                        }
                    }
                }
            }
            return { body, selectionIndex: 0 };
        };
        const tryApplyMatrixEdit = (mode) => {
            var _a;
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                return false;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            if (selection.start !== selection.end) {
                return false;
            }
            const latex = mathfieldApi.getValue("latex");
            if (typeof latex !== "string") {
                return false;
            }
            const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
            const env = findMatrixEnvironment(latex, cursorIndex);
            if (!env) {
                return false;
            }
            const body = latex.slice(env.bodyStart, env.bodyEnd);
            const rows = splitRows(body);
            if (rows.length === 0) {
                return false;
            }
            const parsedRows = rows.map((row) => ({
                ...row,
                cells: splitCells(row.text),
            }));
            const cursorInBody = Math.max(0, cursorIndex - env.bodyStart);
            let rowIndex = parsedRows.findIndex((row) => cursorInBody >= row.start && cursorInBody <= row.end);
            if (rowIndex < 0) {
                rowIndex = Math.max(0, parsedRows.length - 1);
            }
            const row = parsedRows[rowIndex];
            const cursorInRow = cursorInBody - row.start;
            let colIndex = row.cells.findIndex((cell) => cursorInRow >= cell.start && cursorInRow <= cell.end);
            if (colIndex < 0) {
                colIndex = Math.max(0, row.cells.length - 1);
            }
            const colCount = Math.max(1, ...parsedRows.map((entry) => Math.max(1, entry.cells.length)));
            let nextRows = parsedRows.map((entry) => entry.cells.map((cell) => cell.text));
            let selectionTarget = null;
            if (mode === "row") {
                const newRow = Array.from({ length: colCount }, () => PLACEHOLDER_LATEX);
                const insertAt = Math.min(rowIndex + 1, nextRows.length);
                nextRows = [
                    ...nextRows.slice(0, insertAt),
                    newRow,
                    ...nextRows.slice(insertAt),
                ];
                selectionTarget = { row: insertAt, col: 0 };
            }
            else {
                const insertAt = Math.min(colIndex + 1, colCount);
                nextRows = nextRows.map((cells, index) => {
                    const normalized = [...cells];
                    while (normalized.length < colCount) {
                        normalized.push("");
                    }
                    normalized.splice(insertAt, 0, PLACEHOLDER_LATEX);
                    return normalized;
                });
                selectionTarget = { row: rowIndex, col: insertAt };
            }
            const { body: nextBody, selectionIndex } = rebuildMatrixBody(nextRows, selectionTarget);
            const nextLatex = `${env.beginToken}${nextBody}${env.endToken}`;
            const startOffset = indexToOffset(mathfieldApi, env.start);
            const endOffset = indexToOffset(mathfieldApi, env.end);
            setSelectionRange(mathfieldApi, startOffset, endOffset);
            (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
            let replaced = false;
            if (typeof mathfieldApi.executeCommand === "function") {
                try {
                    replaced = mathfieldApi.executeCommand("insert", nextLatex);
                }
                catch {
                    replaced = false;
                }
            }
            if (!replaced && typeof mathfieldApi.insert === "function") {
                mathfieldApi.insert(nextLatex, { focus: true, feedback: false });
                replaced = true;
            }
            if (!replaced) {
                return false;
            }
            if (Number.isFinite(selectionIndex)) {
                const nextSelection = env.start + env.beginToken.length + selectionIndex;
                const nextOffset = indexToOffset(mathfieldApi, nextSelection);
                setSelectionRange(mathfieldApi, nextOffset, nextOffset);
            }
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        };
        const tryInsertMatrixRow = () => tryApplyMatrixEdit("row");
        const tryInsertMatrixColumn = () => tryApplyMatrixEdit("column");
        const openMatrixOpsPalette = () => {
            if (!mathWysiwygApi) {
                return false;
            }
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                return false;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const latex = mathfieldApi.getValue("latex");
            if (typeof latex !== "string") {
                return false;
            }
            const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
            const env = findMatrixEnvironment(latex, cursorIndex);
            if (!env) {
                return false;
            }
            const applyCommand = (command) => (mf) => {
                var _a;
                if (typeof mf.executeCommand !== "function") {
                    return;
                }
                try {
                    const ok = Boolean(mf.executeCommand(command));
                    if (ok) {
                        (_a = mf.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(mf, new Event("input", { bubbles: true }));
                    }
                }
                catch {
                    // ignore
                }
            };
            mathWysiwygApi.openCustomCandidates([
                { id: "matrix-op:add-row", label: "+row", hint: "行を追加", apply: applyCommand("addRowAfter") },
                { id: "matrix-op:add-col", label: "+col", hint: "列を追加", apply: applyCommand("addColumnAfter") },
                { id: "matrix-op:remove-row", label: "-row", hint: "行を削除", apply: applyCommand("removeRow") },
                { id: "matrix-op:remove-col", label: "-col", hint: "列を削除", apply: applyCommand("removeColumn") },
            ]);
            return true;
        };
        openMatrixOpsPaletteForSuggestButton = () => {
            if (mathInput !== mathfield) {
                return false;
            }
            return openMatrixOpsPalette();
        };
        const handleMathFieldKeydown = (event) => {
            var _a;
            if (event.isComposing) {
                return;
            }
            if (mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.handleKeydown(event)) {
                event.stopImmediatePropagation();
                return;
            }
            if (event.key === "/" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!tryWrapSelectionWithFraction()) {
                    insertMathKey({ label: "/", latex: "/" });
                    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                }
                closeWysiwygSuggestions();
                return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
                const mathfieldApi = mathfield;
                if (!event.metaKey && !event.ctrlKey) {
                    let handled = false;
                    if (typeof mathfieldApi.executeCommand === "function") {
                        try {
                            handled = Boolean(mathfieldApi.executeCommand("addRowAfter"));
                        }
                        catch {
                            handled = false;
                        }
                    }
                    if (!handled) {
                        handled = tryInsertMatrixRow();
                    }
                    if (handled) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        closeWysiwygSuggestions();
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                }
                else {
                    let handled = false;
                    if (typeof mathfieldApi.executeCommand === "function") {
                        const before = typeof mathfieldApi.getValue === "function"
                            ? mathfieldApi.getValue("latex")
                            : null;
                        try {
                            const ok = Boolean(mathfieldApi.executeCommand("addColumnAfter"));
                            if (ok) {
                                const after = typeof mathfieldApi.getValue === "function"
                                    ? mathfieldApi.getValue("latex")
                                    : null;
                                handled =
                                    typeof before === "string" && typeof after === "string"
                                        ? before !== after
                                        : ok;
                            }
                        }
                        catch {
                            handled = false;
                        }
                    }
                    if (!handled) {
                        handled = tryInsertMatrixColumn();
                    }
                    if (handled) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        closeWysiwygSuggestions();
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    closeWysiwygSuggestions();
                    (_a = deps.onMathFieldSubmit) === null || _a === void 0 ? void 0 : _a.call(deps);
                    return;
                }
            }
            if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                moveMathFieldPlaceholder(mathfield, event.shiftKey ? "backward" : "forward");
                return;
            }
            if (event.defaultPrevented) {
                return;
            }
        };
        mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        const shadowRoot = mathfield.shadowRoot;
        if (shadowRoot) {
            shadowRoot.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        }
        // When the suggestion panel is open, intercept keydown at the document capture phase.
        // This keeps navigation keys for the panel even when other parts of the app listen to keys.
        if (!globalWysiwygKeydownBound) {
            globalWysiwygKeydownBound = true;
            document.addEventListener("keydown", (event) => {
                if (!mathWysiwygApi) {
                    return;
                }
                if (mathWysiwygApi.handleKeydown(event)) {
                    event.stopImmediatePropagation();
                }
            }, { capture: true });
        }
        mathfield.addEventListener("keydown", (e) => {
            if (mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.handleKeydown(e)) {
                return;
            }
            if (e.isComposing) {
                return;
            }
            if (!e.metaKey && !e.altKey && e.ctrlKey && e.key === ".") {
                const opened = Boolean(mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.openExplicitSuggestions());
                const fallbackOpened = opened ? false : openMatrixOpsPalette();
                if (opened || fallbackOpened) {
                    e.preventDefault();
                }
                return;
            }
            if (e.key === "Escape") {
                closeWysiwygSuggestions();
                mathfield.blur();
                return;
            }
        });
        mathfield.addEventListener("focus", () => {
            mathKeyboardVisibilityHandler();
            mathfield.classList.add("is-focused");
        });
        mathfield.addEventListener("blur", () => {
            mathfield.classList.remove("is-focused");
            closeWysiwygSuggestions();
        });
        mathfield.addEventListener("compositionstart", (e) => {
            e.stopPropagation();
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(true);
        });
        mathfield.addEventListener("compositionend", (e) => {
            e.stopPropagation();
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(false);
        });
        mathfield.addEventListener("pointerdown", () => {
            // Keep suggestions in sync with caret movement.
        });
        mathfield.addEventListener("selection-change", () => {
            // Handled by the MathWysiwyg auto-suggest listener.
        });
        mathfield.addEventListener("move-out", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.attach(mathfield);
    };
    const buildMathSnippet = (formula) => {
        const context = deps.getActiveBlockContext();
        if (context) {
            return reconstructionBlock(context, formula);
        }
        const trimmed = formula.trim();
        if (!trimmed) {
            return "";
        }
        if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
            return trimmed;
        }
        if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\begin{")) {
            return trimmed;
        }
        switch (mathInsertMode) {
            case "inline":
                if (mathInlineWrap === "inline-paren") {
                    return ["\\(", trimmed, "\\)"].join("");
                }
                return `$${trimmed}$`;
            case "display":
                if (mathDisplayWrap === "display-dollar") {
                    return `$$${trimmed}$$`;
                }
                return `\\[${trimmed}\\]`;
            case "align":
                return ["\\begin{align*}", trimmed, "\\end{align*}"].join("\n");
            case "gather":
                return ["\\begin{gather*}", trimmed, "\\end{gather*}"].join("\n");
            case "none":
                return trimmed;
            default:
                return `$${trimmed}$`;
        }
    };
    const getBlockDraft = () => {
        const formula = getMathInputValue();
        const normalizedFormula = normalizeMathValueForOutput(formula);
        const snippet = buildMathSnippet(normalizedFormula);
        if (!snippet.trim()) {
            return null;
        }
        return { snippet, content: { formula: normalizedFormula.trim() } };
    };
    const resolveInsertValue = (key, isTextArea) => {
        const source = isTextArea && key.fallback ? key.fallback : key.latex;
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        return source.replace(/#\?/g, placeholder);
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        if (!mathInput) {
            return;
        }
        const isTextArea = mathInput instanceof HTMLTextAreaElement;
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        const scriptKind = key.scriptKind;
        const templateKind = key.templateKind;
        if (mathInput instanceof HTMLTextAreaElement) {
            const textArea = mathInput;
            const start = (_a = textArea.selectionStart) !== null && _a !== void 0 ? _a : textArea.value.length;
            const end = (_b = textArea.selectionEnd) !== null && _b !== void 0 ? _b : textArea.value.length;
            const selection = { start, end };
            if (scriptKind) {
                const result = applyScriptToText(textArea.value, selection, scriptKind, {
                    placeholder,
                    base: (_c = key.scriptBase) !== null && _c !== void 0 ? _c : null,
                    subValue: scriptKind === "sub"
                        ? (_d = key.scriptValue) !== null && _d !== void 0 ? _d : null
                        : (_e = key.scriptSubValue) !== null && _e !== void 0 ? _e : null,
                    supValue: scriptKind === "sup"
                        ? (_f = key.scriptValue) !== null && _f !== void 0 ? _f : null
                        : (_g = key.scriptSupValue) !== null && _g !== void 0 ? _g : null,
                });
                textArea.value = result.text;
                textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
                textArea.focus();
                textArea.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            if (templateKind) {
                const result = applyTemplateToText(textArea.value, selection, key.latex, {
                    placeholder,
                    baseMode: templateKind,
                    baseIndex: key.templateTarget,
                    baseSeparator: key.templateSeparator,
                    baseScope: key.templateScope,
                });
                textArea.value = result.text;
                textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
                textArea.focus();
                textArea.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            const insertValue = resolveInsertValue(key, true);
            if (!insertValue) {
                return;
            }
            textArea.value =
                textArea.value.slice(0, start) + insertValue + textArea.value.slice(end);
            const nextPos = start + insertValue.length;
            textArea.setSelectionRange(nextPos, nextPos);
            textArea.focus();
            textArea.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }
        const mathField = mathInput;
        (_h = mathField.focus) === null || _h === void 0 ? void 0 : _h.call(mathField);
        const applyMathFieldTextEdit = (next) => {
            if (typeof mathField.setValue === "function") {
                mathField.setValue(next.text);
            }
            else if (typeof mathField.value === "string") {
                mathField.value = next.text;
            }
            const startOffset = indexToOffset(mathField, next.selectionStart);
            const endOffset = indexToOffset(mathField, next.selectionEnd);
            setSelectionRange(mathField, startOffset, endOffset);
            mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        };
        if ((scriptKind || templateKind) &&
            typeof mathField.getValue === "function") {
            const rawValue = mathField.getValue("latex");
            if (typeof rawValue === "string") {
                const selectionOffset = getMathFieldSelectionRange(mathField);
                const selectionIndex = {
                    start: offsetToIndex(mathField, selectionOffset.start),
                    end: offsetToIndex(mathField, selectionOffset.end),
                };
                if (scriptKind) {
                    const result = applyScriptToText(rawValue, selectionIndex, scriptKind, {
                        placeholder,
                        base: (_j = key.scriptBase) !== null && _j !== void 0 ? _j : null,
                        subValue: scriptKind === "sub"
                            ? (_k = key.scriptValue) !== null && _k !== void 0 ? _k : null
                            : (_l = key.scriptSubValue) !== null && _l !== void 0 ? _l : null,
                        supValue: scriptKind === "sup"
                            ? (_m = key.scriptValue) !== null && _m !== void 0 ? _m : null
                            : (_o = key.scriptSupValue) !== null && _o !== void 0 ? _o : null,
                    });
                    applyMathFieldTextEdit(result);
                    return;
                }
                if (templateKind) {
                    const result = applyTemplateToText(rawValue, selectionIndex, key.latex, {
                        placeholder,
                        baseMode: templateKind,
                        baseIndex: key.templateTarget,
                        baseSeparator: key.templateSeparator,
                        baseScope: key.templateScope,
                    });
                    applyMathFieldTextEdit(result);
                    return;
                }
            }
        }
        const insertValue = resolveInsertValue(key, false);
        if (!insertValue) {
            return;
        }
        if (typeof mathField.executeCommand === "function") {
            try {
                mathField.executeCommand("insert", insertValue);
                updateMathPreview();
                return;
            }
            catch (e) {
                console.warn("executeCommand failed:", e);
            }
        }
        if (typeof mathField.insert === "function") {
            mathField.insert(insertValue, { focus: true, feedback: false });
            updateMathPreview();
            return;
        }
        if (typeof mathField.value === "string") {
            mathField.value += insertValue;
        }
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
    };
    mathWysiwygApi = initMathWysiwyg({
        container: blockMathInputContainer instanceof HTMLElement ? blockMathInputContainer : null,
        insertKey: (key) => insertMathKey(key),
        autoSuggest: mathWysiwygSettings.autoSuggest,
        enabledPacks: mathWysiwygSettings.enabledPacks,
        getMruStorageKey: () => {
            var _a;
            const rootKey = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps);
            return rootKey ? `tex64.math-wysiwyg.mru.${rootKey}` : "tex64.math-wysiwyg.mru";
        },
    });
    const setBlockSettingsPage = (page) => {
        activeBlockSettingsPage = page;
        if (Array.isArray(blockSettingsPages)) {
            blockSettingsPages.forEach((view) => {
                const isActive = view.dataset.blockSettingsPage === page;
                view.classList.toggle("is-active", isActive);
            });
        }
    };
    const setBlockSettingsOpen = (open) => {
        blockSettingsOpen = open;
        if (blockSettingsModal instanceof HTMLElement) {
            blockSettingsModal.classList.toggle("is-open", open);
            blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockSettingsButton instanceof HTMLElement) {
            blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
        if (open) {
            setBlockSettingsPage("menu");
        }
    };
    if (blockSettingsButton instanceof HTMLButtonElement) {
        blockSettingsButton.addEventListener("click", () => {
            setBlockSettingsOpen(!blockSettingsOpen);
        });
    }
    if (blockCaptureButton instanceof HTMLButtonElement) {
        blockCaptureButton.addEventListener("click", () => {
            var _a;
            (_a = deps.onMathCaptureRequest) === null || _a === void 0 ? void 0 : _a.call(deps);
        });
    }
    if (blockSuggestButton instanceof HTMLButtonElement) {
        blockSuggestButton.addEventListener("click", () => {
            var _a, _b;
            if (!mathInput) {
                return;
            }
            const opened = Boolean(mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.openExplicitSuggestions());
            const fallbackOpened = opened ? false : Boolean(openMatrixOpsPaletteForSuggestButton === null || openMatrixOpsPaletteForSuggestButton === void 0 ? void 0 : openMatrixOpsPaletteForSuggestButton());
            if (opened || fallbackOpened) {
                if (typeof mathInput.focus === "function") {
                    (_b = (_a = mathInput).focus) === null || _b === void 0 ? void 0 : _b.call(_a);
                }
            }
        });
    }
    if (blockSettingsClose instanceof HTMLButtonElement) {
        blockSettingsClose.addEventListener("click", () => {
            setBlockSettingsOpen(false);
        });
    }
    if (blockSettingsModal instanceof HTMLElement) {
        blockSettingsModal.addEventListener("click", (event) => {
            if (event.target === blockSettingsModal) {
                setBlockSettingsOpen(false);
            }
        });
    }
    if (Array.isArray(blockSettingsMenuItems)) {
        blockSettingsMenuItems.forEach((item) => {
            item.addEventListener("click", () => {
                const target = item.dataset.blockSettingsTarget;
                if (target === "insert-format") {
                    setBlockSettingsPage("insert-format");
                }
                else if (target === "suggestions") {
                    setBlockSettingsPage("suggestions");
                }
            });
        });
    }
    if (Array.isArray(blockSettingsBackButtons)) {
        blockSettingsBackButtons.forEach((button) => {
            button.addEventListener("click", () => {
                setBlockSettingsPage("menu");
            });
        });
    }
    if (Array.isArray(blockSettingsInlineOptions)) {
        blockSettingsInlineOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.inlineFormat;
                if (!next) {
                    return;
                }
                setMathInlineWrap(next);
            });
        });
    }
    if (Array.isArray(blockSettingsDisplayOptions)) {
        blockSettingsDisplayOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.displayFormat;
                if (!next) {
                    return;
                }
                setMathDisplayWrap(next);
            });
        });
    }
    if (Array.isArray(wysiwygAutoOptions)) {
        wysiwygAutoOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const value = option.dataset.wysiwygAuto;
                if (value === "on") {
                    setMathWysiwygAutoSuggest(true);
                }
                else if (value === "off") {
                    setMathWysiwygAutoSuggest(false);
                }
            });
        });
    }
    if (Array.isArray(wysiwygPackOptions)) {
        wysiwygPackOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const packId = option.dataset.wysiwygPack;
                if (!packId) {
                    return;
                }
                toggleMathWysiwygPack(packId);
            });
        });
    }
    if (blockFormatButton instanceof HTMLButtonElement) {
        blockFormatButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setFormatMenuOpen(!formatMenuOpen);
        });
    }
    if (blockFormatMenu instanceof HTMLElement) {
        blockFormatMenu.addEventListener("click", (event) => {
            var _a;
            const target = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(".block-format-option");
            if (!target) {
                return;
            }
            const nextFormat = target.dataset.format;
            if (!nextFormat) {
                return;
            }
            setMathInsertMode(nextFormat);
            setFormatMenuOpen(false);
        });
    }
    document.addEventListener("click", (event) => {
        if (!formatMenuOpen) {
            return;
        }
        const target = event.target;
        if ((blockFormatButton === null || blockFormatButton === void 0 ? void 0 : blockFormatButton.contains(target)) || (blockFormatMenu === null || blockFormatMenu === void 0 ? void 0 : blockFormatMenu.contains(target))) {
            return;
        }
        setFormatMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        if (blockSettingsOpen) {
            setBlockSettingsOpen(false);
            return;
        }
        if (formatMenuOpen) {
            setFormatMenuOpen(false);
        }
    });
    applyMathInsertSettings();
    applyMathWysiwygSettings();
    return {
        getActiveBlockType: () => activeBlockType,
        setActiveBlockType,
        setMathKeyboardVisibilityHandler,
        getMathInputValue,
        setMathInputValue,
        getBlockDraft,
        insertMathKey,
        setMathInputElement,
        setMathInputFallback,
        getMathInputFallback,
        isMathInputFocused,
        attachMathInputListener,
        attachMathFieldEvents,
        updateMathPreview,
    };
};
