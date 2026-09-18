const {
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_MESSAGES,
  PERSIST_SESSION_VERSION,
  clipLongString,
  sanitizeConversationForPersistence,
} = require("./agent-core-utils.cjs");

const PERSIST_MAX_UNDO_ENTRIES = 20;
const PERSIST_MAX_UNDO_BUFFER_BYTES = 1024 * 1024;
const PERSIST_MAX_UNDO_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_RESTORED_UNDO_ENTRIES = 200;
const UNDO_PERSISTENCE_UNAVAILABLE_REASON = "persistence_limit";

const normalizeUndoBarrier = (value, workspaceRootPath = null) => {
  if (!value || typeof value !== "object") return null;
  const entryCount = Number.isSafeInteger(value.entryCount)
    ? Math.max(1, value.entryCount)
    : 1;
  return {
    reason: UNDO_PERSISTENCE_UNAVAILABLE_REASON,
    runId:
      typeof value.runId === "string" && value.runId.trim()
        ? value.runId.trim().slice(0, 512)
        : null,
    entryCount,
    workspaceRootPath:
      typeof value.workspaceRootPath === "string" && value.workspaceRootPath.trim()
        ? value.workspaceRootPath.trim()
        : typeof workspaceRootPath === "string" && workspaceRootPath.trim()
          ? workspaceRootPath.trim()
          : null,
  };
};

const createUndoBarrier = (group, workspaceRootPath = null) =>
  normalizeUndoBarrier(
    {
      runId: group?.runId ?? null,
      entryCount: Array.isArray(group?.entries) ? group.entries.length : 1,
      workspaceRootPath:
        group?.entries?.[group.entries.length - 1]?.workspaceRootPath ?? workspaceRootPath,
    },
    workspaceRootPath,
  );

const isSafeRelativePath = (value) => {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return !normalized.split("/").some((part) => part === "..");
};

const normalizePersistedDocumentMainFile = (value) => {
  if (!isSafeRelativePath(value)) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized.toLowerCase().endsWith(".tex") ? normalized : null;
};

const serializeUndoEntry = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  const type = entry.type;
  if (!new Set(["write", "delete", "rename", "mkdir"]).has(type)) return null;
  if (!isSafeRelativePath(entry.path)) return null;
  const serialized = {
    type,
    historyBoundary: typeof entry.historyBoundary === "string" ? entry.historyBoundary : null,
    conversationId:
      typeof entry.conversationId === "string" ? entry.conversationId : "default",
    runId:
      typeof entry.runId === "string" && entry.runId.trim()
        ? entry.runId.trim()
        : null,
    path: entry.path,
    workspaceRootPath:
      typeof entry.workspaceRootPath === "string" ? entry.workspaceRootPath : null,
  };
  if (type === "rename") {
    if (!isSafeRelativePath(entry.oldPath) || !isSafeRelativePath(entry.newPath)) return null;
    serialized.oldPath = entry.oldPath;
    serialized.newPath = entry.newPath;
  }
  if (type === "write") {
    serialized.existed = entry.existed === true;
    serialized.wasBinary = entry.wasBinary === true;
    if (typeof entry.appliedHash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.appliedHash)) {
      return null;
    }
    serialized.appliedHash = entry.appliedHash.toLowerCase();
  }
  if (type === "rename") {
    if (typeof entry.appliedHash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.appliedHash)) {
      return null;
    }
    serialized.appliedHash = entry.appliedHash.toLowerCase();
  }
  if (type === "write" || type === "delete") {
    if (Buffer.isBuffer(entry.previousBuffer)) {
      if (entry.previousBuffer.byteLength > PERSIST_MAX_UNDO_BUFFER_BYTES) return null;
      serialized.previousBase64 = entry.previousBuffer.toString("base64");
    } else if (type === "delete" || serialized.existed) {
      return null;
    }
  }
  return serialized;
};

