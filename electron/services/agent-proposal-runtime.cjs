const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const {
  MAX_APPLY_UNDO_ENTRIES,
  clipText,
} = require("./agent-core-utils.cjs");
const { decodeBase64Strict } = require("./agent-message-parts.cjs");
const { ensureSessionsRestored } = require("./agent-session-state.cjs");

const refreshWorkspaceBestEffort = async (service, rootPath) => {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve(service.updateWorkspaceIfNeeded(rootPath, true)).catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 6_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

const callBestEffort = (callback) => {
  try {
    return callback();
  } catch {
    return undefined;
  }
};

const maybeAutoBuild = async (service, proposal) => {
  if (!service.agentOptions.autoBuild) {
    return null;
  }
  if (proposal?.type === "mkdir") {
    return null;
  }
  // AgentService serializes every run_build, including explicit model builds
  // and deterministic terminal settlement across concurrent conversations.
  try {
    return await service.executeToolCall(
      { name: "run_build", args: {} },
      proposal?.conversationId ?? "default"
    );
  } catch (error) {
    return {
      status: "failure",
      summary: error?.message || "Build failed.",
    };
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
        error: "Cannot create directory: a file with the same name exists.",
      };
    }
    return { ok: true, targetState: { exists: Boolean(stat), isDirectory: Boolean(stat?.isDirectory?.()) } };
  }

  const targetPath = type === "rename" ? proposal.oldPath : proposal.path;
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, conflict: false, error: "Invalid proposal target path." };
  }

  const state = await readCurrentFileState(service, targetPath);
  if (proposal.isNewFile === true && (type === "write" || type === "patch")) {
    if (state.exists) {
      return {
        ok: false,
        conflict: true,
        error: "File already exists. Please re-propose.",
      };
    }
    return { ok: true, targetState: state };
  }

  if (!state.exists) {
    return {
      ok: false,
      conflict: true,
      error: "File was deleted or moved before apply. Please re-propose.",
    };
  }

  if (!state.isFile) {
    return {
      ok: false,
      conflict: true,
      error: "Target path is not a file. Please re-propose.",
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
        error: "File content was modified before apply. Please review the diff and re-propose.",
      };
    }
  }

  if (type === "rename") {
    const newState = await readCurrentFileState(service, proposal.path);
    if (newState.exists) {
      return {
        ok: false,
        conflict: true,
        error: "A file with the same name exists at the destination. Please re-propose with a different name.",
      };
    }
  }

  return { ok: true, targetState: state };
};

