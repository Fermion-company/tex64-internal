import { CompileFailure, type CompileDiagnostic } from "./types";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MIN_PDF_ARTIFACT_BYTES = 64;
const PDF_HEADER_BYTES = 8;
const PDF_TRAILER_SCAN_BYTES = 1_024;

const blockedPatterns: Array<{ code: string; pattern: RegExp }> = [
  { code: "shell_escape", pattern: /\\(?:write18|ShellEscape|DelayedShellEscape)\b/i },
  { code: "direct_lua", pattern: /\\directlua\b/i },
  { code: "file_write", pattern: /\\(?:openout|write|read|openin)\b/i },
  { code: "external_input", pattern: /\\(?:input|include)\s*\{?\s*(?:\/|\.\.|~)/i },
  { code: "unsafe_package", pattern: /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:shellesc|catchfile|currfile-abspath)\b/i },
];

export function assertSafeGeneratedLatex(latex: string): void {
  if (Buffer.byteLength(latex, "utf8") > MAX_SOURCE_BYTES) {
    throw new CompileFailure("文書が組版上限を超えました。", [
      { severity: "error", code: "source_too_large", message: "文書が大きすぎます。" },
    ]);
  }

  const diagnostics: CompileDiagnostic[] = [];
  for (const blocked of blockedPatterns) {
    if (blocked.pattern.test(latex)) {
      diagnostics.push({
        severity: "error",
        code: blocked.code,
        message: "安全でない組版命令を検出しました。",
      });
    }
  }

  if (diagnostics.length > 0) {
    throw new CompileFailure("安全でない組版命令を拒否しました。", diagnostics);
  }
}

/**
 * Treat the TeX engine as an untrusted producer even when it runs locally.
 * This prevents an empty/error page (or an unexpectedly large output) from
 * being persisted as a successful document artifact.
 */
export function assertValidPdfArtifact(pdf: Uint8Array): void {
  if (pdf.byteLength > MAX_PDF_ARTIFACT_BYTES) {
    throw new CompileFailure("生成されたPDFが上限を超えました。", [
      {
        severity: "error",
        code: "artifact_too_large",
        message: "完成した文書が大きすぎます。",
      },
    ]);
  }

  if (pdf.byteLength < MIN_PDF_ARTIFACT_BYTES) {
    throw invalidPdfFailure();
  }

  const header = Buffer.from(
    pdf.buffer,
    pdf.byteOffset,
    Math.min(PDF_HEADER_BYTES, pdf.byteLength),
  ).toString("ascii");
  if (!/^%PDF-[12]\.[0-9]/.test(header)) {
    throw invalidPdfFailure();
  }

  const trailerLength = Math.min(PDF_TRAILER_SCAN_BYTES, pdf.byteLength);
  const trailer = Buffer.from(
    pdf.buffer,
    pdf.byteOffset + pdf.byteLength - trailerLength,
    trailerLength,
  ).toString("latin1");
  if (!trailer.includes("%%EOF")) {
    throw invalidPdfFailure();
  }
}

/** Parses the bounded output of Poppler's pdfinfo without inspecting PDF syntax. */
export function parsePdfPageCount(output: string): number {
  const match = output.match(/^Pages:\s+(\d+)\s*$/imu);
  const pageCount = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000) {
    throw new CompileFailure("PDFのページ構成を確認できませんでした。", [
      {
        severity: "error",
        code: "invalid_page_count",
        message: "完成した文書のページ数を確認できませんでした。",
      },
    ]);
  }
  return pageCount;
}

/**
 * Verifies that Poppler inspected every rendered page and that no page is
 * effectively empty. A lone running page number is treated as empty because
 * it is a common symptom of an accidental blank page in a manuscript.
 */
export function assertNoBlankPdfPages(
  extractedText: string,
  expectedPageCount: number,
): void {
  if (
    !Number.isSafeInteger(expectedPageCount) ||
    expectedPageCount < 1 ||
    expectedPageCount > 100_000
  ) {
    throw pdfTextInspectionFailure();
  }

  const pages = extractedText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\u0000", "")
    .split("\f");
  if (pages.length === expectedPageCount + 1 && pages.at(-1)?.trim() === "") {
    pages.pop();
  }
  if (pages.length !== expectedPageCount) {
    throw pdfTextInspectionFailure();
  }

  const blankPage = pages.findIndex((page) => {
    const visible = page.normalize("NFKC").replaceAll(/\s/gu, "");
    return (
      visible.length === 0 ||
      /^(?:\p{N}{1,6}|[ivxlcdm]{1,8})$/iu.test(visible)
    );
  });
  if (blankPage >= 0) {
    throw new CompileFailure("空白のページが含まれています。", [
      {
        severity: "error",
        code: "blank_pdf_page",
        message: `${blankPage + 1}ページ目に本文がありません。`,
      },
    ]);
  }
}

