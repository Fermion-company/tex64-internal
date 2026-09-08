import { updatePdfSourceState } from "./viewer.js";
import type { TexEnvReport } from "./tex-env-report.js";
import type {
  BuildState,
  BridgeWindow,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  AgentProposal,
  AgentSettings,
  AgentStatusState,
  AgentUiState,
  AppSettingsSnapshot,
  RootSource,
  SearchResult,
  SectionEntry,
  ApiUsageSnapshot,
  PlatformAuthSnapshot,
  PlatformAiAccessSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
  PlatformUpdateStatusSnapshot,
  AnnouncementSnapshot,
  BuildProfile,
  AgentNextStep,
  AgentQuestion,
  AgentPlan,
} from "./types.js";
import { uiText } from "./i18n.js";
import type { FilePreviewResultPayload } from "./file-preview.js";
import type { WorkspaceFileCacheScope } from "./file-preview.js";
import type { FileExcerptResultPayload } from "./file-excerpt.js";

const AI_MODE_CONVERSATION_PREFIX = "tex64-ai-mode:";

const isAiModeAgentPayload = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;
  const directId = body.conversationId;
  if (
    typeof directId === "string" &&
    directId.startsWith(AI_MODE_CONVERSATION_PREFIX)
  ) {
    return true;
  }
  const proposal = body.proposal;
  return Boolean(
    proposal &&
      typeof proposal === "object" &&
      typeof (proposal as Record<string, unknown>).conversationId === "string" &&
      ((proposal as Record<string, unknown>).conversationId as string).startsWith(
        AI_MODE_CONVERSATION_PREFIX,
      ),
  );
};

