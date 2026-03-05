const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const {
  MAX_APPLY_UNDO_ENTRIES,
  clipText,
} = require("./agent-core-utils.cjs");
const { decodeBase64Strict } = require("./agent-message-parts.cjs");
const { ensureSessionsRestored } = require("./agent-session-state.cjs");

const maybeAutoBuild = async (service, proposal) => {
  if (!service.agentOptions.autoBuild || service.autoBuildInProgress) {
    return null;
  }
  const pathValue = proposal?.path ?? "";
  if (!/\.(tex|bib|sty|cls|ltx|dtx)$/i.test(pathValue)) {
    return null;
  }
  service.autoBuildInProgress = true;
  try {
    return await service.executeToolCall(
      { name: "run_build", args: {} },
      proposal?.conversationId ?? "default"
    );
  } finally {
    service.autoBuildInProgress = false;
  }
};

const getContextSnapshot = (service, conversationId, targetPath) => {
  if (!targetPath) {
    return null;
  }
  const context = service.contextByConversation.get(conversationId);
  if (!context || !targetPath) {
    return null;
  }
  if (context.activeFilePath === targetPath && typeof context.activeFileContent === "string") {
    return {
      path: targetPath,
      content: context.activeFileContent,
      isDirty: Boolean(context.activeFileIsDirty),
      truncated: Boolean(context.activeFileContentTruncated),
      contentLength:
        typeof context.activeFileContentLength === "number"
          ? context.activeFileContentLength
          : context.activeFileContent.length,
    };
  }
  const snapshots = Array.isArray(context.openFileSnapshots) ? context.openFileSnapshots : [];
  const match = snapshots.find((entry) => entry.path === targetPath);
  if (!match || typeof match.content !== "string") {
    return null;
  }
  return {
    path: match.path,
    content: match.content,
    isDirty: Boolean(match.isDirty),
    truncated: Boolean(match.truncated),
    contentLength:
      typeof match.contentLength === "number" ? match.contentLength : match.content.length,
  };
};

const hashBuffer = (_service, buffer) => {
  return crypto.createHash("sha256").update(buffer).digest("hex");
};

const hashUtf8 = (service, value) => {
  return hashBuffer(service, Buffer.from(value ?? "", "utf8"));
};

const hashProposalContent = (service, proposal) => {
  if (!proposal) {
    return null;
  }
  if (proposal.encoding === "base64") {
    const decoded = decodeBase64Strict(proposal.content);
    if (!decoded) {
      return null;
    }
    return hashBuffer(service, Buffer.from(decoded.normalized, "base64"));
  }
  if (typeof proposal.content !== "string") {
    return null;
  }
  return hashUtf8(service, proposal.content);
};

const readCurrentFileState = async (service, relativePath) => {
  const resolved = service.workspace.resolvePath(relativePath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) {
    return { exists: false, isFile: false, resolved, buffer: null };
  }
  if (!stat.isFile()) {
    return { exists: true, isFile: false, resolved, buffer: null };
  }
  const buffer = await fsp.readFile(resolved);
  return { exists: true, isFile: true, resolved, buffer };
};

const validateProposalBeforeApply = async (service, proposal) => {
  const type = proposal?.type || "write";
  if (type === "mkdir") {
    const resolved = service.workspace.resolvePath(proposal.path);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (stat && !stat.isDirectory()) {
      return {
        ok: false,
        conflict: true,
        error: "同名のファイルが存在するためディレクトリを作成できません。",
      };
    }
    return { ok: true, targetState: { exists: Boolean(stat), isDirectory: Boolean(stat?.isDirectory?.()) } };
  }

  const targetPath = type === "rename" ? proposal.oldPath : proposal.path;
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, conflict: false, error: "提案の対象パスが不正です。" };
  }

  const state = await readCurrentFileState(service, targetPath);
  if (proposal.isNewFile === true && (type === "write" || type === "patch")) {
    if (state.exists) {
      return {
        ok: false,
        conflict: true,
        error: "新規作成予定のファイルが既に存在します。再提案してください。",
      };
    }
    return { ok: true, targetState: state };
  }

  if (!state.exists) {
    return {
      ok: false,
      conflict: true,
      error: "適用前に対象ファイルが削除または移動されました。再提案してください。",
    };
  }

  if (!state.isFile) {
    return {
      ok: false,
      conflict: true,
      error: "対象パスがファイルではありません。再提案してください。",
    };
  }

  const expectedHash =
    typeof proposal.baseContentHash === "string" ? proposal.baseContentHash.trim() : "";
  if (expectedHash && state.buffer) {
    const currentHash = hashBuffer(service, state.buffer);
    if (currentHash !== expectedHash) {
      return {
        ok: false,
        conflict: true,
        error: "適用前にファイル内容が変更されました。差分を確認して再提案してください。",
      };
    }
  }

  if (type === "rename") {
    const newState = await readCurrentFileState(service, proposal.path);
    if (newState.exists) {
      return {
        ok: false,
        conflict: true,
        error: "移動先に同名ファイルが存在します。別名で再提案してください。",
      };
    }
  }

  return { ok: true, targetState: state };
};