export function parseLatexDiagnostics(output: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineMatch =
      line.match(/^(?:.*\/)?main\.tex:(\d+):\s*(.+)$/) ??
      line.match(/^(\d+):\s+([A-Za-z][\s\S]*)$/);
    const bangMatch = line.match(/^!\s*(.+)/);
    const warningMatch = line.match(/(?:LaTeX|Package\s+\S+) Warning:\s*(.+)/);
    const overfullMatch = line.match(
      /Overfull \\[hv]box \(([\d.]+)pt too (?:wide|high)\)(?:.*?lines?\s+(\d+))?/i,
    );
    const underfullMatch = line.match(/Underfull \\[hv]box/i);
    const missingCharacterMatch = line.match(/^Missing character:\s*(.+)/i);
    const undefinedReferenceMatch = line.match(
      /(?:LaTeX Warning:\s*)?(?:(?:Citation|Reference)\s+.+?\s+undefined|There were undefined references)/i,
    );
    const oversizedFloatMatch = line.match(
      /(?:LaTeX Warning:\s*)?Float too large for page/i,
    );

    let diagnostic: CompileDiagnostic | undefined;
    if (missingCharacterMatch?.[1]) {
      diagnostic = {
        severity: "error",
        code: "missing_glyph",
        message: normalizeDiagnosticMessage(missingCharacterMatch[1]),
      };
    } else if (undefinedReferenceMatch) {
      diagnostic = {
        severity: "error",
        code: "undefined_reference",
        message: normalizeDiagnosticMessage(line),
      };
    } else if (oversizedFloatMatch) {
      diagnostic = {
        severity: "error",
        code: "oversized_float",
        message: "図表がページ内に収まりません。",
      };
    } else if (overfullMatch?.[1]) {
      const overflowPoints = Number(overfullMatch[1]);
      diagnostic = {
        severity: overflowPoints > 2 ? "error" : "warning",
        code: overflowPoints > 2 ? "content_overflow" : "minor_overflow",
        message: `内容が紙面から${overflowPoints.toFixed(2)}ptはみ出しています。`,
        ...(overfullMatch[2] ? { line: Number(overfullMatch[2]) } : {}),
      };
    } else if (underfullMatch) {
      diagnostic = {
        severity: "warning",
        code: "loose_typesetting",
        message: "行間または文字間の空きが不均一です。",
      };
    } else if (bangMatch?.[1]) {
      diagnostic = {
        severity: "error",
        code: "typesetting_error",
        message: normalizeDiagnosticMessage(bangMatch[1]),
        line: findNearbyLineNumber(lines, index),
      };
    } else if (lineMatch?.[1] && lineMatch[2]) {
      diagnostic = {
        severity: "error",
        code: "source_error",
        message: normalizeDiagnosticMessage(lineMatch[2]),
        line: Number(lineMatch[1]),
      };
    } else if (warningMatch?.[1]) {
      diagnostic = {
        severity: "warning",
        code: "typesetting_warning",
        message: normalizeDiagnosticMessage(warningMatch[1]),
      };
    }

    if (!diagnostic) continue;
    const key = `${diagnostic.severity}:${diagnostic.line ?? ""}:${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
    if (diagnostics.length >= 12) break;
  }

  return diagnostics;
}

/** Rejects successful engine exits that still produced visibly broken output. */
export function assertNoBlockingTypesettingDiagnostics(
  finalPassOutput: string,
): CompileDiagnostic[] {
  const diagnostics = parseLatexDiagnostics(finalPassOutput);
  const blocking = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (blocking.length > 0) {
    throw new CompileFailure(
      "紙面に収まらない内容または未解決の参照があります。",
      blocking,
    );
  }
  return diagnostics;
}

function findNearbyLineNumber(lines: string[], fromIndex: number): number | undefined {
  for (let index = fromIndex + 1; index < Math.min(lines.length, fromIndex + 5); index += 1) {
    const match = (lines[index] ?? "").match(/^l\.(\d+)/);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function normalizeDiagnosticMessage(message: string): string {
  return message
    .replaceAll(/(?:\/[^\s:]+)+\/main\.tex/g, "文書")
    .replaceAll(/main\.tex/g, "文書")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function invalidPdfFailure(): CompileFailure {
  return new CompileFailure("有効なPDFを生成できませんでした。", [
    {
      severity: "error",
      code: "invalid_artifact",
      message: "完成した文書を確認できませんでした。",
    },
  ]);
}

function pdfTextInspectionFailure(): CompileFailure {
  return new CompileFailure("PDFの本文を確認できませんでした。", [
    {
      severity: "error",
      code: "pdf_text_inspection_failed",
      message: "完成した文書の各ページを確認できませんでした。",
    },
  ]);
}