const pushUndoEntry = (service, entry) => {
  if (!entry) {
    return;
  }
  const workspaceRootPath =
    typeof entry.workspaceRootPath === "string" && entry.workspaceRootPath.trim()
      ? entry.workspaceRootPath.trim()
      : service.workspace.getRootPath();
  service.applyUndoStack.push({
    ...entry,
    workspaceRootPath: workspaceRootPath || null,
  });
  while (service.applyUndoStack.length > MAX_APPLY_UNDO_ENTRIES) {
    const oldest = service.applyUndoStack[0];
    const oldestConversationId = oldest?.conversationId || "default";
    const oldestRunId =
      typeof oldest?.runId === "string" && oldest.runId.trim()
        ? oldest.runId.trim()
        : null;
    const removed = [];
    service.applyUndoStack = service.applyUndoStack.filter((candidate, index) => {
      const sameAtomicGroup = oldestRunId
        ? candidate?.conversationId === oldestConversationId && candidate?.runId === oldestRunId
        : index === 0;
      if (sameAtomicGroup) removed.push(candidate);
      return !sameAtomicGroup;
    });
    if (!(service.undoPersistenceBarriersByConversation instanceof Map)) {
      service.undoPersistenceBarriersByConversation = new Map();
    }
    service.undoPersistenceBarriersByConversation.set(oldestConversationId, {
      reason: "persistence_limit",
      runId: oldestRunId,
      entryCount: Math.max(1, removed.length),
      workspaceRootPath:
        typeof oldest?.workspaceRootPath === "string"
          ? oldest.workspaceRootPath
          : null,
    });
  }
  if (typeof service.emitUndoAvailability === "function") {
    service.emitUndoAvailability(entry.conversationId || "default");
  }
  if (typeof service.markSessionDirty === "function") {
    service.markSessionDirty(entry.conversationId || "default");
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

const undoEntryAtIndex = async (
  service,
  targetIndex,
  conversationId,
  {
    emitRenderer = true,
    deferFinalize = false,
    rendererEvents = null,
  } = {},
) => {
  const sendMutationEvent = (type, payload) => {
    if (Array.isArray(rendererEvents)) {
      rendererEvents.push({ type, payload });
      return;
    }
    callBestEffort(() => service.sendToRenderer(type, payload));
  };
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
        message: "No operations to undo.",
        conversationId: requestedConversationId || undefined,
      });
    }
    return {
      ok: false,
      reason: "no_entry",
      message: "No operations to undo.",
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
        message: "No workspace is selected.",
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    return {
      ok: false,
      reason: "workspace_missing",
      message: "No workspace is selected.",
      conversationId: targetConversationId || entry.conversationId,
    };
  }
  if (
    typeof entry.workspaceRootPath === "string" &&
    entry.workspaceRootPath &&
    path.resolve(entry.workspaceRootPath) !== path.resolve(rootPath)
  ) {
    reinstateEntry();
    const message = "Cannot undo: this change belongs to another workspace.";
    service.emitAuditEvent(
      "undo_last_apply",
      { ok: false, reason: "workspace_changed", path: entry.path, type: entry.type },
      targetConversationId || entry.conversationId
    );
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message,
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    return {
      ok: false,
      reason: "workspace_changed",
      message,
      conversationId: targetConversationId || entry.conversationId,
    };
  }

  try {
    if (entry.type === "write") {
      const resolved = service.workspace.resolvePath(entry.path);
      const appliedState = await readCurrentFileState(service, entry.path);
      const appliedHash =
        appliedState.exists && appliedState.isFile && Buffer.isBuffer(appliedState.buffer)
          ? hashBuffer(service, appliedState.buffer)
          : null;
      if (!entry.appliedHash || appliedHash !== entry.appliedHash) {
        throw new Error(
          "Cannot undo: the file changed after Axiom edited it. Your later changes were kept.",
        );
      }
      if (entry.existed && Buffer.isBuffer(entry.previousBuffer)) {
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await fsp.writeFile(resolved, entry.previousBuffer);
        if (entry.wasBinary !== true) {
          sendMutationEvent("agent:applyContent", {
            path: entry.path,
            content: entry.previousBuffer.toString("utf8"),
            expectedContent: appliedState.buffer.toString("utf8"),
            updateSaved: true,
            conversationId: targetConversationId || entry.conversationId,
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
      const currentState = await readCurrentFileState(service, entry.path);
      if (currentState.exists) {
        throw new Error(
          "Cannot undo: a new file now exists at the deleted path. It was kept.",
        );
      }
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, entry.previousBuffer);
      if (entry.wasBinary !== true) {
        sendMutationEvent("agent:applyContent", {
            path: entry.path,
            content: entry.previousBuffer.toString("utf8"),
            expectedFileMissing: true,
            updateSaved: true,
            conversationId: targetConversationId || entry.conversationId,
        });
      }
    } else if (entry.type === "rename") {
      const fromResolved = service.workspace.resolvePath(entry.newPath);
      const toResolved = service.workspace.resolvePath(entry.oldPath);
      const fromStat = await fsp.stat(fromResolved).catch(() => null);
      if (!fromStat || !fromStat.isFile()) {
        throw new Error("Cannot undo: destination file not found.");
      }
      const toStat = await fsp.stat(toResolved).catch(() => null);
      if (toStat) {
        throw new Error("Cannot undo: a file already exists at the original path.");
      }
      const movedBuffer = await fsp.readFile(fromResolved);
      if (!entry.appliedHash || hashBuffer(service, movedBuffer) !== entry.appliedHash) {
        throw new Error(
          "Cannot undo: the renamed file changed afterwards. Your later changes were kept.",
        );
      }
      await fsp.mkdir(path.dirname(toResolved), { recursive: true });
      await fsp.rename(fromResolved, toResolved);
      const context = service.contextByConversation.get(
        targetConversationId || entry.conversationId,
      );
      if (context) {
        if (context.documentMainFile === entry.newPath) {
          context.documentMainFile = entry.oldPath;
        }
        if (context.activeFilePath === entry.newPath) {
          context.activeFilePath = entry.oldPath;
        }
      }
      sendMutationEvent("renameResult", {
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
          throw new Error("Cannot undo: directory is not empty.");
        }
        await fsp.rmdir(resolved);
      }
    } else {
      throw new Error("Unsupported undo operation.");
    }

    if (!deferFinalize) {
      await refreshWorkspaceBestEffort(service, rootPath);
      callBestEffort(() => service.requestIndex(rootPath));
      callBestEffort(() => service.emitAuditEvent(
        "undo_last_apply",
        { ok: true, path: entry.path, type: entry.type },
        targetConversationId || entry.conversationId
      ));
      callBestEffort(() => service.markSessionDirty(targetConversationId || entry.conversationId));
      if (typeof service.emitUndoAvailability === "function") {
        callBestEffort(() =>
          service.emitUndoAvailability(targetConversationId || entry.conversationId || "default")
        );
      }
    }
    if (emitRenderer) {
      callBestEffort(() => service.sendToRenderer("agent:undoResult", {
        ok: true,
        path: entry.path,
        conversationId: targetConversationId || entry.conversationId,
      }));
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
    if (!deferFinalize) {
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
    }
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message: error?.message ?? "Undo failed.",
        conversationId: targetConversationId || entry.conversationId,
      });
    }
    if (!deferFinalize) {
      service.markSessionDirty(targetConversationId || entry.conversationId);
    }
    return {
      ok: false,
      reason: "undo_failed",
      message: error?.message ?? "Undo failed.",
      conversationId: targetConversationId || entry.conversationId,
    };
  }
};

