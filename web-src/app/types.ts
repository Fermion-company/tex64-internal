export type CreateKind = "file" | "folder";
export type DragPayload = { path: string; kind: "file" | "dir" };

export type BuildState = "idle" | "building" | "success" | "failed";
export type IssuesStatus = "success" | "error" | "info";
export type IssueItem = {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
  path?: string;
};
export type IndexEntry = { key: string; path: string; line: number };
export type SectionEntry = { title: string; path: string; line: number; level: number };
export type BlockType = "math" | "table";
export type BlockMode = "insert" | "edit";
export type MathKeyboardTab = "analysis" | "algebra" | "sets" | "logic" | "arrows" | "greek";
export type BlockContent = { formula?: string; rows?: number; cols?: number; raw?: string };
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
export type SearchResult = { path: string; line: number; preview: string };
export type GitEntry = { status: string; path: string; staged?: boolean };
export type GitHistoryEntry = {
  hash: string;
  shortHash: string;
  date: string;
  message: string;
};
export type GitRepoState = { ok: boolean; reason?: string };
export type GitRemoteState = { exists: boolean; name?: string; url?: string | null };
export type GitBranchState = {
  name?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  detached?: boolean;
};
export type GitStatusPayload = {
  entries: GitEntry[];
  message?: string;
  repo?: GitRepoState;
  remote?: GitRemoteState;
  branch?: GitBranchState;
  history?: GitHistoryEntry[];
  historyMessage?: string;
};
export type GitDiffPayload = {
  ok: boolean;
  mode: "commit" | "restore";
  hash?: string;
  patch?: string;
  message?: string | null;
};
export type GitActionResultPayload = {
  action: "init" | "commit" | "remote" | "pull" | "push" | "restore";
  ok: boolean;
  status?: "success" | "info" | "error";
  message?: string | null;
  hint?: string | null;
};
export type FileNode = { name: string; path: string; type: "file" | "dir"; children: FileNode[] };
export type RootSource = "auto" | "manual";
export type LauncherTemplate = "paper" | "lecture";
export type AgentStatusState = "idle" | "running" | "error";
export type AgentSettings = {
  apiKey: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
};
export type AgentProposal = {
  id: string;
  path: string;
  content: string;
  originalContent?: string;
  summary?: string;
  isNewFile?: boolean;
  conversationId?: string;
};

export type EditorFormatIndentStyle = "spaces-2" | "spaces-4" | "tab";
export type EditorFormatBlankLines = "preserve" | "condense" | "remove";
export type EditorFormatSettings = {
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
export type CaptureBridge = {
  listSources?: (options?: {
    thumbnailSize?: { width: number; height: number };
  }) => Promise<CaptureSource[]>;
};
export type MathOcrBridge = {
  run?: (payload: { data: ArrayBuffer; width: number; height: number }) => Promise<{
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
    tex64UpdateSearch?: (payload: { query: string; results: SearchResult[]; message?: string }) => void;
    tex64UpdateGit?: (payload: GitStatusPayload) => void;
    tex64UpdateGitDiff?: (payload: GitDiffPayload) => void;
    tex64UpdateGitActionResult?: (payload: GitActionResultPayload) => void;
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