type BridgeHandlersDeps = {
  bridgeWindow: BridgeWindow;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  handleWorkspaceUpdate: (payload: {
    rootName: string;
    rootPath: string | null;
    files: string[];
    folders?: string[];
    rootFile?: string;
    rootSource?: RootSource;
    buildProfiles?: BuildProfile[];
    buildProfileId?: string;
    workspaceId?: string | null;
    workspaceGeneration?: number;
  }) => void;
  handleIndexUpdate: (payload: {
    labels?: IndexEntry[];
    references?: IndexEntry[];
    citations?: IndexEntry[];
    sections?: SectionEntry[];
    figures?: IndexEntry[];
    tables?: IndexEntry[];
    todos?: IndexEntry[];
  }) => void;
  handleLauncherStatus: (payload: { isBusy?: boolean; message?: string }) => void;
  handleRecentProjects: (projects: { path: string; name: string; openedAt: number }[]) => void;
  app?: {
    handleCommand: (command: string) => void;
  };
  billing?: {
    handleCheckoutClosed: (payload: {
      plan?: string;
      outcome?: "success" | "cancel" | "closed" | "error";
    }) => void;
  };
  search: {
    handleSearchUpdate: (payload: {
      query: string;
      results?: SearchResult[];
      message?: string;
      requestId?: number;
    }) => void;
    handleRenameResult?: (payload: {
      ok: boolean;
      from?: string;
      to?: string;
      fileCount?: number;
      appliedCount?: number;
      skippedCount?: number;
      error?: string;
      conversationId?: string;
    }) => void;
  };
  build: {
    setBuildState: (state: BuildState, message?: string) => void;
    setBuildTarget?: (path: string) => void;
    handleFormatResult: (payload: {
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
      stale?: boolean;
    }) => void;
    handleBuildLog: (log: string | null) => void;
    handleSynctexForwardResult: (payload: {
      ok?: boolean;
      error?: string;
      page?: number;
      x?: number;
      y?: number;
      blockX?: number;
      blockY?: number;
      blockWidth?: number;
      blockHeight?: number;
      pdfPath?: string | null;
      requestId?: string;
      cancelled?: boolean;
    }) => void;
    handleSynctexReverseResult: (payload: {
      ok?: boolean;
      error?: string;
      path?: string;
      line?: number;
      column?: number;
      confidence?: boolean;
      scoreGap?: number | null;
      distance?: number | null;
      pdfPath?: string | null;
    }) => void;
  };
  settings?: {
    updateEnvStatus: (command: string, available: boolean) => void;
    handleEnvDetectResult?: (payload: { report?: TexEnvReport | null; error?: string }) => void;
    handleEnvInstallStart?: (payload: { target?: string; variant?: string }) => void;
    handleEnvInstallResult?: (payload: {
      target?: string;
      success?: boolean;
      message?: string;
    }) => void;
    handleEnvInstallProgress?: (payload: {
      phase?: string;
      current?: number | null;
      total?: number | null;
      percent?: number | null;
    }) => void;
    getSettingsSnapshot?: () => AppSettingsSnapshot;
    applySettingsPatch?: (patch: Partial<AppSettingsSnapshot>) => AppSettingsSnapshot;
  };
  agent?: {
    handleSettings: (settings: AgentSettings) => void;
    handleState?: (state: AgentUiState) => void;
    handleStatus: (
      state: AgentStatusState,
      message?: string,
      conversationId?: string
    ) => void;
    handleMessage: (
      text: string,
      conversationId?: string,
      extras?: { proposals?: AgentNextStep[]; question?: AgentQuestion; plan?: AgentPlan },
    ) => void;
    handleMessageDelta?: (text: string, conversationId?: string) => void;
    handleTitle?: (payload: { conversationId?: string; title?: string }) => void;
    handleMessageReset?: (payload: { conversationId?: string }) => void;
    askFromPdf?: (payload: {
      page: number;
      x: number;
      y: number;
      text: string;
      pdfPath: string | null;
      source?: { file: string; line: number; column: number } | null;
    }) => void;
    handlePdfReverseResult?: (payload: { requestId?: string; ok?: boolean; path?: string; line?: number; error?: string }) => void;
    handleFeedbackResult?: (payload: {
      conversationId?: string;
      assistantIndex?: number;
      rating?: "up" | "down";
      ok?: boolean;
      error?: string;
    }) => void;
    handleBranchResult?: (payload: { ok?: boolean; conversationId?: string; error?: string }) => void;
    handleProposalScope?: (payload: { conversationId?: string; proposalId?: string; page?: number }) => void;
    handleTranscribeResult?: (payload: { requestId?: string; ok?: boolean; text?: string; error?: string }) => void;
    handleDocumentMap: (payload: {
      requestId?: string;
      mainFile?: string | null;
      sections?: Array<{ path: string; id: number; type: string; number?: string; title: string; line: number; endLine: number }>;
      labels?: Array<{ key: string; path: string; line: number }>;
      bibKeys?: Array<{ key: string; path: string; line?: number; title?: string }>;
      git?: { isRepo?: boolean; changed?: number };
      rules?: { exists?: boolean };
    }) => void;
    handleTool: (payload: {
      name: string;
      label?: string;
      detail?: string;
      summary?: string;
      conversationId?: string;
    }) => void;
    handleProposal: (proposal: AgentProposal) => void;
    handleApplyResult: (payload: {
      proposalId: string;
      ok: boolean;
      error?: string;
      conflict?: boolean;
    }) => void;
    handleUndoResult: (payload: {
      ok: boolean;
      message?: string;
      path?: string;
      conversationId?: string;
    }) => void;
    handleUndoAvailability?: (payload: {
      conversationId?: string;
      available?: boolean;
      count?: number;
    }) => void;
    handleScratchpad?: (payload: {
      content: string;
      conversationId?: string;
    }) => void;
    handleThought?: (payload: {
      text: string;
      conversationId?: string;
    }) => void;
    handleError: (message: string, conversationId?: string) => void;
    handleRequestRejected?: (payload: {
      conversationId?: string;
      message?: string;
    }) => void;
  };
  api?: {
    handleUsage: (payload: { snapshot?: ApiUsageSnapshot }) => void;
  };
  platform?: {
    handleAuth: (payload: {
      auth: PlatformAuthSnapshot;
      error?: { code?: string; message?: string };
    }) => void;
    handleAiAccess: (payload: {
      source?: string;
      access: PlatformAiAccessSnapshot;
    }) => void;
    handleUsage: (payload: {
      source?: string;
      usage: PlatformUsageSnapshot;
    }) => void;
    handleUpdate: (payload: {
      source?: string;
      update: PlatformUpdateSnapshot | null;
      error?: { code?: string; message?: string };
    }) => void;
    handleUpdateStatus: (payload: {
      source?: string;
      status: PlatformUpdateStatusSnapshot;
    }) => void;
    handleFeedback: (payload: {
      ok: boolean;
      feedbackId?: string | null;
      error?: { code?: string; message?: string };
    }) => void;
    handleAnnouncements?: (payload: {
      announcements: AnnouncementSnapshot[];
      fetchedAt?: number;
    }) => void;
  };
  editorSession: {
    handleExternalFileChange: (payload: { path: string; content: string | null; fileDeleted?: boolean }) => void;
    handleOpenFileResult: (payload: {
      path: string;
      content?: string;
      error?: string;
      kind?: "text" | "image" | "pdf" | "unsupported";
      data?: string;
      mimeType?: string;
      livePreview?: { generation: number; documentEpoch: number };
    }) => void;
    handleSaveResult: (payload: {
      path: string;
      ok: boolean;
      error?: string;
      content?: string;
      formatError?: string;
    }) => void;
    handleRenameResult: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
    applyContentToOpenFile: (
      path: string,
      content: string,
      options?: {
        updateSaved?: boolean;
        showAiDiff?: boolean;
        expectedContent?: string;
        expectedFileMissing?: boolean;
        fileDeleted?: boolean;
        conversationId?: string;
      }
    ) => { handled: boolean; conflict: boolean };
  };
  filePreview?: {
    handlePreviewResult: (payload: FilePreviewResultPayload) => void;
    setWorkspaceScope: (scope: WorkspaceFileCacheScope) => void;
  };
  fileExcerpt?: {
    handleExcerptResult: (payload: FileExcerptResultPayload) => void;
    setWorkspaceScope: (scope: WorkspaceFileCacheScope) => void;
  };
};

