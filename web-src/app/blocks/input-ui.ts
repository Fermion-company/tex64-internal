import { reconstructionBlock } from "./context.js";
import type { AppContext } from "../context.js";
import type { BlockContent, BlockEditMode, BlockType, MathKey } from "../types.js";
import type { BlockContext } from "./types.js";
import { PLACEHOLDER_LATEX } from "./math-input-utils.js";

export type BlockInputApi = {
  getActiveBlockType: () => BlockType;
  setActiveBlockType: (type: BlockType) => void;
  setMathKeyboardVisibilityHandler: (handler: () => void) => void;
  setTableEditMode: (mode: "grid" | "raw") => void;
  getMathInputValue: () => string;
  setMathInputValue: (value: string) => void;
  getTableRawValue: () => string;
  setTableRawValue: (value: string) => void;
  getBlockDraft: () => { snippet: string; content: BlockContent } | null;
  insertMathKey: (key: MathKey) => void;
  setMathInputElement: (element: HTMLElement | null) => void;
  setMathInputFallback: (value: string | null) => void;
  getMathInputFallback: () => string | null;
  isMathInputFocused: () => boolean;
  attachMathInputListener: () => void;
  attachMathFieldEvents: (mathfield: HTMLElement) => void;
  updateMathPreview: () => void;
};

type BlockInputDeps = {
  enableTableBlocks: boolean;
  getActiveBlockContext: () => BlockContext | null;
  getActiveBlockEditMode: () => BlockEditMode;
  onMathFieldSubmit?: () => void;
  onMathCaptureRequest?: () => void;
};

