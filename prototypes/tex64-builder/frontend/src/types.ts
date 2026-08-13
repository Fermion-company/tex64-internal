export interface AbstractBlock {
  id: string;
  type: 'abstract';
  html: string;
}
export interface HeadingBlock {
  id: string;
  type: 'heading';
  html: string;
}
export interface ParagraphBlock {
  id: string;
  type: 'paragraph';
  html: string;
}
export interface EquationBlock {
  id: string;
  type: 'equation';
  latex: string;
}
export interface FigureBlock {
  id: string;
  type: 'figure';
  src: string | null;
  caption: string;
}
export interface ReferencesBlock {
  id: string;
  type: 'references';
  items: string[];
}

export type Block =
  | AbstractBlock
  | HeadingBlock
  | ParagraphBlock
  | EquationBlock
  | FigureBlock
  | ReferencesBlock;

export interface DocumentModel {
  title: string;
  meta: string;
  blocks: Block[];
}

export interface SuggestionItem {
  title: string;
  desc: string;
}

export type ChatMessage =
  | { id: string; kind: 'user'; text: string; time: string }
  | { id: string; kind: 'assistant'; html: string; time?: string }
  | { id: string; kind: 'status'; label: string; file: string; done: boolean }
  | { id: string; kind: 'suggestions'; title: string; items: SuggestionItem[] };

export interface BuildState {
  phase: 'idle' | 'building' | 'ready';
  progress: number;
}

export type Mode = 'edit' | 'discuss';
export type ViewMode = 'preview' | 'outline';
export type PaperView = 'pdf' | 'edit';

export interface EqModalState {
  targetId: string | null;
  initialLatex: string;
}

export interface CompileState {
  status: 'idle' | 'compiling';
  pdfUrl: string | null;
}

export interface AppState {
  project: { title: string; workspace: string };
  doc: DocumentModel;
  past: DocumentModel[];
  future: DocumentModel[];
  chat: ChatMessage[];
  build: BuildState;
  mode: Mode;
  view: ViewMode;
  paperView: PaperView;
  compile: CompileState;
  busy: boolean;
  eqModal: EqModalState | null;
}

export type Action =
  | { type: 'chat/add'; msg: ChatMessage }
  | { type: 'chat/statusDone'; id: string }
  | { type: 'chat/assistantDelta'; id: string; deltaHtml: string }
  | { type: 'chat/busy'; busy: boolean }
  | { type: 'build/set'; phase: BuildState['phase']; progress: number }
  | { type: 'mode/set'; mode: Mode }
  | { type: 'view/set'; view: ViewMode }
  | { type: 'paperView/set'; view: PaperView }
  | { type: 'compile/start' }
  | { type: 'compile/done'; pdfUrl: string }
  | { type: 'compile/fail' }
  | { type: 'doc/replace'; doc: DocumentModel }
  | { type: 'doc/updateBlock'; id: string; patch: Record<string, unknown> }
  | { type: 'doc/insertBlocks'; afterId: string | null; blocks: Block[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'eqModal/open'; state: EqModalState }
  | { type: 'eqModal/close' };