export const initBridgeHandlers = (deps: BridgeHandlersDeps) => {
  const { bridgeWindow } = deps;
  let externalWorkspaceRoot: string | null = null;
  let externalWorkspaceGeneration: number | undefined;

  bridgeWindow.tex64SetBuildState = (payload) => {
    updatePdfSourceState((payload as typeof payload & { pdfSourceState?: unknown }).pdfSourceState);
    if (payload.targetFile && !payload.requestId) deps.build.setBuildTarget?.(payload.targetFile);
    deps.build.setBuildState(payload.state, payload.message);
  };

  bridgeWindow.tex64UpdateIssues = (payload) => {
    const status = payload.status ?? (payload.count > 0 ? "error" : "success");
    deps.updateIssues(payload.count, payload.summary, status, payload.issues ?? []);
  };

  bridgeWindow.tex64UpdateWorkspace = (payload) => {
    updatePdfSourceState((payload as typeof payload & { pdfSourceState?: unknown }).pdfSourceState, true);
    externalWorkspaceRoot = payload.rootPath;
    externalWorkspaceGeneration = payload.workspaceGeneration;
    deps.filePreview?.setWorkspaceScope(payload);
    deps.fileExcerpt?.setWorkspaceScope(payload);
    deps.handleWorkspaceUpdate(payload);
  };

  bridgeWindow.tex64UpdateIndex = (payload) => {
    deps.handleIndexUpdate(payload);
  };

  bridgeWindow.tex64UpdateSearch = (payload) => {
    deps.search.handleSearchUpdate(payload);
  };

  bridgeWindow.tex64OpenFileResult = (payload) => {
    deps.editorSession.handleOpenFileResult(payload);
  };

  bridgeWindow.tex64SaveResult = (payload) => {
    deps.editorSession.handleSaveResult(payload);
  };

  bridgeWindow.tex64FormatResult = (payload) => {
    deps.build.handleFormatResult(payload);
  };

  bridgeWindow.tex64SynctexForwardResult = (payload) => {
    deps.build.handleSynctexForwardResult(payload);
  };

  bridgeWindow.tex64SynctexReverseResult = (payload) => {
    deps.build.handleSynctexReverseResult(payload);
  };

  bridgeWindow.tex64RenameResult = (payload) => {
    deps.editorSession.handleRenameResult(payload);
  };

  bridgeWindow.tex64AgentSettings = (payload) => {
    deps.agent?.handleSettings(payload.settings);
  };

  bridgeWindow.tex64AgentStatus = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleStatus(payload.state, payload.message, payload.conversationId);
  };

  bridgeWindow.tex64AgentMessage = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleMessage(payload.text, payload.conversationId);
  };

  bridgeWindow.tex64AgentMessageDelta = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleMessageDelta?.(payload.text, payload.conversationId);
  };

  bridgeWindow.tex64AgentTool = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleTool(payload);
  };

  bridgeWindow.tex64AgentProposal = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleProposal(payload.proposal);
  };

  bridgeWindow.tex64AgentApplyResult = (payload) => {
    deps.agent?.handleApplyResult(payload);
  };

  bridgeWindow.tex64AgentError = (payload) => {
    if (isAiModeAgentPayload(payload)) return;
    deps.agent?.handleError(payload.message, payload.conversationId);
  };

  const handleBridgeMessage = (message: { type?: string; payload?: unknown }) => {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case "setBuildState":
        bridgeWindow.tex64SetBuildState?.(message.payload as {
          state: BuildState;
          message?: string;
        });
        break;
      case "updateIssues":
        bridgeWindow.tex64UpdateIssues?.(message.payload as {
          count: number;
          summary: string;
          status?: IssuesStatus;
          issues?: IssueItem[];
        });
        break;
      case "updateWorkspace":
        bridgeWindow.tex64UpdateWorkspace?.(message.payload as {
          rootName: string;
          rootPath: string;
          files: string[];
          folders?: string[];
          rootFile?: string;
          rootSource?: RootSource;
          buildProfiles?: BuildProfile[];
          buildProfileId?: string;
          workspaceId?: string | null;
          workspaceGeneration?: number;
        });
        break;
      case "updateIndex":
        bridgeWindow.tex64UpdateIndex?.(message.payload as {
          labels: IndexEntry[];
          references?: IndexEntry[];
          citations: IndexEntry[];
          sections?: SectionEntry[];
          figures?: IndexEntry[];
          tables?: IndexEntry[];
          todos?: IndexEntry[];
        });
        break;
      case "updateSearch":
        bridgeWindow.tex64UpdateSearch?.(message.payload as {
          query: string;
          results: SearchResult[];
          message?: string;
          requestId?: number;
        });
        break;
      case "search:renameResult":
        deps.search.handleRenameResult?.(
          message.payload as {
            ok: boolean;
            from?: string;
            to?: string;
            fileCount?: number;
            appliedCount?: number;
            skippedCount?: number;
            error?: string;
            conversationId?: string;
          }
        );
        break;
      case "openFileResult":
        bridgeWindow.tex64OpenFileResult?.(message.payload as {
          path: string;
          content?: string;
          error?: string;
        });
        break;
      case "file:externalChange": {
        const change = message.payload as {
          root: string; workspaceGeneration?: number; path: string; content: string | null; fileDeleted?: boolean;
        };
        if (change.root === externalWorkspaceRoot && change.workspaceGeneration === externalWorkspaceGeneration) {
          deps.editorSession.handleExternalFileChange(change);
        }
        break;
      }
      case "saveResult":
        bridgeWindow.tex64SaveResult?.(message.payload as {
          path: string;
          ok: boolean;
          busy?: boolean;
          error?: string;
          content?: string;
          formatError?: string;
        });
        break;
      case "formatResult":
        bridgeWindow.tex64FormatResult?.(message.payload as {
          path: string;
          ok: boolean;
          content?: string;
          error?: string;
          source?: string;
          stale?: boolean;
        });
        break;
      case "buildLog":
        deps.build.handleBuildLog((message.payload as { log?: string | null })?.log ?? null);
        break;
      case "synctex:forwardResult":
        deps.build.handleSynctexForwardResult(message.payload as any);
        break;
      case "synctex:reverseResult": {
        const reverse = message.payload as { requestId?: string };
        if (typeof reverse?.requestId === "string" && reverse.requestId.startsWith("ask-axiom:")) {
          deps.agent?.handlePdfReverseResult?.(message.payload as never);
          break;
        }
        deps.build.handleSynctexReverseResult(message.payload as any);
        break;
      }
      case "pdf:askAxiom":
        deps.agent?.askFromPdf?.(
          message.payload as {
            page: number;
            x: number;
            y: number;
            text: string;
            pdfPath: string | null;
            source?: { file: string; line: number; column: number } | null;
          },
        );
        break;
      case "renameResult":
        bridgeWindow.tex64RenameResult?.(message.payload as {
          oldPath: string;
          newPath: string;
          isDirectory: boolean;
        });
        break;
      case "env:checkResult":
        deps.settings?.updateEnvStatus(
          (message.payload as { command?: string }).command ?? "",
          Boolean((message.payload as { available?: boolean }).available)
        );
        break;
      case "env:detectResult":
        deps.settings?.handleEnvDetectResult?.(
          message.payload as { report?: TexEnvReport | null; error?: string }
        );
        break;
      case "env:installStart":
        deps.settings?.handleEnvInstallStart?.(
          message.payload as { target?: string; variant?: string }
        );
        break;
      case "env:installResult":
        deps.settings?.handleEnvInstallResult?.(
          message.payload as { target?: string; success?: boolean; message?: string }
        );
        break;
      case "env:installProgress":
        deps.settings?.handleEnvInstallProgress?.(
          message.payload as {
            phase?: string;
            current?: number | null;
            total?: number | null;
            percent?: number | null;
          }
        );
        break;
      case "launcherStatus":
        deps.handleLauncherStatus(message.payload as { isBusy?: boolean; message?: string });
        break;
      case "recentProjects":
        deps.handleRecentProjects(
          (message.payload as { projects?: { path: string; name: string; openedAt: number }[] }).projects ?? []
        );
        break;
      case "agent:settings":
        deps.agent?.handleSettings(
          (message.payload as { settings: AgentSettings }).settings
        );
        break;
      case "agent:state":
        // AI mode shares the renderer-wide host bus, but its request-correlated
        // state belongs only to the embedded document workspace. Passing it to
        // Code would replace Code's chat list with the AI document thread.
        if (!isAiModeAgentPayload(message.payload)) {
          deps.agent?.handleState?.(message.payload as AgentUiState);
        }
        break;
      case "settings:request": {
        const payload = message.payload as {
          requestId?: string;
          action?: "get" | "set";
          keys?: string[];
          settings?: Partial<AppSettingsSnapshot>;
        };
        const requestId = payload?.requestId;
        if (!requestId) {
          break;
        }
        let snapshot: AppSettingsSnapshot | null = null;
        let ok = false;
        if (payload?.action === "set") {
          snapshot = deps.settings?.applySettingsPatch?.(payload.settings ?? {}) ?? null;
          ok = Boolean(snapshot);
        } else {
          snapshot = deps.settings?.getSettingsSnapshot?.() ?? null;
          ok = Boolean(snapshot);
        }
        const keys = Array.isArray(payload?.keys) ? payload.keys : [];
        let settings = snapshot;
        if (snapshot && keys.length > 0) {
          const filtered = {};
          const snapshotRecord = snapshot as Record<string, unknown>;
          keys.forEach((key) => {
            if (key in snapshotRecord) {
              filtered[key] = snapshotRecord[key];
            }
          });
          settings = filtered as AppSettingsSnapshot;
        }
        deps.postToNative(
          {
            type: "settings:response",
            requestId,
            ok,
            settings,
            error: ok ? undefined : uiText("Settings could not be retrieved.", "設定が取得できませんでした。"),
          },
          true
        );
        break;
      }
      case "agent:status":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleStatus(
          (message.payload as {
            state: AgentStatusState;
            message?: string;
            conversationId?: string;
          }).state,
          (message.payload as {
            state: AgentStatusState;
            message?: string;
            conversationId?: string;
          }).message,
          (message.payload as {
            state: AgentStatusState;
            message?: string;
            conversationId?: string;
          }).conversationId
        );
        break;
      case "agent:requestRejected":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleRequestRejected?.(
          message.payload as { conversationId?: string; message?: string },
        );
        break;
      case "agent:message": {
        if (isAiModeAgentPayload(message.payload)) break;
        const reply = message.payload as {
          text?: string;
          conversationId?: string;
          proposals?: unknown;
          question?: unknown;
          plan?: unknown;
        };
        deps.agent?.handleMessage(reply.text ?? "", reply.conversationId, {
          proposals: Array.isArray(reply.proposals) ? (reply.proposals as never) : undefined,
          question: reply.question && typeof reply.question === "object" ? (reply.question as never) : undefined,
          plan: reply.plan && typeof reply.plan === "object" ? (reply.plan as never) : undefined,
        });
        break;
      }
      case "agent:messageReset":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleMessageReset?.(message.payload as { conversationId?: string });
        break;
      case "agent:title":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleTitle?.(message.payload as { conversationId?: string; title?: string });
        break;
      case "agent:feedbackResult":
        deps.agent?.handleFeedbackResult?.(
          message.payload as { conversationId?: string; assistantIndex?: number; rating?: "up" | "down"; ok?: boolean; error?: string },
        );
        break;
      case "agent:branchResult":
        deps.agent?.handleBranchResult?.(message.payload as { ok?: boolean; conversationId?: string; error?: string });
        break;
      case "agent:proposalScope":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleProposalScope?.(message.payload as { conversationId?: string; proposalId?: string; page?: number });
        break;
      case "agent:transcribeResult":
        deps.agent?.handleTranscribeResult?.(message.payload as { requestId?: string; ok?: boolean; text?: string; error?: string });
        break;
      case "agent:documentMap":
        deps.agent?.handleDocumentMap?.(message.payload as Parameters<NonNullable<typeof deps.agent>["handleDocumentMap"]>[0]);
        break;
      case "agent:messageDelta":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleMessageDelta?.(
          (message.payload as { text?: string; conversationId?: string }).text ?? "",
          (message.payload as { text?: string; conversationId?: string }).conversationId
        );
        break;
      case "agent:tool":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleTool(
          message.payload as {
            name: string;
            label?: string;
            detail?: string;
            summary?: string;
            conversationId?: string;
          }
        );
        break;
      case "agent:proposal":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleProposal(
          (message.payload as { proposal: AgentProposal }).proposal
        );
        break;
      case "agent:applyResult":
        deps.agent?.handleApplyResult(
          message.payload as {
            proposalId: string;
            ok: boolean;
            error?: string;
            conflict?: boolean;
          }
        );
        break;
      case "agent:undoResult":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleUndoResult(
          message.payload as {
            ok: boolean;
            message?: string;
            path?: string;
            conversationId?: string;
          }
        );
        break;
      case "agent:undoAvailability":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleUndoAvailability?.(
          message.payload as {
            conversationId?: string;
            available?: boolean;
            count?: number;
          }
        );
        break;
      case "agent:scratchpad":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleScratchpad?.(
          message.payload as { content: string; conversationId?: string }
        );
        break;
      case "agent:thought":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleThought?.(
          message.payload as { text: string; conversationId?: string }
        );
        break;
      case "agent:error":
        if (isAiModeAgentPayload(message.payload)) break;
        deps.agent?.handleError(
          (message.payload as { message?: string; conversationId?: string }).message ??
            uiText("Axiom error", "Axiom エラー"),
          (message.payload as { message?: string; conversationId?: string }).conversationId
        );
        break;
      case "api:usage":
        deps.api?.handleUsage(
          message.payload as { snapshot?: ApiUsageSnapshot }
        );
        break;
      case "platform:auth":
        deps.platform?.handleAuth(
          message.payload as {
            auth: PlatformAuthSnapshot;
            error?: { code?: string; message?: string };
          }
        );
        break;
      case "platform:aiAccess":
        deps.platform?.handleAiAccess(
          message.payload as { source?: string; access: PlatformAiAccessSnapshot }
        );
        break;
      case "platform:usage":
        deps.platform?.handleUsage(
          message.payload as { source?: string; usage: PlatformUsageSnapshot }
        );
        break;
      case "platform:update":
        deps.platform?.handleUpdate(
          message.payload as {
            source?: string;
            update: PlatformUpdateSnapshot | null;
            error?: { code?: string; message?: string };
          }
        );
        break;
      case "platform:updateStatus":
        deps.platform?.handleUpdateStatus(
          message.payload as {
            source?: string;
            status: PlatformUpdateStatusSnapshot;
          }
        );
        break;
      case "platform:feedback":
        deps.platform?.handleFeedback(
          message.payload as {
            ok: boolean;
            feedbackId?: string | null;
            error?: { code?: string; message?: string };
          }
        );
        break;
      case "platform:announcements":
        deps.platform?.handleAnnouncements?.(
          message.payload as {
            announcements: AnnouncementSnapshot[];
            fetchedAt?: number;
          }
        );
        break;
      case "billing:checkoutClosed":
        deps.billing?.handleCheckoutClosed(
          message.payload as {
            plan?: string;
            outcome?: "success" | "cancel" | "closed" | "error";
          }
        );
        break;
      case "app:command":
        deps.app?.handleCommand(
          (message.payload as { command?: string }).command ?? ""
        );
        break;
      case "file:previewResult":
        deps.filePreview?.handlePreviewResult(message.payload as FilePreviewResultPayload);
        break;
      case "file:excerptResult":
        deps.fileExcerpt?.handleExcerptResult(message.payload as FileExcerptResultPayload);
        break;
      case "agent:applyContent":
        {
          const applyPayload = message.payload as {
            path?: string;
            content?: string;
            expectedContent?: string;
            expectedFileMissing?: boolean;
            fileDeleted?: boolean;
            updateSaved?: boolean;
            source?: string;
            showAiDiff?: boolean;
            conversationId?: string;
          };
        const applyResult = deps.editorSession.applyContentToOpenFile(
          applyPayload.path ?? "",
          applyPayload.content ?? "",
          {
            updateSaved: applyPayload.updateSaved === true,
            ...(typeof applyPayload.expectedContent === "string"
              ? { expectedContent: applyPayload.expectedContent }
              : {}),
            expectedFileMissing: applyPayload.expectedFileMissing === true,
            fileDeleted: applyPayload.fileDeleted === true,
            ...(typeof applyPayload.conversationId === "string"
              ? { conversationId: applyPayload.conversationId }
              : {}),
            showAiDiff:
              applyPayload.showAiDiff === true ||
              (applyPayload.showAiDiff !== false && applyPayload.source !== "ai-direct-edit"),
          }
        );
        if (
          applyResult.conflict &&
          typeof applyPayload.conversationId === "string" &&
          applyPayload.conversationId.trim()
        ) {
          deps.postToNative({
            type: "agent:contentConflict",
            conversationId: applyPayload.conversationId,
            path: applyPayload.path ?? "",
          });
        }
        }
        break;
      default:
        break;
    }
  };

  if (bridgeWindow.tex64Bridge?.onMessage) {
    bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
  }
};