export const initBlockInputUi = (
  context: AppContext,
  deps: BlockInputDeps
): BlockInputApi => {
  const {
    blockToggleButtons,
    blockForms,
    blockTableRows,
    blockTableCols,
    blockTableGrid,
    blockTableRaw,
    blockTableRawInput,
    blockSettingsButton,
    blockCaptureButton,
    blockSettingsModal,
    blockSettingsClose,
    blockSettingsBack,
    blockSettingsPages,
    blockSettingsMenuItems,
    blockSettingsInlineOptions,
    blockSettingsDisplayOptions,
    blockFormatButton,
    blockFormatMenu,
    blockFormatOptions,
  } = context.dom;

  type MathInsertMode = "inline" | "display" | "align" | "gather" | "none";
  type MathInlineWrap = "inline-dollar" | "inline-paren";
  type MathDisplayWrap = "display-dollar" | "display-bracket";
  type BlockSettingsPage = "menu" | "insert-format";

  const MATH_INSERT_MODE_KEY = "tex64.math-insert-mode";
  const MATH_INSERT_INLINE_KEY = "tex64.math-insert-inline-wrap";
  const MATH_INSERT_DISPLAY_KEY = "tex64.math-insert-display-wrap";
  const MATH_INSERT_LEGACY_KEY = "tex64.math-insert-format";
  const MATH_INSERT_MODES: Array<{
    value: MathInsertMode;
    label: string;
    shortLabel: string;
  }> = [
    { value: "inline", label: "インライン", shortLabel: "INL" },
    { value: "display", label: "別行", shortLabel: "DSP" },
    { value: "align", label: "align*", shortLabel: "ALN" },
    { value: "gather", label: "gather*", shortLabel: "GTH" },
    { value: "none", label: "囲まない", shortLabel: "RAW" },
  ];
  const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
  const ALIGNED_ENV_END = "\\end{aligned}";

  const isEscapedAt = (text: string, index: number) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
      count += 1;
    }
    return count % 2 === 1;
  };

  const hasUnescapedAmpersand = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "&" && !isEscapedAt(text, i)) {
        return true;
      }
    }
    return false;
  };

  const hasLineBreak = (text: string) => {
    for (let i = 0; i < text.length - 1; i += 1) {
      if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
        return true;
      }
    }
    return false;
  };

  const shouldWrapAligned = (text: string) => {
    if (!text) {
      return false;
    }
    if (text.includes("\\begin{") || text.includes("\\end{")) {
      return false;
    }
    return hasUnescapedAmpersand(text) || hasLineBreak(text);
  };

  const wrapAligned = (text: string) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;

  const unwrapAligned = (text: string) => {
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

  const splitAlignedRows = (text: string) => {
    const rows: string[] = [];
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

  const isEmptyAlignedRow = (row: string) => {
    const cleaned = row.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
    return cleaned === "" || cleaned === "&";
  };

  const stripEmptyAlignedRows = (text: string) => {
    const rows = splitAlignedRows(text);
    if (rows.length <= 1) {
      return text;
    }
    const hasNonEmpty = rows.some((row) => !isEmptyAlignedRow(row));
    return hasNonEmpty ? text : "";
  };

  const normalizeMatrixSyntax = (value: string) => {
    if (!value) {
      return value;
    }
    return value.replace(
      /\\begin\{((?:[p|b|B|v|V])?matrix)\}([\s\S]*?)\\end\{\1\}/g,
      (match, env: string, body: string) => {
        if (body.includes("&") || body.includes("\\\\")) {
          return match;
        }
        const cells: string[] = [];
        let i = 0;
        let valid = true;
        while (i < body.length) {
          const ch = body[i];
          if (ch === "{") {
            let depth = 0;
            const start = i + 1;
            for (; i < body.length; i += 1) {
              const inner = body[i];
              if (inner === "{") depth += 1;
              if (inner === "}") {
                depth -= 1;
                if (depth === 0) {
                  cells.push(body.slice(start, i).trim());
                  i += 1;
                  break;
                }
              }
            }
            if (depth !== 0) {
              valid = false;
              break;
            }
            continue;
          }
          if (!/\s/.test(ch)) {
            const start = i;
            while (i < body.length && !/\s/.test(body[i])) {
              i += 1;
            }
            cells.push(body.slice(start, i).trim());
            continue;
          }
          i += 1;
        }
        if (!valid) {
          return match;
        }
        const filtered = cells.filter((cell) => cell.length > 0);
        if (filtered.length === 0) {
          return match;
        }
        const size = Math.sqrt(filtered.length);
        const n = Math.round(size);
        if (!Number.isFinite(size) || n * n !== filtered.length) {
          return match;
        }
        const rows: string[] = [];
        for (let r = 0; r < n; r += 1) {
          const row = filtered.slice(r * n, (r + 1) * n);
          rows.push(row.join("&"));
        }
        return `\\begin{${env}}${rows.join("\\\\")}\\end{${env}}`;
      }
    );
  };

  const normalizeMathValueForOutput = (value: string) => {
    const resolved = mathFieldWrapped ? unwrapAligned(value).value : value;
    return normalizeMatrixSyntax(resolved);
  };

  const prepareMathValueForField = (value: string) => {
    if (!value) {
      return value;
    }
    if (!shouldWrapAligned(value)) {
      return value;
    }
    return wrapAligned(value);
  };

  let activeBlockType: BlockType = "math";
  let tableEditMode: "grid" | "raw" = "grid";
  let mathInput: HTMLElement | null = null;
  let mathInputFallback: string | null = null;
  let currentMathValue = "";
  let mathFieldWrapped = false;
  let mathKeyboardVisibilityHandler = () => {};
  let mathInsertMode: MathInsertMode = "inline";
  let mathInlineWrap: MathInlineWrap = "inline-dollar";
  let mathDisplayWrap: MathDisplayWrap = "display-bracket";
  let blockSettingsOpen = false;
  let activeBlockSettingsPage: BlockSettingsPage = "menu";
  let formatMenuOpen = false;

  const getFormatLabel = (value: MathInsertMode) =>
    MATH_INSERT_MODES.find((entry) => entry.value === value)?.label ?? value;

  const getFormatShortLabel = (value: MathInsertMode) =>
    MATH_INSERT_MODES.find((entry) => entry.value === value)?.shortLabel ?? value;

  const setFormatMenuOpen = (open: boolean) => {
    formatMenuOpen = open;
    if (blockFormatMenu instanceof HTMLElement) {
      blockFormatMenu.classList.toggle("is-open", open);
      blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (blockFormatButton instanceof HTMLElement) {
      blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
    }
  };

  const setMathInsertMode = (value: MathInsertMode) => {
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
      } catch {
        // ignore storage failures
      }
    }
  };

  const setMathInlineWrap = (value: MathInlineWrap) => {
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
      } catch {
        // ignore storage failures
      }
    }
  };

  const setMathDisplayWrap = (value: MathDisplayWrap) => {
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
      } catch {
        // ignore storage failures
      }
    }
  };

  const loadMathInsertSettings = () => {
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

    const modeMatch = MATH_INSERT_MODES.find((entry) => entry.value === storedMode)?.value;
    const inlineMatch =
      storedInline === "inline-dollar" || storedInline === "inline-paren"
        ? (storedInline as MathInlineWrap)
        : null;
    const displayMatch =
      storedDisplay === "display-dollar" || storedDisplay === "display-bracket"
        ? (storedDisplay as MathDisplayWrap)
        : null;

    let resolvedMode = modeMatch ?? mathInsertMode;
    let resolvedInline = inlineMatch ?? mathInlineWrap;
    let resolvedDisplay = displayMatch ?? mathDisplayWrap;

    if (!modeMatch && legacy) {
      if (legacy === "none") {
        resolvedMode = "none";
      } else if (legacy === "inline-dollar" || legacy === "inline-paren") {
        resolvedMode = "inline";
        resolvedInline = legacy;
      } else if (legacy === "display-dollar" || legacy === "display-bracket") {
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

  const setMathKeyboardVisibilityHandler = (handler: () => void) => {
    mathKeyboardVisibilityHandler = handler;
  };

  const setTableEditMode = (mode: "grid" | "raw") => {
    tableEditMode = mode;
    if (blockTableGrid instanceof HTMLElement) {
      blockTableGrid.classList.toggle("is-hidden", mode === "raw");
    }
    if (blockTableRaw instanceof HTMLElement) {
      blockTableRaw.classList.toggle("is-active", mode === "raw");
    }
  };

  const setActiveBlockType = (type: BlockType) => {
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
    } else if (deps.getActiveBlockEditMode() !== "detected") {
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

  const readMathFieldValue = (
    mathField: { getValue?: (format?: string) => unknown; value?: unknown } | null
  ) => {
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

  const writeMathFieldValue = (
    mathField: { setValue?: (value: string) => void; value?: string } | null,
    value: string
  ) => {
    if (!mathField) {
      return;
    }
    if (typeof mathField.setValue === "function") {
      mathField.setValue(value);
      return;
    }
    if ("value" in mathField) {
      (mathField as { value?: string }).value = value;
    }
  };

  const setMathInputElement = (element: HTMLElement | null) => {
    mathInput = element;
    mathFieldWrapped = false;
    if (!mathInput) {
      return;
    }
    if (!currentMathValue) {
      return;
    }
    const resolvedValue =
      mathInput instanceof HTMLTextAreaElement
        ? currentMathValue
        : prepareMathValueForField(currentMathValue);
    if (mathInput instanceof HTMLTextAreaElement) {
      mathInput.value = resolvedValue;
      return;
    }
    mathFieldWrapped = resolvedValue !== currentMathValue;
    writeMathFieldValue(
      mathInput as { setValue?: (value: string) => void; value?: string },
      resolvedValue
    );
  };

  const setMathInputFallback = (value: string | null) => {
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
      const rawValue = readMathFieldValue(
        mathInput as { getValue?: (format?: string) => unknown; value?: unknown }
      );
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
    const value = (mathInput as { value?: string }).value;
    return typeof value === "string" ? value : "";
  };

  const setMathInputValue = (value: string) => {
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
    writeMathFieldValue(
      mathInput as { setValue?: (value: string) => void; value?: string },
      preparedValue
    );
  };

  const getTableRawValue = () => {
    if (blockTableRawInput instanceof HTMLTextAreaElement) {
      return blockTableRawInput.value;
    }
    return "";
  };

  const setTableRawValue = (value: string) => {
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
      const value = (mathInput as { value?: string }).value;
      currentMathValue = typeof value === "string" ? value : "";
    });
  };

  const attachMathFieldEvents = (mathfield: HTMLElement) => {
    const closeMathFieldMenu = () => {
      const internalMenu = (mathfield as { _mathfield?: { menu?: any } })._mathfield?.menu;
      if (internalMenu && typeof internalMenu.hide === "function") {
        if (internalMenu.state && internalMenu.state !== "closed") {
          internalMenu.hide();
          return;
        }
        const element = internalMenu.element as HTMLElement | undefined;
        if (element?.isConnected) {
          internalMenu.hide();
          return;
        }
      }
      const executeCommand = (mathfield as { executeCommand?: (command: string) => void })
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
      const rawValue = readMathFieldValue(
        mathfield as { getValue?: (format?: string) => unknown; value?: unknown }
      );
      if (mathFieldWrapped) {
        const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
        if (didUnwrap) {
          const trimmed = stripEmptyAlignedRows(unwrapped);
          if (trimmed !== unwrapped) {
            mathFieldNormalizing = true;
            writeMathFieldValue(
              mathfield as { setValue?: (value: string) => void; value?: string },
              wrapAligned(trimmed)
            );
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
        writeMathFieldValue(
          mathfield as { setValue?: (value: string) => void; value?: string },
          preparedValue
        );
        const mathfieldApi = mathfield as { lastOffset?: number; position?: number };
        if (typeof mathfieldApi.lastOffset === "number") {
          mathfieldApi.position = Math.max(0, mathfieldApi.lastOffset - 1);
        } else {
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

    mathfield.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        mathfield.blur();
        return;
      }

      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        deps.onMathFieldSubmit?.();
        return;
      }

      if (e.key === "Tab") return;

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

  const buildTableSnippetFromRaw = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.startsWith("\\begin{")) {
      return trimmed;
    }
    return ["\\begin{tabular}{|c|}", trimmed, "\\end{tabular}", ""].join("\n");
  };

  const buildMathSnippet = (formula: string) => {
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

  const parseTableSize = () => {
    const rows =
      blockTableRows instanceof HTMLInputElement
        ? Number.parseInt(blockTableRows.value, 10)
        : NaN;
    const cols =
      blockTableCols instanceof HTMLInputElement
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

  const buildTableSnippet = (rows: number, cols: number) => {
    const columnSpec = `|${"c|".repeat(cols)}`;
    const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
    const lines: string[] = [];
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

  const getBlockDraft = (): { snippet: string; content: BlockContent } | null => {
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

  const resolveInsertValue = (key: MathKey, isTextArea: boolean) => {
    const source = isTextArea && key.fallback ? key.fallback : key.latex;
    const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
    return source.replace(/#\?/g, placeholder);
  };

  const insertMathKey = (key: MathKey) => {
    if (!mathInput) {
      return;
    }
    const isTextArea = mathInput instanceof HTMLTextAreaElement;
    const insertValue = resolveInsertValue(key, isTextArea);
    const mathField = mathInput as {
      insert?: (value: string, options?: Record<string, unknown>) => void;
      executeCommand?: (...args: unknown[]) => boolean;
      focus?: () => void;
      value?: string;
    };

    mathField.focus?.();
    if (!insertValue) {
      return;
    }

    if (typeof mathField.executeCommand === "function") {
      try {
        mathField.executeCommand("insert", insertValue);
        updateMathPreview();
        return;
      } catch (e) {
        console.warn("executeCommand failed:", e);
      }
    }

    if (typeof mathField.insert === "function") {
      mathField.insert(insertValue, { focus: true, feedback: false });
      updateMathPreview();
      return;
    }

    if (mathInput instanceof HTMLTextAreaElement) {
      const start = mathInput.selectionStart ?? mathInput.value.length;
      const end = mathInput.selectionEnd ?? mathInput.value.length;
      mathInput.value =
        mathInput.value.slice(0, start) + insertValue + mathInput.value.slice(end);
      const nextPos = start + insertValue.length;
      mathInput.setSelectionRange(nextPos, nextPos);
      mathInput.focus();
    } else if (typeof mathField.value === "string") {
      mathField.value += insertValue;
    }
    mathInput.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const setBlockSettingsPage = (page: BlockSettingsPage) => {
    activeBlockSettingsPage = page;
    if (Array.isArray(blockSettingsPages)) {
      blockSettingsPages.forEach((view) => {
        const isActive = view.dataset.blockSettingsPage === page;
        view.classList.toggle("is-active", isActive);
      });
    }
  };

  const setBlockSettingsOpen = (open: boolean) => {
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
      if (activeBlockType !== "math") {
        setActiveBlockType("math");
      }
      deps.onMathCaptureRequest?.();
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
        const next = option.dataset.inlineFormat as MathInlineWrap | undefined;
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
        const next = option.dataset.displayFormat as MathDisplayWrap | undefined;
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
      const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        ".block-format-option"
      );
      if (!target) {
        return;
      }
      const nextFormat = target.dataset.format;
      if (!nextFormat) {
        return;
      }
      setMathInsertMode(nextFormat as MathInsertMode);
      setFormatMenuOpen(false);
    });
  }

  document.addEventListener("click", (event) => {
    if (!formatMenuOpen) {
      return;
    }
    const target = event.target as Node;
    if (blockFormatButton?.contains(target) || blockFormatMenu?.contains(target)) {
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
    blockTableRows.addEventListener("input", () => {});
  }

  if (blockTableCols instanceof HTMLInputElement) {
    blockTableCols.addEventListener("input", () => {});
  }

  if (blockTableRawInput instanceof HTMLTextAreaElement) {
    blockTableRawInput.addEventListener("input", () => {});
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
