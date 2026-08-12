import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Block, ChatTurn, DocumentModel } from './types.js';

const MODEL = 'gpt-5.4-mini';

let client: OpenAI | null = null;

export function initAi(): boolean {
  if (process.env.OPENAI_API_KEY) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return true;
  }
  return false;
}

export function aiAvailable(): boolean {
  return client !== null;
}

/* ------------------------------------------------------------------ */
/* チャット: 文書の生成・編集・相談                                        */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `あなたは「TeX64」— AIとの対話だけで学術レベルの文書が完成するアプリのアシスタントです。ユーザーはLaTeXを知らない前提で、あなたが文書(documentModel)を所有・管理します。

## documentModel の構造
文書はブロックの配列です。ブロックの型:
- {"type":"abstract","html":"..."} — 概要(文書の先頭に1つ)
- {"type":"heading","html":"..."} — セクション見出し(番号は自動付与されるので含めない)
- {"type":"paragraph","html":"..."} — 本文段落。使えるタグは <b> <i> <sup> のみ
- {"type":"equation","latex":"..."} — ディスプレイ数式(amsmath。equation環境の中身のみ。番号は自動)
- {"type":"figure","caption":"..."} — 図版。画像そのものはアプリ側で保持されるので位置とキャプションのみ管理
- {"type":"references","items":["..."]} — 参考文献リスト(文書の最後に1つ)

## ふるまい
- 編集モードでは、まず変更方針を1〜3行で簡潔に述べ、その後 update_document ツールで文書全体(変更しない部分も含む完全な blocks 配列)を渡す。
- ディスカスモードでは文書を変更せず、相談にのみ答える(ツールは使わない)。
- 文書の内容は学術的で自然な日本語で書く。段落は2〜4文程度。
- ツール実行後の締めの返答は1〜2文で簡潔に。「紙面を直接クリックして編集できます」等の案内は初回のみ。
- LaTeXやコンパイルの内部事情、エラーの話はユーザーに決して出さない。
- 出力はプレーンテキスト。マークダウン記法(** や # や -)は使わない。箇条書きが必要なら「・」を使う。
- 回答は日本語。`;

const UPDATE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'update_document',
    description:
      '文書全体を新しい内容で置き換える。ユーザーの指示を反映した完全なdocumentModel(全ブロック)を渡すこと。部分だけ渡すと残りが消えるため、変更しないブロックもそのまま含める。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文書タイトル' },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['abstract', 'heading', 'paragraph', 'equation', 'figure', 'references'],
              },
              html: { type: 'string', description: 'abstract/heading/paragraph の本文' },
              latex: { type: 'string', description: 'equation のLaTeXソース' },
              caption: { type: 'string', description: 'figure のキャプション' },
              items: {
                type: 'array',
                items: { type: 'string' },
                description: 'references の項目',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['title', 'blocks'],
    },
  },
};

interface RawBlock {
  type: string;
  html?: string;
  latex?: string;
  caption?: string;
  items?: string[];
}

/** ツール出力を正規化し、既存文書から画像を引き継ぐ */
export function normalizeDoc(
  input: { title?: string; blocks?: RawBlock[] },
  oldDoc: DocumentModel,
): DocumentModel {
  const oldFigures = oldDoc.blocks.filter((b) => b.type === 'figure');
  let figIdx = 0;
  const blocks: Block[] = [];

  for (const [i, raw] of (input.blocks ?? []).entries()) {
    const id = `b${i}`;
    switch (raw.type) {
      case 'abstract':
      case 'heading':
      case 'paragraph':
        blocks.push({ id, type: raw.type, html: raw.html ?? '' });
        break;
      case 'equation':
        blocks.push({ id, type: 'equation', latex: raw.latex ?? '' });
        break;
      case 'figure': {
        const old = oldFigures[figIdx] as { src: string | null } | undefined;
        figIdx += 1;
        blocks.push({
          id,
          type: 'figure',
          src: old?.src ?? null,
          caption: raw.caption ?? '挿入後にキャプションが自動生成されます',
        });
        break;
      }
      case 'references':
        blocks.push({ id, type: 'references', items: raw.items ?? [] });
        break;
    }
  }

  return {
    title: input.title || oldDoc.title,
    meta: oldDoc.meta,
    blocks,
  };
}

export interface ChatEvent {
  type: 'msg_start' | 'text' | 'status' | 'status_done' | 'doc' | 'notice' | 'done';
  delta?: string;
  id?: string;
  file?: string;
  doc?: DocumentModel;
  text?: string;
}

/**
 * チャット1ターンを実行し、イベントをコールバックへ流す。
 * 編集モードでツールが呼ばれた場合は tool結果を返して締めの返答まで続ける。
 */
