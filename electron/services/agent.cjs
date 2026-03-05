const crypto = require("crypto");
const {
  DEFAULT_MAX_ITERATIONS,
  buildAgentPolicy,
  clampNumber,
} = require("./agent-policy.cjs");
const {
  clipText,
  deriveTurnRouting,
  deriveTurnTemperature,
  extractMentionedPaths,
  extractTextFromParts,
  resolvePrefetchMaxChars,
} = require("./agent-core-utils.cjs");
const { buildSystemPrompt } = require("./agent-prompt-utils.cjs");
const {
  ensureSessionsRestored,
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
const {
  buildProgressMessage,
  buildPlatformUsageFromQuota,
  extractUsageMetadata,
  normalizeModelCandidate,
} = require("./agent-model-response-utils.cjs");
const { executeToolCall } = require("./agent-tool-executor.cjs");
const {
  terminateConversationTerminals,
  terminateAllTerminals,
  gcIdleTerminals,
} = require("./agent-terminal-runtime.cjs");
const {
  resolveChatModel,
  resolveMaxOutputTokens,
  estimateRequestPartSize,
  estimateRequestMessageSize,
  sanitizeMessageForRequest,
  buildRequestContents,
} = require("./agent-request-utils.cjs");
const { runAgentConversation } = require("./agent-run-loop.cjs");

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
    requestAiChat,
  }) {
    this.workspace = workspace;
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
    this.auditService =
      auditService && typeof auditService.append === "function" ? auditService : null;
    this.sessionsService =
      sessionsService &&
      typeof sessionsService.saveSession === "function" &&
      typeof sessionsService.loadSessions === "function"
        ? sessionsService
        : null;
    this.requestAiChat = typeof requestAiChat === "function" ? requestAiChat : null;

    this.conversations = new Map();
    this.proposals = new Map();
    this.contextByConversation = new Map();
    this.runningControllers = new Map();
    this.lastStatusByConversation = new Map();
    this.workspaceRootByConversation = new Map();
    this.sessionMetaByConversation = new Map();
    this.scratchpadByConversation = new Map();
    this.terminalsById = new Map();
    this.terminalIdsByConversation = new Map();
    this.sessionsRestored = false;
    this.restorePromise = null;
    this.persistTimers = new Map();
    this.terminalGcTimer = setInterval(() => {
      try {
        gcIdleTerminals(this);
      } catch {
        // ignore gc failures
      }
    }, 60_000);
    this.terminalGcTimer?.unref?.();

    this.agentPolicy = buildAgentPolicy();
    this.agentOptions = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: true,
      autoBuild: true,
      allowRunCommand: true,
    };
    this.autoBuildInProgress = false;
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
    };
  }

  emitUndoAvailability(conversationId) {
    const payload = this.getUndoAvailability(conversationId);
    this.sendToRenderer("agent:undoAvailability", payload);
    return payload;
  }

  sendStatus(state, message, conversationId) {
    this.sendToRenderer("agent:status", { state, message, conversationId });
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : "";
    if (normalizedConversationId) {
      this.lastStatusByConversation.set(normalizedConversationId, {
        state: typeof state === "string" ? state : "idle",
        message: typeof message === "string" ? message : "",
        ts: Date.now(),
      });
      this.markSessionDirty(normalizedConversationId);
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
    this.conversations.set(normalized, []);
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
    this.applyUndoStack = this.applyUndoStack.filter((entry) => entry?.conversationId !== normalized);
    this.emitUndoAvailability(normalized);
    terminateConversationTerminals(this, normalized);
    if (this.sessionsService) {
      this.sessionsService.deleteSession(normalized).catch(() => {});
    }
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
      }
      this.runningControllers.delete(targetConversationId);
      return;
    }
    this.runningControllers.forEach((entry) => {
      entry?.controller?.abort?.();
    });
    this.runningControllers.clear();
    terminateAllTerminals(this);
  }

  startConversationRun(conversationId) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const existing = this.runningControllers.get(normalizedConversationId);
    existing?.controller?.abort?.();
    const token =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    this.runningControllers.set(normalizedConversationId, { controller, token });
    return { conversationId: normalizedConversationId, controller, token };
  }

  isRunCurrent(conversationId, token) {
    const current = this.runningControllers.get(conversationId);
    return Boolean(current && current.token === token);
  }

  finishConversationRun(conversationId, token) {
    if (!this.isRunCurrent(conversationId, token)) {
      return;
    }
    this.runningControllers.delete(conversationId);
  }

  resolveAgentPolicy(settings) {
    const policy = buildAgentPolicy(settings);
    this.agentPolicy = policy;
    return policy;
  }

  resolveAgentOptions(settings) {
    const options = {
      maxIterations: clampNumber(
        settings?.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        { min: 1, max: 120 }
      ),
      stream: settings?.stream !== false,
      autoApply: true,
      autoBuild: true,
      allowRunCommand: true,
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
        resolve({ error: "設定の取得に失敗しました。" });
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

  async undoLastApply(conversationId) {
    return undoLastApply(this, conversationId);
  }

  async undoLastRunApply(conversationId) {
    return undoLastRunApply(this, conversationId);
  }

  async applyProposal(proposalId, options) {
    return applyProposal(this, proposalId, options);
  }

  buildProgressMessage(label) {
    return buildProgressMessage(label);
  }

  buildPlatformUsageFromQuota(quota, plan, source = "chat") {
    return buildPlatformUsageFromQuota(quota, plan, source);
  }

  extractUsageMetadata(response) {
    return extractUsageMetadata(response);
  }

  normalizeModelCandidate(response) {
    return normalizeModelCandidate(response);
  }

  async executeToolCall(toolCall, conversationId) {
    return executeToolCall(this, toolCall, conversationId);
  }

  resolveChatModel(settings) {
    return resolveChatModel(settings);
  }

  resolveMaxOutputTokens(settings) {
    return resolveMaxOutputTokens(settings);
  }

  estimateRequestPartSize(part) {
    return estimateRequestPartSize(part);
  }

  estimateRequestMessageSize(message) {
    return estimateRequestMessageSize(message);
  }

  sanitizeMessageForRequest(message, options) {
    return sanitizeMessageForRequest(message, options);
  }

  buildRequestContents(conversation, iteration, settings) {
    return buildRequestContents(conversation, iteration, settings);
  }

  async run(payload) {
    return runAgentConversation(this, payload);
  }
}

module.exports = {
  AgentService,
  buildSystemPrompt,
  deriveTurnRouting,
  deriveTurnTemperature,
  extractMentionedPaths,
  extractTextFromParts,
  resolvePrefetchMaxChars,
};