const deserializeUndoEntry = (entry, conversationId, workspaceRootPath) => {
  if (!entry || typeof entry !== "object") return null;
  const serialized = serializeUndoEntry({
    ...entry,
    conversationId,
    workspaceRootPath:
      typeof entry.workspaceRootPath === "string"
        ? entry.workspaceRootPath
        : workspaceRootPath,
    previousBuffer:
      typeof entry.previousBase64 === "string"
        ? Buffer.from(entry.previousBase64, "base64")
        : null,
  });
  if (!serialized) return null;
  const restored = {
    ...serialized,
    conversationId,
    workspaceRootPath:
      typeof serialized.workspaceRootPath === "string"
        ? serialized.workspaceRootPath
        : workspaceRootPath || null,
  };
  delete restored.previousBase64;
  if (typeof entry.previousBase64 === "string") {
    const encoded = entry.previousBase64;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return null;
    }
    const previousBuffer = Buffer.from(encoded, "base64");
    if (previousBuffer.byteLength > PERSIST_MAX_UNDO_BUFFER_BYTES) return null;
    restored.previousBuffer = previousBuffer;
  } else {
    restored.previousBuffer = null;
  }
  return restored;
};

/**
 * Build newest-contiguous, run-atomic undo groups. If one complete run cannot
 * fit, it becomes a barrier and no older run is persisted past it. This makes
 * "undo last AI run" fail closed after restart instead of reverting a tail and
 * reporting success while earlier edits from the same run remain.
 */
const buildPersistedUndoState = (service, conversationId, workspaceRootPath) => {
  const indexedEntries = service.applyUndoStack
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.conversationId === conversationId);
  const groupsByKey = new Map();
  indexedEntries.forEach(({ entry, index }) => {
    const runId =
      typeof entry.runId === "string" && entry.runId.trim() ? entry.runId.trim() : null;
    const key = runId ? `run:${runId}` : `entry:${index}`;
    let group = groupsByKey.get(key);
    if (!group) {
      group = { runId, entries: [], newestIndex: index };
      groupsByKey.set(key, group);
    }
    group.entries.push({ entry, index });
    group.newestIndex = Math.max(group.newestIndex, index);
  });

  const newestFirst = [...groupsByKey.values()].sort(
    (left, right) => right.newestIndex - left.newestIndex,
  );
  const retainedNewestFirst = [];
  let retainedEntryCount = 0;
  let retainedBytes = 0;
  let undoBarrier = normalizeUndoBarrier(
    service.undoPersistenceBarriersByConversation?.get(conversationId),
    workspaceRootPath,
  );

  for (const group of newestFirst) {
    const orderedEntries = group.entries
      .slice()
      .sort((left, right) => left.index - right.index)
      .map(({ entry }) => entry);
    const atomicGroup = { runId: group.runId, entries: orderedEntries };
    if (retainedEntryCount + orderedEntries.length > PERSIST_MAX_UNDO_ENTRIES) {
      undoBarrier = createUndoBarrier(atomicGroup, workspaceRootPath);
      break;
    }
    const serializedEntries = orderedEntries.map(serializeUndoEntry);
    if (serializedEntries.some((entry) => entry === null)) {
      undoBarrier = createUndoBarrier(atomicGroup, workspaceRootPath);
      break;
    }
    const serializedGroup = {
      runId: group.runId,
      entryCount: serializedEntries.length,
      entries: serializedEntries,
    };
    const groupBytes = Buffer.byteLength(JSON.stringify(serializedGroup), "utf8");
    if (retainedBytes + groupBytes > PERSIST_MAX_UNDO_TOTAL_BYTES) {
      undoBarrier = createUndoBarrier(atomicGroup, workspaceRootPath);
      break;
    }
    retainedNewestFirst.push(serializedGroup);
    retainedEntryCount += serializedEntries.length;
    retainedBytes += groupBytes;
  }

  return {
    undoGroups: retainedNewestFirst.reverse(),
    undoBarrier,
  };
};

