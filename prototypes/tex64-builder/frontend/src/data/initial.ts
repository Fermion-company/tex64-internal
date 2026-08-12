import type { AppState, ChatMessage, DocumentModel, SuggestionItem } from '../types';
import { ATTENTION_LATEX, MULTIHEAD_LATEX } from '../lib/latex';

export const PERSIST_KEY = 'tex64.builder.v1';

export const DEFAULT_SUGGESTIONS: SuggestionItem[] = [
  { title: '参考文献を整形する', desc: 'BibTeXをAPA形式に統一' },
  { title: '図表に通し番号をつける', desc: '本文中の参照も自動更新' },
  { title: '結論を書き直す', desc: 'より簡潔なトーンに' },
];

const seedDoc: DocumentModel = {
  title: '深層学習における注意機構の理論的解析',
  meta: 'Personal Workspace  ·  2026',
  blocks: [
    {
      id: 'b-abstract',
      type: 'abstract',
      html: '本論文では Transformer における注意機構の数理的性質を整理し、既存手法と比較する。',
    },
    { id: 'b-h1', type: 'heading', html: 'はじめに' },
    {
      id: 'b-p1',
      type: 'paragraph',
      html: '自然言語処理における系列変換タスクは、長らく再帰構造に依存してきた。Transformer はこれを再考する試みとして提案された。本稿では、その中核をなす注意機構の理論的基盤を整理する。',
    },
    { id: 'b-eq1', type: 'equation', latex: ATTENTION_LATEX },
    { id: 'b-h2', type: 'heading', html: '関連手法' },
    {
      id: 'b-p2',
      type: 'paragraph',
      html: '既存手法は再帰構造に基づくものが多く、計算コストが系列長に対して線形に増加するという課題があった。畳み込みに基づく手法も提案されているが、長距離依存の把握には多層化が必要となる。',
    },
    {
      id: 'b-fig1',
      type: 'figure',
      src: null,
      caption: '挿入後にキャプションが自動生成されます',
    },
    { id: 'b-h3', type: 'heading', html: '手法' },
    {
      id: 'b-p3',
      type: 'paragraph',
      html: '本章では、スケール化内積注意を基礎とした多頭注意の構成を述べる。各ヘッドは独立した部分空間で注意分布を計算し、その結果を結合して線形変換する。',
    },
    { id: 'b-eq2', type: 'equation', latex: MULTIHEAD_LATEX },
    { id: 'b-h4', type: 'heading', html: '実験' },
    {
      id: 'b-p4',
      type: 'paragraph',
      html: '機械翻訳ベンチマークにおいて、本構成は従来の再帰型モデルと同等以上の精度を、大幅に短い学習時間で達成した。系列長に対するスケーリング特性についても検証する。',
    },
    { id: 'b-h5', type: 'heading', html: '結論' },
    {
      id: 'b-p5',
      type: 'paragraph',
      html: '注意機構は系列変換の帰納バイアスを再定義した。今後の課題は計算量の削減と、より長い系列への拡張である。',
    },
    {
      id: 'b-refs',
      type: 'references',
      items: [
        'A. Vaswani et al., "Attention Is All You Need," NeurIPS, 2017.',
        'D. Bahdanau, K. Cho, and Y. Bengio, "Neural Machine Translation by Jointly Learning to Align and Translate," ICLR, 2015.',
        'J. Devlin et al., "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding," NAACL, 2019.',
      ],
    },
  ],
};

const seedChat: ChatMessage[] = [
  { id: 'c-1', kind: 'user', text: '深層学習の注意機構について論文を書いて', time: '数秒前' },
  {
    id: 'c-2',
    kind: 'assistant',
    html: '論文ドラフトが完成しました。概要・本文・数式・図表・参考文献を含みます。文章や数式は紙面を直接クリックして書き換えられます。',
    time: '数秒前',
  },
  { id: 'c-3', kind: 'suggestions', title: '次に何をしますか?', items: DEFAULT_SUGGESTIONS },
];

const seedState: AppState = {
  project: { title: 'AttentionPaper', workspace: 'Personal Workspace' },
  doc: seedDoc,
  past: [],
  future: [],
  chat: seedChat,
  build: { phase: 'ready', progress: 100 },
  mode: 'edit',
  view: 'preview',
  paperView: 'pdf',
  compile: { status: 'idle', pdfUrl: null },
  busy: false,
  eqModal: null,
};

export function loadInitialState(): AppState {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return seedState;
    const saved = JSON.parse(raw) as Partial<AppState>;
    const chat = (saved.chat ?? seedChat).map((m) =>
      m.kind === 'status' ? { ...m, done: true } : m,
    );
    return {
      ...seedState,
      project: saved.project ?? seedState.project,
      doc: saved.doc ?? seedDoc,
      chat,
      mode: saved.mode ?? 'edit',
      paperView: saved.paperView ?? 'pdf',
    };
  } catch {
    return seedState;
  }
}
