import { getEditorModelPath } from "../editor-session/model-path.js";
import { isTexFilePath } from "../files.js";
import { pickCitationEntries } from "../index-utils.js";
import { extractListKey, extractSingleKey, findCommandMatchAt, } from "./command-key-match.js";
import { extractBibEntryText, formatBibEntryMarkdown, parseBibFields } from "./bib-utils.js";
import { renderExcerpt, sliceExcerptAroundLine } from "./excerpt-utils.js";
import { buildImagePreviewHtml, createHtmlHoverContent } from "./hover-html.js";
import { buildMathPreviewHtml, trackFormulaHoverPointer, typesetMathHover } from "./math-preview.js";
import { findMathAt } from "./math-scan.js";
import { extractMathEnvFromExcerpt, extractRefTargetSummary, findLabelColumn } from "./ref-target-preview.js";
import { buildColorSwatchHtml, collectDefinedColors, resolveColorSpec, rgbToHex, } from "./color-hover.js";
import { resolveGraphicsCandidates, resolveTexIncludeCandidates, isPreviewableImagePath, isPdfPath, } from "./path-candidates.js";
import { renderPdfFirstPageThumbnail } from "./pdf-thumbnail.js";
import { findCommandTokenAt, findMacroDefinitionInLines } from "./macro-definition.js";
import { buildPackageHoverMarkdown } from "./package-hover.js";
import { rememberStableHoverAnchor } from "./stable-hover.js";
import { getHoverLine, getCursorIndex } from "./utils.js";
import { getUiLocale } from "../i18n.js";
export const registerHoverProvider = (monaco, deps, state) => {
    var _a;
    if (state.registered || typeof ((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerHoverProvider) !== "function") {
        return;
    }
    const hoverResultCache = new Map();
    let workspaceRoot = null;
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
        const lastColumn = safeEndLine > lineNumber && typeof endIndex === "number"
            ? Math.max(1, endIndex + 1)
            : endColumn;
        return new monaco.Range(lineNumber, startColumn, safeEndLine, lastColumn);
    };
    const getModelLineCountSafe = (m, fallback) => {
        var _a;
        const count = (_a = m.getLineCount) === null || _a === void 0 ? void 0 : _a.call(m);
        return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : fallback;
    };
    const requestPreview = (path) => {
        var _a, _b;
        return (_b = (_a = deps.requestFilePreview) === null || _a === void 0 ? void 0 : _a.call(deps, path).catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error !== null && error !== void 0 ? error : "preview failed"),
        }))) !== null && _b !== void 0 ? _b : Promise.resolve({ ok: false });
    };
    const provideHover = (model, position) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const root = (_b = (_a = deps.getWorkspaceRoot) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null;
        if (root !== workspaceRoot) {
            workspaceRoot = root;
            hoverResultCache.clear();
        }
        const activePath = (_c = getEditorModelPath(model)) !== null && _c !== void 0 ? _c : deps.getActiveFilePath();
        if (!isTexFilePath(activePath)) {
            return null;
        }
        const line = model.getLineContent(position.lineNumber);
        const cursorIndex = getCursorIndex(position);
        const effectiveLine = getHoverLine(line, cursorIndex);
        if (cursorIndex >= effectiveLine.length)
            return null;
        const mathMatch = findMathAt(model, position, cursorIndex);
        if (mathMatch) {
            const tokenKey = buildHoverTokenKey({
                activePath,
                lineNumber: mathMatch.startLineNumber,
                endLineNumber: mathMatch.endLineNumber,
                startIndex: mathMatch.startIndex,
                endIndex: mathMatch.endIndex,
                kind: "math",
                extra: mathMatch.latex,
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
        const packageMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g, extractListKey);
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
            const value = buildPackageHoverMarkdown(packageMatch.key);
            if (!value) {
                return null;
            }
            const range = createAnchorRange(position.lineNumber, packageMatch.startIndex, packageMatch.endIndex);
            return rememberHoverResult(tokenKey, { contents: [{ value }], range });
        }
        const classMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(documentclass)(?:\[[^\]]*\])?\{([^}]+)\}/g, extractSingleKey);
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
            const value = buildPackageHoverMarkdown(classMatch.key);
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
            const braceIndex = match[0].length - content.length - 2;
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
                : (_d = definedColors.get(colorMatch.key)) !== null && _d !== void 0 ? _d : resolveColorSpec(colorDefineSpec, colorDefineModel, definedColors);
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
        const refMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\*?\{([^}]+)\}/g, (match, index) => /^(?:c|namec)ref$/i.test(match[1])
            ? extractListKey(match, index) : extractSingleKey(match, index));
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
                return deps
                    .requestFileExcerpt(primary.path, primary.line, { radius: 48, maxLines: 220 })
                    .then((excerpt) => {
                    var _a, _b;
                    const contents = [{ value: `\`${primary.path}:${primary.line}\`` }];
                    const excerptOk = (excerpt === null || excerpt === void 0 ? void 0 : excerpt.ok) && Array.isArray(excerpt.lines);
                    const excerptData = excerptOk
                        ? {
                            startLine: (_a = excerpt.startLine) !== null && _a !== void 0 ? _a : primary.line,
                            lines: excerpt.lines,
                            targetLine: primary.line,
                            labelColumn: findLabelColumn((_b = excerpt.lines[primary.line - excerpt.startLine]) !== null && _b !== void 0 ? _b : "", refMatch.key),
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
            }
            return {
                contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
                range,
            };
        }
        const citeMatch = findCommandMatchAt(effectiveLine, cursorIndex, /\\(cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g, extractListKey);
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
            const entries = pickCitationEntries(deps.getIndexCitations()).filter((entry) => entry.key === citeMatch.key);
            const primary = entries.length > 0 ? entries[0] : null;
            const range = createAnchorRange(position.lineNumber, citeMatch.startIndex, citeMatch.endIndex);
            if (!primary) {
                return null;
            }
            if (typeof deps.requestFileExcerpt === "function" &&
                typeof primary.path === "string" &&
                /\.bib$/i.test(primary.path) &&
                Number.isFinite(primary.line)) {
                return deps
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
            }
            return {
                contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
                range,
            };
        }
        const includeGraphicsHit = findCommandMatchAt(effectiveLine, cursorIndex, /\\(includegraphics)(?:\[[^\]]*\])?\{([^}]+)\}/g, extractSingleKey);
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
            const candidates = resolveGraphicsCandidates(activePath, includeGraphicsHit.key, deps.getWorkspaceFiles(), (_e = deps.getRootFilePath) === null || _e === void 0 ? void 0 : _e.call(deps));
            if (candidates.length === 0) {
                return null;
            }
            const previewPath = (_f = candidates[0]) !== null && _f !== void 0 ? _f : "";
            const range = createAnchorRange(position.lineNumber, includeGraphicsHit.startIndex, includeGraphicsHit.endIndex);
            const contents = [{ value: `\`${previewPath}\`` }];
            if (candidates.length > 1) {
                contents.push({ value: candidates.slice(1).map((path) => `- ${path}`).join("\n") });
            }
            if (previewPath && isPreviewableImagePath(previewPath)) {
                const pending = requestPreview(previewPath).then((preview) => {
                    if ((preview === null || preview === void 0 ? void 0 : preview.ok) && typeof preview.dataUrl === "string" && preview.dataUrl) {
                        contents.push(createHtmlHoverContent(buildImagePreviewHtml(preview.dataUrl)));
                    }
                    return { contents, range };
                });
                return pending;
            }
            // PDF figures (the most common \includegraphics format): rasterize the
            // first page into a thumbnail via the vendored pdfjs.
            if (previewPath && isPdfPath(previewPath)) {
                const pending = requestPreview(previewPath).then(async (preview) => {
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
                return pending;
            }
            return { contents, range };
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
            const candidates = resolveTexIncludeCandidates(activePath, includeHit.key, deps.getWorkspaceFiles(), (_g = deps.getRootFilePath) === null || _g === void 0 ? void 0 : _g.call(deps));
            if (candidates.length === 0) {
                return null;
            }
            const previewPath = (_h = candidates[0]) !== null && _h !== void 0 ? _h : "";
            const range = createAnchorRange(position.lineNumber, includeHit.startIndex, includeHit.endIndex);
            const locations = candidates.map((p) => `- ${p}`).join("\n");
            if (candidates.length > 0 && typeof deps.requestFileExcerpt === "function") {
                return deps.requestFileExcerpt(previewPath, 1, { radius: 8, maxLines: 18 }).then((excerpt) => {
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
            }
            return {
                contents: [{ value: locations }],
                range,
            };
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
                    extra: `${commandToken.name}|${definition.lineNumber}|${definition.text}`,
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
    document.addEventListener("pointermove", trackFormulaHoverPointer, { capture: true, passive: true });
    document.addEventListener("load", typesetMathHover, true);
    state.registered = true;
};