const restoreAtomicUndoState = (
  service,
  session,
  conversationId,
  workspaceRootPath,
) => {
  const sessionVersion = Number.isSafeInteger(session.version) ? session.version : 0;
  if (sessionVersion < PERSIST_SESSION_VERSION) {
    const legacyEntryCount = Array.isArray(session.undoGroups)
      ? session.undoGroups.reduce(
          (sum, group) => sum + (Array.isArray(group?.entries) ? group.entries.length : 0),
          0,
        )
      : Array.isArray(session.undoEntries)
        ? session.undoEntries.length
        : 0;
    if (legacyEntryCount > 0) {
      service.undoPersistenceBarriersByConversation.set(
        conversationId,
        normalizeUndoBarrier(
          {
            entryCount: legacyEntryCount,
            workspaceRootPath,
          },
          workspaceRootPath,
        ),
      );
    }
    return;
  }

  const storedGroups = Array.isArray(session.undoGroups) ? session.undoGroups : [];
  const restoredNewestFirst = [];
  let barrier = normalizeUndoBarrier(session.undoBarrier, workspaceRootPath);
  for (let index = storedGroups.length - 1; index >= 0; index -= 1) {
    const group = storedGroups[index];
    const storedEntries = Array.isArray(group?.entries) ? group.entries : [];
    const expectedCount = Number.isSafeInteger(group?.entryCount) ? group.entryCount : -1;
    const runId =
      typeof group?.runId === "string" && group.runId.trim() ? group.runId.trim() : null;
    const restoredEntries = storedEntries.map((entry) =>
      deserializeUndoEntry(entry, conversationId, workspaceRootPath),
    );
    const complete =
      expectedCount > 0 &&
      expectedCount === storedEntries.length &&
      restoredEntries.every(
        (entry) =>
          entry !== null &&
          ((runId === null && entry.runId === null) || entry.runId === runId),
      );
    if (!complete) {
      barrier = normalizeUndoBarrier(
        {
          runId,
          entryCount: Math.max(expectedCount, storedEntries.length, 1),
          workspaceRootPath,
        },
        workspaceRootPath,
      );
      break;
    }
    restoredNewestFirst.push(restoredEntries);
  }
  restoredNewestFirst
    .reverse()
    .flat()
    .forEach((entry) => service.applyUndoStack.push(entry));
  if (barrier) {
    service.undoPersistenceBarriersByConversation.set(conversationId, barrier);
  }
};

/**
 * The process-wide restored stack also has a cap. Remove its oldest complete
 * run(s), never an arbitrary entry count, or the surviving tail could later be
 * reported as a successful whole-run undo.
 */
const trimRestoredUndoStackAtomic = (service) => {
  while (service.applyUndoStack.length > MAX_RESTORED_UNDO_ENTRIES) {
    const oldest = service.applyUndoStack[0];
    const conversationId =
      typeof oldest?.conversationId === "string" && oldest.conversationId.trim()
        ? oldest.conversationId.trim()
        : "default";
    const runId =
      typeof oldest?.runId === "string" && oldest.runId.trim()
        ? oldest.runId.trim()
        : null;
    const removed = [];
    service.applyUndoStack = service.applyUndoStack.filter((candidate, index) => {
      const belongsToOldestRun = runId
        ? candidate?.conversationId === conversationId && candidate?.runId === runId
        : index === 0;
      if (belongsToOldestRun) removed.push(candidate);
      return !belongsToOldestRun;
    });
    service.undoPersistenceBarriersByConversation.set(
      conversationId,
      normalizeUndoBarrier({
        runId,
        entryCount: Math.max(1, removed.length),
        workspaceRootPath:
          typeof oldest?.workspaceRootPath === "string"
            ? oldest.workspaceRootPath
            : null,
      }),
    );
  }
};

/**
 * Migrate a conversation array from legacy format ({ role, parts })
 * to OpenAI format ({ role, content }) if needed.
 * Kept for backward compatibility with old saved sessions.
 */