const pushUndoEntry = (service, entry) => {
  if (!entry) {
    return;
  }
  service.applyUndoStack.push(entry);
  if (service.applyUndoStack.length > MAX_APPLY_UNDO_ENTRIES) {
    service.applyUndoStack.splice(0, service.applyUndoStack.length - MAX_APPLY_UNDO_ENTRIES);
  }
  if (typeof service.emitUndoAvailability === "function") {
    service.emitUndoAvailability(entry.conversationId || "default");
  }
};

const resolveTargetConversationId = (conversationId) =>
  typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : "";

const findLatestUndoIndex = (service, conversationId, { requireRunId = false, runId = null } = {}) => {
  const targetConversationId = resolveTargetConversationId(conversationId);
  for (let i = service.applyUndoStack.length - 1; i >= 0; i -= 1) {
    const entry = service.applyUndoStack[i];
    if (!entry) {
      continue;
    }
    if (targetConversationId && entry.conversationId !== targetConversationId) {
      continue;
    }
    if (requireRunId && !entry.runId) {
      continue;
    }
    if (runId && entry.runId !== runId) {
      continue;
    }
    return i;
  }
  return -1;
};

const undoEntryAtIndex = async (service, targetIndex, conversationId, { emitRenderer = true } = {}) => {
  const requestedConversationId = resolveTargetConversationId(conversationId);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= service.applyUndoStack.length) {
    if (requestedConversationId && typeof service.emitUndoAvailability === "function") {
      service.emitUndoAvailability(requestedConversationId);
    }
    if (emitRenderer) {
      service.emitAuditEvent(
        "undo_last_apply",
        { ok: false, reason: "no_entry" },
        requestedConversationId || null
      );
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message: "取り消せる操作がありません。",
        conversationId: requestedConversationId || undefined,
      });
    }
    return {
      ok: false,
      reason: "no_entry",
      message: "取り消せる操作がありません。",
      conversationId: requestedConversationId || undefined,
    };
  }

  const entry = service.applyUndoStack.splice(targetIndex, 1)[0];
  const reinstateEntry = () => {
    if (targetIndex >= 0 && targetIndex <= service.applyUndoStack.length) {
      service.applyUndoStack.splice(targetIndex, 0, entry);
    } else {
      service.applyUndoStack.push(entry);
    }
  };

  const targetConversationId =
    requestedConversationId ||
    (typeof entry?.conversationId === "string" && entry.conversationId.trim()
      ? entry.conversationId.trim()
      : "");
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    reinstateEntry();
    service.emitAuditEvent(
      "undo_last_apply",
      { ok: false, reason: "workspace_missing", path: entry.path, type: entry.type },
      targetConversationId || entry.conversationId
    );
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message: "ワークスペースが選択されていません。",
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    return {
      ok: false,
      reason: "workspace_missing",
      message: "ワークスペースが選択されていません。",
      conversationId: targetConversationId || entry.conversationId,
    };
  }

  try {
    if (entry.type === "write") {
      const resolved = service.workspace.resolvePath(entry.path);
      if (entry.existed && Buffer.isBuffer(entry.previousBuffer)) {
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await fsp.writeFile(resolved, entry.previousBuffer);
        if (entry.wasBinary !== true) {
          service.sendToRenderer("agent:applyContent", {
            path: entry.path,
            content: entry.previousBuffer.toString("utf8"),
            updateSaved: true,
          });
        }
      } else {
        await fsp.unlink(resolved).catch((error) => {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        });
      }
    } else if (entry.type === "delete") {
      const resolved = service.workspace.resolvePath(entry.path);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, entry.previousBuffer);
      if (entry.wasBinary !== true) {
        service.sendToRenderer("agent:applyContent", {
          path: entry.path,
          content: entry.previousBuffer.toString("utf8"),
          updateSaved: true,
        });
      }
    } else if (entry.type === "rename") {
      const fromResolved = service.workspace.resolvePath(entry.newPath);
      const toResolved = service.workspace.resolvePath(entry.oldPath);
      const fromStat = await fsp.stat(fromResolved).catch(() => null);
      if (!fromStat || !fromStat.isFile()) {
        throw new Error("移動先ファイルが見つからないため取り消せません。");
      }
      const toStat = await fsp.stat(toResolved).catch(() => null);
      if (toStat) {
        throw new Error("元のパスに既存ファイルがあるため取り消せません。");
      }
      await fsp.mkdir(path.dirname(toResolved), { recursive: true });
      await fsp.rename(fromResolved, toResolved);
      service.sendToRenderer("renameResult", {
        oldPath: entry.newPath,
        newPath: entry.oldPath,
        isDirectory: false,
      });
    } else if (entry.type === "mkdir") {
      const resolved = service.workspace.resolvePath(entry.path);
      const stat = await fsp.stat(resolved).catch(() => null);
      if (stat && stat.isDirectory()) {
        const childEntries = await fsp.readdir(resolved).catch(() => []);
        if (childEntries.length > 0) {
          throw new Error("ディレクトリ内にファイルがあるため取り消せません。");
        }
        await fsp.rmdir(resolved);
      }
    } else {
      throw new Error("未対応の取り消し操作です。");
    }

    await service.updateWorkspaceIfNeeded(rootPath, true);
    service.requestIndex(rootPath);
    service.emitAuditEvent(
      "undo_last_apply",
      { ok: true, path: entry.path, type: entry.type },
      targetConversationId || entry.conversationId
    );
    service.markSessionDirty(targetConversationId || entry.conversationId);
    if (typeof service.emitUndoAvailability === "function") {
      service.emitUndoAvailability(targetConversationId || entry.conversationId || "default");
    }
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: true,
        path: entry.path,
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    return {
      ok: true,
      path: entry.path,
      type: entry.type,
      runId: entry.runId || null,
      conversationId: targetConversationId || entry.conversationId,
    };
  } catch (error) {
    reinstateEntry();
    service.emitAuditEvent(
      "undo_last_apply",
      {
        ok: false,
        reason: "undo_failed",
        path: entry.path,
        type: entry.type,
        error: clipText(error?.message ?? "undo failed", 260),
      },
      targetConversationId || entry.conversationId
    );
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message: error?.message ?? "取り消しに失敗しました。",
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    service.markSessionDirty(targetConversationId || entry.conversationId);
    return {
      ok: false,
      reason: "undo_failed",
      message: error?.message ?? "取り消しに失敗しました。",
      conversationId: targetConversationId || entry.conversationId,
    };
  }
};

