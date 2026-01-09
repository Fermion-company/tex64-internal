import type { AppContext } from "./context.js";
import type { EditorSessionApi } from "./editor-session.js";
import type { PostToNative } from "./bridge-sender.js";
import type { IssuesStatus, IssueItem } from "./types.js";
import type {
  AlchemyPreviewApi,
  AlchemyItem,
  AlchemyItemKind,
} from "./alchemy-preview-ui.js";
import { convertHtmlToLatex, extractPlainText } from "./html-to-latex.js";
import { formatSnippetForInsert } from "./blocks/format.js";
import {
  buildFigureSnippet,
  buildMathSnippet,
  buildTableSnippet,
  buildTextSnippet,
  FigureFormat,
  MathFormat,
  TableFormat,
  TextFormat,
} from "./snippet-builders.js";
import { importPdfFromBase64, type PdfImportPage } from "./pdf-import.js";
import { recognizeImage } from "./ocr.js";

type ClipboardPayload = {
  requestId?: string;
  formats?: string[];
  text?: string;
  html?: string;
  imageDataUrl?: string;
  pdfBase64?: string;
};

type StoredItem = {
  id: string;
  kind: AlchemyItemKind;
  tag?: string;
  score?: number | string | null;
  status?: "ready" | "processing" | "error";
  formats: string[];
  format: string;
  mode?: string;
  modeOptions?: string[];
  preview: AlchemyItem["preview"];
  snippet?: string;
  source: {
    text?: string;
    latex?: string;
    rows?: string[][];
    imageDataUrl?: string;
    savedPath?: string;
    pdfText?: string;
    ocrText?: string;
    pdfPage?: number;
    ocrRequestId?: string;
    ocrLanguage?: string;
  };
};

type PasteAlchemyDeps = {
  alchemyPreview: AlchemyPreviewApi;
  editorSession: EditorSessionApi;
  postToNative: PostToNative;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  getMonacoApi: () => Record<string, unknown> | null;
};

export type PasteAlchemyApi = {
  requestClipboardRead: () => void;
  handleClipboardPayload: (payload: ClipboardPayload) => void;
  handleImageSaved: (payload: {
    requestId?: string;
    ok?: boolean;
    path?: string;
    error?: string;
  }) => void;
  handleCaptureImage: (imageDataUrl: string, tag?: string) => void;
  getItemSnippet: (id: string) => Promise<string>;
  applyEditedSnippet: (id: string, snippet: string) => void;
};

