const crypto = require("crypto");
const path = require("path");
const {
  DEFAULT_MAX_ITERATIONS,
  buildAgentPolicy,
} = require("./agent-policy.cjs");
const {
  clipText,
} = require("./agent-core-utils.cjs");
const {
  ensureSessionsRestored,
  flushPendingSessions,
  markSessionDirty,
  persistSession,
  getUiState,
} = require("./agent-session-state.cjs");
const {
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
} = require("./agent-proposal-runtime.cjs");
const { executeToolCall } = require("./agent-tool-executor.cjs");
const { runAgentConversation, completeSingleChat } = require("./openprism/run-loop.cjs");
const { runCodexConversation } = require("./codex/axiom-adapter.cjs");

const abortError = () => {
  const error = new Error("Axiom request aborted.");
  error.name = "AbortError";
  return error;
};

const awaitAbortable = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

class AgentService {
  constructor({
    workspace,
    searchService,
    ensureUserSettings,
    sendToRenderer,
    updateWorkspaceIfNeeded,
    requestIndex,
    buildService,
    sendBuildState,
    sendBuildLog,
    sendIssues,
    indexerService,
    apiUsageService,
    auditService,
    sessionsService,
    platformAccess,
    envService,
    synctexService,
    isRendererWorkspaceMutationActive,
    getHistoryBoundary,
  }) {
    this.workspace = workspace;
    this.getHistoryBoundary = typeof getHistoryBoundary === "function" ? getHistoryBoundary : () => null;
    this.searchService = searchService;
    this.ensureUserSettings = ensureUserSettings;
    this.sendToRenderer = sendToRenderer;
    this.updateWorkspaceIfNeeded = updateWorkspaceIfNeeded;
    this.requestIndex = requestIndex;
    this.buildService = buildService;
    this.sendBuildState = sendBuildState;
    this.sendBuildLog = sendBuildLog;
    this.sendIssues = sendIssues;
    this.indexerService = indexerService;
    this.apiUsageService = apiUsageService;
    this.platformAccess = platformAccess ?? null;
    this.envService = envService ?? null;
    this.synctexService = synctexService ?? null;
    /** Written proposals of a conversation whose page is looked up after a build. */
    this.proposalScopesByConversation = new Map();
    this.isRendererWorkspaceMutationActive =
      typeof isRendererWorkspaceMutationActive === "function"
        ? isRendererWorkspaceMutationActive
        : () => false;
    this.auditService =
      auditService && typeof auditService.append === "function" ? auditService : null;
    this.sessionsService =
      sessionsService &&
      typeof sessionsService.saveSession === "function" &&
      typeof sessionsService.loadSessions === "function"
        ? sessionsService
        : null;
    this.conversations = new Map();
    this.proposals = new Map();
    this.contextByConversation = new Map();
    this.runningControllers = new Map();
    this.runningWorkspaceRoots = new Map();
    this.lastStatusByConversation = new Map();
    this.workspaceRootByConversation = new Map();
    this.sessionMetaByConversation = new Map();
    this.scratchpadByConversation = new Map();
    this.undoPersistenceBarriersByConversation = new Map();
    this.contentConflictsByConversation = new Map();
    this.contentConflictWorkspaceRootsByConversation = new Map();
    this.sessionsRestored = false;
    this.restorePromise = null;
    this.persistTimers = new Map();
    this.sessionPersistPromises = new Set();
    this.deletedConversations = new Set();

    this.agentPolicy = buildAgentPolicy();
    this.agentOptions = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: true,
      autoBuild: true,
      allowRunCommand: false,
    };
    this.autoBuildQueue = Promise.resolve();
    this.activeAgentBuildConversationId = null;
    this.pendingSettingsRequests = new Map();
    this.applyUndoStack = [];
  }

  getUndoAvailability(conversationId) {
    const targetConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    let count = 0;
    for (let i = 0; i < this.applyUndoStack.length; i += 1) {
      const entry = this.applyUndoStack[i];
      if (!entry || entry.conversationId !== targetConversationId) {
        continue;
      }
      count += 1;
    }
    return {
      conversationId: targetConversationId,
      available: count > 0,
      count,
      ...(count === 0 && this.undoPersistenceBarriersByConversation.has(targetConversationId)
        ? {
            unavailableReason: "persistence_limit",
            message:
              "The last AI change cannot be undone after restart because its complete undo snapshot exceeded the safety limit.",
          }
        : {}),
    };
  }

  emitUndoAvailability(conversationId) {
    const payload = this.getUndoAvailability(conversationId);
    this.sendToRenderer("agent:undoAvailability", payload);
    return payload;
  }

  sendStatus(state, message, conversationId) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : "";
    const hasContentConflict =
      normalizedConversationId &&
      (this.contentConflictsByConversation.get(normalizedConversationId)?.size ?? 0) > 0;
    const effectiveState = state === "idle" && hasContentConflict ? "resumable" : state;
    const effectiveMessage =
      state === "idle" && hasContentConflict
        ? "Resolve the editor conflict before continuing."
        : message;
    this.sendToRenderer("agent:status", {
      state: effectiveState,
      message: effectiveMessage,
      conversationId,
    });
    if (normalizedConversationId) {
      this.lastStatusByConversation.set(normalizedConversationId, {
        state: typeof effectiveState === "string" ? effectiveState : "idle",
        message: typeof effectiveMessage === "string" ? effectiveMessage : "",
        ts: Date.now(),
      });
      this.markSessionDirty(normalizedConversationId);
    }
  }

  reportContentConflict(conversationId, relativePath) {
    const normalized =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const targetPath =
      typeof relativePath === "string" && relativePath.trim()
        ? relativePath.trim()
        : "the open file";
    let paths = this.contentConflictsByConversation.get(normalized);
    if (!paths) {
      paths = new Set();
      this.contentConflictsByConversation.set(normalized, paths);
    }
    paths.add(targetPath);
    const conflictRoot =
      this.workspaceRootByConversation.get(normalized) ??
      this.contextByConversation.get(normalized)?.workspaceRoot ??
      this.workspace.getRootPath?.() ??
      null;
    if (conflictRoot) {
      this.contentConflictWorkspaceRootsByConversation.set(normalized, conflictRoot);
    }
    const message = `Axiom and unsaved editor changes conflict in ${targetPath}. Choose which version to keep.`;
    this.sendToRenderer("agent:error", { message, conversationId: normalized });
    this.sendStatus("resumable", message, normalized);
  }

  resolveContentConflict(conversationId, relativePath) {
    const normalized =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const paths = this.contentConflictsByConversation.get(normalized);
    if (!paths) return;
    if (typeof relativePath === "string" && relativePath.trim()) {
      paths.delete(relativePath.trim());
    } else {
      paths.clear();
    }
    if (paths.size > 0) {
      this.markSessionDirty(normalized);
      return;
    }
    const conflictRoot =
      this.contentConflictWorkspaceRootsByConversation.get(normalized) ?? null;
    this.contentConflictsByConversation.delete(normalized);
    this.contentConflictWorkspaceRootsByConversation.delete(normalized);
    this.markSessionDirty(normalized);
    // The user has now chosen the authoritative bytes. Compile once after any
    // active turn has released its workspace lease so the PDF cannot remain on
    // the pre-resolution version.
    void (async () => {
      if (this.runningControllers.has(normalized)) {
        await this.waitForIdle(2 * 60 * 1000);
      }
      if (this.contentConflictsByConversation.has(normalized)) return;
      if (conflictRoot && this.workspace.getRootPath?.() !== conflictRoot) return;
      let resolutionRun;
      try {
        resolutionRun = this.startConversationRun(normalized);
        const result = await this.executeToolCall({ name: "run_build", args: {} }, normalized);
        if (result?.status === "success") {
          this.sendStatus("idle", "Waiting", normalized);
        } else if (result?.status !== "cancelled") {
          this.sendStatus("resumable", "Compilation failed", normalized);
        }
      } catch (error) {
        if (
          error?.code === "AGENT_RUN_IN_PROGRESS" ||
          error?.code === "AGENT_WORKSPACE_RUN_IN_PROGRESS"
        ) {
          // The newer turn owns the definitive terminal build.
          return;
        }
        const message = error?.message || "Compilation failed after resolving the edit conflict.";
        this.sendToRenderer("agent:error", { message, conversationId: normalized });
        this.sendStatus("resumable", message, normalized);
      } finally {
        if (resolutionRun) {
          this.finishConversationRun(normalized, resolutionRun.token);
        }
      }
    })();
  }

  hasContentConflictInWorkspace(rootPath) {
    if (!rootPath) return false;
    for (const [conversationId, paths] of this.contentConflictsByConversation) {
      if (
        paths.size > 0 &&
        this.contentConflictWorkspaceRootsByConversation.get(conversationId) === rootPath
      ) {
        return true;
      }
    }
    return false;
  }

  discardContentConflictsForWorkspace(rootPath) {
    if (!rootPath) return;
    for (const [conversationId, conflictRoot] of [
      ...this.contentConflictWorkspaceRootsByConversation,
    ]) {
      if (conflictRoot !== rootPath) continue;
      this.contentConflictsByConversation.delete(conversationId);
      this.contentConflictWorkspaceRootsByConversation.delete(conversationId);
      this.markSessionDirty(conversationId);
    }
  }

  async ensureSessionsRestored() {
    return ensureSessionsRestored(this);
  }

  markSessionDirty(conversationId) {
    return markSessionDirty(this, conversationId);
  }

  async persistSession(conversationId) {
    return persistSession(this, conversationId);
  }

  async flushPendingSessions() {
    return flushPendingSessions(this);
  }

  async getUiState() {
    return getUiState(this);
  }

  emitAuditEvent(eventType, payload, conversationId, runIdOverride) {
    if (!this.auditService) {
      return;
    }
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : null;
    const runId =
      typeof runIdOverride === "string" && runIdOverride.trim()
        ? runIdOverride.trim()
        : normalizedConversationId
        ? this.runningControllers.get(normalizedConversationId)?.token ?? null
        : null;
    const safePayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { value: payload };
    this.auditService
      .append({
        ts: Date.now(),
        conversationId: normalizedConversationId,
        runId,
        eventType: typeof eventType === "string" ? eventType : "event",
        payload: safePayload,
      })
      .catch(() => {});
  }

  buildConversation(conversationId) {
    this.deletedConversations.delete(conversationId);
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, []);
    }
    return this.conversations.get(conversationId);
  }

  clearConversation(conversationId) {
    const normalized =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    if (this.runningControllers.has(normalized)) {
      return {
        ok: false,
        error: "Wait for the Axiom turn to finish before deleting this chat.",
      };
    }
    this.deletedConversations.add(normalized);
    const pendingPersist = this.persistTimers.get(normalized);
    if (pendingPersist) clearTimeout(pendingPersist);
    this.persistTimers.delete(normalized);
    this.conversations.delete(normalized);
    this.contextByConversation.delete(normalized);
    const proposalIdsToDelete = [];
    this.proposals.forEach((proposal, proposalId) => {
      const pConversationId =
        typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
          ? proposal.conversationId.trim()
          : "default";
      if (pConversationId === normalized) {
        proposalIdsToDelete.push(proposalId);
      }
    });
    proposalIdsToDelete.forEach((proposalId) => {
      this.proposals.delete(proposalId);
    });
    this.sessionMetaByConversation.delete(normalized);
    this.workspaceRootByConversation.delete(normalized);
    this.lastStatusByConversation.delete(normalized);
    this.scratchpadByConversation.delete(normalized);
    this.undoPersistenceBarriersByConversation.delete(normalized);
    this.contentConflictsByConversation.delete(normalized);
    this.contentConflictWorkspaceRootsByConversation.delete(normalized);
    this.proposalScopesByConversation.delete(normalized);
    this.applyUndoStack = this.applyUndoStack.filter((entry) => entry?.conversationId !== normalized);
    this.emitUndoAvailability(normalized);
    if (this.sessionsService) {
      this.sessionsService.deleteSession(normalized).catch(() => {});
    }
    return { ok: true };
  }

  dismissProposal(proposalId) {
    const id = typeof proposalId === "string" ? proposalId.trim() : "";
    if (!id) {
      return;
    }
    const proposal = this.proposals.get(id);
    if (!proposal) {
      return;
    }
    const conversationId =
      typeof proposal.conversationId === "string" && proposal.conversationId.trim()
        ? proposal.conversationId.trim()
        : "default";
    this.proposals.delete(id);
    this.markSessionDirty(conversationId);
  }

  abort(conversationId) {
    const targetConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "";
    if (targetConversationId) {
      const entry = this.runningControllers.get(targetConversationId);
      if (entry?.controller) {
        entry.controller.abort();
        if (this.activeAgentBuildConversationId === targetConversationId) {
          this.buildService?.cancelCurrentRun?.();
        }
        // A terminal status follows only after the run loop has settled any
        // partial write through the real build service. This immediate,
        // non-terminal acknowledgement keeps desktop clients from timing out
        // and starting a conflicting turn while that build is still active.
        this.sendStatus(
          "stopping",
          "Finishing partial changes...",
          targetConversationId,
        );
      }
      return;
    }
    this.runningControllers.forEach((entry, activeConversationId) => {
      entry?.controller?.abort?.();
      this.sendStatus(
        "stopping",
        "Finishing partial changes...",
        activeConversationId,
      );
    });
    if (this.activeAgentBuildConversationId) {
      this.buildService?.cancelCurrentRun?.();
    }
  }

  async waitForIdle(timeoutMs = 5000) {
    if (this.runningControllers.size === 0) {
      return true;
    }
    const parsedTimeout = Number(timeoutMs);
    const timeout = Number.isFinite(parsedTimeout)
      ? Math.max(0, parsedTimeout)
      : 5000;
    if (timeout === 0) {
      return false;
    }
    const deadline = Date.now() + timeout;
    return new Promise((resolve) => {
      const check = () => {
        if (this.runningControllers.size === 0) {
          resolve(true);
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolve(false);
          return;
        }
        setTimeout(check, Math.min(25, remaining));
      };
      check();
    });
  }

  startConversationRun(conversationId) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const existing = this.runningControllers.get(normalizedConversationId);
    if (existing) {
      const error = new Error("An Axiom turn is already finishing for this conversation.");
      error.code = "AGENT_RUN_IN_PROGRESS";
      throw error;
    }
    const workspaceRoot = this.workspace.getRootPath?.() ?? null;
    const boundWorkspaceRoot = this.workspaceRootByConversation.get(
      normalizedConversationId,
    );
    if (
      workspaceRoot &&
      boundWorkspaceRoot &&
      path.resolve(boundWorkspaceRoot) !== path.resolve(workspaceRoot)
    ) {
      const error = new Error(
        "This Axiom chat belongs to another workspace. Start a new chat here.",
      );
      error.code = "AGENT_CONVERSATION_WORKSPACE_MISMATCH";
      throw error;
    }
    if (workspaceRoot && this.hasContentConflictInWorkspace(workspaceRoot)) {
      const error = new Error("Resolve the editor conflict before starting another Axiom turn.");
      error.code = "AGENT_CONTENT_CONFLICT";
      throw error;
    }
    if (workspaceRoot && this.isRendererWorkspaceMutationActive(workspaceRoot)) {
      const error = new Error(
        "A file save is still finishing in this workspace. Retry the Axiom turn in a moment.",
      );
      error.code = "RENDERER_WORKSPACE_MUTATION_IN_PROGRESS";
      throw error;
    }
    const workspaceOwner = workspaceRoot
      ? this.runningWorkspaceRoots.get(workspaceRoot)
      : null;
    if (workspaceOwner) {
      const error = new Error(
        "Another Axiom turn is still finishing in this workspace.",
      );
      error.code = "AGENT_WORKSPACE_RUN_IN_PROGRESS";
      throw error;
    }
    const token =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    this.runningControllers.set(normalizedConversationId, {
      controller,
      token,
      workspaceRoot,
    });
    if (workspaceRoot) {
      this.runningWorkspaceRoots.set(workspaceRoot, {
        conversationId: normalizedConversationId,
        token,
      });
    }
    return { conversationId: normalizedConversationId, controller, token, workspaceRoot };
  }

  isRunCurrent(conversationId, token) {
    const current = this.runningControllers.get(conversationId);
    return Boolean(current && current.token === token);
  }

  finishConversationRun(conversationId, token) {
    if (!this.isRunCurrent(conversationId, token)) {
      return;
    }
    const current = this.runningControllers.get(conversationId);
    this.runningControllers.delete(conversationId);
    if (current?.workspaceRoot) {
      const workspaceOwner = this.runningWorkspaceRoots.get(current.workspaceRoot);
      if (workspaceOwner?.token === token) {
        this.runningWorkspaceRoots.delete(current.workspaceRoot);
      }
    }
  }

  resolveAgentPolicy(settings) {
    const policy = buildAgentPolicy(settings);
    this.agentPolicy = policy;
    return policy;
  }

  resolveAgentOptions() {
    // The agent's nature is fixed in code: edits apply directly, every edit
    // is built, the shell is never available. Nothing here is a preference.
    const options = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: true,
      autoBuild: true,
      allowRunCommand: false,
    };
    this.agentOptions = options;
    return options;
  }

  setContext(conversationId, context) {
    if (!conversationId) {
      return;
    }
    this.contextByConversation.set(conversationId, context ?? {});
  }

  requestAppSettings(action, payload) {
    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSettingsRequests.delete(requestId);
        resolve({ error: "Failed to get settings." });
      }, 3000);
      this.pendingSettingsRequests.set(requestId, { resolve, timer });
      this.sendToRenderer("settings:request", {
        requestId,
        action,
        ...payload,
      });
    });
  }

  handleSettingsResponse(payload) {
    const requestId = payload?.requestId;
    if (!requestId || !this.pendingSettingsRequests.has(requestId)) {
      return;
    }
    const entry = this.pendingSettingsRequests.get(requestId);
    this.pendingSettingsRequests.delete(requestId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    entry?.resolve?.(payload);
  }

  async maybeAutoBuild(proposal) {
    return maybeAutoBuild(this, proposal);
  }

  getContextSnapshot(conversationId, targetPath) {
    return getContextSnapshot(this, conversationId, targetPath);
  }

  hashBuffer(buffer) {
    return hashBuffer(this, buffer);
  }

  hashUtf8(value) {
    return hashUtf8(this, value);
  }

  hashProposalContent(proposal) {
    return hashProposalContent(this, proposal);
  }

  async readCurrentFileState(relativePath) {
    return readCurrentFileState(this, relativePath);
  }

  async validateProposalBeforeApply(proposal) {
    return validateProposalBeforeApply(this, proposal);
  }

  pushUndoEntry(entry) {
    return pushUndoEntry(this, entry);
  }

  async withUndoWorkspaceLease(conversationId, options, operation) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const emitRenderer = options?.emitRenderer !== false;
    const ownedToken = options?._workspaceRunToken;
    let run = null;
    if (typeof ownedToken === "string" && ownedToken) {
      if (!this.isRunCurrent(normalizedConversationId, ownedToken)) {
        const message = "Cannot undo: the Axiom turn that owned this change has finished.";
        if (emitRenderer) {
          this.sendToRenderer("agent:undoResult", {
            ok: false,
            message,
            conversationId: normalizedConversationId,
          });
        }
        return {
          ok: false,
          reason: "workspace_busy",
          message,
          conversationId: normalizedConversationId,
        };
      }
    } else {
      try {
        run = this.startConversationRun(normalizedConversationId);
        this.sendStatus("running", "Undoing changes...", normalizedConversationId);
      } catch (error) {
        const message = error?.message || "Cannot undo while the workspace is being updated.";
        if (emitRenderer) {
          this.sendToRenderer("agent:undoResult", {
            ok: false,
            message,
            conversationId: normalizedConversationId,
          });
        }
        return {
          ok: false,
          reason: "workspace_busy",
          message,
          conversationId: normalizedConversationId,
        };
      }
    }
    try {
      const result = await operation(normalizedConversationId);
      const settled = await this.buildAfterUndo(result, normalizedConversationId);
      if (
        run &&
        !Object.prototype.hasOwnProperty.call(settled ?? {}, "build")
      ) {
        this.sendStatus("idle", "Waiting", normalizedConversationId);
      }
      return settled;
    } catch (error) {
      if (run) {
        const message = error?.message || "Undo failed.";
        this.sendToRenderer("agent:error", {
          message,
          conversationId: normalizedConversationId,
        });
        this.sendStatus("error", message, normalizedConversationId);
      }
      throw error;
    } finally {
      if (run) this.finishConversationRun(normalizedConversationId, run.token);
    }
  }

  async buildAfterUndo(result, conversationId) {
    if (result?.ok !== true && result?.requiresBuild !== true) return result;
    if (!this.buildService) return result;
    const requiresBuild =
      typeof result.requiresBuild === "boolean"
        ? result.requiresBuild
        : result.type !== "mkdir";
    if (!requiresBuild) {
      return result;
    }
    const context = this.contextByConversation.get(conversationId) ?? {};
    let mainFile = [context.documentMainFile, context.activeFilePath]
      .find(
        (value) =>
          typeof value === "string" && path.extname(value).toLowerCase() === ".tex",
      );
    if (!mainFile && conversationId.startsWith("tex64-ai-mode:")) {
      const suffix = conversationId.slice("tex64-ai-mode:".length);
      const separator = suffix.indexOf(":");
      if (separator >= 0) {
        try {
          const decoded = decodeURIComponent(suffix.slice(separator + 1));
          if (path.extname(decoded).toLowerCase() === ".tex") mainFile = decoded;
        } catch {
          // The normal workspace root fallback below is still safe.
        }
      }
    }
    let buildResult;
    try {
      buildResult = await this.executeToolCall(
        {
          name: "run_build",
          args: typeof mainFile === "string" ? { mainFile } : {},
        },
        conversationId,
      );
    } catch (error) {
      buildResult = { status: "failure", error: error?.message || "Build failed." };
    }
    if (buildResult?.status === "success") {
      this.sendStatus("idle", "Waiting", conversationId);
    } else {
      const message = "Undo completed, but a compilation error remains.";
      this.sendToRenderer("agent:error", { message, conversationId });
      this.sendStatus("resumable", "Compilation failed", conversationId);
    }
    return { ...result, build: buildResult };
  }

  async undoLastApply(conversationId, options) {
    await this.ensureSessionsRestored();
    return this.withUndoWorkspaceLease(conversationId, options, (normalized) =>
      undoLastApply(this, normalized, options),
    );
  }

  async undoLastRunApply(conversationId, options) {
    await this.ensureSessionsRestored();
    return this.withUndoWorkspaceLease(conversationId, options, (normalized) =>
      undoLastRunApply(this, normalized, options),
    );
  }

  async applyProposal(proposalId, options) {
    await this.ensureSessionsRestored();
    const proposal = this.proposals.get(proposalId);
    const conversationId =
      typeof proposal?.conversationId === "string" && proposal.conversationId.trim()
        ? proposal.conversationId.trim()
        : "default";
    const ownedToken = options?._workspaceRunToken;
    let run = null;
    if (typeof ownedToken === "string" && ownedToken) {
      if (!this.isRunCurrent(conversationId, ownedToken)) {
        const error = "Cannot apply: the Axiom turn that created this proposal has finished.";
        this.sendToRenderer("agent:applyResult", { proposalId, ok: false, error });
        return { ok: false, proposalId, error };
      }
    } else {
      try {
        run = this.startConversationRun(conversationId);
        this.sendStatus("running", "Applying change...", conversationId);
      } catch (cause) {
        const error = cause?.message || "Cannot apply while the workspace is being updated.";
        this.sendToRenderer("agent:applyResult", { proposalId, ok: false, error });
        return { ok: false, proposalId, error };
      }
    }
    try {
      const result = await applyProposal(this, proposalId, options);
      if (run) {
        if (result?.autoBuild) {
          this.settleManualApplyBuild(result.autoBuild, conversationId);
        } else {
          this.sendStatus("idle", "Waiting", conversationId);
        }
      }
      return result;
    } catch (error) {
      if (run) {
        const message = error?.message || "Apply failed.";
        this.sendToRenderer("agent:error", { message, conversationId });
        this.sendStatus("error", message, conversationId);
      }
      throw error;
    } finally {
      if (run) this.finishConversationRun(conversationId, run.token);
    }
  }

  async applyProposals(proposalIds) {
    await this.ensureSessionsRestored();
    const ids = [...new Set(
      (Array.isArray(proposalIds) ? proposalIds : [])
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim()),
    )].slice(0, 100);
    if (ids.length === 0) return { ok: false, results: [], error: "No proposals selected." };
    const proposals = ids.map((id) => this.proposals.get(id));
    const conversationIds = new Set(
      proposals
        .filter(Boolean)
        .map((proposal) => proposal.conversationId || "default"),
    );
    if (proposals.some((proposal) => !proposal) || conversationIds.size !== 1) {
      const error = "Apply all requires existing proposals from one chat.";
      ids.forEach((proposalId) =>
        this.sendToRenderer("agent:applyResult", { proposalId, ok: false, error })
      );
      return { ok: false, results: [], error };
    }
    const conversationId = [...conversationIds][0];
    let run;
    try {
      run = this.startConversationRun(conversationId);
      this.sendStatus("running", "Applying changes...", conversationId);
    } catch (cause) {
      const error = cause?.message || "Cannot apply while the workspace is being updated.";
      ids.forEach((proposalId) =>
        this.sendToRenderer("agent:applyResult", { proposalId, ok: false, error })
      );
      return { ok: false, results: [], error };
    }
    try {
      const results = [];
      for (const proposalId of ids) {
        results.push(
          await applyProposal(this, proposalId, {
            _workspaceRunToken: run.token,
            skipAutoBuild: true,
          }),
        );
      }
      const firstFileChange = results.find(
        (result) => result?.ok === true && result.type !== "mkdir",
      );
      const autoBuild = firstFileChange
        ? await maybeAutoBuild(this, {
            type: firstFileChange.type,
            path: firstFileChange.path,
            conversationId,
          })
        : null;
      if (autoBuild) this.settleManualApplyBuild(autoBuild, conversationId);
      else this.sendStatus("idle", "Waiting", conversationId);
      return {
        ok: results.every((result) => result?.ok === true),
        results,
        autoBuild,
      };
    } catch (error) {
      const message = error?.message || "Apply failed.";
      this.sendToRenderer("agent:error", { message, conversationId });
      this.sendStatus("error", message, conversationId);
      throw error;
    } finally {
      this.finishConversationRun(conversationId, run.token);
    }
  }

  settleManualApplyBuild(buildResult, conversationId) {
    if (buildResult?.status === "success") {
      this.sendStatus("idle", "Waiting", conversationId);
      return;
    }
    const message = buildResult?.summary || buildResult?.error || "Compilation failed.";
    this.sendToRenderer("agent:error", { message, conversationId });
    this.sendStatus("resumable", "Compilation failed", conversationId);
  }

  async runSerializedBuild(task, conversationId = null) {
    if (typeof task !== "function") {
      throw new TypeError("A build task is required.");
    }
    const turnSignal =
      typeof conversationId === "string"
        ? this.runningControllers.get(conversationId)?.controller?.signal
        : null;
    const waitForExternalBuild = async () => {
      // Agent turns share the queue below. The normal Build button does not,
      // so wait for it explicitly instead of accepting BuildService's `busy`
      // sentinel as a real compile attempt.
      let waited = false;
      while (this.buildService?.isBuilding === true) {
        waited = true;
        await awaitAbortable(
          new Promise((resolve) => setTimeout(resolve, 25)),
          turnSignal,
        );
      }
      // An already-aborted terminal settlement may start immediately when the
      // build service is free, so partial edits still get one definitive build.
      // If Stop arrived while queued behind a manual build, do not launch a new
      // two-minute process after that unrelated build eventually finishes.
      if (waited && turnSignal?.aborted) {
        throw abortError();
      }
    };
    const previous = Promise.resolve(this.autoBuildQueue).catch(() => {});
    const queued = previous.then(async () => {
      await waitForExternalBuild();
      return task();
    });
    // A failed build must not poison later turns' place in the queue.
    this.autoBuildQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async executeToolCall(toolCall, conversationId) {
    if (toolCall?.name === "run_build") {
      return this.runSerializedBuild(
        () => executeToolCall(this, toolCall, conversationId),
        conversationId,
      );
    }
    return executeToolCall(this, toolCall, conversationId);
  }

  async run(payload, prestartedRun = null) {
    const conversationId =
      typeof payload?.conversationId === "string" && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : "default";
    // Register before session/settings preflight. Otherwise Stop can arrive
    // while the UI says Preparing but no controller exists to receive it.
    const run = prestartedRun ?? this.startConversationRun(conversationId);
    const isCurrentRun = () => this.isRunCurrent(conversationId, run.token);
    if (!prestartedRun) {
      this.sendStatus("running", "Preparing...", conversationId);
    }
    try {
      // A run can arrive before the renderer asks for agent:state. Restore the
      // persisted conversation first so the first turn after launch does not
      // silently start with an empty history.
      await awaitAbortable(this.ensureSessionsRestored(), run.controller.signal);
      if (!isCurrentRun()) return;
      if (run.controller.signal.aborted) {
        this.sendStatus("idle", "Aborted.", conversationId);
        return;
      }

      // model "codex" はユーザー自身の ChatGPT/Codex サブスクで動くバックエンド。
      // それ以外は従来どおり openprism (Axiom proxy) 経路。
      const settings = await awaitAbortable(
        this.ensureUserSettings().getAgentSettings(),
        run.controller.signal,
      );
      if (!isCurrentRun()) return;
      if (run.controller.signal.aborted) {
        this.sendStatus("idle", "Aborted.", conversationId);
        return;
      }
      if (payload?.forcePlatformAxiom !== true && (settings?.model || "") === "codex") {
        return await runCodexConversation(this, payload, run);
      }
      return await runAgentConversation(this, payload, run);
    } catch (error) {
      if (!isCurrentRun()) return;
      if (error?.name === "AbortError" || run.controller.signal.aborted) {
        this.sendStatus("idle", "Aborted.", conversationId);
        return;
      }
      const message =
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Axiom could not start. Please restart TeX64 and try again.";
      this.sendToRenderer("agent:error", { message, conversationId });
      this.sendStatus("error", message, conversationId);
    } finally {
      this.finishConversationRun(conversationId, run.token);
      this.markSessionDirty(conversationId);
    }
  }

  async completeOnce(payload) {
    return completeSingleChat(this, payload);
  }
}

module.exports = {
  AgentService,
};