const undoLastApply = async (service, conversationId) => {
  await ensureSessionsRestored(service);
  const targetIndex = findLatestUndoIndex(service, conversationId);
  return undoEntryAtIndex(service, targetIndex, conversationId, { emitRenderer: true });
};

const undoLastRunApply = async (service, conversationId) => {
  await ensureSessionsRestored(service);
  const targetConversationId = resolveTargetConversationId(conversationId);
  const anchorIndex = findLatestUndoIndex(service, targetConversationId, { requireRunId: true });
  if (anchorIndex < 0) {
    return undoLastApply(service, conversationId);
  }
  const anchorEntry = service.applyUndoStack[anchorIndex];
  const targetRunId =
    anchorEntry && typeof anchorEntry.runId === "string" && anchorEntry.runId.trim()
      ? anchorEntry.runId.trim()
      : "";
  if (!targetRunId) {
    return undoLastApply(service, conversationId);
  }
  const targetIndexes = [];
  for (let i = service.applyUndoStack.length - 1; i >= 0; i -= 1) {
    const entry = service.applyUndoStack[i];
    if (!entry) {
      continue;
    }
    if (targetConversationId && entry.conversationId !== targetConversationId) {
      continue;
    }
    if (entry.runId === targetRunId) {
      targetIndexes.push(i);
    }
  }
  if (targetIndexes.length === 0) {
    return undoLastApply(service, conversationId);
  }

  let undoneCount = 0;
  let firstPath = "";
  for (const index of targetIndexes) {
    const result = await undoEntryAtIndex(service, index, targetConversationId, {
      emitRenderer: false,
    });
    if (!result.ok) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message: result.message ?? "取り消しに失敗しました。",
        conversationId: (result.conversationId ?? targetConversationId) || undefined,
      });
      return result;
    }
    undoneCount += 1;
    if (!firstPath && typeof result.path === "string" && result.path) {
      firstPath = result.path;
    }
  }

  const resultConversationId =
    targetConversationId ||
    (typeof anchorEntry?.conversationId === "string" ? anchorEntry.conversationId : "");
  const summaryMessage =
    undoneCount <= 1
      ? firstPath
        ? `取り消し完了: ${firstPath}`
        : "取り消し完了"
      : `実行単位で${undoneCount}件の変更を取り消しました。`;
  service.emitAuditEvent(
    "undo_run_apply",
    { ok: true, runId: targetRunId, count: undoneCount },
    resultConversationId || null
  );
  if (resultConversationId) {
    service.markSessionDirty(resultConversationId);
  }
  service.sendToRenderer("agent:undoResult", {
    ok: true,
    message: summaryMessage,
    conversationId: resultConversationId || undefined,
  });
  return {
    ok: true,
    runId: targetRunId,
    count: undoneCount,
    conversationId: resultConversationId || undefined,
  };
};