const migrateConversation = (conversation) => {
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return [];
  }
  // Check if already in OpenAI format (has `content` key)
  const first = conversation[0];
  if (first && typeof first.content === "string") {
    return conversation; // Already OpenAI format
  }
  // Convert legacy { role, parts } → OpenAI { role, content }
  const migrated = [];
  conversation.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const role = entry.role;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    if (role === "user") {
      const text = parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        migrated.push({ role: "user", content: text });
      }
    } else if (role === "model") {
      const text = parts
        .filter((p) => !p?.functionCall)
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        migrated.push({ role: "assistant", content: text });
      }
    }
    // Skip "tool" entries — intermediate results not shown in UI
  });
  return migrated;
};

const ensureSessionsRestored = async (service) => {
  if (service.sessionsRestored || !service.sessionsService) {
    return;
  }
  if (service.restorePromise) {
    await service.restorePromise;
    return;
  }
  service.restorePromise = (async () => {
    const sessions = await service.sessionsService.loadSessions().catch(() => []);
    sessions.forEach((session) => {
      if (!session || typeof session !== "object") {
        return;
      }
      const conversationId =
        typeof session.conversationId === "string" ? session.conversationId.trim() : "";
      if (!conversationId) {
        return;
      }
      if (service.deletedConversations?.has(conversationId)) {
        return;
      }

      const storedConversation = Array.isArray(session.conversation) ? session.conversation : null;
      if (
        storedConversation &&
        (!service.conversations.has(conversationId) ||
          (service.conversations.get(conversationId)?.length ?? 0) === 0)
      ) {
        // Auto-migrate old legacy format sessions to OpenAI format
        const migrated = migrateConversation(storedConversation);
        service.conversations.set(conversationId, migrated);
      }

      const storedProposals = Array.isArray(session.proposals) ? session.proposals : [];
      storedProposals.forEach((proposal) => {
        if (!proposal || typeof proposal !== "object") {
          return;
        }
        const id = typeof proposal.id === "string" ? proposal.id : "";
        if (!id) {
          return;
        }
        if (!proposal.conversationId) {
          proposal.conversationId = conversationId;
        }
        service.proposals.set(id, proposal);
      });

      const workspaceRootPath =
        typeof session.workspaceRootPath === "string" && session.workspaceRootPath.trim()
          ? session.workspaceRootPath.trim()
          : "";
      if (workspaceRootPath && !service.workspaceRootByConversation.has(conversationId)) {
        service.workspaceRootByConversation.set(conversationId, workspaceRootPath);
      }
      const documentMainFile = normalizePersistedDocumentMainFile(
        session.context?.documentMainFile,
      );
      if (documentMainFile && !service.contextByConversation.has(conversationId)) {
        service.contextByConversation.set(conversationId, { documentMainFile });
      }

      restoreAtomicUndoState(
        service,
        session,
        conversationId,
        workspaceRootPath,
      );

      const createdAt =
        typeof session.createdAt === "number" && Number.isFinite(session.createdAt)
          ? session.createdAt
          : null;
      const updatedAt =
        typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : null;
      const storedTitle =
        typeof session.title === "string" && session.title.trim() ? session.title.trim().slice(0, 80) : "";
      if ((createdAt || updatedAt || storedTitle) && !service.sessionMetaByConversation.has(conversationId)) {
        service.sessionMetaByConversation.set(conversationId, {
          createdAt: createdAt ?? updatedAt ?? Date.now(),
          updatedAt: updatedAt ?? createdAt ?? Date.now(),
          ...(storedTitle ? { title: storedTitle } : {}),
        });
      }

      const lastStatus =
        session.lastStatus && typeof session.lastStatus === "object" ? session.lastStatus : null;
      if (lastStatus && !service.lastStatusByConversation.has(conversationId)) {
        service.lastStatusByConversation.set(conversationId, {
          state: typeof lastStatus.state === "string" ? lastStatus.state : "idle",
          message: typeof lastStatus.message === "string" ? lastStatus.message : "",
          ts: typeof lastStatus.ts === "number" ? lastStatus.ts : null,
        });
      }

      const scratchpad =
        typeof session.scratchpad === "string" ? clipLongString(session.scratchpad, 120_000) : "";
      if (scratchpad && !service.scratchpadByConversation.has(conversationId)) {
        service.scratchpadByConversation.set(conversationId, scratchpad);
      }
    });
    trimRestoredUndoStackAtomic(service);
    service.sessionsRestored = true;
  })();
  await service.restorePromise;
};

