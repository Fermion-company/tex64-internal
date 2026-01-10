import { reconstructionBlock } from "./context.js";
import { PLACEHOLDER_LATEX } from "./math-input-utils.js";
export const initBlockInputUi = (context, deps) => {
    const { blockToggleButtons, blockForms, blockTableRows, blockTableCols, blockTableGrid, blockTableRaw, blockTableRawInput, blockSettingsButton, blockSettingsModal, blockSettingsClose, blockSettingsBack, blockSettingsPages, blockSettingsMenuItems, blockSettingsInlineOptions, blockSettingsDisplayOptions, blockFormatButton, blockFormatMenu, blockFormatOptions, } = context.dom;
    const MATH_INSERT_MODE_KEY = "tex64.math-insert-mode";
    const MATH_INSERT_INLINE_KEY = "tex64.math-insert-inline-wrap";
    const MATH_INSERT_DISPLAY_KEY = "tex64.math-insert-display-wrap";
    const MATH_INSERT_LEGACY_KEY = "tex64.math-insert-format";
    const MATH_INSERT_MODES = [
        { value: "inline", label: "インライン", shortLabel: "INL" },
        { value: "display", label: "別行", shortLabel: "DSP" },
        { value: "align", label: "align*", shortLabel: "ALN" },
        { value: "gather", label: "gather*", shortLabel: "GTH" },
        { value: "none", label: "囲まない", shortLabel: "RAW" },
    ];
    const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
    const ALIGNED_ENV_END = "\\end{aligned}";
    const isEscapedAt = (text, index) => {
        let count = 0;
        for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
            count += 1;
        }
        return count % 2 === 1;
    };
    const hasUnescapedAmpersand = (text) => {
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] === "&" && !isEscapedAt(text, i)) {
                return true;
            }
        }
        return false;
    };
    const hasLineBreak = (text) => {
        for (let i = 0; i < text.length - 1; i += 1) {
            if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
                return true;
            }
        }
        return false;
    };
    const shouldWrapAligned = (text) => {
        if (!text) {
            return false;
        }
        if (text.includes("\\begin{") || text.includes("\\end{")) {
            return false;
        }
        return hasUnescapedAmpersand(text) || hasLineBreak(text);
    };
    const wrapAligned = (text) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;
    const unwrapAligned = (text) => {
        const start = text.indexOf(ALIGNED_ENV_BEGIN);
        const end = text.lastIndexOf(ALIGNED_ENV_END);
        if (start === -1 || end === -1) {
            return { value: text, didUnwrap: false };
        }
        const before = text.slice(0, start).trim();
        const after = text.slice(end + ALIGNED_ENV_END.length).trim();
        if (before || after) {
            return { value: text, didUnwrap: false };
        }
        let inner = text.slice(start + ALIGNED_ENV_BEGIN.length, end);
        if (inner.startsWith("\n")) {
            inner = inner.slice(1);
        }
        if (inner.endsWith("\n")) {
            inner = inner.slice(0, -1);
        }
        return { value: inner, didUnwrap: true };
    };
    const splitAlignedRows = (text) => {
        const rows = [];
        let current = "";
        for (let i = 0; i < text.length; i += 1) {
            if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
                rows.push(current);
                current = "";
                i += 1;
                continue;
            }
            current += text[i];
        }
        rows.push(current);
        return rows;
    };
    const isEmptyAlignedRow = (row) => {
        const cleaned = row.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
        return cleaned === "" || cleaned === "&";
    };
    const stripEmptyAlignedRows = (text) => {
        const rows = splitAlignedRows(text);
        const kept = rows.filter((row) => !(rows.length > 1 && isEmptyAlignedRow(row)));
        if (kept.length === 0) {
            return "";
        }
        return kept.join("\\\\");
    };
    const normalizeMathValueForOutput = (value) => {
        if (!mathFieldWrapped) {
            return value;
        }
        const { value: unwrapped, didUnwrap } = unwrapAligned(value);
        return didUnwrap ? unwrapped : value;
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
    let tableEditMode = "grid";
    let mathInput = null;
    let mathInputFallback = null;
    let currentMathValue = "";
    let mathFieldWrapped = false;
    let mathKeyboardVisibilityHandler = () => { };
    let mathInsertMode = "inline";
    let mathInlineWrap = "inline-dollar";
    let mathDisplayWrap = "display-bracket";
    let blockSettingsOpen = false;
    let activeBlockSettingsPage = "menu";
    let formatMenuOpen = false;
    const getFormatLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : value; };
    const getFormatShortLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.shortLabel) !== null && _b !== void 0 ? _b : value; };
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
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_MODE_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
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
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_INLINE_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
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
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_DISPLAY_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
    };
    const loadMathInsertSettings = () => {
        var _a;
        if (typeof localStorage === "undefined") {
            setMathInsertMode(mathInsertMode);
            setMathInlineWrap(mathInlineWrap);
            setMathDisplayWrap(mathDisplayWrap);
            return;
        }
        const storedMode = localStorage.getItem(MATH_INSERT_MODE_KEY);
        const storedInline = localStorage.getItem(MATH_INSERT_INLINE_KEY);
        const storedDisplay = localStorage.getItem(MATH_INSERT_DISPLAY_KEY);
        const legacy = localStorage.getItem(MATH_INSERT_LEGACY_KEY);
        const modeMatch = (_a = MATH_INSERT_MODES.find((entry) => entry.value === storedMode)) === null || _a === void 0 ? void 0 : _a.value;
        const inlineMatch = storedInline === "inline-dollar" || storedInline === "inline-paren"
            ? storedInline
            : null;
        const displayMatch = storedDisplay === "display-dollar" || storedDisplay === "display-bracket"
            ? storedDisplay
            : null;
        let resolvedMode = modeMatch !== null && modeMatch !== void 0 ? modeMatch : mathInsertMode;
        let resolvedInline = inlineMatch !== null && inlineMatch !== void 0 ? inlineMatch : mathInlineWrap;
        let resolvedDisplay = displayMatch !== null && displayMatch !== void 0 ? displayMatch : mathDisplayWrap;
        if (!modeMatch && legacy) {
            if (legacy === "none") {
                resolvedMode = "none";
            }
            else if (legacy === "inline-dollar" || legacy === "inline-paren") {
                resolvedMode = "inline";
                resolvedInline = legacy;
            }
            else if (legacy === "display-dollar" || legacy === "display-bracket") {
                resolvedMode = "display";
                resolvedDisplay = legacy;
            }
        }
        setMathInsertMode(resolvedMode);
        setMathInlineWrap(resolvedInline);
        setMathDisplayWrap(resolvedDisplay);
    };
    const updateMathPreview = () => {
        // preview disabled
    };
    const setMathKeyboardVisibilityHandler = (handler) => {
        mathKeyboardVisibilityHandler = handler;
    };
    const setTableEditMode = (mode) => {
        tableEditMode = mode;
        if (blockTableGrid instanceof HTMLElement) {
            blockTableGrid.classList.toggle("is-hidden", mode === "raw");
        }
        if (blockTableRaw instanceof HTMLElement) {
            blockTableRaw.classList.toggle("is-active", mode === "raw");
        }
    };
    const setActiveBlockType = (type) => {
        const resolvedType = deps.enableTableBlocks ? type : "math";
        activeBlockType = resolvedType;
        blockToggleButtons.forEach((button) => {
            const isActive = button.dataset.block === resolvedType;
            button.classList.toggle("is-active", isActive);
        });
        blockForms.forEach((form) => {
            const isActive = form.dataset.form === resolvedType;
            form.classList.toggle("is-active", isActive);
        });
        mathKeyboardVisibilityHandler();
        if (resolvedType === "math") {
            updateMathPreview();
            setTableEditMode("grid");
        }
        else if (deps.getActiveBlockEditMode() !== "detected") {
            setTableEditMode("grid");
        }
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
    const readMathFieldValue = (mathField) => {
        if (!mathField) {
            return "";
        }
        if (typeof mathField.getValue === "function") {
            const nextValue = mathField.getValue("latex");
            if (typeof nextValue === "string") {
                return nextValue;
            }
        }
        if (typeof mathField.value === "string") {
            return mathField.value;
        }
        return "";
    };
    const writeMathFieldValue = (mathField, value) => {
        if (!mathField) {
            return;
        }
        if (typeof mathField.setValue === "function") {
            mathField.setValue(value);
            return;
        }
        if ("value" in mathField) {
            mathField.value = value;
        }
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
    const getTableRawValue = () => {
        if (blockTableRawInput instanceof HTMLTextAreaElement) {
            return blockTableRawInput.value;
        }
        return "";
    };
    const setTableRawValue = (value) => {
        if (blockTableRawInput instanceof HTMLTextAreaElement) {
            blockTableRawInput.value = value;
        }
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
        mathfield.addEventListener("keydown", (e) => {
            var _a;
            if (e.key === "Escape") {
                mathfield.blur();
                return;
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                (_a = deps.onMathFieldSubmit) === null || _a === void 0 ? void 0 : _a.call(deps);
                return;
            }
            if (e.key === "Tab")
                return;
            e.stopPropagation();
        });
        mathfield.addEventListener("focus", () => {
            mathKeyboardVisibilityHandler();
            mathfield.classList.add("is-focused");
        });
        mathfield.addEventListener("blur", () => {
            mathfield.classList.remove("is-focused");
        });
        mathfield.addEventListener("compositionstart", (e) => e.stopPropagation());
        mathfield.addEventListener("compositionend", (e) => e.stopPropagation());
    };
    const buildTableSnippetFromRaw = (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return "";
        }
        const context = deps.getActiveBlockContext();
        if ((context === null || context === void 0 ? void 0 : context.type) === "table") {
            return reconstructionBlock(context, raw);
        }
        if (trimmed.startsWith("\\begin{")) {
            return trimmed;
        }
        return ["\\begin{tabular}{|c|}", trimmed, "\\end{tabular}", ""].join("\n");
    };
    const buildMathSnippet = (formula) => {
        const context = deps.getActiveBlockContext();
        const activeMathEditCell = deps.getActiveMathEditCell();
        if ((context === null || context === void 0 ? void 0 : context.type) === "math") {
            if (activeMathEditCell && activeMathEditCell.context === context) {
                const replacement = activeMathEditCell.range.leading + formula + activeMathEditCell.range.trailing;
                const updatedInner = activeMathEditCell.inner.slice(0, activeMathEditCell.range.start) +
                    replacement +
                    activeMathEditCell.inner.slice(activeMathEditCell.range.end);
                return reconstructionBlock(context, updatedInner);
            }
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
    const parseTableSize = () => {
        const rows = blockTableRows instanceof HTMLInputElement
            ? Number.parseInt(blockTableRows.value, 10)
            : NaN;
        const cols = blockTableCols instanceof HTMLInputElement
            ? Number.parseInt(blockTableCols.value, 10)
            : NaN;
        if (!Number.isFinite(rows) || rows < 1 || rows > 20) {
            return null;
        }
        if (!Number.isFinite(cols) || cols < 1 || cols > 12) {
            return null;
        }
        return { rows, cols };
    };
    const buildTableSnippet = (rows, cols) => {
        const columnSpec = `|${"c|".repeat(cols)}`;
        const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
        const lines = [];
        lines.push(`\\begin{tabular}{${columnSpec}}`);
        for (let row = 0; row < rows; row += 1) {
            lines.push("\\hline");
            lines.push(`${rowCells} \\\\`);
        }
        lines.push("\\hline");
        lines.push("\\end{tabular}");
        lines.push("");
        return lines.join("\n");
    };
    const getBlockDraft = () => {
        if (activeBlockType === "math") {
            const formula = getMathInputValue();
            const normalizedFormula = normalizeMathValueForOutput(formula);
            const snippet = buildMathSnippet(normalizedFormula);
            if (!snippet.trim()) {
                return null;
            }
            return { snippet, content: { formula: normalizedFormula.trim() } };
        }
        if (tableEditMode === "raw") {
            const raw = getTableRawValue();
            const snippet = buildTableSnippetFromRaw(raw);
            if (!snippet.trim()) {
                return null;
            }
            return { snippet, content: { raw } };
        }
        const size = parseTableSize();
        if (!size) {
            return null;
        }
        return {
            snippet: buildTableSnippet(size.rows, size.cols),
            content: { rows: size.rows, cols: size.cols },
        };
    };
    const resolveInsertValue = (key, isTextArea) => {
        const source = isTextArea && key.fallback ? key.fallback : key.latex;
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        return source.replace(/#\?/g, placeholder);
    };
    const insertMathKey = (key) => {
        var _a, _b, _c;
        if (!mathInput) {
            return;
        }
        const isTextArea = mathInput instanceof HTMLTextAreaElement;
        const insertValue = resolveInsertValue(key, isTextArea);
        const mathField = mathInput;
        (_a = mathField.focus) === null || _a === void 0 ? void 0 : _a.call(mathField);
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
        if (mathInput instanceof HTMLTextAreaElement) {
            const start = (_b = mathInput.selectionStart) !== null && _b !== void 0 ? _b : mathInput.value.length;
            const end = (_c = mathInput.selectionEnd) !== null && _c !== void 0 ? _c : mathInput.value.length;
            mathInput.value =
                mathInput.value.slice(0, start) + insertValue + mathInput.value.slice(end);
            const nextPos = start + insertValue.length;
            mathInput.setSelectionRange(nextPos, nextPos);
            mathInput.focus();
        }
        else if (typeof mathField.value === "string") {
            mathField.value += insertValue;
        }
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
    };
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
            });
        });
    }
    if (blockSettingsBack instanceof HTMLButtonElement) {
        blockSettingsBack.addEventListener("click", () => {
            setBlockSettingsPage("menu");
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
    blockToggleButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const type = button.dataset.block === "table" ? "table" : "math";
            setActiveBlockType(type);
        });
    });
    if (blockTableRows instanceof HTMLInputElement) {
        blockTableRows.addEventListener("input", () => { });
    }
    if (blockTableCols instanceof HTMLInputElement) {
        blockTableCols.addEventListener("input", () => { });
    }
    if (blockTableRawInput instanceof HTMLTextAreaElement) {
        blockTableRawInput.addEventListener("input", () => { });
    }
    loadMathInsertSettings();
    return {
        getActiveBlockType: () => activeBlockType,
        setActiveBlockType,
        setMathKeyboardVisibilityHandler,
        setTableEditMode,
        getMathInputValue,
        setMathInputValue,
        getTableRawValue,
        setTableRawValue,
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