const applyProposal = async (service, proposalId, options = {}) => {
  await ensureSessionsRestored(service);
  const skipAutoBuild = options?.skipAutoBuild === true;
  const discardOnFailure = options?.discardOnFailure === true;
  const proposal = service.proposals.get(proposalId);
  const proposalConversationId =
    typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
      ? proposal.conversationId.trim()
      : "default";
  const runId = service.runningControllers.get(proposalConversationId)?.token ?? null;
  const rootPath = service.workspace.getRootPath();
  if (!proposal) {
    service.emitAuditEvent("proposal_apply", { proposalId, ok: false, reason: "not_found" }, null);
    service.sendToRenderer("agent:applyResult", {
      proposalId,
      ok: false,
      error: "提案が見つかりません。",
    });
    return { ok: false, proposalId, error: "提案が見つかりません。" };
  }
  if (!rootPath) {
    service.emitAuditEvent(
      "proposal_apply",
      { proposalId, ok: false, reason: "workspace_missing", path: proposal.path },
      proposal.conversationId || "default"
    );
    service.sendToRenderer("agent:applyResult", {
      proposalId,
      ok: false,
      error: "ワークスペースが選択されていません。",
    });
    if (discardOnFailure) {
      service.proposals.delete(proposalId);
    }
    return { ok: false, proposalId, path: proposal.path, error: "ワークスペースが選択されていません。" };
  }
  const expectedWorkspace =
    typeof proposal.workspaceRootPath === "string" && proposal.workspaceRootPath.trim()
      ? proposal.workspaceRootPath.trim()
      : "";
  if (expectedWorkspace && expectedWorkspace !== rootPath) {
    service.emitAuditEvent(
      "proposal_apply",
      {
        proposalId,
        ok: false,
        reason: "workspace_mismatch",
        path: proposal.path,
        expectedWorkspace,
        actualWorkspace: rootPath,
      },
      proposal.conversationId || "default"
    );
    service.sendToRenderer("agent:applyResult", {
      proposalId,
      ok: false,
      error: "別のワークスペースで作られた提案のため適用できません。",
    });
    if (discardOnFailure) {
      service.proposals.delete(proposalId);
    }
    return {
      ok: false,
      proposalId,
      path: proposal.path,
      error: "別のワークスペースで作られた提案のため適用できません。",
    };
  }
  try {
    const type = proposal.type || "write";
    const validation = await validateProposalBeforeApply(service, proposal);
    if (!validation.ok) {
      service.emitAuditEvent(
        "proposal_apply",
        {
          proposalId,
          ok: false,
          reason: "validation_failed",
          path: proposal.path,
          type,
          conflict: validation.conflict === true,
          error: clipText(validation.error || "validation failed", 260),
        },
        proposal.conversationId || "default"
      );
      service.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        conflict: validation.conflict === true,
        error: validation.error || "適用前チェックに失敗しました。",
      });
      if (discardOnFailure) {
        service.proposals.delete(proposalId);
      }
      return {
        ok: false,
        proposalId,
        path: proposal.path,
        conflict: validation.conflict === true,
        error: validation.error || "適用前チェックに失敗しました。",
      };
    }
    let undoEntry = null;

    if (type === "delete") {
      const resolved = service.workspace.resolvePath(proposal.path);
      const currentState = validation.targetState;
      if (!currentState?.buffer) {
        throw new Error("削除前の内容を取得できませんでした。");
      }
      undoEntry = {
        type: "delete",
        conversationId: proposal.conversationId || "default",
        runId,
        path: proposal.path,
        previousBuffer: currentState.buffer,
        wasBinary: Boolean(proposal.isBinary),
      };
      if (typeof service.workspace.moveToInternalTrash === "function") {
        await service.workspace.moveToInternalTrash(resolved);
      } else {
        await fsp.unlink(resolved);
      }
    } else if (type === "rename") {
      const oldResolved = service.workspace.resolvePath(proposal.oldPath);
      const newResolved = service.workspace.resolvePath(proposal.path);
      undoEntry = {
        type: "rename",
        conversationId: proposal.conversationId || "default",
        runId,
        oldPath: proposal.oldPath,
        newPath: proposal.path,
        path: proposal.path,
      };
      await fsp.mkdir(path.dirname(newResolved), { recursive: true });
      await fsp.rename(oldResolved, newResolved);
      service.sendToRenderer("renameResult", {
        oldPath: proposal.oldPath,
        newPath: proposal.path,
        isDirectory: false,
      });
    } else if (type === "mkdir") {
      const resolved = service.workspace.resolvePath(proposal.path);
      undoEntry = {
        type: "mkdir",
        conversationId: proposal.conversationId || "default",
        runId,
        path: proposal.path,
      };
      await fsp.mkdir(resolved, { recursive: true });
    } else {
      const resolved = service.workspace.resolvePath(proposal.path);
      const currentState = validation.targetState;
      const existedBefore = Boolean(currentState?.exists && currentState?.isFile);
      const previousBuffer = existedBefore ? currentState.buffer : null;
      const wasBinary = existedBefore ? Boolean(previousBuffer?.includes?.(0)) : false;
      const nextHash = hashProposalContent(service, proposal);
      if (nextHash && typeof proposal.baseContentHash === "string" && nextHash === proposal.baseContentHash) {
        service.sendToRenderer("agent:applyResult", {
          proposalId,
          ok: false,
          error: "変更内容がありません。",
        });
        if (discardOnFailure) {
          service.proposals.delete(proposalId);
        }
        return { ok: false, proposalId, path: proposal.path, error: "変更内容がありません。" };
      }
      undoEntry = {
        type: "write",
        conversationId: proposal.conversationId || "default",
        runId,
        path: proposal.path,
        existed: existedBefore,
        previousBuffer,
        wasBinary,
      };
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      if (proposal.encoding === "base64") {
        const decoded = decodeBase64Strict(proposal.content);
        if (!decoded) {
          throw new Error("base64 の内容が不正です。");
        }
        const buffer = Buffer.from(decoded.normalized, "base64");
        await fsp.writeFile(resolved, buffer);
      } else {
        await service.workspace.writeFile(proposal.path, proposal.content);
        service.sendToRenderer("agent:applyContent", {
          path: proposal.path,
          content: proposal.content,
          updateSaved: true,
        });
      }
    }

    pushUndoEntry(service, undoEntry);
    await service.updateWorkspaceIfNeeded(rootPath, true);
    service.requestIndex(rootPath);
    service.proposals.delete(proposalId);
    service.emitAuditEvent(
      "proposal_apply",
      { proposalId, ok: true, path: proposal.path, type: proposal.type || "write" },
      proposal.conversationId || "default"
    );
    service.markSessionDirty(proposal.conversationId || "default");
    service.sendToRenderer("agent:applyResult", { proposalId, ok: true });
    const autoBuild = skipAutoBuild ? null : await maybeAutoBuild(service, proposal);
    return {
      ok: true,
      proposalId,
      path: proposal.path,
      type: proposal.type || "write",
      autoBuild,
    };
  } catch (error) {
    service.emitAuditEvent(
      "proposal_apply",
      {
        proposalId,
        ok: false,
        reason: "apply_failed",
        path: proposal.path,
        type: proposal.type || "write",
        error: clipText(error?.message ?? "apply failed", 260),
      },
      proposal.conversationId || "default"
    );
    service.sendToRenderer("agent:applyResult", {
      proposalId,
      ok: false,
      error: error?.message ?? "操作に失敗しました。",
    });
    service.markSessionDirty(proposal.conversationId || "default");
    if (discardOnFailure) {
      service.proposals.delete(proposalId);
    }
    return {
      ok: false,
      proposalId,
      path: proposal.path,
      type: proposal.type || "write",
      error: error?.message ?? "操作に失敗しました。",
    };
  }
};

module.exports = {
  maybeAutoBuild,
  getContextSnapshot,
  hashBuffer,
  hashUtf8,
  hashProposalContent,
  readCurrentFileState,
  validateProposalBeforeApply,
  pushUndoEntry,
  undoLastApply,
  undoLastRunApply,
  applyProposal,
};
