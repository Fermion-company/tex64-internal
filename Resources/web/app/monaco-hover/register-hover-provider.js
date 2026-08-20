import { pickCitationEntries } from "../index-utils.js";
import { extractCiteKey, extractDocumentClassKey, extractPackageKey, extractSingleKey, findCommandMatchAt, } from "./command-key-match.js";
import { extractBibEntryText, formatBibEntryMarkdown, parseBibFields } from "./bib-utils.js";
import { renderExcerpt, sliceExcerptAroundLine } from "./excerpt-utils.js";
import { buildImagePreviewHtml, createHtmlHoverContent } from "./hover-html.js";
import { buildMathPreviewHtml } from "./math-preview.js";
import { findMathAt } from "./math-scan.js";
import { extractMathEnvFromExcerpt, extractRefTargetSummary } from "./ref-target-preview.js";
import { buildColorSwatchHtml, collectDefinedColors, resolveColorSpec, rgbToHex, } from "./color-hover.js";
import { resolveGraphicsCandidates, resolveTexIncludeCandidates, isPreviewableImagePath, isPdfPath, } from "./path-candidates.js";
import { renderPdfFirstPageThumbnail } from "./pdf-thumbnail.js";
import { findCommandTokenAt, findMacroDefinitionInLines } from "./macro-definition.js";
import { buildPackageHoverMarkdown } from "./package-hover.js";
import { rememberStableHoverAnchor } from "./stable-hover.js";
import { findFirstUnescapedPercent, getCursorIndex } from "./utils.js";
import { getUiLocale } from "../i18n.js";
export const registerHoverProvider = (monaco, deps, state) => {
    var _a;
    if (state.registered || typeof ((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerHoverProvider) !== "function") {
        return;
    }
    const hoverResultCache = new Map();
    const previewRequestCache = new Map();
    const MAX_HOVER_CACHE_SIZE = 512;
    const rememberHoverResult = (key, value) => {
        hoverResultCache.set(key, value);
        if (hoverResultCache.size > MAX_HOVER_CACHE_SIZE) {
            const firstKey = hoverResultCache.keys().next().value;
            if (typeof firstKey === "string") {
                hoverResultCache.delete(firstKey);
            }
        }
        return value;
    };
    const getCachedHoverResult = (key) => hoverResultCache.has(key) ? hoverResultCache.get(key) : null;
    const buildHoverTokenKey = (payload) => {
        var _a, _b;
        return [
            payload.activePath,
            String(payload.lineNumber),
            String((_a = payload.endLineNumber) !== null && _a !== void 0 ? _a : payload.lineNumber),
            `${payload.startIndex}:${payload.endIndex}`,
            payload.kind,
            (_b = payload.extra) !== null && _b !== void 0 ? _b : "",
        ].join("|");
    };
    const createAnchorRange = (lineNumber, startIndex, endIndex, endLineNumber) => {
        if (!monaco.Range) {
            return undefined;
        }
        const startColumn = Math.max(1, startIndex + 1);
        const endColumn = Math.max(startColumn + 1, (typeof endIndex === "number" ? endIndex : startIndex + 1) + 1);
        const safeEndLine = Number.isFinite(endLineNumber)
            ? Math.max(lineNumber, Math.floor(endLineNumber !== null && endLineNumber !== void 0 ? endLineNumber : lineNumber))
            : lineNumber;
        return new monaco.Range(lineNumber, startColumn, safeEndLine, endColumn);
    };
    const getModelLineCountSafe = (m, fallback) => {
        var _a;
        const count = (_a = m.getLineCount) === null || _a === void 0 ? void 0 : _a.call(m);
        return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : fallback;
    };
    const getOrCreatePreviewRequest = (path) => {
        const cached = previewRequestCache.get(path);
        if (cached) {
            return cached;
        }
        const requestPreview = deps.requestFilePreview;
        if (typeof requestPreview !== "function") {
            return Promise.resolve({ ok: false, error: "preview unavailable" });
        }
        const pending = requestPreview(path)
            .then((result) => {
            if (!((result === null || result === void 0 ? void 0 : result.ok) && typeof result.dataUrl === "string" && result.dataUrl)) {
                previewRequestCache.delete(path);
            }
            return result;
        })
            .catch((error) => {
            previewRequestCache.delete(path);
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error !== null && error !== void 0 ? error : "preview failed"),
            };
        });
        previewRequestCache.set(path, pending);
        return pending;
    };
    const provideHover = (model, position) => {
        var _a, _b, _c;
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
            const range = createAnchorRange(mathMatch.startLineNumber, mathMatch.startIndex, mathMatch.endIndex, mathMatch.endLineNumber);
            return rememberHoverResult(tokenKey, {
                contents: [createHtmlHoverContent(html)],
                range,
            });
        }
        const packageMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g, extractPackageKey);
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
        const classMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g, extractDocumentClassKey);
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
        // ── Color swatch hover (\textcolor / \color / \definecolor / …) ──
        let colorModelOption = null;
        const colorUseMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(textcolor|color|colorbox|pagecolor|rowcolor|cellcolor|arrayrulecolor)(?:\[([^\]]*)\])?\{([^}]+)\}/g, (match, index) => {
            var _a, _b, _c, _d, _e, _f;
            const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
            const model = (_b = match[2]) !== null && _b !== void 0 ? _b : null;
            const content = (_c = match[3]) !== null && _c !== void 0 ? _c : "";
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
            colorModelOption = model && model.trim() ? model.trim() : null;
            const leading = (_f = (_e = (_d = content.match(/^\s*/)) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0;
            return {
                command,
                key,
                startIndex: contentStart + leading,
                endIndex: contentStart + leading + key.length,
            };
        });
        let colorDefineMatch = null;
        let colorDefineModel = null;
        let colorDefineSpec = "";
        if (!colorUseMatch) {
            const defineRegex = /\\(definecolor|providecolor|colorlet)\s*\{([^{}]+)\}\s*(?:\{([^{}]+)\}\s*)?\{([^{}]+)\}/g;
            colorDefineMatch = findCommandMatchAt(effectiveLine, cursorIndex, defineRegex, (match, index) => {
                var _a, _b, _c;
                if (typeof match.index !== "number") {
                    return null;
                }
                const start = match.index;
                const end = start + match[0].length;
                if (index < start || index > end) {
                    return null;
                }
                const name = ((_a = match[2]) !== null && _a !== void 0 ? _a : "").trim();
                const spec = ((_b = match[4]) !== null && _b !== void 0 ? _b : "").trim();
                if (!name || !spec) {
                    return null;
                }
                colorDefineModel = match[3] && match[3].trim() ? match[3].trim() : null;
                colorDefineSpec = spec;
                return { command: (_c = match[1]) !== null && _c !== void 0 ? _c : "definecolor", key: name, startIndex: start, endIndex: end };
            });
        }
        const colorMatch = colorUseMatch !== null && colorUseMatch !== void 0 ? colorUseMatch : colorDefineMatch;
        if (colorMatch) {
            const definedColors = collectDefinedColors((lineNumber) => model.getLineContent(lineNumber), getModelLineCountSafe(model, position.lineNumber));
            const rgb = colorUseMatch
                ? resolveColorSpec(colorMatch.key, colorModelOption, definedColors)
                : (_a = definedColors.get(colorMatch.key)) !== null && _a !== void 0 ? _a : resolveColorSpec(colorDefineSpec, colorDefineModel, definedColors);
            if (rgb) {
                const hex = rgbToHex(rgb);
                const tokenKey = buildHoverTokenKey({
                    activePath,
                    lineNumber: position.lineNumber,
                    startIndex: colorMatch.startIndex,
                    endIndex: colorMatch.endIndex,
                    kind: `color:${colorMatch.command}`,
                    extra: `${colorMatch.key}|${hex}`,
                });
                rememberStableHoverAnchor({
                    filePath: activePath,
                    startLineNumber: position.lineNumber,
                    startIndex: colorMatch.startIndex,
                    endIndex: colorMatch.endIndex,
                    tokenKey,
                });
                const cached = getCachedHoverResult(tokenKey);
                if (cached) {
                    return cached;
                }
                const range = createAnchorRange(position.lineNumber, colorMatch.startIndex, colorMatch.endIndex);
                return rememberHoverResult(tokenKey, {
                    contents: [createHtmlHoverContent(buildColorSwatchHtml(rgb, colorMatch.key))],
                    range,
                });
            }
        }
        const refMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]+)\}/g, extractSingleKey);
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
            const seen = new Set();
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
                    return a.path.localeCompare(b.path, getUiLocale());
                }
                return a.line - b.line;
            });
            const primary = deduped.length > 0 ? deduped[0] : null;
            const range = createAnchorRange(position.lineNumber, refMatch.startIndex, refMatch.endIndex);
            if (!primary) {
                return null;
            }
            if (typeof deps.requestFileExcerpt === "function" &&
                typeof primary.path === "string" &&
                Number.isFinite(primary.line)) {
                const pending = deps
                    .requestFileExcerpt(primary.path, primary.line, { radius: 48, maxLines: 220 })
                    .then((excerpt) => {
                    var _a;
                    const contents = [{ value: `\`${primary.path}:${primary.line}\`` }];
                    const excerptOk = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerpt.lines);
                    const excerptData = excerptOk
                        ? {
                            startLine: (_a = excerpt.startLine) !== null && _a !== void 0 ? _a : primary.line,
                            lines: excerpt.lines,
                            targetLine: primary.line,
                        }
                        : null;
                    // Show WHAT the label points at, not just where: a rendered
                    // preview for equations, the heading for sections, the caption
                    // for figures/tables. The raw excerpt stays as source context.
                    let previewShown = false;
                    if (excerptData) {
                        const mathLatex = extractMathEnvFromExcerpt(excerptData);
                        if (mathLatex) {
                            const mathHtml = buildMathPreviewHtml(mathLatex);
                            if (mathHtml) {
                                contents.push(createHtmlHoverContent(mathHtml));
                                previewShown = true;
                            }
                        }
                        if (!previewShown) {
                            const summary = extractRefTargetSummary(excerptData);
                            if (summary) {
                                contents.push({ value: `**${summary.text}**` });
                                previewShown = true;
                            }
                        }
                    }
                    const snippet = excerptData
                        ? (() => {
                            const slice = sliceExcerptAroundLine({
                                startLine: excerptData.startLine,
                                lines: excerptData.lines,
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
        const citeMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\[[^\]]*\])*\{([^}]+)\}/g, extractCiteKey);
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
            const entries = pickCitationEntries(deps.getIndexCitations()).filter((entry) => entry.key === citeMatch.key);
            const primary = entries.length > 0 ? entries[0] : null;
            const range = createAnchorRange(position.lineNumber, citeMatch.startIndex, citeMatch.endIndex);
            if (!primary) {
                return null;
            }
            if (typeof deps.requestFileExcerpt === "function" &&
                typeof primary.path === "string" &&
                primary.path.endsWith(".bib") &&
                Number.isFinite(primary.line)) {
                const pending = deps
                    .requestFileExcerpt(primary.path, primary.line, { radius: 120, maxLines: 260 })
                    .then((excerpt) => {
                    const excerptLines = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) ? excerpt.lines : null;
                    const startLine = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) ? excerpt.startLine : null;
                    const text = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerptLines) ? excerptLines.join("\n") : "";
                    const entryText = extractBibEntryText(text, citeMatch.key);
                    const fields = entryText ? parseBibFields(entryText) : {};
                    const where = typeof primary.path === "string" && Number.isFinite(primary.line)
                        ? `\`${primary.path}:${primary.line}\``
                        : "";
                    const summaryMarkdown = formatBibEntryMarkdown(fields);
                    const contents = [];
                    if (where)
                        contents.push({ value: where });
                    if (summaryMarkdown) {
                        contents.push({ value: summaryMarkdown });
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
        const includeGraphicsHit = findCommandMatchAt(effectiveLine, cursorIndex, /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, (match, index) => {
            var _a, _b, _c, _d;
            const content = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
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
            const leading = (_d = (_c = (_b = content.match(/^\s*/)) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0;
            return {
                command: "includegraphics",
                key,
                startIndex: contentStart + leading,
                endIndex: contentStart + leading + key.length,
            };
        });
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
            const candidates = resolveGraphicsCandidates(activePath, includeGraphicsHit.key, deps.getWorkspaceFiles());
            if (candidates.length === 0) {
                return null;
            }
            const previewPath = (_b = candidates[0]) !== null && _b !== void 0 ? _b : "";
            const range = createAnchorRange(position.lineNumber, includeGraphicsHit.startIndex, includeGraphicsHit.endIndex);
            const locations = candidates.map((p) => `- ${p}`).join("\n");
            if (previewPath && isPreviewableImagePath(previewPath)) {
                const pending = getOrCreatePreviewRequest(previewPath).then((preview) => {
                    const contents = [{ value: `\`${previewPath}\`` }];
                    if ((preview === null || preview === void 0 ? void 0 : preview.ok) && typeof preview.dataUrl === "string" && preview.dataUrl) {
                        contents.push({ value: locations });
                        contents.push(createHtmlHoverContent(buildImagePreviewHtml(preview.dataUrl)));
                    }
                    else {
                        contents.push({ value: locations });
                    }
                    return { contents, range };
                });
                return rememberHoverResult(tokenKey, pending);
            }
            // PDF figures (the most common \includegraphics format): rasterize the
            // first page into a thumbnail via the vendored pdfjs.
            if (previewPath && isPdfPath(previewPath)) {
                const pending = getOrCreatePreviewRequest(previewPath).then(async (preview) => {
                    const contents = [{ value: `\`${previewPath}\`` }, { value: locations }];
                    if ((preview === null || preview === void 0 ? void 0 : preview.ok) &&
                        typeof preview.dataUrl === "string" &&
                        preview.dataUrl.startsWith("data:application/pdf")) {
                        const thumbnail = await renderPdfFirstPageThumbnail(preview.dataUrl);
                        if (thumbnail) {
                            contents.push(createHtmlHoverContent(buildImagePreviewHtml(thumbnail)));
                        }
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
        const includeHit = findCommandMatchAt(effectiveLine, cursorIndex, /\\(input|include)\{([^}]+)\}/g, extractSingleKey);
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
            const candidates = resolveTexIncludeCandidates(activePath, includeHit.key, deps.getWorkspaceFiles());
            if (candidates.length === 0) {
                return null;
            }
            const previewPath = (_c = candidates[0]) !== null && _c !== void 0 ? _c : "";
            const range = createAnchorRange(position.lineNumber, includeHit.startIndex, includeHit.endIndex);
            const locations = candidates.map((p) => `- ${p}`).join("\n");
            if (candidates.length > 0 && typeof deps.requestFileExcerpt === "function") {
                const pending = deps.requestFileExcerpt(previewPath, 1, { radius: 8, maxLines: 18 }).then((excerpt) => {
                    var _a;
                    const contents = [{ value: `\`${previewPath}:1\`` }];
                    if ((excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerpt.lines)) {
                        const slice = sliceExcerptAroundLine({
                            startLine: (_a = excerpt.startLine) !== null && _a !== void 0 ? _a : 1,
                            lines: excerpt.lines,
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
        // ── User-defined macro hover ──
        // Runs last so all specific hovers (math preview, refs, colors, …) win.
        // Hovering \mymacro in text mode shows its \newcommand/\def definition
        // from the current file. (Inside math the equation preview takes over.)
        const commandToken = findCommandTokenAt(effectiveLine, cursorIndex);
        if (commandToken && commandToken.name.length > 1) {
            const definition = findMacroDefinitionInLines((lineNumber) => model.getLineContent(lineNumber), getModelLineCountSafe(model, position.lineNumber), commandToken.name);
            if (definition && definition.lineNumber !== position.lineNumber) {
                const tokenKey = buildHoverTokenKey({
                    activePath,
                    lineNumber: position.lineNumber,
                    startIndex: commandToken.startIndex,
                    endIndex: commandToken.endIndex,
                    kind: "macro-definition",
                    extra: `${commandToken.name}|${definition.lineNumber}|${definition.text.slice(0, 80)}`,
                });
                rememberStableHoverAnchor({
                    filePath: activePath,
                    startLineNumber: position.lineNumber,
                    startIndex: commandToken.startIndex,
                    endIndex: commandToken.endIndex,
                    tokenKey,
                });
                const cached = getCachedHoverResult(tokenKey);
                if (cached) {
                    return cached;
                }
                const range = createAnchorRange(position.lineNumber, commandToken.startIndex, commandToken.endIndex);
                return rememberHoverResult(tokenKey, {
                    contents: [
                        { value: `\`${activePath}:${definition.lineNumber}\`` },
                        { value: `\`\`\`tex\n${definition.text}\n\`\`\`` },
                    ],
                    range,
                });
            }
        }
        return null;
    };
    ["latex", "plaintext"].forEach((languageId) => {
        var _a, _b;
        (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerHoverProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, { provideHover });
    });
    state.registered = true;
};