const generateId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `alchemy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeCell = (value: string) =>
  value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();

const PDF_MODE_OPTIONS = ["Auto", "PDFテキスト", "OCR"] as const;
type PdfMode = (typeof PDF_MODE_OPTIONS)[number];
const MIN_PDF_TEXT_LENGTH = 24;

const normalizePdfMode = (mode?: string): PdfMode => {
  if (mode && (PDF_MODE_OPTIONS as readonly string[]).includes(mode)) {
    return mode as PdfMode;
  }
  return "Auto";
};

const hasUsefulPdfText = (text: string) =>
  text.replace(/\s+/g, "").length >= MIN_PDF_TEXT_LENGTH;

const parseTablesFromHtml = (html: string) => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table")).map((table) => {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map((cell) =>
        normalizeCell(cell.textContent ?? "")
      )
    );
    const headers =
      rows.length > 0 && table.querySelector("th") ? rows.shift() ?? [] : [];
    return { headers, rows };
  });
  doc.querySelectorAll("table").forEach((table) => table.remove());
  return { tables, html: doc.body.innerHTML };
};

export const initPasteAlchemy = (
  context: AppContext,
  deps: PasteAlchemyDeps
): PasteAlchemyApi => {
  const { editorHost, editorHostSecondary } = context.dom;
  const pendingClipboard = new Set<string>();
  const pendingImageSaves = new Map<
    string,
    { resolve: (path: string) => void; reject: (message: string) => void }
  >();
  const enablePasteIntercept = false;
  let storedItems: StoredItem[] = [];

  const refreshUi = () => {
    const items: AlchemyItem[] = storedItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      tag: item.tag,
      score: item.score,
      status: item.status,
      formats: item.formats,
      format: item.format,
      mode: item.mode,
      modeOptions: item.modeOptions,
      preview: item.preview,
      snippet: item.snippet,
    }));
    deps.alchemyPreview.setItems(items);
  };

  const ensureSnippet = async (item: StoredItem) => {
    const targetId = item.id;
    try {
      const snippet = await buildSnippet(item);
      item.snippet = snippet;
    } catch {
      item.snippet = "";
    }
    if (storedItems.some((entry) => entry.id === targetId)) {
      refreshUi();
    }
  };

  const discardItem = (id: string) => {
    storedItems = storedItems.filter((item) => item.id !== id);
    refreshUi();
  };

  const discardAll = () => {
    storedItems = [];
    deps.alchemyPreview.clearItems();
  };

  const updateItemFormat = (id: string, format: string) => {
    const item = storedItems.find((entry) => entry.id === id);
    if (!item) return;
    item.format = format;
    void ensureSnippet(item);
  };

  const isOcrModeActive = (item: StoredItem) => {
    const pdfText = item.source.pdfText ?? "";
    const mode = normalizePdfMode(item.mode);
    if (mode === "OCR") return true;
    if (mode === "Auto") return !hasUsefulPdfText(pdfText);
    return false;
  };

  const startOcrForItem = (item: StoredItem, language: string) => {
    if (!item.source.imageDataUrl) {
      item.preview = { type: "text", value: "OCR対象がありません。" };
      item.status = "error";
      item.score = "OCR不可";
      return;
    }
    if (item.status === "processing" && item.source.ocrRequestId) {
      return;
    }
    const requestId = generateId();
    item.source.ocrRequestId = requestId;
    item.source.ocrLanguage = language;
    item.status = "processing";
    item.score = "OCR中";
    item.preview = { type: "image", url: item.source.imageDataUrl };
    if (storedItems.some((entry) => entry.id === item.id)) {
      refreshUi();
    }
    recognizeImage(item.source.imageDataUrl, { language })
      .then((result) => {
        const current = storedItems.find((entry) => entry.id === item.id);
        if (!current || current.source.ocrRequestId !== requestId) {
          return;
        }
        const text = result.text.trim();
        current.source.ocrText = text;
        current.source.text = text;
        current.source.ocrRequestId = undefined;
        if (isOcrModeActive(current)) {
          current.preview = {
            type: "text",
            value: text || "OCR結果が空でした。",
          };
          current.status = text ? "ready" : "error";
          current.score = text ? null : "OCR結果なし";
        }
        void ensureSnippet(current);
        refreshUi();
      })
      .catch((error) => {
        const current = storedItems.find((entry) => entry.id === item.id);
        if (!current || current.source.ocrRequestId !== requestId) {
          return;
        }
        current.source.ocrRequestId = undefined;
        if (isOcrModeActive(current)) {
          current.preview = {
            type: "text",
            value: error instanceof Error ? error.message : "OCRに失敗しました。",
          };
          current.status = "error";
          current.score = "OCR失敗";
        }
        refreshUi();
      });
  };

  const applyPdfMode = (item: StoredItem, mode: string) => {
    const normalizedMode = normalizePdfMode(mode);
    item.mode = normalizedMode;
    const pdfText = item.source.pdfText ?? "";
    const effectiveMode =
      normalizedMode === "Auto"
        ? hasUsefulPdfText(pdfText)
          ? "PDFテキスト"
          : "OCR"
        : normalizedMode;
    if (effectiveMode === "PDFテキスト") {
      const text = pdfText.trim();
      item.source.text = text;
      item.preview = {
        type: "text",
        value: text || "PDFテキストが見つかりませんでした。",
      };
      item.status = text ? "ready" : "error";
      item.score = null;
      return;
    }
    const settings = deps.alchemyPreview.getSettings();
    const language = settings.ocrLanguage || "eng";
    const ocrText = item.source.ocrText ?? "";
    if (ocrText && item.source.ocrLanguage === language) {
      item.source.text = ocrText;
      item.preview = { type: "text", value: ocrText };
      item.status = "ready";
      item.score = null;
      return;
    }
    startOcrForItem(item, language);
  };

  const updateItemMode = (id: string, mode: string) => {
    const item = storedItems.find((entry) => entry.id === id);
    if (!item || !item.modeOptions || item.modeOptions.length === 0) return;
    applyPdfMode(item, mode);
    refreshUi();
    void ensureSnippet(item);
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
    const editor = activeGroup.editor as {
      executeEdits?: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus?: () => void;
      getPosition?: () => { lineNumber: number; column: number } | null;
      getSelection?: () => {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      } | null;
      getModel?: () => {
        getLineContent?: (lineNumber: number) => string;
      };
    };
    const monaco = deps.getMonacoApi() as {
      Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    if (!monaco?.Range) {
      deps.updateIssues(1, "エディタの準備が完了していません。", "error", [
        { severity: "error", message: "エディタの準備が完了していません。" },
      ]);
      return false;
    }
    const selection = editor.getSelection?.();
    const position = editor.getPosition?.() ?? { lineNumber: 1, column: 1 };
    const insertPosition = selection
      ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
      : position;
    const model = editor.getModel?.();
    const formatted = formatSnippetForInsert(snippet, model, insertPosition);
    const range = selection
      ? new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        )
      : new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column
        );
    editor.executeEdits?.("alchemy-insert", [
      { range, text: formatted, forceMoveMarkers: true },
    ]);
    editor.focus?.();
    return true;
  };

  const saveImage = (dataUrl: string) =>
    new Promise<string>((resolve, reject) => {
      const requestId = generateId();
      pendingImageSaves.set(requestId, { resolve, reject });
      const ok = deps.postToNative(
        { type: "alchemy:save-image", requestId, dataUrl },
        true
      );
      if (!ok) {
        pendingImageSaves.delete(requestId);
        reject("画像の保存要求に失敗しました。");
      }
    });

  const buildSnippet = async (item: StoredItem) => {
    if (item.kind === "text") {
      const baseText = item.source.text ?? item.source.latex ?? "";
      if (!baseText) return "";
      if (item.source.latex && item.format === "plain") {
        return item.source.latex;
      }
      return buildTextSnippet(baseText, item.format as TextFormat);
    }
    if (item.kind === "math") {
      const latex = item.source.latex ?? "";
      return buildMathSnippet(latex, item.format as MathFormat);
    }
    if (item.kind === "table") {
      return buildTableSnippet(item.source.rows ?? [], item.format as TableFormat);
    }
    if (item.kind === "figure") {
      if (!item.source.imageDataUrl) return "";
      if (item.source.savedPath) {
        return buildFigureSnippet(item.source.savedPath, item.format as FigureFormat);
      }
      const savedPath = await saveImage(item.source.imageDataUrl);
      item.source.savedPath = savedPath;
      return buildFigureSnippet(savedPath, item.format as FigureFormat);
    }
    return "";
  };

  const applyItem = async (id: string) => {
    const item = storedItems.find((entry) => entry.id === id);
    if (!item) return;
    try {
      const snippet = item.snippet || (await buildSnippet(item));
      if (snippet && !item.snippet) {
        item.snippet = snippet;
      }
      if (!snippet) {
        const isPdfItem = item.source.pdfPage !== undefined;
        const message = isPdfItem
          ? item.mode === "OCR" || item.mode === "Auto"
            ? "OCR結果がありません。PDFテキストに切り替えてください。"
            : "PDFテキストが空でした。"
          : "挿入する内容がありません。";
        deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        return;
      }
      const ok = insertSnippet(snippet);
      if (!ok) {
        return;
      }
      discardItem(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "挿入に失敗しました。";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
    }
  };

  const getItemSnippet = async (id: string) => {
    const item = storedItems.find((entry) => entry.id === id);
    if (!item) return "";
    if (item.snippet) {
      return item.snippet;
    }
    try {
      const snippet = await buildSnippet(item);
      item.snippet = snippet;
      refreshUi();
      return snippet;
    } catch (error) {
      const message = error instanceof Error ? error.message : "挿入内容の生成に失敗しました。";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      return "";
    }
  };

  const applyEditedSnippet = (id: string, snippet: string) => {
    const trimmed = snippet.trim();
    if (!trimmed) {
      deps.updateIssues(1, "挿入する内容がありません。", "error", [
        { severity: "error", message: "挿入する内容がありません。" },
      ]);
      return;
    }
    const ok = insertSnippet(snippet);
    if (!ok) {
      return;
    }
    discardItem(id);
  };

  const applyAll = async () => {
    const current = [...storedItems];
    for (const item of current) {
      await applyItem(item.id);
    }
  };

  const createPdfItem = (page: PdfImportPage, mode: string) => {
    const item: StoredItem = {
      id: generateId(),
      kind: "text",
      tag: `PDF p.${page.pageNumber}`,
      formats: ["plain", "quote", "itemize"],
      format: "plain",
      modeOptions: [...PDF_MODE_OPTIONS],
      mode: normalizePdfMode(mode),
      preview: { type: "text", value: "" },
      source: {
        pdfPage: page.pageNumber,
        pdfText: page.text,
        imageDataUrl: page.imageDataUrl,
      },
    };
    applyPdfMode(item, item.mode ?? "Auto");
    return item;
  };

  const importPdfPayload = async (pdfBase64: string) => {
    deps.alchemyPreview.setOpen(true);
    const placeholderId = generateId();
    storedItems = storedItems.concat({
      id: placeholderId,
      kind: "text",
      tag: "PDF",
      status: "processing",
      formats: ["plain"],
      format: "plain",
      preview: { type: "text", value: "PDFを解析中..." },
      source: {},
    });
    refreshUi();
    const settings = deps.alchemyPreview.getSettings();
    try {
      const pages = await importPdfFromBase64(pdfBase64, { scale: 2 });
      storedItems = storedItems.filter((item) => item.id !== placeholderId);
      if (pages.length === 0) {
        deps.updateIssues(0, "PDFにページがありませんでした。", "info", []);
        refreshUi();
        return;
      }
      const pdfItems = pages.map((page) => createPdfItem(page, settings.pdfMode));
      storedItems = storedItems.concat(pdfItems);
      refreshUi();
      pdfItems.forEach((item) => {
        void ensureSnippet(item);
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "PDFの取り込みに失敗しました。";
      const placeholder = storedItems.find((item) => item.id === placeholderId);
      if (placeholder) {
        placeholder.status = "error";
        placeholder.preview = { type: "text", value: message };
      }
      refreshUi();
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
    }
  };

  const handleClipboardPayload = (payload: ClipboardPayload) => {
    if (payload.requestId) {
      if (!pendingClipboard.has(payload.requestId)) {
        return;
      }
      pendingClipboard.delete(payload.requestId);
    }
    const settings = deps.alchemyPreview.getSettings();
    const nextItems: StoredItem[] = [];
    if (payload.html) {
      const parsed = parseTablesFromHtml(payload.html);
      parsed.tables.forEach((table) => {
        const id = generateId();
        nextItems.push({
          id,
          kind: "table",
          tag: "HTML表",
          formats: ["tabular", "tabularx", "longtable"],
          format: settings.defaultTable,
          preview: {
            type: "table",
            headers: table.headers,
            rows: table.rows,
          },
          source: {
            rows: table.rows,
          },
        });
      });
      const plainText = extractPlainText(parsed.html);
      const latex = convertHtmlToLatex(parsed.html);
      if (plainText || latex) {
        const id = generateId();
        nextItems.push({
          id,
          kind: "text",
          tag: "HTML",
          formats: ["plain", "quote", "itemize"],
          format: "plain",
          preview: { type: "text", value: plainText || latex },
          source: { text: plainText, latex },
        });
      }
    } else if (payload.text) {
      const id = generateId();
      nextItems.push({
        id,
        kind: "text",
        tag: "テキスト",
        formats: ["plain", "quote", "itemize"],
        format: "plain",
        preview: { type: "text", value: payload.text },
        source: { text: payload.text },
      });
    }

    if (payload.imageDataUrl) {
      const id = generateId();
      nextItems.push({
        id,
        kind: "figure",
        tag: "画像",
        formats: ["includegraphics", "figure"],
        format: settings.defaultFigure,
        preview: { type: "image", url: payload.imageDataUrl },
        source: { imageDataUrl: payload.imageDataUrl },
      });
    }
    const hasPdf = Boolean(payload.pdfBase64);

    if (nextItems.length === 0 && !hasPdf) {
      deps.updateIssues(0, "取り込み対象が見つかりませんでした。", "info", []);
      return;
    }
    if (nextItems.length > 0) {
      storedItems = storedItems.concat(nextItems);
      refreshUi();
      deps.alchemyPreview.setOpen(true);
      nextItems.forEach((item) => {
        void ensureSnippet(item);
      });
    }
    if (payload.pdfBase64) {
      void importPdfPayload(payload.pdfBase64);
    }
  };

  const handleCaptureImage = (imageDataUrl: string, tag = "キャプチャ") => {
    if (!imageDataUrl) return;
    const settings = deps.alchemyPreview.getSettings();
    const id = generateId();
    const item: StoredItem = {
      id,
      kind: "figure",
      tag,
      formats: ["includegraphics", "figure"],
      format: settings.defaultFigure,
      preview: { type: "image", url: imageDataUrl },
      source: { imageDataUrl },
    };
    storedItems = storedItems.concat(item);
    refreshUi();
    deps.alchemyPreview.setOpen(true);
    void ensureSnippet(item);
  };

  const handleImageSaved = (payload: {
    requestId?: string;
    ok?: boolean;
    path?: string;
    error?: string;
  }) => {
    const requestId = payload.requestId;
    if (!requestId) return;
    const pending = pendingImageSaves.get(requestId);
    if (!pending) return;
    pendingImageSaves.delete(requestId);
    if (payload.ok && payload.path) {
      pending.resolve(payload.path);
      return;
    }
    pending.reject(payload.error ?? "画像の保存に失敗しました。");
  };

  const requestClipboardRead = () => {
    const requestId = generateId();
    pendingClipboard.add(requestId);
    deps.postToNative({ type: "alchemy:clipboard:read", requestId }, true);
    deps.alchemyPreview.setOpen(true);
  };

  const shouldInterceptPaste = (event: ClipboardEvent) => {
    const types = Array.from(event.clipboardData?.types ?? []);
    if (types.length === 1 && types[0] === "text/plain") {
      return false;
    }
    return (
      types.includes("text/html") ||
      types.some((type) => type.startsWith("image/")) ||
      types.some((type) => type.toLowerCase().includes("pdf"))
    );
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) {
      return;
    }
    if (!shouldInterceptPaste(event)) {
      return;
    }
    const target = event.target as Node | null;
    const inPrimary = editorHost instanceof HTMLElement && target && editorHost.contains(target);
    const inSecondary =
      editorHostSecondary instanceof HTMLElement &&
      target &&
      editorHostSecondary.contains(target);
    if (!inPrimary && !inSecondary) {
      return;
    }
    event.preventDefault();
    const requestId = generateId();
    pendingClipboard.add(requestId);
    deps.postToNative({ type: "alchemy:clipboard:read", requestId }, true);
    deps.alchemyPreview.setOpen(true);
  };

  if (enablePasteIntercept && editorHost instanceof HTMLElement) {
    editorHost.addEventListener("paste", handlePaste);
  }
  if (enablePasteIntercept && editorHostSecondary instanceof HTMLElement) {
    editorHostSecondary.addEventListener("paste", handlePaste);
  }

  deps.alchemyPreview.setHandlers({
    onApplyItem: (id) => {
      void applyItem(id);
    },
    onDiscardItem: discardItem,
    onApplyAll: () => {
      void applyAll();
    },
    onDiscardAll: discardAll,
    onFormatChange: updateItemFormat,
    onModeChange: updateItemMode,
  });

  return {
    requestClipboardRead,
    handleClipboardPayload,
    handleImageSaved,
    handleCaptureImage,
    getItemSnippet,
    applyEditedSnippet,
  };
};
