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
  ApiCompletionResultPayload,
  ApiUsageSnapshot,
  PlatformAuthSnapshot,
  PlatformAiAccessSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
  PlatformUpdateStatusSnapshot,
  BuildProfile,
} from "./types.js";
import type { FilePreviewResultPayload } from "./file-preview.js";
import type { FileExcerptResultPayload } from "./file-excerpt.js";

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
    rootPath: string;
    files: string[];
    folders?: string[];
    rootFile?: string;
    rootSource?: RootSource;
    buildProfiles?: BuildProfile[];
    buildProfileId?: string;
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
    handleFormatResult: (payload: {
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
    }) => void;
    handleBuildLog: (log: string | null) => void;
    handleSynctexForwardResult: (payload: {
      ok?: boolean;
      error?: string;
      page?: number;
      x?: number;
      y?: number;
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
    handleEnvInstallStart?: (payload: { target?: string }) => void;
    handleEnvInstallResult?: (payload: {
      target?: string;
      success?: boolean;
      message?: string;
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
    handleMessage: (text: string, conversationId?: string) => void;
    handleMessageDelta?: (text: string, conversationId?: string) => void;
    handleTool: (payload: {
      name: string;
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
  };
  api?: {
    handleCompletionResult: (payload: ApiCompletionResultPayload) => void;
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
  };
  editorSession: {
    handleOpenFileResult: (payload: {
      path: string;
      content?: string;
      error?: string;
      kind?: "text" | "image" | "pdf" | "unsupported";
      data?: string;
      mimeType?: string;
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
      options?: { updateSaved?: boolean }
    ) => void;
  };
  filePreview?: {
    handlePreviewResult: (payload: FilePreviewResultPayload) => void;
  };
  fileExcerpt?: {
    handleExcerptResult: (payload: FileExcerptResultPayload) => void;
  };
};

export const initBridgeHandlers = (deps: BridgeHandlersDeps) => {
  const { bridgeWindow } = deps;

  bridgeWindow.tex64SetBuildState = (payload) => {
    deps.build.setBuildState(payload.state, payload.message);
  };

  bridgeWindow.tex64UpdateIssues = (payload) => {
    const status = payload.status ?? (payload.count > 0 ? "error" : "success");
    deps.updateIssues(payload.count, payload.summary, status, payload.issues ?? []);
  };

  bridgeWindow.tex64UpdateWorkspace = (payload) => {
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
    deps.agent?.handleStatus(payload.state, payload.message, payload.conversationId);
  };

  bridgeWindow.tex64AgentMessage = (payload) => {
    deps.agent?.handleMessage(payload.text, payload.conversationId);
  };

  bridgeWindow.tex64AgentMessageDelta = (payload) => {
    deps.agent?.handleMessageDelta?.(payload.text, payload.conversationId);
  };

  bridgeWindow.tex64AgentTool = (payload) => {
    deps.agent?.handleTool(payload);
  };

  bridgeWindow.tex64AgentProposal = (payload) => {
    deps.agent?.handleProposal(payload.proposal);
  };

  bridgeWindow.tex64AgentApplyResult = (payload) => {
    deps.agent?.handleApplyResult(payload);
  };

  bridgeWindow.tex64AgentError = (payload) => {
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
      case "saveResult":
        bridgeWindow.tex64SaveResult?.(message.payload as {
          path: string;
          ok: boolean;
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
        });
        break;
      case "buildLog":
        deps.build.handleBuildLog((message.payload as { log?: string | null })?.log ?? null);
        break;
      case "synctex:forwardResult":
        deps.build.handleSynctexForwardResult(message.payload as any);
        break;
      case "synctex:reverseResult":
        deps.build.handleSynctexReverseResult(message.payload as any);
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
      case "env:installStart":
        deps.settings?.handleEnvInstallStart?.(
          message.payload as { target?: string }
        );
        break;
      case "env:installResult":
        deps.settings?.handleEnvInstallResult?.(
          message.payload as { target?: string; success?: boolean; message?: string }
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
        deps.agent?.handleState?.(message.payload as AgentUiState);
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
            error: ok ? undefined : "設定が取得できませんでした。",
          },
          true
        );
        break;
      }
      case "agent:status":
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
      case "agent:message":
        deps.agent?.handleMessage(
          (message.payload as { text?: string; conversationId?: string }).text ?? "",
          (message.payload as { text?: string; conversationId?: string }).conversationId
        );
        break;
      case "agent:messageDelta":
        deps.agent?.handleMessageDelta?.(
          (message.payload as { text?: string; conversationId?: string }).text ?? "",
          (message.payload as { text?: string; conversationId?: string }).conversationId
        );
        break;
      case "agent:tool":
        deps.agent?.handleTool(
          message.payload as { name: string; label?: string; summary?: string; conversationId?: string }
        );
        break;
      case "agent:proposal":
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
        deps.agent?.handleUndoAvailability?.(
          message.payload as {
            conversationId?: string;
            available?: boolean;
            count?: number;
          }
        );
        break;
      case "agent:scratchpad":
        deps.agent?.handleScratchpad?.(
          message.payload as { content: string; conversationId?: string }
        );
        break;
      case "agent:thought":
        deps.agent?.handleThought?.(
          message.payload as { text: string; conversationId?: string }
        );
        break;
      case "agent:error":
        deps.agent?.handleError(
          (message.payload as { message?: string; conversationId?: string }).message ??
            "Axiom エラー",
          (message.payload as { message?: string; conversationId?: string }).conversationId
        );
        break;
      case "api:completionResult":
        deps.api?.handleCompletionResult(
          message.payload as ApiCompletionResultPayload
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
      case "file:previewResult":
        deps.filePreview?.handlePreviewResult(message.payload as FilePreviewResultPayload);
        break;
      case "file:excerptResult":
        deps.fileExcerpt?.handleExcerptResult(message.payload as FileExcerptResultPayload);
        break;
      case "agent:applyContent":
        deps.editorSession.applyContentToOpenFile(
          (message.payload as { path?: string; content?: string }).path ?? "",
          (message.payload as { path?: string; content?: string }).content ?? "",
          (message.payload as { updateSaved?: boolean }).updateSaved !== false
            ? { updateSaved: true }
            : undefined
        );
        break;
      default:
        break;
    }
  };

  if (bridgeWindow.tex64Bridge?.onMessage) {
    bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
  }
};
