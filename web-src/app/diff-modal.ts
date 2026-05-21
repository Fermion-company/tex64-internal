import { buildLineDiff } from "./diff.js";
import type { AppContext } from "./context.js";

export type DiffContext =
  | { type: "block" }
  | { type: "aiApply"; proposalIds: string[] }
  | null;

export type FileDiff = {
  fileName: string;
  original: string;
  modified: string;
};

export type DiffModalApi = {
  showDiffModal: (
    original: string,
    modified: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => void;
  showMultiFileDiff: (
    files: FileDiff[],
    options?: { title?: string; submitLabel?: string }
  ) => void;
  closeDiffModal: () => void;
  resetDiffEditor: () => void;
  getDiffContext: () => DiffContext;
  setDiffContext: (context: DiffContext) => void;
};

type DiffModalDeps = {
  getMonacoApi: () => Record<string, unknown> | null;
  getActiveFilePath: () => string | null;
};

export const initDiffModal = (context: AppContext, deps: DiffModalDeps): DiffModalApi => {
  const { diffModal, diffTitle, diffModalSubmit, blockDiffContainer, diffSummary, diffFileName } =
    context.dom;

  const defaultDiffSubmitLabel =
    diffModalSubmit instanceof HTMLButtonElement
      ? diffModalSubmit.textContent ?? "Confirm"
      : "Confirm";

  let diffEditor: unknown = null;
  let diffOriginalModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let diffModifiedModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let diffContext: DiffContext = null;

  const renderDiffSummary = (before: string, after: string) => {
    if (!(diffSummary instanceof HTMLElement)) {
      return;
    }
    diffSummary.textContent = "";
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    let adds = 0;
    let dels = 0;
    diffLines.forEach((entry) => {
      if (entry.type === "add") {
        adds += 1;
      } else if (entry.type === "del") {
        dels += 1;
      }
    });
    if (adds === 0 && dels === 0) {
      diffSummary.textContent = "No change";
      return;
    }
    const add = document.createElement("span");
    add.className = "diff-summary-item is-add";
    add.textContent = `+${adds}`;
    const del = document.createElement("span");
    del.className = "diff-summary-item is-del";
    del.textContent = `-${dels}`;
    diffSummary.append(add, del);
  };

  const renderDiffHeader = () => {
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent =
        diffContext?.type === "block" ? "Confirm changes (format after finalization)" : "Confirm changes";
    }
    if (diffFileName instanceof HTMLElement) {
      const activePath = deps.getActiveFilePath();
      const fileName = activePath ? activePath.split(/[/\\]/).pop() ?? activePath : "Unsaved";
      diffFileName.textContent = fileName;
    }
  };

  const setDiffHeader = (options: {
    title?: string;
    fileName?: string;
  }) => {
    if (diffTitle instanceof HTMLElement && typeof options.title === "string") {
      diffTitle.textContent = options.title;
    }
    if (diffFileName instanceof HTMLElement && typeof options.fileName === "string") {
      diffFileName.textContent = options.fileName;
    }
  };

  const detectLanguage = (fileName?: string | null): string => {
    if (!fileName) return "plaintext";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      tex: "latex", sty: "latex", cls: "latex", bib: "bibtex",
      js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
      py: "python", rb: "ruby", rs: "rust", go: "go",
      java: "java", kt: "kotlin", swift: "swift",
      css: "css", scss: "scss", less: "less",
      html: "html", xml: "xml", json: "json", yaml: "yaml", yml: "yaml",
      md: "markdown", sh: "shell", bash: "shell",
      c: "c", cpp: "cpp", h: "c", hpp: "cpp",
      sql: "sql", lua: "lua", r: "r",
    };
    return map[ext] ?? "plaintext";
  };

  const countLines = (text: string) => {
    if (!text) return 1;
    return text.split(/\r?\n/).length;
  };

  const countLineBreaks = (text: string) => text.match(/\r?\n/g)?.length ?? 0;

  const buildDiffPreviewContext = (
    model: {
      getValue: () => string;
      getPositionAt: (offset: number) => { lineNumber: number; column: number };
      getLineCount?: () => number;
    },
    startOffset: number,
    endOffset: number,
    replacement: string,
    contextLineCount = 3
  ) => {
    const originalText = model.getValue();
    const totalLines =
      typeof model.getLineCount === "function" ? model.getLineCount() : countLines(originalText);
    const startPos = model.getPositionAt(startOffset);
    const endPos = model.getPositionAt(endOffset);
    let startLine = startPos.lineNumber;
    let endLine = endPos.lineNumber;
    if (endOffset > startOffset && endPos.column === 1) {
      endLine = Math.max(startLine, endLine - 1);
    }
    const contextStartLine = Math.max(1, startLine - contextLineCount);
    const contextEndLine = Math.min(totalLines, endLine + contextLineCount);
    const originalLines = originalText.split(/\r?\n/);
    const originalSlice = originalLines.slice(contextStartLine - 1, contextEndLine).join("\n");
    const originalSegment = originalText.slice(startOffset, endOffset);
    const lineDelta = countLineBreaks(replacement) - countLineBreaks(originalSegment);
    const modifiedText =
      originalText.slice(0, startOffset) + replacement + originalText.slice(endOffset);
    const modifiedTotalLines = totalLines + lineDelta;
    const modifiedEndLine = Math.min(modifiedTotalLines, contextEndLine + lineDelta);
    const modifiedLines = modifiedText.split(/\r?\n/);
    const modifiedSlice = modifiedLines
      .slice(contextStartLine - 1, Math.max(contextStartLine, modifiedEndLine))
      .join("\n");
    return {
      original: originalSlice,
      modified: modifiedSlice,
      lineOffset: contextStartLine - 1,
    };
  };

  const applyDiffLineNumberOffset = (offset: number, original: string, modified: string) => {
    if (!diffEditor) return;
    const maxLine = offset + Math.max(countLines(original), countLines(modified));
    const minChars = Math.max(2, String(maxLine).length);
    const lineNumbers = (lineNumber: number) => String(lineNumber + offset);
    const options = { lineNumbers, lineNumbersMinChars: minChars };
    const editorAny = diffEditor as {
      getOriginalEditor?: () => { updateOptions?: (opts: unknown) => void };
      getModifiedEditor?: () => { updateOptions?: (opts: unknown) => void };
      updateOptions?: (opts: unknown) => void;
    };
    editorAny.getOriginalEditor?.()?.updateOptions?.(options);
    editorAny.getModifiedEditor?.()?.updateOptions?.(options);
    editorAny.updateOptions?.(options);
  };

  const resetDiffEditor = () => {
    diffOriginalModel?.dispose?.();
    diffModifiedModel?.dispose?.();
    diffOriginalModel = null;
    diffModifiedModel = null;
    if (diffEditor) {
      const diffEditorAny = diffEditor as {
        setModel?: (model: { original: unknown; modified: unknown } | null) => void;
        dispose?: () => void;
      };
      diffEditorAny.setModel?.(null);
      diffEditorAny.dispose?.();
      diffEditor = null;
    }
    if (blockDiffContainer instanceof HTMLElement) {
      blockDiffContainer.innerHTML = "";
    }
  };

  const showDiffModal = (
    original: string,
    modified: string,
    lineOffset = 0,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) return;
    const monacoApiAny = monacoApi as {
      editor: {
        createDiffEditor: (el: HTMLElement, options: unknown) => unknown;
        createModel: (val: string, lang: string) => unknown;
      };
    };
    const container = blockDiffContainer;
    if (!container) return;

    if (!diffContext) {
      diffContext = { type: "block" };
    }
    if (diffModal) {
      diffModal.classList.add("is-open");
      diffModal.setAttribute("aria-hidden", "false");
    }

    if (!diffEditor) {
      container.innerHTML = "";
      diffEditor = monacoApiAny.editor.createDiffEditor(container, {
        originalEditable: false,
        readOnly: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false,
        renderIndicators: true,
        renderMarginRevertIcon: false,
        diffWordWrap: "off",
        wordWrap: "off",
        hideUnchangedRegions: { enabled: false },
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        renderOverviewRuler: false,
        overviewRulerBorder: false,
        occurrencesHighlight: false,
        selectionHighlight: false,
        lineNumbers: "on",
        fontSize: 12,
        lineHeight: 20,
        fontFamily: '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace',
      });
    } else {
      const diffEditorAny = diffEditor as {
        getDomNode?: () => HTMLElement | null;
        getContainerDomNode?: () => HTMLElement | null;
        layout?: () => void;
      };
      const diffNode = diffEditorAny.getDomNode?.() ?? diffEditorAny.getContainerDomNode?.() ?? null;
      if (diffNode && !container.contains(diffNode)) {
        container.innerHTML = "";
        container.appendChild(diffNode);
      }
      diffEditorAny.layout?.();
    }

    renderDiffHeader();
    if (diffModalSubmit instanceof HTMLButtonElement) {
      const submitLabel = options?.submitLabel;
      diffModalSubmit.textContent =
        typeof submitLabel === "string" && submitLabel.trim().length > 0
          ? submitLabel
          : defaultDiffSubmitLabel;
    }
    if (options) {
      setDiffHeader(options);
    }
    renderDiffSummary(original, modified);

    const diffEditorAny = diffEditor as {
      setModel?: (model: { original: unknown; modified: unknown }) => void;
      getModel?: () => { original?: unknown; modified?: unknown } | null;
    };

    diffOriginalModel?.dispose?.();
    diffModifiedModel?.dispose?.();
    const lang = detectLanguage(options?.fileName ?? deps.getActiveFilePath());
    diffOriginalModel = monacoApiAny.editor.createModel(original, lang);
    diffModifiedModel = monacoApiAny.editor.createModel(modified, lang);
    diffEditorAny.setModel?.({
      original: diffOriginalModel,
      modified: diffModifiedModel,
    });
    applyDiffLineNumberOffset(lineOffset, original, modified);
    if (typeof (diffEditor as any).layout === "function") {
      (diffEditor as any).layout();
    }
    // Scroll to first change
    requestAnimationFrame(() => {
      const editorAny = diffEditor as {
        getModifiedEditor?: () => { revealLine?: (line: number, scrollType?: number) => void };
      };
      const modEditor = editorAny.getModifiedEditor?.();
      if (!modEditor?.revealLine) return;
      const beforeLines = original.split(/\r?\n/);
      const afterLines = modified.split(/\r?\n/);
      for (let k = 0; k < afterLines.length; k++) {
        if (beforeLines[k] !== afterLines[k]) {
          modEditor.revealLine(Math.max(1, k + 1 - 2)); // 2 lines above for context
          break;
        }
      }
    });
  };

  /* ── Multi-file HTML diff (Pattern B: vertical concatenation) ── */

  const computeDiffCounts = (original: string, modified: string) => {
    const bLines = original.trimEnd().length ? original.trimEnd().split(/\r?\n/) : [""];
    const aLines = modified.trimEnd().length ? modified.trimEnd().split(/\r?\n/) : [""];
    const lines = buildLineDiff(bLines, aLines);
    let adds = 0;
    let dels = 0;
    lines.forEach((e) => { if (e.type === "add") adds++; else if (e.type === "del") dels++; });
    return { adds, dels, diffLines: lines };
  };

  const renderSideBySideDiff = (diffLines: ReturnType<typeof buildLineDiff>) => {
    // Build left (original) and right (modified) line arrays
    const leftLines: { text: string; type: "same" | "del" | "empty" }[] = [];
    const rightLines: { text: string; type: "same" | "add" | "empty" }[] = [];
    let li = 0;
    let ri = 0;
    for (const entry of diffLines) {
      if (entry.type === "same") {
        li++;
        ri++;
        leftLines.push({ text: entry.line, type: "same" });
        rightLines.push({ text: entry.line, type: "same" });
      } else if (entry.type === "del") {
        li++;
        leftLines.push({ text: entry.line, type: "del" });
        rightLines.push({ text: "", type: "empty" });
      } else {
        ri++;
        leftLines.push({ text: "", type: "empty" });
        rightLines.push({ text: entry.line, type: "add" });
      }
    }

    const wrapper = document.createElement("div");
    wrapper.className = "multi-diff-editor";
    const leftCol = document.createElement("div");
    leftCol.className = "multi-diff-col multi-diff-original";
    const rightCol = document.createElement("div");
    rightCol.className = "multi-diff-col multi-diff-modified";
    let firstChangeLine: HTMLElement | null = null;

    for (let i = 0; i < leftLines.length; i++) {
      const ll = leftLines[i];
      const rl = rightLines[i];
      const leftDiv = document.createElement("div");
      leftDiv.className = `multi-diff-line is-${ll.type}`;
      leftDiv.textContent = ll.type !== "empty" ? ll.text : "";
      const rightDiv = document.createElement("div");
      rightDiv.className = `multi-diff-line is-${rl.type}`;
      rightDiv.textContent = rl.type !== "empty" ? rl.text : "";
      leftCol.appendChild(leftDiv);
      rightCol.appendChild(rightDiv);
      if (!firstChangeLine && (ll.type !== "same" || rl.type !== "same")) {
        firstChangeLine = leftDiv;
      }
    }
    wrapper.append(leftCol, rightCol);
    return { element: wrapper, firstChangeLine };
  };

  const showMultiFileDiff = (
    files: FileDiff[],
    options?: { title?: string; submitLabel?: string }
  ) => {
    const container = blockDiffContainer;
    if (!container) return;
    if (!diffContext) diffContext = { type: "aiApply", proposalIds: [] };

    // Open modal
    if (diffModal) {
      diffModal.classList.add("is-open");
      diffModal.setAttribute("aria-hidden", "false");
    }
    // Dispose any Monaco editor
    resetDiffEditor();

    // Header
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent = options?.title ?? "Confirm changes";
    }
    if (diffFileName instanceof HTMLElement) {
      diffFileName.textContent = `${files.length}file`;
    }
    if (diffModalSubmit instanceof HTMLButtonElement) {
      diffModalSubmit.textContent = options?.submitLabel ?? defaultDiffSubmitLabel;
    }

    // Compute totals
    let totalAdds = 0;
    let totalDels = 0;
    const fileDiffs = files.map((f) => {
      const { adds, dels, diffLines } = computeDiffCounts(f.original, f.modified);
      totalAdds += adds;
      totalDels += dels;
      return { ...f, adds, dels, diffLines };
    });

    // Render summary
    if (diffSummary instanceof HTMLElement) {
      diffSummary.textContent = "";
      if (totalAdds > 0 || totalDels > 0) {
        const addEl = document.createElement("span");
        addEl.className = "diff-summary-item is-add";
        addEl.textContent = `+${totalAdds}`;
        const delEl = document.createElement("span");
        delEl.className = "diff-summary-item is-del";
        delEl.textContent = `-${totalDels}`;
        diffSummary.append(addEl, delEl);
      }
    }

    // Render file sections
    container.innerHTML = "";
    const scrollArea = document.createElement("div");
    scrollArea.className = "multi-diff-scroll";
    let globalFirstChange: HTMLElement | null = null;

    for (const fd of fileDiffs) {
      const section = document.createElement("div");
      section.className = "multi-diff-section";

      // File header
      const fileHeader = document.createElement("div");
      fileHeader.className = "multi-diff-file-header";
      const nameSpan = document.createElement("span");
      nameSpan.className = "multi-diff-file-name";
      nameSpan.textContent = fd.fileName;
      const countsSpan = document.createElement("span");
      countsSpan.className = "diff-summary";
      if (fd.adds > 0) {
        const a = document.createElement("span");
        a.className = "diff-summary-item is-add";
        a.textContent = `+${fd.adds}`;
        countsSpan.appendChild(a);
      }
      if (fd.dels > 0) {
        const d = document.createElement("span");
        d.className = "diff-summary-item is-del";
        d.textContent = `-${fd.dels}`;
        countsSpan.appendChild(d);
      }
      fileHeader.append(nameSpan, countsSpan);
      section.appendChild(fileHeader);

      // Side-by-side diff
      const { element, firstChangeLine } = renderSideBySideDiff(fd.diffLines);
      section.appendChild(element);
      scrollArea.appendChild(section);

      if (!globalFirstChange && firstChangeLine) {
        globalFirstChange = firstChangeLine;
      }
    }

    container.appendChild(scrollArea);

    // Scroll to first change
    if (globalFirstChange) {
      requestAnimationFrame(() => {
        globalFirstChange!.scrollIntoView({ block: "center" });
      });
    }
  };

  const closeDiffModal = () => {
    if (diffModal) {
      diffModal.classList.remove("is-open");
      diffModal.setAttribute("aria-hidden", "true");
    }
    if (diffSummary instanceof HTMLElement) {
      diffSummary.textContent = "";
    }
    if (diffFileName instanceof HTMLElement) {
      diffFileName.textContent = "";
    }
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent = "Confirm changes";
    }
    if (diffModalSubmit instanceof HTMLButtonElement) {
      diffModalSubmit.textContent = defaultDiffSubmitLabel;
    }
    diffContext = null;
    resetDiffEditor();
  };

  // Plain Enter confirms (inserts) while the diff modal is open. Captured at the
  // document level so the keystroke never reaches the editor behind the modal;
  // the diff preview is read-only, so Enter has no competing meaning here.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(diffModal instanceof HTMLElement) || !diffModal.classList.contains("is-open")) {
        return;
      }
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }
      if (!(diffModalSubmit instanceof HTMLButtonElement) || diffModalSubmit.disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      diffModalSubmit.click();
    },
    true
  );

  return {
    showDiffModal,
    showMultiFileDiff,
    closeDiffModal,
    resetDiffEditor,
    getDiffContext: () => diffContext,
    setDiffContext: (context) => {
      diffContext = context;
    },
  };
};
