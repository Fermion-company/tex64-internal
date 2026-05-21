import type { LspBridge } from "./lsp/lsp-client.js";

export type SpellBridge = {
  check: (words: string[]) => Promise<string[]>;
  suggest: (word: string) => Promise<string[]>;
  add: (word: string) => Promise<boolean>;
};

export type CreateKind = "file" | "folder";
export type DragPayload = { path: string; kind: "file" | "dir" };

export type BuildState = "idle" | "building" | "success" | "failed";
export type IssuesStatus = "success" | "error" | "info";
export type IssueAction = "open-runtime";
export type IssueItem = {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
  path?: string;
  action?: IssueAction;
};
export type IndexEntry = { key: string; path: string; line: number };
export type SectionEntry = { title: string; path: string; line: number; level: number };
export type BlockType = "math";
export type BlockMode = "insert" | "edit";
export type MathKeyboardTab = "analysis" | "algebra" | "sets" | "logic" | "arrows" | "greek";
export type BlockContent = { formula?: string };
export type BlockEditMode = "none" | "detected";
export type BlockApplyMode = "detected" | "new";
export type MathKey = {
  label: string;
  latex: string;
  fallback?: string;
  shiftLabel?: string;
  shiftLatex?: string;
  shiftFallback?: string;
  displayLatex?: string;
  shiftDisplayLatex?: string;
  hint?: string;
  scriptKind?: "sub" | "sup" | "subsup";
  scriptValue?: string | null;
  shiftScriptKind?: "sub" | "sup" | "subsup";
  shiftScriptValue?: string | null;
  scriptBase?: string;
  scriptSubValue?: string | null;
  scriptSupValue?: string | null;
  shiftScriptBase?: string;
  shiftScriptSubValue?: string | null;
  shiftScriptSupValue?: string | null;
  templateKind?: "wrap" | "after";
  templateTarget?: number;
  templateSeparator?: string;
  templateScope?: "selection-or-atom" | "selection";
  shiftTemplateKind?: "wrap" | "after";
  shiftTemplateTarget?: number;
  shiftTemplateSeparator?: string;
  shiftTemplateScope?: "selection-or-atom" | "selection";
};
export type SearchResult = {
  path: string;
  line: number;
  preview: string;
  matchStart?: number;
  matchLength?: number;
};
export type FileNode = { name: string; path: string; type: "file" | "dir"; children: FileNode[] };
export type RootSource = "auto" | "manual";
export type BuildProfile = {
  id: string;
  name: string;
  outDir?: string | null;
  extraArgs?: string | null;
};

export type AgentStatusState = "idle" | "running" | "error" | "resumable";
export type AgentSettings = {
  apiKey?: string;
  endpoint?: string;
  model?: string;

  temperature: number;
  maxIterations?: number;
  stream?: boolean;
  autoApply?: boolean;
  autoBuild?: boolean;
  allowRunCommand?: boolean;
  maxFileBytes?: number;
  maxReadFiles?: number;
  openFileMaxBytes?: number;
  openFileMaxChars?: number;
  maxConversationMessages?: number;
  maxConversationChars?: number;
  allowedTopLevel?: string[];
  blockedTopLevel?: string[];
  textExtensions?: string[];
  extraTextExtensions?: string[];
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
};

export type ApiUsageSnapshot = {
  currency: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  totalCostUsd: number;
  formattedTotalCostUsd?: string;
  lastUpdatedAt?: number | null;
  pricing?: { inputPerMillion: number; outputPerMillion: number; currency?: string };
  byModel?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      totalCostUsd: number;
      totalRequests: number;
      lastSource?: string | null;
    }
  >;
};

export type PlatformQuotaSummary = {
  limitTokens: number;
  usedTokens: number;
  remainingTokens: number;
  usedRequests: number;
  remainingRequests: number;
  periodStart?: string | null;
  periodEnd?: string | null;
};

export type PlatformAuthSnapshot = {
  authenticated: boolean;
  pending?: boolean;
  user?: { id?: string | null; email?: string | null; name?: string | null } | null;
  plan?: string | null;
  pricingUrl?: string;
};

