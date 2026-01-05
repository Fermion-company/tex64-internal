export type CreateKind = "file" | "folder";
export type DragPayload = { path: string; kind: "file" | "dir" };

export type BuildState = "idle" | "building" | "success" | "failed";
export type IssuesStatus = "success" | "error" | "info";
export type IssueItem = { severity: "error" | "warning"; message: string; line?: number };
export type IndexEntry = { key: string; path: string; line: number };
export type SectionEntry = { title: string; path: string; line: number; level: number };
export type BlockType = "math" | "table";
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
};
export type SearchResult = { path: string; line: number; preview: string };
export type GitEntry = { status: string; path: string };
export type FileNode = { name: string; path: string; type: "file" | "dir"; children: FileNode[] };
export type RootSource = "auto" | "manual";
export type LauncherTemplate = "paper" | "lecture";

export type WebkitHandler = { postMessage: (message: unknown) => void };
export type WebkitBridge = { messageHandlers?: { tex180?: WebkitHandler } };
export type ElectronBridge = {
  postMessage: (message: unknown) => void;
  onMessage?: (handler: (message: { type: string; payload?: unknown }) => void) => void;
};
export type BridgeWindow = Window &
  typeof globalThis & {
    webkit?: WebkitBridge;
    tex180Bridge?: ElectronBridge;
    tex180SetBuildState?: (payload: { state: BuildState; message?: string }) => void;
    tex180UpdateIssues?: (payload: {
      count: number;
      summary: string;
      status?: IssuesStatus;
      issues?: IssueItem[];
    }) => void;
    tex180UpdateWorkspace?: (payload: {
      rootName: string;
      rootPath: string;
      files: string[];
      folders?: string[];
      rootFile?: string;
      rootSource?: RootSource;
    }) => void;
    tex180UpdateIndex?: (payload: {
      labels: IndexEntry[];
      references?: IndexEntry[];
      citations: IndexEntry[];
      sections?: SectionEntry[];
      figures?: IndexEntry[];
      tables?: IndexEntry[];
      todos?: IndexEntry[];
    }) => void;
    tex180UpdateSearch?: (payload: { query: string; results: SearchResult[]; message?: string }) => void;
    tex180UpdateGit?: (payload: { entries: GitEntry[]; message?: string }) => void;
    tex180OpenFileResult?: (payload: { path: string; content?: string; error?: string }) => void;
    tex180SaveResult?: (payload: {
      path: string;
      ok: boolean;
      error?: string;
      content?: string;
      formatError?: string;
    }) => void;
    tex180FormatResult?: (payload: {
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
    }) => void;
    tex180RenameResult?: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
  };
