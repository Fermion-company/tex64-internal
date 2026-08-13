import type { Dispatch } from 'react';
import type { Action, AppState, DocumentModel, Mode } from '../types';
import { DEFAULT_SUGGESTIONS } from '../data/initial';
import { escapeHtml, stripHtml, uid } from './latex';

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/* ------------------------------------------------------------------ */
/* チャット: バックエンドのSSEストリームを読み、状態へ反映する               */
/* ------------------------------------------------------------------ */

interface ChatServerEvent {
  type: 'msg_start' | 'text' | 'status' | 'status_done' | 'doc' | 'notice' | 'done';
  delta?: string;
  id?: string;
  file?: string;
  doc?: DocumentModel;
  text?: string;
}

export async function sendChat(
  dispatch: Dispatch<Action>,
  state: AppState,
  text: string,
  forceEdit = false,
): Promise<void> {
  const mode: Mode = forceEdit ? 'edit' : state.mode;
  dispatch({ type: 'chat/add', msg: { id: uid(), kind: 'user', text, time: 'たった今' } });
  dispatch({ type: 'chat/busy', busy: true });

  const history = state.chat
    .filter((m) => m.kind === 'user' || m.kind === 'assistant')
    .map((m) =>
      m.kind === 'user'
        ? { role: 'user' as const, text: m.text }
        : { role: 'assistant' as const, text: stripHtml(m.html.replace(/<br\s*\/?>/g, '\n')) },
    )
    .filter((t) => t.text.trim().length > 0);

  let currentId: string | null = null;
  let gotDoc = false;

  const handle = (e: ChatServerEvent) => {
    switch (e.type) {
      case 'msg_start':
        currentId = null; // 次のテキストで新しいメッセージを開始
        break;
      case 'text': {
        if (!e.delta) break;
        if (!currentId) {
          currentId = uid();
          dispatch({
            type: 'chat/add',
            msg: { id: currentId, kind: 'assistant', html: '', time: 'たった今' },
          });
        }
        dispatch({ type: 'chat/assistantDelta', id: currentId, deltaHtml: textToHtml(e.delta) });
        break;
      }
      case 'status':
        if (e.id && e.file) {
          dispatch({
            type: 'chat/add',
            msg: { id: e.id, kind: 'status', label: '書き込み中', file: e.file, done: false },
          });
        }
        break;
      case 'status_done':
        if (e.id) dispatch({ type: 'chat/statusDone', id: e.id });
        break;
      case 'doc':
        if (e.doc) {
          gotDoc = true;
          // タイトルが変わる更新は「新しい文書のビルド」としてビルド画面を出す
          if (e.doc.title !== state.doc.title) startBuildingProgress(dispatch);
          dispatch({ type: 'doc/replace', doc: e.doc });
        }
        break;
      case 'notice':
        if (e.text) {
          dispatch({
            type: 'chat/add',
            msg: { id: uid(), kind: 'assistant', html: textToHtml(e.text), time: 'たった今' },
          });
        }
        break;
      case 'done':
        break;
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history, text, doc: state.doc, mode }),
    });
    if (!res.ok || !res.body) throw new Error(`chat http ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (chunk.startsWith('data: ')) {
          try {
            handle(JSON.parse(chunk.slice(6)) as ChatServerEvent);
          } catch {
            // 不完全なチャンクは無視
          }
        }
      }
    }
  } catch (err) {
    console.warn('[chat] failed:', err);
    dispatch({
      type: 'chat/add',
      msg: {
        id: uid(),
        kind: 'assistant',
        html: 'サーバーに接続できませんでした。バックエンド(npm run dev)が起動しているか確認してください。',
        time: 'たった今',
      },
    });
  } finally {
    stopBuildingProgress();
    dispatch({ type: 'chat/busy', busy: false });
    if (gotDoc) {
      dispatch({
        type: 'chat/add',
        msg: { id: uid(), kind: 'suggestions', title: '次に何をしますか?', items: DEFAULT_SUGGESTIONS },
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* コンパイル: doc → 実PDF                                              */
/* ------------------------------------------------------------------ */

let compileAbort: AbortController | null = null;
let lastPdfUrl: string | null = null;
let buildingTimer: ReturnType<typeof setInterval> | null = null;

function startBuildingProgress(dispatch: Dispatch<Action>): void {
  stopBuildingProgress();
  let p = 12;
  dispatch({ type: 'build/set', phase: 'building', progress: p });
  buildingTimer = setInterval(() => {
    p = Math.min(p + 6, 92);
    dispatch({ type: 'build/set', phase: 'building', progress: p });
  }, 320);
}

function stopBuildingProgress(): void {
  if (buildingTimer) {
    clearInterval(buildingTimer);
    buildingTimer = null;
  }
}

export async function compilePdf(dispatch: Dispatch<Action>, doc: DocumentModel): Promise<void> {
  compileAbort?.abort();
  const ctrl = new AbortController();
  compileAbort = ctrl;
  dispatch({ type: 'compile/start' });
  try {
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc }),
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) return;
    if (res.status === 200) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
      lastPdfUrl = url;
      stopBuildingProgress();
      dispatch({ type: 'compile/done', pdfUrl: url });
    } else {
      // 失敗時は直前のPDFを保持(エラーは見せない)
      stopBuildingProgress();
      dispatch({ type: 'compile/fail' });
    }
  } catch {
    if (!ctrl.signal.aborted) {
      stopBuildingProgress();
      dispatch({ type: 'compile/fail' });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 数式: 説明→LaTeX / 写真→LaTeX                                        */
/* ------------------------------------------------------------------ */

export async function apiDescribeToLatex(description: string): Promise<string | null> {
  try {
    const res = await fetch('/api/math/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const json = (await res.json()) as { latex: string | null };
    return json.latex;
  } catch {
    return null;
  }
}

export async function apiOcrToLatex(imageDataUrl: string): Promise<string | null> {
  try {
    const res = await fetch('/api/math/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl }),
    });
    const json = (await res.json()) as { latex: string | null };
    return json.latex;
  } catch {
    return null;
  }
}