const markSessionDirty = (service, conversationId) => {
  if (!service.sessionsService) {
    return;
  }
  const normalized =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  if (service.deletedConversations?.has(normalized)) return;
  const existingTimer = service.persistTimers.get(normalized);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    service.persistTimers.delete(normalized);
    queueSessionPersist(service, normalized).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
  service.persistTimers.set(normalized, timer);
};

const queueSessionPersist = (service, conversationId) => {
  const promise = persistSession(service, conversationId);
  if (!(service.sessionPersistPromises instanceof Set)) {
    service.sessionPersistPromises = new Set();
  }
  service.sessionPersistPromises.add(promise);
  promise.then(
    () => service.sessionPersistPromises.delete(promise),
    () => service.sessionPersistPromises.delete(promise),
  );
  return promise;
};

/** Flush every debounced or already-running snapshot before process exit. */
const flushPendingSessions = async (service) => {
  if (!service.sessionsService) return;
  // A completed/aborted run can mark itself dirty while an earlier snapshot is
  // being written. Drain repeatedly until no timer or write remains. The quit
  // coordinator wraps this in a hard wall-clock timeout.
  for (let pass = 0; pass < 8; pass += 1) {
    const pendingIds = [...service.persistTimers.keys()];
    pendingIds.forEach((conversationId) => {
      const timer = service.persistTimers.get(conversationId);
      if (timer) clearTimeout(timer);
      service.persistTimers.delete(conversationId);
    });
    const writes = pendingIds.map((conversationId) =>
      queueSessionPersist(service, conversationId),
    );
    const inFlight = service.sessionPersistPromises instanceof Set
      ? [...service.sessionPersistPromises]
      : [];
    await Promise.allSettled([...new Set([...writes, ...inFlight])]);
    const inFlightCount =
      service.sessionPersistPromises instanceof Set
        ? service.sessionPersistPromises.size
        : 0;
    if (service.persistTimers.size === 0 && inFlightCount === 0) {
      break;
    }
  }
  if (typeof service.sessionsService.flush === "function") {
    await service.sessionsService.flush();
  }
};

