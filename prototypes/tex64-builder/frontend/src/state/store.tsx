import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ReactNode, Dispatch } from 'react';
import type { Action, AppState, Block, DocumentModel } from '../types';
import { loadInitialState, PERSIST_KEY } from '../data/initial';

const MAX_HISTORY = 100;

function pushHistory(s: AppState, doc: DocumentModel): AppState {
  return { ...s, past: [...s.past.slice(-(MAX_HISTORY - 1)), s.doc], future: [], doc };
}

function insertBlocks(doc: DocumentModel, afterId: string | null, blocks: Block[]): DocumentModel {
  const arr = [...doc.blocks];
  let idx: number;
  if (afterId) {
    const i = arr.findIndex((b) => b.id === afterId);
    idx = i === -1 ? arr.length : i + 1;
  } else {
    // 挿入位置未指定なら本文の末尾(参考文献の直前)へ
    const r = arr.findIndex((b) => b.type === 'references');
    idx = r === -1 ? arr.length : r;
  }
  arr.splice(idx, 0, ...blocks);
  return { ...doc, blocks: arr };
}

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'chat/add':
      return { ...s, chat: [...s.chat, a.msg] };
    case 'chat/statusDone':
      return {
        ...s,
        chat: s.chat.map((m) => (m.kind === 'status' && m.id === a.id ? { ...m, done: true } : m)),
      };
    case 'chat/assistantDelta':
      return {
        ...s,
        chat: s.chat.map((m) =>
          m.kind === 'assistant' && m.id === a.id ? { ...m, html: m.html + a.deltaHtml } : m,
        ),
      };
    case 'chat/busy':
      return { ...s, busy: a.busy };
    case 'build/set':
      return { ...s, build: { phase: a.phase, progress: a.progress } };
    case 'mode/set':
      return { ...s, mode: a.mode };
    case 'view/set':
      return { ...s, view: a.view };
    case 'paperView/set':
      return { ...s, paperView: a.view };
    case 'compile/start':
      return { ...s, compile: { ...s.compile, status: 'compiling' } };
    case 'compile/done':
      return {
        ...s,
        compile: { status: 'idle', pdfUrl: a.pdfUrl },
        build: s.build.phase === 'building' ? { phase: 'ready', progress: 100 } : s.build,
      };
    case 'compile/fail':
      return {
        ...s,
        compile: { ...s.compile, status: 'idle' },
        build: s.build.phase === 'building' ? { phase: 'ready', progress: 100 } : s.build,
      };
    case 'doc/replace':
      return pushHistory(s, a.doc);
    case 'doc/updateBlock': {
      const doc = {
        ...s.doc,
        blocks: s.doc.blocks.map((b) => (b.id === a.id ? ({ ...b, ...a.patch } as Block) : b)),
      };
      return pushHistory(s, doc);
    }
    case 'doc/insertBlocks':
      return pushHistory(s, insertBlocks(s.doc, a.afterId, a.blocks));
    case 'undo': {
      if (s.past.length === 0) return s;
      const past = [...s.past];
      const doc = past.pop() as DocumentModel;
      return { ...s, past, future: [s.doc, ...s.future], doc };
    }
    case 'redo': {
      if (s.future.length === 0) return s;
      const [doc, ...future] = s.future;
      return { ...s, past: [...s.past, s.doc], future, doc };
    }
    case 'eqModal/open':
      return { ...s, eqModal: a.state };
    case 'eqModal/close':
      return { ...s, eqModal: null };
    default:
      return s;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitialState);

  // プロジェクト・文書・チャットはローカルに永続化(プロトタイプ段階)
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const { project, doc, chat, mode, paperView } = state;
        localStorage.setItem(PERSIST_KEY, JSON.stringify({ project, doc, chat, mode, paperView }));
      } catch {
        // 容量超過(大きな画像等)時は永続化をスキップ
      }
    }, 400);
    return () => clearTimeout(t);
  }, [state]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore must be used within StoreProvider');
  return v;
}
