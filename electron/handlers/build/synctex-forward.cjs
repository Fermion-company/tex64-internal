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
        error: "ワークスペースが選択されていません。",
      }));
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "対象のTeXファイルが選択されていません。",
      }));
      return;
    }
    if (!sourcePath.toLowerCase().endsWith(".tex")) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "SyncTeX は TeX ファイルのみ対応しています。",
      }));
      return;
    }
    if (!pdfPath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "PDFがまだ生成されていません。",
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
      (error.includes("位置情報") || error.includes("解析に失敗"));
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

    const runForward = async (forwardLine, forwardColumn) => {
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
    let result = preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(targetLine, column);
    let bestLowQualitySuccess =
      result.ok && isLowQualityForwardResult(result, targetLine)
        ? {
            result,
            offset: 0,
            matchDiff: getForwardTargetDiff(result, targetLine),
          }
        : null;
    if (preferBacktrack || (!result.ok && isRetryableSynctexError(result.error))) {
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
    if ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) {
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
      ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) &&
      bestLowQualitySuccess?.result?.ok
    ) {
      result = bestLowQualitySuccess.result;
    }
    if (result.ok) {
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
    if (!result.ok && allowFallback) {
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
    setCachedSynctexForwardResult({
      sourcePath,
      pdfPath,
      line: targetLine,
      column: targetColumn,
      result,
    });
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      const windowSyncPayload = { page: result.page, x: result.x, y: result.y };
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


  return { handleSynctexForward };
};

module.exports = { createSynctexForwardHandler };