export type PlatformAiAccessSnapshot = {
  authenticated: boolean;
  allowed: boolean;
  reason?: string | null;
  status?: string | null;
  plan?: string | null;
  user?: { id?: string | null; email?: string | null; name?: string | null } | null;
  quota?: PlatformQuotaSummary | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  graceEndsAt?: string | null;
  message?: string | null;
  pricingUrl?: string;
  fetchedAt?: number;
};

export type PlatformUsageSnapshot = {
  authenticated: boolean;
  plan?: string | null;
  period?: string | null;
  summary?: PlatformQuotaSummary | null;
  byFeature?: Record<string, { usedTokens?: number; usedRequests?: number }> | null;
  errorCode?: string | null;
  message?: string | null;
  fetchedAt?: number;
};

export type LocalizedText =
  | string
  | {
      en?: string;
      ja?: string;
      zh?: string;
      ko?: string;
      fr?: string;
      de?: string;
      es?: string;
    }
  | null;

export type AnnouncementSnapshot = {
  id: string;
  kind: "info" | "feedback";
  title: LocalizedText;
  body: LocalizedText;
  url?: string | null;
  urlLabel?: LocalizedText;
  publishedAt?: string | null;
  expiresAt?: string | null;
};

export type PlatformUpdateSnapshot = {
  platform?: string | null;
  arch?: string | null;
  channel?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  hasUpdate?: boolean;
  required?: boolean;
  notesUrl?: string | null;
  artifactUrl?: string | null;
  artifactSha256?: string | null;
  sha256?: string | null;
  checksum?: string | null;
  signature?: string | null;
  checkedAt?: number;
};
export type PlatformUpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";
export type PlatformUpdateStatusSnapshot = {
  phase: PlatformUpdatePhase;
  mode?: string | null;
  message?: string | null;
  progressPercent?: number | null;
  transferredBytes?: number | null;
  totalBytes?: number | null;
  downloadedPath?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  checkedAt?: number | null;
  updatedAt?: number;
  error?: { code?: string | null; message?: string | null } | null;
};
export type AppSettingsSnapshot = {
  compileEngine: string;
  wordWrapEnabled: boolean;
  autoSynctexOnBuild: boolean;
  reverseSynctexEnabled: boolean;
  pdfViewerMode: "window" | "tab";
  alignEnv: boolean;
  formatSettings: EditorFormatSettings;
};
export type AgentProposal = {
  id: string;
  type?: "write" | "patch" | "delete" | "rename" | "mkdir";
  path: string;
  oldPath?: string;
  content: string;
  originalContent?: string;
  encoding?: "utf8" | "base64";
  isBinary?: boolean;
  summary?: string;
  isNewFile?: boolean;
  conversationId?: string;
  workspaceRootPath?: string;
  baseContentHash?: string;
  baseExists?: boolean;
  baseSource?: "disk" | "snapshot";
  createdAt?: number;
};

export type AgentUiSession = {
  conversationId: string;
  title: string;
  workspaceRootPath?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  status?: { state: AgentStatusState; message?: string; undoAvailable?: boolean; undoCount?: number };
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  proposals: AgentProposal[];
};

export type AgentUiState = {
  sessions: AgentUiSession[];
};

export type EditorFormatIndentStyle = "spaces-2" | "spaces-4" | "tab";
export type EditorFormatBlankLines = "preserve" | "condense" | "remove";
export type EditorFormatSettings = {
  enabled: boolean;
  indentStyle: EditorFormatIndentStyle;
  beginEndOnOwnLine: boolean;
  documentNoIndent: boolean;
  alignMathDelims: boolean;
  alignTableDelims: boolean;
  blankLines: EditorFormatBlankLines;
  customVerbatim: string[];
};
export type EditorFormatAlignEnvs = {
  math: string[];
  table: string[];
};
export type FormatSettingsPayload = EditorFormatSettings & {
  alignEnvs: EditorFormatAlignEnvs;
};

