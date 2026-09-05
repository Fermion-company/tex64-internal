import { loadPdfjs } from "./pdfjs";
import type { AttachmentKind, ChatAttachment, MessagePart } from "./types";

/**
 * Files the reader sends with a message. Everything the agent can use is
 * turned into what the desktop agent accepts — text for tables, PDFs and
 * documents, inline images for figures and pages — and the original is saved
 * into the workspace so the paper can include it.
 */

export const MAX_ATTACHMENTS = 6;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Host limits for inline images: 5 MB each, 8 MB per message.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
const MAX_PDF_PAGE_IMAGES = 3;
const MAX_PDF_TEXT_PAGES = 8;
const MAX_TEXT_CHARS = 12_000;
const MAX_SHEETS = 4;
const MAX_SHEET_ROWS = 200;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv", "tsv"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "json", "tex", "bib", "dat"]);
const OTHER_EXTENSIONS = new Set(["svg"]);

export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Object URL of the image itself, for the chip thumbnail. */
  previewUrl: string | null;
}

export interface PreparedAttachments {
  parts: MessagePart[];
  /** What the chat shows under the message. */
  attachments: ChatAttachment[];
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function attachmentKindOf(file: File): AttachmentKind | null {
  const extension = extensionOf(file.name);
  if (IMAGE_EXTENSIONS.has(extension) || (file.type.startsWith("image/") && !extension)) return "image";
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (SHEET_EXTENSIONS.has(extension)) return "sheet";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (OTHER_EXTENSIONS.has(extension)) return "file";
  return null;
}

/** Why a file cannot be attached, or null when it can. */
export function rejectAttachment(file: File, current: PendingAttachment[]): string | null {
  if (current.length >= MAX_ATTACHMENTS) return `添付は ${MAX_ATTACHMENTS} 件までです。`;
  if (file.size === 0) return `${file.name} は空のファイルです。`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} は 20 MB を超えています。`;
  if (!attachmentKindOf(file)) return `${file.name} の形式は扱えません（画像・PDF・Excel/CSV・テキスト）。`;
  return null;
}

let attachmentSequence = 0;

export function createPendingAttachment(file: File): PendingAttachment | null {
  const kind = attachmentKindOf(file);
  if (!kind) return null;
  attachmentSequence += 1;
  const name = file.name || (kind === "image" ? `image-${attachmentSequence}.png` : `file-${attachmentSequence}`);
  return {
    id: `attachment-${Date.now()}-${attachmentSequence}`,
    file,
    name,
    size: file.size,
    kind,
    previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
  };
}

export function releasePendingAttachment(attachment: PendingAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const readAsArrayBuffer = (file: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });

const readAsText = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });

const base64Of = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunk) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

/** Base64 of the original bytes, for saving the file into the workspace. */
export async function attachmentBase64(file: File): Promise<string> {
  return base64Of(await readAsArrayBuffer(file));
}

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

interface InlineImage {
  mimeType: string;
  data: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Draws a bitmap no larger than the model needs and encodes it under the
 * host's per-image limit: PNG keeps line art and screenshots crisp, JPEG
 * takes over when a photo would otherwise be too large.
 */
async function encodeInlineImage(
  source: ImageBitmap | HTMLCanvasElement,
  preferPng: boolean,
): Promise<InlineImage | null> {
  const width = source.width;
  const height = source.height;
  const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return null;
  if (!preferPng) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const attempts: Array<[string, number | undefined]> = preferPng
    ? [["image/png", undefined], ["image/jpeg", 0.85], ["image/jpeg", 0.7]]
    : [["image/jpeg", 0.85], ["image/jpeg", 0.7], ["image/jpeg", 0.5]];
  for (const [type, quality] of attempts) {
    const blob = await canvasToBlob(canvas, type, quality);
    if (!blob || blob.size > MAX_INLINE_IMAGE_BYTES) continue;
    return {
      mimeType: type,
      data: base64Of(await readAsArrayBuffer(blob)),
      bytes: blob.size,
      width: canvas.width,
      height: canvas.height,
    };
  }
  return null;
}

async function prepareImage(file: File): Promise<{ inline: InlineImage | null; note: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const preferPng = file.type === "image/png" || file.type === "image/gif" || file.type === "image/bmp";
    const inline = await encodeInlineImage(bitmap, preferPng);
    const note = `画像 ${bitmap.width}×${bitmap.height}`;
    bitmap.close();
    return { inline, note };
  } catch {
    return { inline: null, note: "画像" };
  }
}

async function preparePdf(file: File): Promise<{ inline: InlineImage[]; text: string; note: string }> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await readAsArrayBuffer(file));
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const inline: InlineImage[] = [];
  const textPages: string[] = [];
  let textChars = 0;
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, MAX_PDF_TEXT_PAGES); pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      if (textChars < MAX_TEXT_CHARS) {
        const content = await page.getTextContent();
        let pageText = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          pageText += item.str;
          pageText += item.hasEOL ? "\n" : " ";
        }
        const trimmed = pageText.replace(/[ \t]+\n/g, "\n").trim();
        if (trimmed) {
          const room = MAX_TEXT_CHARS - textChars;
          const slice = trimmed.length > room ? `${trimmed.slice(0, room)}…` : trimmed;
          textPages.push(`[p.${pageNumber}]\n${slice}`);
          textChars += slice.length;
        }
      }
      if (pageNumber <= MAX_PDF_PAGE_IMAGES) {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(base.width, base.height, 1));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        await page.render({ canvas, viewport }).promise;
        const encoded = await encodeInlineImage(canvas, false);
        if (encoded) inline.push(encoded);
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  const shownPages = Math.min(pageCount, MAX_PDF_PAGE_IMAGES);
  const note = `PDF ${pageCount} ページ${
    inline.length > 0 ? `、先頭 ${shownPages} ページの画像` : ""
  }${textPages.length > 0 ? `、本文抜粋（${Math.min(pageCount, MAX_PDF_TEXT_PAGES)} ページまで）` : ""}`;
  return { inline, text: textPages.join("\n\n"), note };
}

async function prepareSheet(file: File): Promise<{ text: string; note: string }> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await readAsArrayBuffer(file), { type: "array", cellDates: true });
  const sections: string[] = [];
  const summaries: string[] = [];
  let chars = 0;
  for (const sheetName of workbook.SheetNames.slice(0, MAX_SHEETS)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const rows = range.e.r - range.s.r + 1;
    const cols = range.e.c - range.s.c + 1;
    summaries.push(`${sheetName}: ${rows}行×${cols}列`);
    if (chars >= MAX_TEXT_CHARS) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const shown = lines.slice(0, MAX_SHEET_ROWS);
    let body = shown.join("\n");
    const room = MAX_TEXT_CHARS - chars;
    if (body.length > room) body = `${body.slice(0, room)}…`;
    chars += body.length;
    const omitted = lines.length - shown.length;
    sections.push(
      `--- ${file.name} / ${sheetName} (CSV, ${rows}行×${cols}列${omitted > 0 ? `、先頭 ${shown.length} 行` : ""}) ---\n${body}`,
    );
  }
  return {
    text: sections.join("\n\n"),
    note: summaries.length > 0 ? `表 ${summaries.join("、")}` : "表",
  };
}

async function prepareText(file: File): Promise<{ text: string; note: string }> {
  const raw = await readAsText(file);
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  const body = trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed;
  const lines = trimmed.split("\n").length;
  return {
    text: `--- ${file.name} (${lines} 行) ---\n${body}`,
    note: `テキスト ${lines} 行`,
  };
}

/**
 * Turns the pending files into the parts of one message. `importFile` saves
 * the original into the workspace and returns its path there, or null when
 * it could not be saved; the agent is told either way.
 */
export async function prepareAttachments(
  pending: PendingAttachment[],
  importFile: (attachment: PendingAttachment) => Promise<string | null>,
): Promise<PreparedAttachments> {
  const lines: string[] = [];
  const extracts: string[] = [];
  const images: MessagePart[] = [];
  const attachments: ChatAttachment[] = [];
  let inlineBytes = 0;
  const pushImage = (image: InlineImage | null) => {
    if (!image || inlineBytes + image.bytes > MAX_INLINE_TOTAL_BYTES) return false;
    inlineBytes += image.bytes;
    images.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    return true;
  };

  for (const [index, attachment] of pending.entries()) {
    const savedPath = await importFile(attachment);
    const where = savedPath ? `${savedPath}` : `${attachment.name}（保存できず、内容のみ）`;
    let note = "";
    try {
      if (attachment.kind === "image") {
        const image = await prepareImage(attachment.file);
        const shown = pushImage(image.inline);
        note = `${image.note}${shown ? "、画像を添付" : ""}${savedPath ? "、\\includegraphics で配置可" : ""}`;
      } else if (attachment.kind === "pdf") {
        const pdf = await preparePdf(attachment.file);
        let shown = 0;
        for (const image of pdf.inline) if (pushImage(image)) shown += 1;
        note = pdf.note + (shown === 0 && pdf.inline.length > 0 ? "（画像は容量のため省略）" : "");
        if (pdf.text) extracts.push(`--- ${attachment.name} 本文抜粋 ---\n${pdf.text}`);
      } else if (attachment.kind === "sheet") {
        const sheet = await prepareSheet(attachment.file);
        note = sheet.note;
        if (sheet.text) extracts.push(sheet.text);
      } else if (attachment.kind === "text") {
        const text = await prepareText(attachment.file);
        note = text.note;
        if (text.text) extracts.push(text.text);
      } else {
        note = "ファイル";
      }
    } catch {
      note = "内容を読み取れませんでした";
    }
    lines.push(`${index + 1}. ${where}（${note}）`);
    attachments.push({
      name: attachment.name,
      kind: attachment.kind,
      ...(savedPath ? { path: savedPath } : {}),
    });
  }

  const block = [`[添付ファイル]`, ...lines, ...(extracts.length > 0 ? ["", ...extracts] : [])].join("\n");
  return { parts: [{ text: block }, ...images], attachments };
}

/** The attachment list a stored user message carries, when it does. */
export function splitAttachmentBlock(text: string): { body: string; attachmentCount: number; names: string[] } {
  const marker = text.indexOf("\n[添付ファイル]\n");
  const start = marker >= 0 ? marker : text.startsWith("[添付ファイル]\n") ? 0 : -1;
  if (start < 0) return { body: text, attachmentCount: 0, names: [] };
  const body = text.slice(0, start).trimEnd();
  const lines = text.slice(start).split("\n");
  const markerIndex = lines.indexOf("[添付ファイル]");
  const rest = markerIndex >= 0 ? lines.slice(markerIndex + 1) : [];
  const names: string[] = [];
  for (const line of rest) {
    const match = /^\d+\. (.+?)（/.exec(line);
    if (!match) break;
    names.push((match[1] ?? "").replace(/^assets\//, ""));
  }
  return { body, attachmentCount: names.length, names };
}