const persistSession = async (service, conversationId) => {
  if (!service.sessionsService) {
    return;
  }
  const normalized =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  if (service.deletedConversations?.has(normalized)) return;
  await ensureSessionsRestored(service);
  if (service.deletedConversations?.has(normalized)) return;

  const conversation = service.conversations.get(normalized) ?? [];
  const proposals = [];
  service.proposals.forEach((proposal) => {
    const pConversationId =
      typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
        ? proposal.conversationId.trim()
        : "default";
    if (pConversationId === normalized) {
      proposals.push(proposal);
    }
  });

  const now = Date.now();
  const meta = service.sessionMetaByConversation.get(normalized) ?? { createdAt: now, updatedAt: now };
  if (!meta.createdAt || !Number.isFinite(meta.createdAt)) {
    meta.createdAt = now;
  }
  meta.updatedAt = now;
  service.sessionMetaByConversation.set(normalized, meta);

  const currentRoot = service.workspace.getRootPath();
  const storedRoot = service.workspaceRootByConversation.get(normalized);
  const workspaceRootPath =
    (typeof storedRoot === "string" && storedRoot.trim() ? storedRoot.trim() : null) ||
    currentRoot;
  if (workspaceRootPath) {
    service.workspaceRootByConversation.set(normalized, workspaceRootPath);
  }

  const lastStatus = service.lastStatusByConversation.get(normalized) ?? null;
  const scratchpad = clipLongString(
    service.scratchpadByConversation.get(normalized) ?? "",
    120_000,
  );
  const { undoGroups, undoBarrier } = buildPersistedUndoState(
    service,
    normalized,
    workspaceRootPath,
  );
  const documentMainFile = normalizePersistedDocumentMainFile(
    service.contextByConversation.get(normalized)?.documentMainFile,
  );

  const snapshotBase = {
    version: PERSIST_SESSION_VERSION,
    conversationId: normalized,
    workspaceRootPath: workspaceRootPath || null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(typeof meta.title === "string" && meta.title ? { title: meta.title } : {}),
    lastStatus,
    scratchpad,
    proposals,
    undoGroups,
    undoBarrier,
    ...(documentMainFile ? { context: { documentMainFile } } : {}),
  };

  const byteLimit =
    typeof service.sessionsService.maxSessionBytes === "number" &&
    Number.isFinite(service.sessionsService.maxSessionBytes)
      ? Math.max(128 * 1024, service.sessionsService.maxSessionBytes)
      : 8 * 1024 * 1024;
  const estimateBytes = (value) => {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const conversationWindows = [PERSIST_MAX_MESSAGES, 100, 60, 40, 25, 12];
  let conversationSnapshot = sanitizeConversationForPersistence(conversation);
  let snapshot = { ...snapshotBase, conversation: conversationSnapshot };
  let estimatedBytes = estimateBytes(snapshot);

  for (let index = 0; index < conversationWindows.length && estimatedBytes > byteLimit; index += 1) {
    const windowSize = conversationWindows[index];
    const sliced =
      conversation.length > windowSize ? conversation.slice(conversation.length - windowSize) : conversation;
    conversationSnapshot = sanitizeConversationForPersistence(sliced);
    snapshot = { ...snapshotBase, conversation: conversationSnapshot };
    estimatedBytes = estimateBytes(snapshot);
  }

  if (estimatedBytes > byteLimit) {
    snapshot = { ...snapshotBase, conversation: [] };
    estimatedBytes = estimateBytes(snapshot);
  }
  if (estimatedBytes > byteLimit) {
    snapshot = { ...snapshotBase, conversation: [], proposals: [] };
  }

  if (service.deletedConversations?.has(normalized)) return;
  await service.sessionsService.saveSession(snapshot);
};

const getUiState = async (service) => {
  await ensureSessionsRestored(service);
  const conversationIds = new Set();
  service.conversations.forEach((_value, key) => {
    if (key) {
      conversationIds.add(key);
    }
  });
  service.runningControllers.forEach((_value, key) => {
    if (key) {
      conversationIds.add(key);
    }
  });
  service.proposals.forEach((proposal) => {
    const conversationId =
      typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
        ? proposal.conversationId.trim()
        : "default";
    if (conversationId) {
      conversationIds.add(conversationId);
    }
  });

  const buildTitle = (messages, fallback) => {
    const firstUser = Array.isArray(messages)
      ? messages.find((msg) => msg?.role === "user" && typeof msg.text === "string" && msg.text.trim())
      : null;
    const raw = typeof firstUser?.text === "string" ? firstUser.text.trim() : "";
    if (!raw) {
      return fallback;
    }
    return raw.replace(/\s+/g, " ").slice(0, 24) || fallback;
  };

  const sessions = [];
  conversationIds.forEach((conversationId) => {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const conversation = service.conversations.get(normalizedConversationId) ?? [];
    // A process/network failure may happen after all tools succeeded, before
    // the final prose arrives. Recover the saved receipt without paid work.
    if (!service.runningControllers.has(normalizedConversationId) && conversation.at(-1)?.role === "user") {
      const { readTask, completedEditReceipt } = require("./openprism/task-state.cjs");
      const task = readTask(service, normalizedConversationId);
      const receipt = task?.request === conversation.at(-1).content?.trim().slice(0, 4000)
        ? completedEditReceipt(task, service.contextByConversation.get(normalizedConversationId)?.uiLocale)
        : null;
      if (receipt) {
        conversation.push({ role: "assistant", content: receipt, ...(task.proposals?.length ? { proposals: task.proposals } : {}) });
        service.lastStatusByConversation.set(normalizedConversationId, { state: "idle", message: "Waiting", ts: Date.now() });
        service.markSessionDirty(normalizedConversationId);
      }
    }
    const messages = [];

    // Read OpenAI format: { role, content }
    conversation.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const role = typeof entry.role === "string" ? entry.role : "";
      const content = typeof entry.content === "string" ? entry.content : "";

      if (role === "user") {
        // New sessions store clean user text in content.
        // Legacy sessions may have context metadata baked in — strip it.
        let display = content;
        if (display.includes("User prompt: ")) {
          const match = display.match(/User prompt:\s*([\s\S]*?)(?:\n\nSelection:\n[\s\S]*)?$/);
          if (match) display = match[1].trim();
        }
        if (display.trim()) {
          messages.push({
            role: "user",
            text: clipLongString(display, 20_000),
            ...(typeof entry.displayText === "string" && entry.displayText.trim() ? { displayText: entry.displayText.slice(0, 1000) } : {}),
            // An app-started turn (the opening read) stays out of the transcript view.
            ...(entry.hidden === true ? { hidden: true } : {}),
          });
        }
      } else if (role === "assistant") {
        if (content.trim() || entry.proposals?.length || entry.question) {
          messages.push({
            role: "assistant",
            text: clipLongString(content, 30_000),
            ...(Array.isArray(entry.proposals) && entry.proposals.length > 0
              ? { proposals: entry.proposals }
              : {}),
            ...(entry.question && typeof entry.question === "object"
              ? { question: entry.question }
              : {}),
            ...(entry.rating === "up" || entry.rating === "down" ? { rating: entry.rating } : {}),
            ...(entry.plan && typeof entry.plan === "object" ? { plan: entry.plan } : {}),
          });
        }
      }
    });

    const proposals = [];
    service.proposals.forEach((proposal) => {
      const pConversationId =
        typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
          ? proposal.conversationId.trim()
          : "default";
      if (pConversationId === normalizedConversationId) {
        proposals.push(proposal);
      }
    });

    const meta = service.sessionMetaByConversation.get(normalizedConversationId) ?? null;
    const workspaceRootPath =
      service.workspaceRootByConversation.get(normalizedConversationId) ?? null;
    const lastStatus = service.lastStatusByConversation.get(normalizedConversationId) ?? null;
    const undoCount = Array.isArray(service.applyUndoStack)
      ? service.applyUndoStack.reduce((sum, entry) => {
          if (!entry || entry.conversationId !== normalizedConversationId) {
            return sum;
          }
          return sum + 1;
        }, 0)
      : 0;
    const undoBarrier = service.undoPersistenceBarriersByConversation?.get(
      normalizedConversationId,
    );
    const state = service.runningControllers.has(normalizedConversationId)
      ? lastStatus?.state === "stopping"
        ? "stopping"
        : "running"
      : lastStatus?.state === "error"
        ? "error"
        : lastStatus?.state === "resumable"
          ? "resumable"
          : "idle";
    const title =
      typeof meta?.title === "string" && meta.title.trim()
        ? meta.title.trim()
        : buildTitle(messages, normalizedConversationId);
    sessions.push({
      conversationId: normalizedConversationId,
      title,
      workspaceRootPath,
      createdAt: meta?.createdAt ?? null,
      updatedAt: meta?.updatedAt ?? null,
      status: {
        state,
        message: lastStatus?.message ?? "",
        undoAvailable: undoCount > 0,
        undoCount,
        ...(undoCount === 0 && undoBarrier
          ? { undoUnavailableReason: UNDO_PERSISTENCE_UNAVAILABLE_REASON }
          : {}),
      },
      messages,
      proposals,
    });
  });

  sessions.sort((a, b) => {
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return aUpdated - bUpdated;
  });
  return { sessions };
};

module.exports = {
  ensureSessionsRestored,
  flushPendingSessions,
  markSessionDirty,
  persistSession,
  getUiState,
};
