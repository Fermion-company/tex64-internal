const {
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_MESSAGES,
  PERSIST_SESSION_VERSION,
  clipLongString,
  extractTextFromParts,
  sanitizeConversationForPersistence,
} = require("./agent-core-utils.cjs");

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

      const storedConversation = Array.isArray(session.conversation) ? session.conversation : null;
      if (
        storedConversation &&
        (!service.conversations.has(conversationId) ||
          (service.conversations.get(conversationId)?.length ?? 0) === 0)
      ) {
        service.conversations.set(conversationId, storedConversation);
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

      const createdAt =
        typeof session.createdAt === "number" && Number.isFinite(session.createdAt)
          ? session.createdAt
          : null;
      const updatedAt =
        typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : null;
      if ((createdAt || updatedAt) && !service.sessionMetaByConversation.has(conversationId)) {
        service.sessionMetaByConversation.set(conversationId, {
          createdAt: createdAt ?? updatedAt ?? Date.now(),
          updatedAt: updatedAt ?? createdAt ?? Date.now(),
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
  const existingTimer = service.persistTimers.get(normalized);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    service.persistTimers.delete(normalized);
    persistSession(service, normalized).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
  service.persistTimers.set(normalized, timer);
};

const persistSession = async (service, conversationId) => {
  if (!service.sessionsService) {
    return;
  }
  const normalized =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";
  await ensureSessionsRestored(service);

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
    currentRoot || (typeof storedRoot === "string" && storedRoot.trim() ? storedRoot.trim() : null);
  if (workspaceRootPath) {
    service.workspaceRootByConversation.set(normalized, workspaceRootPath);
  }

  const lastStatus = service.lastStatusByConversation.get(normalized) ?? null;
  const scratchpad = clipLongString(
    service.scratchpadByConversation.get(normalized) ?? "",
    120_000
  );

  const snapshotBase = {
    version: PERSIST_SESSION_VERSION,
    conversationId: normalized,
    workspaceRootPath: workspaceRootPath || null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastStatus,
    scratchpad,
    proposals,
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
    const messages = [];
    conversation.forEach((entry) => {
      const role = typeof entry?.role === "string" ? entry.role : "";
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      if (role === "user") {
        const text = extractTextFromParts(parts);
        if (text.trim()) {
          messages.push({ role: "user", text: clipLongString(text, 20_000) });
          return;
        }
        const hadInlineData = parts.some((part) => part && typeof part === "object" && part.inlineData);
        if (hadInlineData) {
          messages.push({ role: "user", text: "画像を送信しました。" });
        }
        return;
      }
      if (role === "model") {
        const text = extractTextFromParts(parts);
        if (text.trim()) {
          messages.push({ role: "assistant", text: clipLongString(text, 30_000) });
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
    const state = service.runningControllers.has(normalizedConversationId)
      ? "running"
      : lastStatus?.state === "error"
      ? "error"
      : "idle";
    const title = buildTitle(messages, normalizedConversationId);
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
  markSessionDirty,
  persistSession,
  getUiState,
};
