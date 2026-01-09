import type {
  BuildState,
  BridgeWindow,
  GitActionResultPayload,
  GitDiffPayload,
  GitStatusPayload,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  RootSource,
  SearchResult,
  SectionEntry,
} from "./types.js";
import type { AlchemySettings } from "./alchemy-preview-ui.js";

type BridgeHandlersDeps = {
  bridgeWindow: BridgeWindow;
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
  search: {
    handleSearchUpdate: (payload: {
      query: string;
      results?: SearchResult[];
      message?: string;
    }) => void;
  };
  git: {
    handleUpdate: (payload: GitStatusPayload) => void;
    handleDiff: (payload: GitDiffPayload) => void;
    handleActionResult: (payload: GitActionResultPayload) => void;
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
    handleSynctexForwardResult: (payload: { ok?: boolean; error?: string }) => void;
  };
  alchemy?: {
    handleSettings: (payload: { settings: AlchemySettings }) => void;
    handleClipboardPayload?: (payload: {
      requestId?: string;
      formats?: string[];
      text?: string;
      html?: string;
      imageDataUrl?: string;
      pdfBase64?: string;
    }) => void;
    handleImageSaved?: (payload: {
      requestId?: string;
      ok?: boolean;
      path?: string;
      error?: string;
    }) => void;
  };
  capture?: {
    openCapture: () => void;
  };
  settings?: {
    updateEnvStatus: (command: string, available: boolean) => void;
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

  bridgeWindow.tex64UpdateGit = (payload) => {
    deps.git.handleUpdate(payload);
  };

  bridgeWindow.tex64UpdateGitDiff = (payload) => {
    deps.git.handleDiff(payload);
  };

  bridgeWindow.tex64UpdateGitActionResult = (payload) => {
    deps.git.handleActionResult(payload);
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

  bridgeWindow.tex64RenameResult = (payload) => {
    deps.editorSession.handleRenameResult(payload);
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
        });
        break;
      case "updateGit":
        bridgeWindow.tex64UpdateGit?.(message.payload as GitStatusPayload);
        break;
      case "updateGitDiff":
        bridgeWindow.tex64UpdateGitDiff?.(message.payload as GitDiffPayload);
        break;
      case "gitActionResult":
        bridgeWindow.tex64UpdateGitActionResult?.(
          message.payload as GitActionResultPayload
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
        deps.build.handleSynctexForwardResult(
          message.payload as { ok?: boolean; error?: string }
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
      case "launcherStatus":
        deps.handleLauncherStatus(message.payload as { isBusy?: boolean; message?: string });
        break;
      case "alchemy:settings":
        deps.alchemy?.handleSettings(
          message.payload as { settings: AlchemySettings }
        );
        break;
      case "alchemy:clipboard":
        deps.alchemy?.handleClipboardPayload?.(message.payload as {
          requestId?: string;
          formats?: string[];
          text?: string;
          html?: string;
          imageDataUrl?: string;
          pdfBase64?: string;
        });
        break;
      case "alchemy:image-saved":
        deps.alchemy?.handleImageSaved?.(message.payload as {
          requestId?: string;
          ok?: boolean;
          path?: string;
          error?: string;
        });
        break;
      case "capture:open":
        deps.capture?.openCapture();
        break;
      default:
        break;
    }
  };

  if (bridgeWindow.tex64Bridge?.onMessage) {
    bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
  }
};
