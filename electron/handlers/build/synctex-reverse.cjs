const createSynctexReverseHandler = (deps, resolvers) => {
  const { synctexService, sendToRenderer, ensureWorkspace, state } = deps;
  const { resolveWorkspacePathFromRoot, resolveWorkspaceRelativePath, resolveSynctexWorkspacePath } =
    resolvers;

  const handleSynctexReverse = async (message) => {
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    const requestedGeneration = Number.isSafeInteger(message?.workspaceGeneration)
      ? message.workspaceGeneration
      : Number.isSafeInteger(state?.workspaceGeneration)
        ? state.workspaceGeneration
        : null;
    const requestedWorkspaceId =
      typeof message?.workspaceId === "string" && message.workspaceId.trim()
        ? message.workspaceId.trim()
        : typeof state?.workspaceId === "string" && state.workspaceId.trim()
          ? state.workspaceId.trim()
          : null;
    const documentMainFile =
      typeof message?.documentMainFile === "string" && message.documentMainFile.trim()
        ? message.documentMainFile.trim()
        : null;
    const withRequestId = (payload) => ({
      ...payload,
      ...(requestId ? { requestId } : {}),
      ...(Number.isSafeInteger(requestedGeneration)
        ? { workspaceGeneration: requestedGeneration }
        : {}),
      ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
      ...(documentMainFile ? { documentMainFile } : {}),
    });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "No workspace is selected.",
      }));
      return;
    }
    const requestIsCurrent = () => {
      if (ensureWorkspace() !== rootPath) return false;
      if (
        Number.isSafeInteger(requestedGeneration) &&
        Number.isSafeInteger(state?.workspaceGeneration) &&
        requestedGeneration !== state.workspaceGeneration
      ) {
        return false;
      }
      if (
        requestedWorkspaceId &&
        typeof state?.workspaceId === "string" &&
        state.workspaceId &&
        requestedWorkspaceId !== state.workspaceId
      ) {
        return false;
      }
      return true;
    };
    if (!requestIsCurrent()) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        stale: true,
        error: "The workspace changed.",
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
    const preferExact = message.preferExact === true;

    const reverseOptions = {
      page,
      x,
      y,
      pdfPath,
      refineLines,
      allowExpandedOffsets,
      bypassHint,
      preferExact,
    };
    let result;
    try {
      result = await synctexService.reverse(reverseOptions);
    } catch (_error) {
      if (!requestIsCurrent()) {
        sendToRenderer("synctex:reverseResult", withRequestId({
          ok: false,
          stale: true,
          error: "The workspace changed.",
        }));
        return;
      }
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX parsing failed.",
      }));
      return;
    }

    if (!requestIsCurrent()) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        stale: true,
        error: "The workspace changed.",
      }));
      return;
    }

    const resolveResultSourcePath = (candidate) => {
      const workspaceResolved = resolveSynctexWorkspacePath(rootPath, candidate?.path);
      if (!workspaceResolved) return null;
      return resolveWorkspaceRelativePath(rootPath, workspaceResolved) || null;
    };
    let resolvedSourcePath = result?.ok ? resolveResultSourcePath(result) : null;
    // The one-query path is the normal case. A package/class can occasionally
    // own the exact PDF point, though, and those files live outside the open
    // workspace. Only for that rare case, fall back to the broader scorer so a
    // nearby editable workspace line can still win without taxing every click.
    if (result?.ok && preferExact && result.fastPath === true && !resolvedSourcePath) {
      try {
        result = await synctexService.reverse({ ...reverseOptions, preferExact: false });
      } catch (_error) {
        if (!requestIsCurrent()) {
          sendToRenderer("synctex:reverseResult", withRequestId({
            ok: false,
            stale: true,
            error: "The workspace changed.",
          }));
          return;
        }
        sendToRenderer("synctex:reverseResult", withRequestId({
          ok: false,
          error: "SyncTeX parsing failed.",
        }));
        return;
      }
      if (!requestIsCurrent()) {
        sendToRenderer("synctex:reverseResult", withRequestId({
          ok: false,
          stale: true,
          error: "The workspace changed.",
        }));
        return;
      }
      resolvedSourcePath = result?.ok ? resolveResultSourcePath(result) : null;
    }

    if (!result?.ok) {
      // A reply that carries neither ok nor a reason leaves the caller waiting
      // on a promise that already settled against it.
      sendToRenderer(
        "synctex:reverseResult",
        withRequestId(
          result && typeof result === "object"
            ? { ...result, ok: false, error: result.error ?? "SyncTeX could not resolve that spot." }
            : { ok: false, error: "SyncTeX could not resolve that spot." },
        ),
      );
      return;
    }

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
      ...(result.fastPath === true ? { fastPath: true } : {}),
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
