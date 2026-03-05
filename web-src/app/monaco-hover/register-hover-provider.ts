import type { IndexEntry } from "../types.js";
import { pickCitationEntries } from "../index-utils.js";

import type { FileExcerptResult, FilePreviewResult, HoverState } from "./types.js";
import {
  extractCiteKey,
  extractDocumentClassKey,
  extractPackageKey,
  extractSingleKey,
  findCommandMatchAt,
} from "./command-key-match.js";
import { extractBibEntryText, parseBibFields } from "./bib-utils.js";
import { renderExcerpt, sliceExcerptAroundLine } from "./excerpt-utils.js";
import { buildImagePreviewHtml, createHtmlHoverContent } from "./hover-html.js";
import { buildMathPreviewHtml } from "./math-preview.js";
import { findMathAt } from "./math-scan.js";
import { resolveGraphicsCandidates, resolveTexIncludeCandidates, isPreviewableImagePath } from "./path-candidates.js";
import { buildPackageHoverMarkdown } from "./package-hover.js";
import { rememberStableHoverAnchor } from "./stable-hover.js";
import { findFirstUnescapedPercent, getCursorIndex } from "./utils.js";

export const registerHoverProvider = (
  monaco: {
    languages?: {
      [key: string]: unknown;
      registerHoverProvider?: (
        languageId: string,
        provider: {
          provideHover: (
            model: {
              getLineContent: (lineNumber: number) => string;
              getLineCount?: () => number;
            },
            position: { lineNumber: number; column: number }
          ) => unknown;
        }
      ) => void;
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  },
  deps: {
    getActiveFilePath: () => string | null;
    getWorkspaceFiles: () => string[];
    getIndexLabels: () => IndexEntry[];
    getIndexCitations: () => IndexEntry[];
    requestFilePreview?: (path: string) => Promise<FilePreviewResult>;
    requestFileExcerpt?: (
      path: string,
      line: number,
      options?: { radius?: number; maxLines?: number }
    ) => Promise<FileExcerptResult>;
  },
  state: HoverState
) => {
  if (state.registered || typeof monaco.languages?.registerHoverProvider !== "function") {
    return;
  }

  const hoverResultCache = new Map<string, unknown>();
  const previewRequestCache = new Map<string, Promise<FilePreviewResult>>();
  const MAX_HOVER_CACHE_SIZE = 512;

  const rememberHoverResult = <T>(key: string, value: T): T => {
    hoverResultCache.set(key, value as unknown);
    if (hoverResultCache.size > MAX_HOVER_CACHE_SIZE) {
      const firstKey = hoverResultCache.keys().next().value;
      if (typeof firstKey === "string") {
        hoverResultCache.delete(firstKey);
      }
    }
    return value;
  };

  const getCachedHoverResult = (key: string) =>
    hoverResultCache.has(key) ? hoverResultCache.get(key) : null;

  const buildHoverTokenKey = (payload: {
    activePath: string;
    lineNumber: number;
    endLineNumber?: number;
    startIndex: number;
    endIndex: number;
    kind: string;
    extra?: string;
  }) =>
    [
      payload.activePath,
      String(payload.lineNumber),
      String(payload.endLineNumber ?? payload.lineNumber),
      `${payload.startIndex}:${payload.endIndex}`,
      payload.kind,
      payload.extra ?? "",
    ].join("|");

  const createAnchorRange = (
    lineNumber: number,
    startIndex: number,
    endIndex?: number,
    endLineNumber?: number
  ) => {
    if (!monaco.Range) {
      return undefined;
    }
    const startColumn = Math.max(1, startIndex + 1);
    const endColumn = Math.max(
      startColumn + 1,
      (typeof endIndex === "number" ? endIndex : startIndex + 1) + 1
    );
    const safeEndLine = Number.isFinite(endLineNumber)
      ? Math.max(lineNumber, Math.floor(endLineNumber ?? lineNumber))
      : lineNumber;
    return new monaco.Range(lineNumber, startColumn, safeEndLine, endColumn);
  };

  const getOrCreatePreviewRequest = (path: string) => {
    const cached = previewRequestCache.get(path);
    if (cached) {
      return cached;
    }
    const requestPreview = deps.requestFilePreview;
    if (typeof requestPreview !== "function") {
      return Promise.resolve({ ok: false, error: "preview unavailable" } as FilePreviewResult);
    }
    const pending = requestPreview(path)
      .then((result) => {
        if (!(result?.ok && typeof result.dataUrl === "string" && result.dataUrl)) {
          previewRequestCache.delete(path);
        }
        return result;
      })
      .catch((error) => {
        previewRequestCache.delete(path);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error ?? "preview failed"),
        } as FilePreviewResult;
      });
    previewRequestCache.set(path, pending);
    return pending;
  };

  const provideHover = (
    model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
    position: { lineNumber: number; column: number }
  ) => {
    const activePath = deps.getActiveFilePath();
    if (!activePath || !activePath.endsWith(".tex")) {
      return null;
    }
    const line = model.getLineContent(position.lineNumber);
    const cursorIndex = getCursorIndex(position);
    const commentIndex = findFirstUnescapedPercent(line);
    if (commentIndex >= 0 && cursorIndex >= commentIndex) {
      return null;
    }
    const effectiveLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;

    const mathMatch = findMathAt(model, position, effectiveLine, cursorIndex);
    if (mathMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: mathMatch.startLineNumber,
        endLineNumber: mathMatch.endLineNumber,
        startIndex: mathMatch.startIndex,
        endIndex: mathMatch.endIndex,
        kind: "math",
        extra: mathMatch.latex.slice(0, 180),
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: mathMatch.startLineNumber,
        endLineNumber: mathMatch.endLineNumber,
        startIndex: mathMatch.startIndex,
        endIndex: mathMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const html = buildMathPreviewHtml(mathMatch.latex);
      if (!html) {
        return null;
      }
      const range = createAnchorRange(
        mathMatch.startLineNumber,
        mathMatch.startIndex,
        mathMatch.endIndex,
        mathMatch.endLineNumber
      );
      return rememberHoverResult(tokenKey, {
        contents: [createHtmlHoverContent(html)],
        range,
      });
    }

    const packageMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g,
      extractPackageKey
    );
    if (packageMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: packageMatch.startIndex,
        endIndex: packageMatch.endIndex,
        kind: packageMatch.command,
        extra: packageMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: packageMatch.startIndex,
        endIndex: packageMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const packageCommand = packageMatch.command === "RequirePackage" ? "RequirePackage" : "usepackage";
      const value = buildPackageHoverMarkdown(packageMatch.key, packageCommand);
      if (!value) {
        return null;
      }
      const range = createAnchorRange(position.lineNumber, packageMatch.startIndex, packageMatch.endIndex);
      return rememberHoverResult(tokenKey, { contents: [{ value }], range });
    }

    const classMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g,
      extractDocumentClassKey
    );
    if (classMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: classMatch.startIndex,
        endIndex: classMatch.endIndex,
        kind: "documentclass",
        extra: classMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: classMatch.startIndex,
        endIndex: classMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const value = buildPackageHoverMarkdown(classMatch.key, "documentclass");
      if (!value) {
        return null;
      }
      const range = createAnchorRange(position.lineNumber, classMatch.startIndex, classMatch.endIndex);
      return rememberHoverResult(tokenKey, { contents: [{ value }], range });
    }

    const refMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]+)\}/g,
      extractSingleKey
    );
    if (refMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: refMatch.startIndex,
        endIndex: refMatch.endIndex,
        kind: refMatch.command,
        extra: refMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: refMatch.startIndex,
        endIndex: refMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const entries = deps.getIndexLabels().filter((entry) => entry.key === refMatch.key);
      const seen = new Set<string>();
      const deduped = entries
        .filter((entry) => {
          const token = `${entry.path}:${entry.line}`;
          if (seen.has(token)) {
            return false;
          }
          seen.add(token);
          return true;
        })
        .sort((a, b) => {
          if (a.path !== b.path) {
            return a.path.localeCompare(b.path, "ja");
          }
          return a.line - b.line;
        });
      const primary = deduped.length > 0 ? deduped[0] : null;
      const range = createAnchorRange(position.lineNumber, refMatch.startIndex, refMatch.endIndex);
      if (!primary) {
        return null;
      }

      if (
        typeof deps.requestFileExcerpt === "function" &&
        typeof primary.path === "string" &&
        Number.isFinite(primary.line)
      ) {
        const pending = deps
          .requestFileExcerpt(primary.path, primary.line, { radius: 48, maxLines: 220 })
          .then((excerpt) => {
            const contents: any[] = [{ value: `\`${primary.path}:${primary.line}\`` }];
            const snippet =
              excerpt?.ok && Array.isArray((excerpt as any).lines)
                ? (() => {
                    const slice = sliceExcerptAroundLine({
                      startLine: (excerpt as any).startLine ?? primary.line,
                      lines: (excerpt as any).lines,
                      targetLine: primary.line,
                      radius: 1,
                      maxLines: 4,
                    });
                    return renderExcerpt({
                      startLine: slice.startLine,
                      lines: slice.lines,
                      highlightLine: primary.line,
                    });
                  })()
                : null;
            if (snippet) {
              contents.push({ value: snippet });
            }
            return { contents, range };
          });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
        range,
      });
    }

    const citeMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\[[^\]]*\])*\{([^}]+)\}/g,
      extractCiteKey
    );
    if (citeMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: citeMatch.startIndex,
        endIndex: citeMatch.endIndex,
        kind: citeMatch.command,
        extra: citeMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: citeMatch.startIndex,
        endIndex: citeMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const entries = pickCitationEntries(deps.getIndexCitations()).filter(
        (entry) => entry.key === citeMatch.key
      );
      const primary = entries.length > 0 ? entries[0] : null;
      const range = createAnchorRange(position.lineNumber, citeMatch.startIndex, citeMatch.endIndex);
      if (!primary) {
        return null;
      }

      if (
        typeof deps.requestFileExcerpt === "function" &&
        typeof primary.path === "string" &&
        primary.path.endsWith(".bib") &&
        Number.isFinite(primary.line)
      ) {
        const pending = deps
          .requestFileExcerpt(primary.path, primary.line, { radius: 120, maxLines: 260 })
          .then((excerpt) => {
            const excerptLines = excerpt?.ok ? (excerpt as any).lines : null;
            const startLine = excerpt?.ok ? (excerpt as any).startLine : null;
            const text =
              excerpt?.ok && Array.isArray(excerptLines) ? excerptLines.join("\n") : "";
            const entryText = extractBibEntryText(text, citeMatch.key);
            const fields = entryText ? parseBibFields(entryText) : {};
            const title = fields.title || "";
            const author = fields.author || "";
            const year = fields.year || "";
            const where =
              typeof primary.path === "string" && Number.isFinite(primary.line)
                ? `\`${primary.path}:${primary.line}\``
                : "";
            const summaryParts = [title, author, year].filter(Boolean);

            const contents: any[] = [];
            if (where) contents.push({ value: where });
            if (summaryParts.length > 0) {
              contents.push({ value: summaryParts.join("\n") });
            }
            if (contents.length === 0) {
              return null;
            }
            return { contents, range };
          });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
        range,
      });
    }

    const includeGraphicsHit = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g,
      (match, index) => {
        const content = match[1] ?? "";
        const braceIndex = match[0].indexOf("{");
        if (braceIndex < 0 || typeof match.index !== "number") {
          return null;
        }
        const contentStart = match.index + braceIndex + 1;
        const contentEnd = contentStart + content.length;
        if (index < contentStart || index > contentEnd) {
          return null;
        }
        const key = content.trim();
        if (!key) {
          return null;
        }
        const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
        return {
          command: "includegraphics",
          key,
          startIndex: contentStart + leading,
          endIndex: contentStart + leading + key.length,
        };
      }
    );
    if (includeGraphicsHit) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: includeGraphicsHit.startIndex,
        endIndex: includeGraphicsHit.endIndex,
        kind: "includegraphics",
        extra: includeGraphicsHit.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: includeGraphicsHit.startIndex,
        endIndex: includeGraphicsHit.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }

      const candidates = resolveGraphicsCandidates(
        activePath,
        includeGraphicsHit.key,
        deps.getWorkspaceFiles()
      );
      if (candidates.length === 0) {
        return null;
      }
      const previewPath = candidates[0] ?? "";
      const range = createAnchorRange(
        position.lineNumber,
        includeGraphicsHit.startIndex,
        includeGraphicsHit.endIndex
      );
      const locations = candidates.map((p) => `- ${p}`).join("\n");

      if (previewPath && isPreviewableImagePath(previewPath)) {
        const pending = getOrCreatePreviewRequest(previewPath).then((preview) => {
          const contents: any[] = [{ value: `\`${previewPath}\`` }];
          if (preview?.ok && typeof preview.dataUrl === "string" && preview.dataUrl) {
            contents.push({ value: locations });
            contents.push(createHtmlHoverContent(buildImagePreviewHtml(preview.dataUrl)));
          } else {
            contents.push({ value: locations });
          }
          return { contents, range };
        });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: locations }],
        range,
      });
    }

    const includeHit = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(input|include)\{([^}]+)\}/g,
      extractSingleKey
    );
    if (includeHit) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: includeHit.startIndex,
        endIndex: includeHit.endIndex,
        kind: includeHit.command,
        extra: includeHit.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: includeHit.startIndex,
        endIndex: includeHit.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const candidates = resolveTexIncludeCandidates(
        activePath,
        includeHit.key,
        deps.getWorkspaceFiles()
      );
      if (candidates.length === 0) {
        return null;
      }
      const previewPath = candidates[0] ?? "";
      const range = createAnchorRange(position.lineNumber, includeHit.startIndex, includeHit.endIndex);
      const locations = candidates.map((p) => `- ${p}`).join("\n");

      if (candidates.length > 0 && typeof deps.requestFileExcerpt === "function") {
        const pending = deps.requestFileExcerpt(previewPath, 1, { radius: 8, maxLines: 18 }).then((excerpt) => {
          const contents: any[] = [{ value: `\`${previewPath}:1\`` }];
          if (excerpt?.ok && Array.isArray((excerpt as any).lines)) {
            const slice = sliceExcerptAroundLine({
              startLine: (excerpt as any).startLine ?? 1,
              lines: (excerpt as any).lines,
              targetLine: 1,
              radius: 1,
              maxLines: 4,
            });
            contents.push({
              value: renderExcerpt({
                startLine: slice.startLine,
                lines: slice.lines,
                highlightLine: 1,
              }),
            });
          }
          return { contents, range };
        });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: locations }],
        range,
      });
    }

    return null;
  };

  ["latex", "plaintext"].forEach((languageId) => {
    monaco.languages?.registerHoverProvider?.(languageId, { provideHover });
  });

  state.registered = true;
};
