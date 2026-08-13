import { useEffect } from 'react';
import { Header } from './components/Header';
import { ChatPanel } from './components/ChatPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { EquationModal } from './components/EquationModal';
import { useStore } from './state/store';
import { compilePdf } from './lib/api';

export default function App() {
  const { state, dispatch } = useStore();

  // 文書が変わるたびにバックグラウンドで実LaTeXコンパイル(デバウンス)
  useEffect(() => {
    const t = setTimeout(() => {
      void compilePdf(dispatch, state.doc);
    }, 700);
    return () => clearTimeout(t);
  }, [state.doc, dispatch]);

  // 直接編集中(contenteditable/textarea)以外での Cmd+Z / Shift+Cmd+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <ChatPanel />
        <PreviewPanel />
      </div>
      {state.eqModal && <EquationModal key={state.eqModal.targetId ?? 'new'} />}
    </div>
  );
}