const undoLastApply = async (
  service,
  conversationId,
  { emitRenderer = true } = {}
) => {
  await ensureSessionsRestored(service);
  const targetIndex = findLatestUndoIndex(service, conversationId);
  const targetConversationId = resolveTargetConversationId(conversationId) || "default";
  if (
    targetIndex < 0 &&
    service.undoPersistenceBarriersByConversation?.has(targetConversationId)
  ) {
    const message =
      "The last AI change cannot be undone after restart because its complete undo snapshot exceeded the safety limit.";
    service.emitUndoAvailability?.(targetConversationId);
    service.emitAuditEvent(
      "undo_last_apply",
      { ok: false, reason: "undo_persistence_limit" },
      targetConversationId,
    );
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message,
        conversationId: targetConversationId,
      });
    }
    return {
      ok: false,
      reason: "undo_persistence_limit",
      message,
      conversationId: targetConversationId,
    };
  }
  return undoEntryAtIndex(service, targetIndex, conversationId, { emitRenderer });
};

const preflightUndoRun = async (service, entries, rootPath) => {
  const paths = new Set();
  for (const entry of entries) {
    if (
      typeof entry?.workspaceRootPath === "string" &&
      entry.workspaceRootPath &&
      path.resolve(entry.workspaceRootPath) !== path.resolve(rootPath)
    ) {
      return {
        ok: false,
        reason: "workspace_changed",
        error: "Cannot undo: this change belongs to another workspace.",
      };
    }
    if (entry?.type === "rename") {
      if (typeof entry.oldPath === "string") paths.add(entry.oldPath);
      if (typeof entry.newPath === "string") paths.add(entry.newPath);
    } else if (typeof entry?.path === "string") {
      paths.add(entry.path);
    }
  }

  const states = new Map();
  try {
    for (const relativePath of paths) {
      const resolved = service.workspace.resolvePath(relativePath);
      const stat = await fsp.stat(resolved).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) {
        states.set(relativePath, { kind: "missing" });
      } else if (stat.isFile()) {
        states.set(relativePath, { kind: "file", buffer: await fsp.readFile(resolved) });
      } else if (stat.isDirectory()) {
        states.set(relativePath, {
          kind: "directory",
          children: new Set(await fsp.readdir(resolved)),
        });
      } else {
        states.set(relativePath, { kind: "other" });
      }
    }
  } catch (error) {
    return { ok: false, error: error?.message || "Cannot inspect files before undo." };
  }

  const cloneStates = () =>
    new Map(
      [...states].map(([relativePath, state]) => [
        relativePath,
        state.kind === "file"
          ? { kind: "file", buffer: Buffer.from(state.buffer) }
          : state.kind === "directory"
            ? { kind: "directory", children: new Set(state.children) }
            : { ...state },
      ]),
    );
  const rollbackStates = new Map();

  const setVirtualState = (relativePath, nextState) => {
    const previousState = states.get(relativePath) ?? { kind: "missing" };
    const parentPath = path.posix.dirname(relativePath.replaceAll("\\", "/"));
    const parentState = parentPath === "." ? null : states.get(parentPath);
    if (parentState?.kind === "directory") {
      const name = path.posix.basename(relativePath.replaceAll("\\", "/"));
      if (previousState.kind !== "missing" && nextState.kind === "missing") {
        parentState.children.delete(name);
      } else if (previousState.kind === "missing" && nextState.kind !== "missing") {
        parentState.children.add(name);
      }
    }
    states.set(relativePath, nextState);
  };

  for (const entry of entries) {
    // Keep the exact virtual bytes immediately before this individual Undo.
    // A run may write the same path repeatedly (old -> mid -> new), so one
    // run-level snapshot is insufficient for compensating in reverse order.
    rollbackStates.set(entry, cloneStates());
    if (entry.type === "write") {
      const current = states.get(entry.path) ?? { kind: "missing" };
      if (
        current.kind !== "file" ||
        !entry.appliedHash ||
        hashBuffer(service, current.buffer) !== entry.appliedHash
      ) {
        return {
          ok: false,
          error: "Cannot undo: the file changed after Axiom edited it. Your later changes were kept.",
        };
      }
      if (entry.existed) {
        if (!Buffer.isBuffer(entry.previousBuffer)) {
          return { ok: false, error: "Cannot undo: the previous file snapshot is unavailable." };
        }
        setVirtualState(entry.path, { kind: "file", buffer: entry.previousBuffer });
      } else {
        setVirtualState(entry.path, { kind: "missing" });
      }
    } else if (entry.type === "delete") {
      const current = states.get(entry.path) ?? { kind: "missing" };
      if (current.kind !== "missing") {
        return {
          ok: false,
          error: "Cannot undo: a new file now exists at the deleted path. It was kept.",
        };
      }
      if (!Buffer.isBuffer(entry.previousBuffer)) {
        return { ok: false, error: "Cannot undo: the deleted file snapshot is unavailable." };
      }
      setVirtualState(entry.path, { kind: "file", buffer: entry.previousBuffer });
    } else if (entry.type === "rename") {
      const source = states.get(entry.newPath) ?? { kind: "missing" };
      const destination = states.get(entry.oldPath) ?? { kind: "missing" };
      if (source.kind !== "file") {
        return { ok: false, error: "Cannot undo: destination file not found." };
      }
      if (destination.kind !== "missing") {
        return {
          ok: false,
          error: "Cannot undo: a file already exists at the original path.",
        };
      }
      if (!entry.appliedHash || hashBuffer(service, source.buffer) !== entry.appliedHash) {
        return {
          ok: false,
          error: "Cannot undo: the renamed file changed afterwards. Your later changes were kept.",
        };
      }
      setVirtualState(entry.newPath, { kind: "missing" });
      setVirtualState(entry.oldPath, { kind: "file", buffer: source.buffer });
    } else if (entry.type === "mkdir") {
      const current = states.get(entry.path) ?? { kind: "missing" };
      if (current.kind === "missing") continue;
      if (current.kind !== "directory") {
        return { ok: false, error: "Cannot undo: the created directory path is no longer a directory." };
      }
      if (current.children.size > 0) {
        return { ok: false, error: "Cannot undo: directory is not empty." };
      }
      setVirtualState(entry.path, { kind: "missing" });
    } else {
      return { ok: false, error: "Unsupported undo operation." };
    }
  }
  return { ok: true, rollbackStates };
};

