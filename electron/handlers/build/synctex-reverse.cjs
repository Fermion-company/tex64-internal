const createSynctexReverseHandler = (deps, resolvers) => {
  const { synctexService, sendToRenderer, ensureWorkspace, state } = deps;
  const { resolveWorkspacePathFromRoot, resolveWorkspaceRelativePath, resolveSynctexWorkspacePath } =
    resolvers;

  const handleSynctexReverse = async (message) => {
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    const withRequestId = (payload) =>
      requestId ? { ...payload, requestId } : { ...payload };
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "No workspace is selected.",
      }));
      return;
    }

    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) ||
      resolveWorkspacePathFromRoot(rootPath, message.path) ||
      state.lastBuildPdfPath;
    if (!pdfPath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "PDF has not been generated yet.",
      }));
      return;
    }

    const page = Number.parseInt(message.page, 10);
    const x = Number.parseFloat(message.x);
    const y = Number.parseFloat(message.y);
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX coordinates are invalid.",
      }));
      return;
    }

    const parsedRefineLines = Number.parseInt(message.refineLines, 10);
    const refineLines =
      Number.isFinite(parsedRefineLines) && parsedRefineLines >= 0
        ? parsedRefineLines
        : undefined;
    const allowExpandedOffsets =
      message.allowExpandedOffsets === true;
    const bypassHint = message.bypassHint === true;

    let result;
    try {
      result = await synctexService.reverse({
        page,
        x,
        y,
        pdfPath,
        refineLines,
        allowExpandedOffsets,
        bypassHint,
      });
    } catch (_error) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX parsing failed.",
      }));
      return;
    }

    if (!result?.ok) {
      sendToRenderer("synctex:reverseResult", withRequestId(result));
      return;
    }

    const resolvedSourcePath = (() => {
      const workspaceResolved = resolveSynctexWorkspacePath(rootPath, result.path);
      if (!workspaceResolved) {
        return null;
      }
      const normalized = resolveWorkspaceRelativePath(rootPath, workspaceResolved);
      if (normalized) {
        return normalized;
      }
      return null;
    })();
    if (!resolvedSourcePath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX reference is outside the workspace.",
      }));
      return;
    }

    sendToRenderer("synctex:reverseResult", withRequestId({
      ok: true,
      path: resolvedSourcePath,
      line: result.line,
      column: result.column ?? 1,
      confidence: result.confidence === true,
      scoreGap: Number.isFinite(result.scoreGap) ? result.scoreGap : null,
      distance: Number.isFinite(result.distance) ? result.distance : null,
      hinted: result.hinted === true,
      hintCandidateCount:
        Number.isFinite(result.hintCandidateCount) && result.hintCandidateCount >= 0
          ? result.hintCandidateCount
          : null,
      hintPreview: Array.isArray(result.hintPreview) ? result.hintPreview : null,
      pdfPath: resolveWorkspaceRelativePath(rootPath, pdfPath),
    }));
  };


  return { handleSynctexReverse };
};

module.exports = { createSynctexReverseHandler };
