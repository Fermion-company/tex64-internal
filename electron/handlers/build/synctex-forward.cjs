const path = require("path");

const createSynctexForwardHandler = (deps, resolvers) => {
  const { fs, pdfWindowManager, synctexService, sendToRenderer, ensureWorkspace, state, delay } = deps;
  const { resolveWorkspacePathFromRoot, resolveWorkspaceRelativePath, isWorkspaceSynctexPathSame } =
    resolvers;

  let synctexForwardGeneration = 0;
  const synctexForwardResultCache = new Map();

  const isSkippableSynctexLine = (sourcePath, lineNumber) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return false;
    }
    try {
      const content = fs.readFileSync(sourcePath, "utf8");
      const lines = content.split(/\r?\n/);
      const line = lines[lineNumber - 1];
      if (typeof line !== "string") {
        return false;
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("%")) {
        return true;
      }
      if (
        /^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(
          trimmed
        )
      ) {
        return true;
      }
      if (/\\\\\s*$/.test(trimmed)) {
        return true;
      }
      if (/(^|[^\\])&/.test(trimmed)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  // Lines above \begin{document} of the file the engine ran on never reach a
  // page themselves: what their macros typeset is filed under the line that
  // uses them. (Only that file: a chapter may show \begin{document} in a
  // verbatim example.)
  const isPreambleLine = (sourcePath, lineNumber) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return false;
    try {
      const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
      const begin = lines.findIndex((line) => /^[^%]*\\begin\s*\{document\}/.test(line));
      return begin >= 0 && lineNumber - 1 < begin;
    } catch {
      return false;
    }
  };

  // The line whose output a jump from `lineNumber` should show, and whether
  // to show where that output ends (`toEnd`) rather than where it begins. A
  // blank or closing line ends what precedes it; a comment or an opening
  // line (\begin, \label, a rule) introduces what follows. Their own SyncTeX
  // records are no guide: TeX breaks the page while reading the blank line
  // after a paragraph, so that line carries the finished page's head and folio.
  const jumpAnchorLine = (sourcePath, lineNumber) => {
    let lines;
    try {
      lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
    } catch {
      return { line: lineNumber, toEnd: false };
    }
    const text = (n) => (lines[n - 1] ?? "").trim();
    const quiet = (t) => !t || t.startsWith("%");
    // Table rows and captions are output of their own, not markers. A page
    // break command ends what is before it; its own records are only the
    // head and folio of the page it ships.
    const closing = (t) =>
      /^\\end\b/.test(t) ||
      /^\\\\(\[[^\]]*\])?$/.test(t) ||
      /^\\(?:clearpage|cleardoublepage|newpage|pagebreak)\b/.test(t);
    const opening = (t) =>
      /^\\(?:begin|label|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(t);
    // A heading's text is filed under the line after it (TeX reads ahead to
    // finish the heading), so the blank line after one belongs to it.
    const heading = (t) =>
      /^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]/.test(t);
    const own = text(lineNumber);
    const comment = own.startsWith("%");
    const reach = 80;
    // A heading's text is filed under its own line or, as TeX reads ahead to
    // finish it, under the next one; its own line may also carry the head
    // and folio of the page \chapter's \clearpage ships.
    if (heading(own)) return { line: lineNumber, toEnd: false, heading: lineNumber };
    if (!comment && (!own || closing(own))) {
      for (let n = lineNumber - 1; n >= 1 && n >= lineNumber - reach; n -= 1) {
        const t = text(n);
        if (quiet(t) || closing(t)) continue;
        if (heading(t) && !own && n === lineNumber - 1) return { line: n, toEnd: false, heading: n };
        return { line: n, toEnd: !heading(t) };
      }
    } else if (comment || opening(own)) {
      for (let n = lineNumber + 1; n <= lines.length && n <= lineNumber + reach; n += 1) {
        const t = text(n);
        if (!quiet(t) && !opening(t)) return { line: n, toEnd: false };
      }
    }
    return { line: lineNumber, toEnd: false };
  };

  // The file an \input / \include / \subfile line reads, if it exists. TeX
  // resolves the name against the directory it runs in: the project root,
  // which is also the PDF's unless the build writes to an output directory.
  const includedFileOnLine = (sourcePath, lineNumber, baseDirs) => {
    let text;
    try {
      text = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/)[lineNumber - 1];
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    const code = text.replace(/(^|[^\\])%.*$/, "$1");
    const match = /\\(?:input|include|subfile)\s*\{([^}]+)\}/.exec(code);
    if (!match) return null;
    const name = match[1].trim();
    for (const base of baseDirs) {
      for (const candidate of [name, `${name}.tex`]) {
        const full = path.resolve(base, candidate);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          // try the next spelling or directory
        }
      }
    }
    return null;
  };

  const readMtimeMs = (targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return 0;
    }
    try {
      const stats = fs.statSync(targetPath);
      const value = Number(stats?.mtimeMs);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  const buildSynctexForwardCacheKey = ({ sourcePath, pdfPath, line, column }) =>
    `${sourcePath}::${pdfPath}::${Math.floor(line)}:${Math.floor(column)}`;

  const pruneSynctexForwardCache = (now = Date.now()) => {
    const maxAgeMs = 8000;
    for (const [key, entry] of synctexForwardResultCache.entries()) {
      if (!entry || now - entry.timestamp > maxAgeMs) {
        synctexForwardResultCache.delete(key);
      }
    }
    const maxEntries = 160;
    if (synctexForwardResultCache.size <= maxEntries) {
      return;
    }
    const entries = Array.from(synctexForwardResultCache.entries()).sort(
      (left, right) => (left[1]?.timestamp ?? 0) - (right[1]?.timestamp ?? 0)
    );
    while (synctexForwardResultCache.size > maxEntries && entries.length > 0) {
      const oldest = entries.shift();
      if (!oldest) {
        break;
      }
      synctexForwardResultCache.delete(oldest[0]);
    }
  };

  const getCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
  }) => {
    const now = Date.now();
    pruneSynctexForwardCache(now);
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
    const entry = synctexForwardResultCache.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.timestamp > 1200) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    const pdfMtimeMs = readMtimeMs(pdfPath);
    const sourceMtimeMs = readMtimeMs(sourcePath);
    if (entry.pdfMtimeMs !== pdfMtimeMs || entry.sourceMtimeMs !== sourceMtimeMs) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    const cached = {
      ok: true,
      page: entry.page,
      x: entry.x,
      y: entry.y,
      fallback: entry.fallback === true,
      cached: true,
    };
    if (Number.isFinite(entry.blockX)) cached.blockX = entry.blockX;
    if (Number.isFinite(entry.blockY)) cached.blockY = entry.blockY;
    if (Number.isFinite(entry.blockWidth) && entry.blockWidth > 0) cached.blockWidth = entry.blockWidth;
    if (Number.isFinite(entry.blockHeight) && entry.blockHeight > 0) cached.blockHeight = entry.blockHeight;
    return cached;
  };

  const setCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
    result,
  }) => {
    if (!result || result.ok !== true) {
      return;
    }
    if (
      !Number.isFinite(result.page) ||
      !Number.isFinite(result.x) ||
      !Number.isFinite(result.y)
    ) {
      return;
    }
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
	    const cacheEntry = {
	      timestamp: Date.now(),
	      page: result.page,
	      x: result.x,
	      y: result.y,
	      fallback: result.fallback === true,
	      pdfMtimeMs: readMtimeMs(pdfPath),
	      sourceMtimeMs: readMtimeMs(sourcePath),
	    };
	    if (Number.isFinite(result.blockX)) cacheEntry.blockX = result.blockX;
	    if (Number.isFinite(result.blockY)) cacheEntry.blockY = result.blockY;
	    if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) cacheEntry.blockWidth = result.blockWidth;
	    if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) cacheEntry.blockHeight = result.blockHeight;
	    synctexForwardResultCache.set(key, cacheEntry);
	    pruneSynctexForwardCache();
	  };

	  const handleSynctexForward = async (message) => {
	    const generation = ++synctexForwardGeneration;
	    const isStaleRequest = () => generation !== synctexForwardGeneration;
	    const requestId =
	      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    const withRequestId = (payload) =>
      requestId ? { ...payload, requestId } : { ...payload };
    const forwardSource =
      typeof message?.source === "string" && message.source.trim()
        ? message.source.trim()
        : "other";
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "No workspace is selected.",
      }));
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "No TeX file selected.",
      }));
      return;
    }
    if (!sourcePath.toLowerCase().endsWith(".tex")) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "SyncTeX only supports TeX files.",
      }));
      return;
    }
    if (!pdfPath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "PDF has not been generated yet.",
      }));
      return;
    }
    const line = Number.parseInt(message.line, 10);
    const column = Number.parseInt(message.column, 10);
    const targetLine = Number.isFinite(line) ? line : 1;
    const targetColumn = Number.isFinite(column) ? column : 1;
    const viewerMode = message.pdfViewerMode === "tab" ? "tab" : "window";
    const allowFallback = message.fallbackToTop !== false;
    if (isStaleRequest()) {
      return;
    }
    const cached = getCachedSynctexForwardResult({
      sourcePath,
      pdfPath,
      line: targetLine,
      column: targetColumn,
    });
    if (cached) {
      if (viewerMode === "window") {
        pdfWindowManager.show(pdfPath, { reload: false });
        const windowCachedSync = { page: cached.page, x: cached.x, y: cached.y };
        if (Number.isFinite(cached.blockX)) windowCachedSync.blockX = cached.blockX;
        if (Number.isFinite(cached.blockY)) windowCachedSync.blockY = cached.blockY;
        if (Number.isFinite(cached.blockWidth) && cached.blockWidth > 0) windowCachedSync.blockWidth = cached.blockWidth;
        if (Number.isFinite(cached.blockHeight) && cached.blockHeight > 0) windowCachedSync.blockHeight = cached.blockHeight;
        pdfWindowManager.queueSync(windowCachedSync);
      }
      synctexService.registerForwardHint({
        pdfPath,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
      const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
      const cachedPayload = {
        ok: true,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        fallback: cached.fallback === true,
        cached: true,
        pdfPath: relativePdfPath,
      };
      if (Number.isFinite(cached.blockX)) cachedPayload.blockX = cached.blockX;
      if (Number.isFinite(cached.blockY)) cachedPayload.blockY = cached.blockY;
      if (Number.isFinite(cached.blockWidth) && cached.blockWidth > 0) cachedPayload.blockWidth = cached.blockWidth;
      if (Number.isFinite(cached.blockHeight) && cached.blockHeight > 0) cachedPayload.blockHeight = cached.blockHeight;
      sendToRenderer("synctex:forwardResult", withRequestId(cachedPayload));
      return;
    }
    const isRetryableSynctexError = (error) =>
      typeof error === "string" &&
      (error.includes("position") || error.includes("parsing failed"));
    const getForwardTargetDiff = (forwardResult, expectedLine) => {
      if (!forwardResult || forwardResult.ok !== true || !Number.isFinite(expectedLine)) {
        return Number.POSITIVE_INFINITY;
      }
      if (forwardResult.sameSourcePath === true && Number.isFinite(forwardResult.matchedLine)) {
        return Math.abs(forwardResult.matchedLine - expectedLine);
      }
      return Number.POSITIVE_INFINITY;
    };
    const isLowQualityForwardResult = (forwardResult, expectedLine = targetLine) => {
      if (!forwardResult || forwardResult.ok !== true) {
        return false;
      }
      const targetDiff = getForwardTargetDiff(forwardResult, expectedLine);
      if (Number.isFinite(targetDiff)) {
        return targetDiff > 1;
      }
      if (forwardResult.sameSourcePath === false) {
        return true;
      }
      if (Number.isFinite(forwardResult.matchDiff)) {
        return forwardResult.matchDiff > 1;
      }
      return false;
    };

    const runForward = async (forwardLine, forwardColumn, narrowing = {}) => {
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      let result = await synctexService.forward({
        sourcePath,
        line: Number.isFinite(forwardLine) ? forwardLine : 1,
        column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
        pdfPath,
        hintLine: targetLine,
        hintColumn: targetColumn,
        registerHint: false,
        ...narrowing,
      });
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      if (result.ok || !isRetryableSynctexError(result.error)) {
        return result;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        await delay(200);
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        result = await synctexService.forward({
          sourcePath,
          line: Number.isFinite(forwardLine) ? forwardLine : 1,
          column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
          pdfPath,
          hintLine: targetLine,
          hintColumn: targetColumn,
          registerHint: false,
          ...narrowing,
        });
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        if (result.ok || !isRetryableSynctexError(result.error)) {
          break;
        }
      }
      return result;
    };

    const preferBacktrack = isSkippableSynctexLine(sourcePath, targetLine);
    // Which nearby line left ink is a memory read from the SyncTeX index.
    // Probing the neighbours one `synctex view` process at a time took
    // 6–27 s from a preamble line and held up the next Jump meanwhile, so
    // the CLI now runs once, on the line the index picked, for its block box.
    // null: the index could not answer; the process probes below still can.
    const resolveFromIndex = async () => {
      if (typeof synctexService.forwardLinesQuick !== "function") return null;
      let quick;
      let anchor = { line: targetLine, toEnd: false };
      try {
        anchor = jumpAnchorLine(sourcePath, targetLine);
        // An \input / \include line stands for the file it reads: go to
        // where that file's output begins (or ends, from the blank line
        // after it). The line itself only marks where TeX came back from
        // the file, often the last page.
        const included = includedFileOnLine(sourcePath, anchor.line, [
          rootPath,
          path.dirname(pdfPath),
          path.dirname(sourcePath),
        ]);
        if (included) {
          let lastLine = 1;
          try {
            lastLine = fs.readFileSync(included, "utf8").split(/\r?\n/).length;
          } catch {
            // start of the file then
          }
          const inner = synctexService.forwardLinesQuick({
            sourcePath: included,
            pdfPath,
            lines: [anchor.toEnd ? lastLine : 1],
            preferAbove: anchor.toEnd,
            firstSubstantialPage: !anchor.toEnd,
            lastSubstantialPage: anchor.toEnd,
          });
          const innerHit = inner?.ok ? inner.results?.[0] : null;
          if (innerHit?.found) {
            return { ok: true, page: innerHit.page, x: innerHit.x, y: innerHit.y, fallback: true };
          }
        }
        if (anchor.heading) {
          // The heading is on the later of: the last page its own line
          // reaches (after any page it shipped) and the first page of the
          // next line's records, when that line has any.
          const own = synctexService.forwardLinesQuick({
            sourcePath,
            pdfPath,
            lines: [anchor.heading],
            lastSubstantialPage: true,
          });
          const next = synctexService.forwardLinesQuick({
            sourcePath,
            pdfPath,
            lines: [anchor.heading + 1],
            firstSubstantialPage: true,
          });
          const ownHit = own?.ok ? own.results?.[0] : null;
          const nextHit = next?.ok ? next.results?.[0] : null;
          const candidates = [
            ownHit?.found && ownHit.matchedLine === anchor.heading ? ownHit : null,
            nextHit?.found && nextHit.matchedLine === anchor.heading + 1 ? nextHit : null,
          ].filter(Boolean);
          if (candidates.length > 0) {
            const best = candidates.reduce((a, b) => (b.page > a.page ? b : a));
            quick = { ...own, ok: true, isRootFile: own?.isRootFile, results: [best] };
          }
        }
        quick ??= synctexService.forwardLinesQuick({
          sourcePath,
          pdfPath,
          lines: [anchor.line],
          preferAbove: anchor.toEnd,
          firstSubstantialPage: !anchor.toEnd,
          lastSubstantialPage: anchor.toEnd,
        });
      } catch {
        return null;
      }
      if (!quick?.ok) {
        // The PDF's SyncTeX was read and this file is not in it: no other
        // line of it can do better.
        return quick?.error === "The file is not part of this PDF." ? { ok: false, error: quick.error } : null;
      }
      const hit = quick.results?.[0];
      if (!hit) return null;
      const inPreamble = quick.isRootFile === true && isPreambleLine(sourcePath, targetLine);
      if (!hit.found || (inPreamble && hit.matchedLine !== targetLine)) {
        // Nothing near this line reaches the page (the preamble, say).
        return allowFallback
          ? { ok: true, page: 1, x: 0, y: 0, fallback: true, notTypeset: true }
          : { ok: false, error: "This line does not appear in the PDF.", notTypeset: true };
      }
      const line = hit.matchedLine;
      const fallback = line !== targetLine || anchor.line !== targetLine;
      // The first box on the page the index picked is where that line's
      // output begins there; checking more boxes costs one process each.
      const forward = await runForward(line, fallback ? 1 : column, {
        preferPage: hit.page,
        preferBottom: anchor.toEnd,
        maxVerifiedBlocks: 1,
      });
      if (forward.cancelled) return forward;
      if (forward.ok && !isLowQualityForwardResult(forward, line)) {
        return fallback ? { ...forward, fallback: true } : forward;
      }
      return { ok: true, page: hit.page, x: hit.x, y: hit.y, fallback };
    };
    const indexed = await resolveFromIndex();
    if (isStaleRequest() || indexed?.cancelled === true) {
      return;
    }
    let result = indexed ?? (preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(targetLine, column));
    let bestLowQualitySuccess =
      !indexed && result.ok && isLowQualityForwardResult(result, targetLine)
        ? {
            result,
            offset: 0,
            matchDiff: getForwardTargetDiff(result, targetLine),
          }
        : null;
    if (!indexed && (preferBacktrack || (!result.ok && isRetryableSynctexError(result.error)))) {
      const maxBacktrack = forwardSource === "manual" ? 60 : 80;
      for (let offset = 1; offset <= maxBacktrack; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = targetLine - offset;
        if (candidateLine < 1) {
          break;
        }
        if (isSkippableSynctexLine(sourcePath, candidateLine)) {
          continue;
        }
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok) {
          const candidateLowQuality = isLowQualityForwardResult(candidate, targetLine);
          if (!candidateLowQuality) {
            candidate.fallback = true;
            result = candidate;
            break;
          }
          const candidateMatchDiff = getForwardTargetDiff(candidate, targetLine);
          const candidateScore = {
            result: { ...candidate, fallback: true },
            offset,
            matchDiff: candidateMatchDiff,
          };
          if (!bestLowQualitySuccess) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          const currentSamePath = bestLowQualitySuccess.result.sameSourcePath === true;
          const nextSamePath = candidateScore.result.sameSourcePath === true;
          if (nextSamePath && !currentSamePath) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          if (nextSamePath === currentSamePath) {
            if (candidateScore.matchDiff < bestLowQualitySuccess.matchDiff) {
              bestLowQualitySuccess = candidateScore;
              continue;
            }
            if (
              candidateScore.matchDiff === bestLowQualitySuccess.matchDiff &&
              candidateScore.offset < bestLowQualitySuccess.offset
            ) {
              bestLowQualitySuccess = candidateScore;
            }
          }
          continue;
        }
        if (!isRetryableSynctexError(candidate.error)) {
          result = candidate;
          break;
        }
      }
    }
    if (!indexed && ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok)) {
      const maxForwardScan = 12;
      for (let offset = 1; offset <= maxForwardScan; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = targetLine + offset;
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok && !isLowQualityForwardResult(candidate, targetLine)) {
          result = { ...candidate, fallback: true };
          break;
        }
      }
    }
    if (
      !indexed &&
      ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) &&
      bestLowQualitySuccess?.result?.ok
    ) {
      result = bestLowQualitySuccess.result;
    }
    if (!indexed && result.ok) {
      const exactDiff = getForwardTargetDiff(result, targetLine);
      if (Number.isFinite(exactDiff) && exactDiff > 0) {
        const maxExactScan = 12;
        outerExactScan: for (let offset = 1; offset <= maxExactScan; offset += 1) {
          if (isStaleRequest()) {
            return;
          }
          const candidateLine = targetLine - offset;
          if (candidateLine >= 1) {
            const candidate = await runForward(candidateLine, column);
            if (candidate.ok && getForwardTargetDiff(candidate, targetLine) === 0) {
              result = { ...candidate, fallback: true };
              break outerExactScan;
            }
          }
          const forwardLine = targetLine + offset;
          const forwardCandidate = await runForward(forwardLine, column);
          if (forwardCandidate.ok && getForwardTargetDiff(forwardCandidate, targetLine) === 0) {
            result = { ...forwardCandidate, fallback: true };
            break outerExactScan;
          }
        }
      }
    }
    if (!indexed && !result.ok && allowFallback) {
      const fallbackResult = await runForward(1, 1);
      if (fallbackResult.ok) {
        fallbackResult.fallback = true;
      }
      result = fallbackResult;
    }
    if (isStaleRequest() || result?.cancelled === true) {
      return;
    }
    if (!result.ok) {
      sendToRenderer("synctex:forwardResult", withRequestId(result));
      return;
    }
    if (
      result.notTypeset !== true &&
      Number.isFinite(result.page) &&
      Number.isFinite(result.x) &&
      Number.isFinite(result.y)
    ) {
      synctexService.registerForwardHint({
        pdfPath,
        page: result.page,
        x: result.x,
        y: result.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
    }
    if (result.notTypeset !== true) {
      setCachedSynctexForwardResult({
        sourcePath,
        pdfPath,
        line: targetLine,
        column: targetColumn,
        result,
      });
    }
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      const windowSyncPayload = { page: result.page, x: result.x, y: result.y };
      if (result.notTypeset === true) windowSyncPayload.marker = false;
      if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) {
        windowSyncPayload.blockWidth = result.blockWidth;
      }
      if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) {
        windowSyncPayload.blockHeight = result.blockHeight;
      }
      if (Number.isFinite(result.blockX)) {
        windowSyncPayload.blockX = result.blockX;
      }
      if (Number.isFinite(result.blockY)) {
        windowSyncPayload.blockY = result.blockY;
      }
      pdfWindowManager.queueSync(windowSyncPayload);
    }
    const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
    const forwardPayload = {
      ok: true,
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true,
      pdfPath: relativePdfPath,
    };
    if (result.notTypeset === true) forwardPayload.notTypeset = true;
    if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) {
      forwardPayload.blockWidth = result.blockWidth;
    }
    if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) {
      forwardPayload.blockHeight = result.blockHeight;
    }
    if (Number.isFinite(result.blockX)) {
      forwardPayload.blockX = result.blockX;
    }
    if (Number.isFinite(result.blockY)) {
      forwardPayload.blockY = result.blockY;
    }
    sendToRenderer("synctex:forwardResult", withRequestId(forwardPayload));
  };


  /**
   * Many lines of one file against one PDF in a single reply, answered from
   * the in-process SyncTeX index: no process per line, so the AI mode can pin
   * every proposed step to the page the moment the PDF is shown.
   */
  const handleSynctexForwardBatch = (message) => {
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim() ? message.requestId : null;
    if (!requestId) return;
    const reply = (payload) => sendToRenderer("synctex:forwardBatchResult", { requestId, ...payload });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      reply({ ok: false, error: "No workspace is selected." });
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath = resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath || !sourcePath.toLowerCase().endsWith(".tex")) {
      reply({ ok: false, error: "No TeX file selected." });
      return;
    }
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      reply({ ok: false, error: "PDF has not been generated yet." });
      return;
    }
    const lines = Array.isArray(message.lines)
      ? message.lines
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value) && value > 0)
          .slice(0, 64)
      : [];
    if (lines.length === 0) {
      reply({ ok: true, results: [] });
      return;
    }
    try {
      const result = synctexService.forwardLinesQuick({ sourcePath, pdfPath, lines });
      reply({ ...result, path: message.path, pdfPath: message.pdfPath });
    } catch (_error) {
      reply({ ok: false, error: "SyncTeX parsing failed." });
    }
  };

  return { handleSynctexForward, handleSynctexForwardBatch };
};

module.exports = { createSynctexForwardHandler };