const rollbackUndoneEntry = async (service, entry, entryStates) => {
  if (entry.type === "write") {
    const current = await readCurrentFileState(service, entry.path);
    if (entry.existed) {
      if (
        !current.exists ||
        !current.isFile ||
        !Buffer.isBuffer(entry.previousBuffer) ||
        hashBuffer(service, current.buffer) !== hashBuffer(service, entry.previousBuffer)
      ) {
        throw new Error(`Rollback conflict in ${entry.path}.`);
      }
    } else if (current.exists) {
      throw new Error(`Rollback conflict in ${entry.path}.`);
    }
    const original = entryStates?.get(entry.path);
    if (original?.kind !== "file") throw new Error(`Rollback snapshot missing for ${entry.path}.`);
    const resolved = service.workspace.resolvePath(entry.path);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, original.buffer);
    return;
  }
  if (entry.type === "delete") {
    const current = await readCurrentFileState(service, entry.path);
    if (
      !current.exists ||
      !current.isFile ||
      !Buffer.isBuffer(entry.previousBuffer) ||
      hashBuffer(service, current.buffer) !== hashBuffer(service, entry.previousBuffer)
    ) {
      throw new Error(`Rollback conflict in ${entry.path}.`);
    }
    await fsp.unlink(service.workspace.resolvePath(entry.path));
    return;
  }
  if (entry.type === "rename") {
    const oldState = await readCurrentFileState(service, entry.oldPath);
    const newState = await readCurrentFileState(service, entry.newPath);
    if (
      !oldState.exists ||
      !oldState.isFile ||
      newState.exists ||
      !entry.appliedHash ||
      hashBuffer(service, oldState.buffer) !== entry.appliedHash
    ) {
      throw new Error(`Rollback conflict in ${entry.oldPath}.`);
    }
    await fsp.mkdir(path.dirname(service.workspace.resolvePath(entry.newPath)), {
      recursive: true,
    });
    await fsp.rename(
      service.workspace.resolvePath(entry.oldPath),
      service.workspace.resolvePath(entry.newPath),
    );
    return;
  }
  if (entry.type === "mkdir") {
    const original = entryStates?.get(entry.path);
    if (original?.kind === "missing") return;
    const resolved = service.workspace.resolvePath(entry.path);
    const current = await fsp.stat(resolved).catch(() => null);
    if (current) throw new Error(`Rollback conflict in ${entry.path}.`);
    await fsp.mkdir(resolved);
    return;
  }
  throw new Error("Unsupported rollback operation.");
};