export async function runChat(
  history: ChatTurn[],
  userText: string,
  doc: DocumentModel,
  mode: 'edit' | 'discuss',
  emit: (e: ChatEvent) => void,
): Promise<void> {
  if (!client) {
    emit({
      type: 'notice',
      text: 'AIバックエンドが未設定です。backend/.env に OPENAI_API_KEY を設定してサーバーを再起動してください。',
    });
    emit({ type: 'done' });
    return;
  }

  const docContext = `<current_document>\n${JSON.stringify(
    { title: doc.title, blocks: doc.blocks.map(stripForModel) },
    null,
    0,
  )}\n</current_document>`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-16).map((t) => ({ role: t.role, content: t.text }) as ChatCompletionMessageParam),
    {
      role: 'user',
      content: `${docContext}\n\n[モード: ${mode === 'edit' ? '編集' : 'ディスカス'}]\n${userText}`,
    },
  ];

  for (let iteration = 0; iteration < 2; iteration++) {
    const stream = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 8000,
      tools: mode === 'edit' ? [UPDATE_TOOL] : undefined,
      messages,
      stream: true,
    });

    emit({ type: 'msg_start' });

    let toolCallId: string | null = null;
    let toolCallArgs = '';
    let sawToolCall = false;
    let finishReason: string | null = null;
    let statusTimer: NodeJS.Timeout | null = null;
    const statusIds: string[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta?.content) {
        emit({ type: 'text', delta: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) toolCallId = tc.id;
          if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
        }
        if (!sawToolCall) {
          // 進捗表示(デザイン仕様のステータス行)。エラーログではない。
          sawToolCall = true;
          const s1 = `s${Date.now()}-1`;
          statusIds.push(s1);
          emit({ type: 'status', id: s1, file: 'main.tex' });
          statusTimer = setTimeout(() => {
            emit({ type: 'status_done', id: s1 });
            const s2 = `s${Date.now()}-2`;
            statusIds.push(s2);
            emit({ type: 'status', id: s2, file: 'sections/body.tex' });
          }, 1200);
        }
      }
    }

    if (statusTimer) clearTimeout(statusTimer);
    for (const id of statusIds) emit({ type: 'status_done', id });

    if (finishReason === 'tool_calls' && toolCallId && toolCallArgs) {
      let parsed: { title?: string; blocks?: RawBlock[] };
      try {
        parsed = JSON.parse(toolCallArgs);
      } catch (err) {
        console.warn('[runChat] failed to parse tool arguments:', err);
        break;
      }
      const newDoc = normalizeDoc(parsed, doc);
      emit({ type: 'doc', doc: newDoc });

      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: { name: 'update_document', arguments: toolCallArgs },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: '文書に反映しました。',
      });
      continue;
    }
    break;
  }

  emit({ type: 'done' });
}

function stripForModel(b: Block): Record<string, unknown> {
  if (b.type === 'figure') return { type: 'figure', caption: b.caption, hasImage: Boolean(b.src) };
  const rest: Record<string, unknown> = { ...b };
  delete rest.id;
  return rest;
}

/* ------------------------------------------------------------------ */
/* LaTeX自己修復: コンパイル失敗をAIが直す(ユーザーには露出しない)          */
/* ------------------------------------------------------------------ */

export async function repairLatex(source: string, logTail: string): Promise<string | null> {
  if (!client) return null;
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: `以下のLaTeXソースはコンパイルに失敗しました。エラーを修正した完全なソースを出力してください。出力はLaTeXソースのみ(説明やコードフェンス不要)。\n\n--- ソース ---\n${source}\n\n--- ログ末尾 ---\n${logTail}`,
        },
      ],
    });
    const text = response.choices[0]?.message?.content ?? '';
    const cleaned = text.replace(/^```(?:latex|tex)?\n?/, '').replace(/\n?```$/, '').trim();
    return cleaned.includes('\\documentclass') ? cleaned : null;
  } catch (err) {
    console.warn('[repairLatex] failed:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 数式: 自然文説明 → LaTeX / 写真OCR → LaTeX                            */
/* ------------------------------------------------------------------ */

const MATH_INSTRUCTION =
  '出力はLaTeXの数式コードのみ。$ や \\[ \\] や equation 環境は含めない。amsmathで有効な、ディスプレイ数式の中身だけを1つ出力する。説明文は不要。';

function cleanLatexReply(text: string): string {
  return text
    .replace(/^```(?:latex|tex|math)?\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^\$\$?/, '')
    .replace(/\$\$?$/, '')
    .replace(/^\\\[/, '')
    .replace(/\\\]$/, '')
    .trim();
}

export async function describeToLatex(description: string): Promise<string | null> {
  if (!client) return null;
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `次の説明をLaTeXの数式に変換してください。${MATH_INSTRUCTION}\n\n説明: ${description}`,
        },
      ],
    });
    const text = response.choices[0]?.message?.content ?? '';
    return cleanLatexReply(text) || null;
  } catch (err) {
    console.warn('[describeToLatex] failed:', err);
    return null;
  }
}

export async function ocrToLatex(imageDataUrl: string): Promise<string | null> {
  if (!client) return null;
  if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(imageDataUrl)) return null;
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            {
              type: 'text',
              text: `この画像に写っている数式を読み取り、LaTeXに変換してください。${MATH_INSTRUCTION}`,
            },
          ],
        },
      ],
    });
    const text = response.choices[0]?.message?.content ?? '';
    return cleanLatexReply(text) || null;
  } catch (err) {
    console.warn('[ocrToLatex] failed:', err);
    return null;
  }
}
