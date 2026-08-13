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

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}