const undoLastRunApply = async (
  service,
  conversationId,
  { emitRenderer = true } = {}
) => {
  await ensureSessionsRestored(service);
  const targetConversationId = resolveTargetConversationId(conversationId);
  const anchorIndex = findLatestUndoIndex(service, targetConversationId, { requireRunId: true });
  if (anchorIndex < 0) {
    return undoLastApply(service, conversationId, { emitRenderer });
  }
  const anchorEntry = service.applyUndoStack[anchorIndex];
  const targetRunId =
    anchorEntry && typeof anchorEntry.runId === "string" && anchorEntry.runId.trim()
      ? anchorEntry.runId.trim()
      : "";
  if (!targetRunId) {
    return undoLastApply(service, conversationId, { emitRenderer });
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
    return undoLastApply(service, conversationId, { emitRenderer });
  }

  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return undoLastApply(service, conversationId, { emitRenderer });
  }
  const preflight = await preflightUndoRun(
    service,
    targetIndexes.map((index) => service.applyUndoStack[index]),
    rootPath,
  );
  if (!preflight.ok) {
    const message = preflight.error || "Cannot safely undo the complete Axiom run.";
    const reason = preflight.reason || "preflight_failed";
    service.emitAuditEvent(
      "undo_run_apply",
      { ok: false, runId: targetRunId, reason, error: message },
      targetConversationId || anchorEntry?.conversationId || null,
    );
    if (emitRenderer) {
      service.sendToRenderer("agent:undoResult", {
        ok: false,
        message,
        conversationId: targetConversationId || anchorEntry?.conversationId || undefined,
      });
    }
    return {
      ok: false,
      reason,
      message,
      conversationId: targetConversationId || anchorEntry?.conversationId || undefined,
    };
  }

  let undoneCount = 0;
  let firstPath = "";
  const undonePaths = [];
  const requiresBuild = targetIndexes.some(
    (index) => service.applyUndoStack[index]?.type !== "mkdir",
  );
  const stackBefore = service.applyUndoStack.slice();
  const completedEntries = [];
  const rendererEvents = [];
  const resultConversationId =
    targetConversationId ||
    (typeof anchorEntry?.conversationId === "string" ? anchorEntry.conversationId : "");
  const transactionContext = resultConversationId
    ? service.contextByConversation.get(resultConversationId)
    : null;
  const contextPathsBefore = transactionContext
    ? {
        hasDocumentMainFile: Object.prototype.hasOwnProperty.call(
          transactionContext,
          "documentMainFile",
        ),
        documentMainFile: transactionContext.documentMainFile,
        hasActiveFilePath: Object.prototype.hasOwnProperty.call(
          transactionContext,
          "activeFilePath",
        ),
        activeFilePath: transactionContext.activeFilePath,
      }
    : null;
  const restoreContextPaths = () => {
    if (!transactionContext || !contextPathsBefore) return;
    if (contextPathsBefore.hasDocumentMainFile) {
      transactionContext.documentMainFile = contextPathsBefore.documentMainFile;
    } else {
      delete transactionContext.documentMainFile;
    }
    if (contextPathsBefore.hasActiveFilePath) {
      transactionContext.activeFilePath = contextPathsBefore.activeFilePath;
    } else {
      delete transactionContext.activeFilePath;
    }
  };
  for (const index of targetIndexes) {
    const entry = service.applyUndoStack[index];
    const result = await undoEntryAtIndex(service, index, targetConversationId, {
      emitRenderer: false,
      deferFinalize: true,
      rendererEvents,
    });
    if (!result.ok) {
      let rollbackError = null;
      for (const completedEntry of completedEntries.slice().reverse()) {
        try {
          await rollbackUndoneEntry(
            service,
            completedEntry,
            preflight.rollbackStates.get(completedEntry),
          );
        } catch (error) {
          rollbackError = rollbackError || error;
        }
      }
      service.applyUndoStack = stackBefore;
      // A successful rename Undo updates the conversation's active/main path.
      // If a later entry fails and the rename is compensated, its in-memory
      // routing must be compensated with the same transaction.
      restoreContextPaths();
      await refreshWorkspaceBestEffort(service, rootPath);
      callBestEffort(() => service.requestIndex(rootPath));
      const message = rollbackError
        ? `${result.message ?? "Undo failed."} The earlier files could not all be restored: ${rollbackError.message}`
        : result.message ?? "Undo failed. No files were changed.";
      callBestEffort(() => service.emitAuditEvent(
        "undo_run_apply",
        {
          ok: false,
          runId: targetRunId,
          reason: rollbackError ? "rollback_failed" : "undo_failed_rolled_back",
          error: clipText(message, 260),
        },
        targetConversationId || anchorEntry?.conversationId || null,
      ));
      if (emitRenderer) {
        service.sendToRenderer("agent:undoResult", {
          ok: false,
          message,
          conversationId: (result.conversationId ?? targetConversationId) || undefined,
        });
      }
      return {
        ...result,
        message,
        reason: rollbackError ? "rollback_failed" : result.reason,
        // A failed compensation means disk state may differ from the last
        // rendered PDF. Force one deterministic build of the actual files.
        ...(rollbackError
          ? { requiresBuild: true, workspaceMayHaveChanged: true }
          : {}),
      };
    }
    completedEntries.push(entry);
    undoneCount += 1;
    if (!firstPath && typeof result.path === "string" && result.path) {
      firstPath = result.path;
    }
    if (typeof result.path === "string" && result.path) undonePaths.push(result.path);
  }

  const summaryMessage =
    undoneCount <= 1
      ? firstPath
        ? `Undone: ${firstPath}`
        : "Undone"
      : `Undone ${undoneCount} changes from this run.`;
  await refreshWorkspaceBestEffort(service, rootPath);
  callBestEffort(() => service.requestIndex(rootPath));
  rendererEvents.forEach(({ type, payload }) =>
    callBestEffort(() => service.sendToRenderer(type, payload))
  );
  callBestEffort(() => service.emitAuditEvent(
    "undo_run_apply",
    { ok: true, runId: targetRunId, count: undoneCount },
    resultConversationId || null
  ));
  if (resultConversationId) {
    callBestEffort(() => service.markSessionDirty(resultConversationId));
    callBestEffort(() => service.emitUndoAvailability?.(resultConversationId));
  }
  if (emitRenderer) {
    service.sendToRenderer("agent:undoResult", {
      ok: true,
      message: summaryMessage,
      conversationId: resultConversationId || undefined,
    });
  }
  return {
    ok: true,
    runId: targetRunId,
    count: undoneCount,
    paths: undonePaths,
    requiresBuild,
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
      error: "Proposal not found.",
    });
    return { ok: false, proposalId, error: "Proposal not found." };
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
      error: "No workspace is selected.",
    });
    if (discardOnFailure) {
      service.proposals.delete(proposalId);
    }
    return { ok: false, proposalId, path: proposal.path, error: "No workspace is selected." };
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
      error: "Cannot apply: proposal was created in a different workspace.",
    });
    if (discardOnFailure) {
      service.proposals.delete(proposalId);
    }
    return {
      ok: false,
      proposalId,
      path: proposal.path,
      error: "Cannot apply: proposal was created in a different workspace.",
    };
  }
  const mutationType = proposal.type || "write";
  const mutationPath = mutationType === "rename" ? proposal.oldPath : proposal.path;
  if (
    options?._insideFileMutation !== true &&
    mutationType !== "mkdir" &&
    typeof service.workspace.withFileMutation === "function"
  ) {
    return service.workspace.withFileMutation(mutationPath, () =>
      applyProposal(service, proposalId, {
        ...options,
        _insideFileMutation: true,
      }),
    );
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
        error: validation.error || "Pre-apply validation failed.",
      });
      if (discardOnFailure) {
        service.proposals.delete(proposalId);
      }
      return {
        ok: false,
        proposalId,
        path: proposal.path,
        conflict: validation.conflict === true,
        error: validation.error || "Pre-apply validation failed.",
      };
    }
    let undoEntry = null;

    if (type === "delete") {
      const resolved = service.workspace.resolvePath(proposal.path);
      const currentState = validation.targetState;
      if (!currentState?.buffer) {
        throw new Error("Could not read file content before deletion.");
      }
      undoEntry = {
        type: "delete",
        conversationId: proposal.conversationId || "default",
        runId,
        path: proposal.path,
        appliedHash: hashBuffer(service, currentState.buffer),
        previousBuffer: currentState.buffer,
        wasBinary: Boolean(proposal.isBinary),
      };
      if (typeof service.workspace.moveToInternalTrash === "function") {
        await service.workspace.moveToInternalTrash(resolved);
      } else {
        await fsp.unlink(resolved);
      }
      if (!currentState.buffer.includes(0)) {
        service.sendToRenderer("agent:applyContent", {
          path: proposal.path,
          content: "",
          expectedContent: currentState.buffer.toString("utf8"),
          fileDeleted: true,
          updateSaved: false,
          conversationId: proposal.conversationId || "default",
        });
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
        appliedHash: hashBuffer(service, validation.targetState.buffer),
      };
      await fsp.mkdir(path.dirname(newResolved), { recursive: true });
      await fsp.rename(oldResolved, newResolved);
      service.sendToRenderer("renameResult", {
        oldPath: proposal.oldPath,
        newPath: proposal.path,
        isDirectory: false,
      });
      if (!validation.targetState.buffer.includes(0)) {
        const renamedContent = validation.targetState.buffer.toString("utf8");
        // renameResult moves the Monaco model first. The following CAS then
        // detects typing that happened after the proposal snapshot instead of
        // silently treating the renamed on-disk bytes as the user's buffer.
        service.sendToRenderer("agent:applyContent", {
          path: proposal.path,
          content: renamedContent,
          expectedContent: renamedContent,
          updateSaved: true,
          conversationId: proposal.conversationId || "default",
        });
      }
    } else if (type === "mkdir") {
      const resolved = service.workspace.resolvePath(proposal.path);
      // mkdir -p on a directory the user already owned is a successful no-op.
      // Never put that directory on the AI Undo stack: Undo would otherwise
      // delete an empty directory Axiom did not create.
      if (!validation.targetState?.exists) {
        undoEntry = {
          type: "mkdir",
          conversationId: proposal.conversationId || "default",
          runId,
          path: proposal.path,
        };
        await fsp.mkdir(resolved, { recursive: true });
      }
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
          error: "No change detected.",
        });
        if (discardOnFailure) {
          service.proposals.delete(proposalId);
        }
        return { ok: false, proposalId, path: proposal.path, error: "No change detected." };
      }
      let nextBuffer;
      if (proposal.encoding === "base64") {
        const decoded = decodeBase64Strict(proposal.content);
        if (!decoded) {
          throw new Error("Invalid base64 content.");
        }
        nextBuffer = Buffer.from(decoded.normalized, "base64");
      } else {
        nextBuffer = Buffer.from(proposal.content, "utf8");
      }
      undoEntry = {
        type: "write",
        conversationId: proposal.conversationId || "default",
        runId,
        path: proposal.path,
        existed: existedBefore,
        previousBuffer,
        wasBinary,
        appliedHash: hashBuffer(service, nextBuffer),
      };
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      if (proposal.encoding === "base64") {
        await fsp.writeFile(resolved, nextBuffer);
      } else {
        await service.workspace.writeFile(proposal.path, proposal.content);
        service.sendToRenderer("agent:applyContent", {
          path: proposal.path,
          content: proposal.content,
          ...(existedBefore && !wasBinary
            ? { expectedContent: previousBuffer.toString("utf8") }
            : { expectedFileMissing: true }),
          updateSaved: true,
          conversationId: proposal.conversationId || "default",
        });
        // Update context snapshot so consecutive writes see fresh content
        const ctx = service.contextByConversation.get(proposal.conversationId || "default");
        if (ctx && ctx.activeFilePath === proposal.path) {
          ctx.activeFileContent = proposal.content;
          ctx.activeFileIsDirty = false;
          ctx.activeFileContentTruncated = false;
        }
      }
    }

    pushUndoEntry(service, undoEntry);
    await service.updateWorkspaceIfNeeded(rootPath, true);
    service.requestIndex(rootPath);
    if (type === "rename") {
      const context = service.contextByConversation.get(
        proposal.conversationId || "default",
      );
      if (context) {
        if (context.documentMainFile === proposal.oldPath) {
          context.documentMainFile = proposal.path;
        }
        if (context.activeFilePath === proposal.oldPath) {
          context.activeFilePath = proposal.path;
        }
      }
    }
    service.proposals.delete(proposalId);
    service.emitAuditEvent(
      "proposal_apply",
      { proposalId, ok: true, path: proposal.path, type: proposal.type || "write" },
      proposal.conversationId || "default"
    );
    service.markSessionDirty(proposal.conversationId || "default");
    service.sendToRenderer("agent:applyResult", { proposalId, ok: true, conversationId: proposal.conversationId || undefined });
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
      error: error?.message ?? "Operation failed.",
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
      error: error?.message ?? "Operation failed.",
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