export type WebkitHandler = { postMessage: (message: unknown) => void };
export type WebkitBridge = { messageHandlers?: { tex64?: WebkitHandler } };
export type ElectronBridge = {
  postMessage: (message: unknown) => void;
  onMessage?: (handler: (message: { type: string; payload?: unknown }) => void) => void;
};
export type CaptureSource = {
  id: string;
  title: string;
  app?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
};
export type CapturePermissionStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";
export type CaptureBridge = {
  listSources?: (options?: {
    thumbnailSize?: { width: number; height: number };
  }) => Promise<CaptureSource[]>;
  captureHighRes?: (sourceId: string) => Promise<{
    thumbnailUrl: string;
    width: number;
    height: number;
  } | null>;
  checkPermission?: () => Promise<CapturePermissionStatus>;
  openPermissionSettings?: () => Promise<boolean>;
};
export type MathOcrBridge = {
  run?: (payload: {
    data: ArrayBuffer;
    width: number;
    height: number;
    imageDataUrl?: string;
    fallbackImageDataUrls?: string[];
    maxSeqLen?: number;
    maxDecodeCandidates?: number;
  }) => Promise<{
    latex?: string;
    error?: string;
  }>;
};
export type BridgeWindow = Window &
  typeof globalThis & {
    webkit?: WebkitBridge;
    tex64Bridge?: ElectronBridge;
    tex64Capture?: CaptureBridge;
    tex64MathOcr?: MathOcrBridge;
    tex64Lsp?: LspBridge;
    tex64Spell?: SpellBridge;
    __tex64TestCaptureApi?: CaptureBridge;
    __tex64TestMathOcr?: MathOcrBridge;
    __tex64TestRecognizeMath?: (imageDataUrl: string) => Promise<string>;
    tex64SetBuildState?: (payload: { state: BuildState; message?: string }) => void;
    tex64UpdateIssues?: (payload: {
      count: number;
      summary: string;
      status?: IssuesStatus;
      issues?: IssueItem[];
    }) => void;
    tex64UpdateWorkspace?: (payload: {
      rootName: string;
      rootPath: string;
      files: string[];
      folders?: string[];
      rootFile?: string;
      rootSource?: RootSource;
    }) => void;
    tex64UpdateIndex?: (payload: {
      labels: IndexEntry[];
      references?: IndexEntry[];
      citations: IndexEntry[];
      sections?: SectionEntry[];
      figures?: IndexEntry[];
      tables?: IndexEntry[];
      todos?: IndexEntry[];
    }) => void;
    tex64UpdateSearch?: (payload: {
      query: string;
      results: SearchResult[];
      message?: string;
      requestId?: number;
    }) => void;
    tex64OpenFileResult?: (payload: { path: string; content?: string; error?: string }) => void;
    tex64SaveResult?: (payload: {
      path: string;
      ok: boolean;
      error?: string;
      content?: string;
      formatError?: string;
    }) => void;
    tex64FormatResult?: (payload: {
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
    }) => void;
    tex64SynctexForwardResult?: (payload: {
      ok?: boolean;
      error?: string;
      page?: number;
      x?: number;
      y?: number;
      pdfPath?: string | null;
    }) => void;
    tex64SynctexReverseResult?: (payload: {
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
    tex64RenameResult?: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
    tex64AgentSettings?: (payload: { settings: AgentSettings }) => void;
    tex64AgentStatus?: (payload: {
      state: AgentStatusState;
      message?: string;
      conversationId?: string;
    }) => void;
    tex64AgentMessage?: (payload: { text: string; conversationId?: string }) => void;
    tex64AgentMessageDelta?: (payload: { text: string; conversationId?: string }) => void;
    tex64AgentTool?: (payload: {
      name: string;
      summary?: string;
      conversationId?: string;
    }) => void;
    tex64AgentProposal?: (payload: { proposal: AgentProposal }) => void;
    tex64AgentApplyResult?: (payload: {
      proposalId: string;
      ok: boolean;
      error?: string;
    }) => void;
    tex64AgentError?: (payload: { message: string; conversationId?: string }) => void;
  };
