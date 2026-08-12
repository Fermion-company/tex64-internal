import { useCallback, useState } from 'react';
import { useStore } from '../state/store';
import { PaperArea } from './Paper';
import { PdfView } from './PdfView';
import { BuildingView } from './BuildingView';
import { outlineItems, scrollToBlock } from '../lib/outline';
import { uid } from '../lib/latex';
import { ExpandIcon, RedoIcon, UndoIcon } from './icons';

function OutlineSidebar({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const items = outlineItems(state.doc);

  const addSection = () => {
    const hid = uid();
    dispatch({
      type: 'doc/insertBlocks',
      afterId: null,
      blocks: [
        { id: hid, type: 'heading', html: '新しいセクション' },
        {
          id: uid(),
          type: 'paragraph',
          html: 'ここをクリックして本文を執筆するか、チャットでAIに依頼してください。',
        },
      ],
    });
    dispatch({ type: 'paperView/set', view: 'edit' });
    setTimeout(() => scrollToBlock(hid), 80);
  };

  return (
    <nav className="outline-sidebar">
      <div className="outline-label">アウトライン</div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`outline-item${activeId === it.id ? ' active' : ''}`}
          onClick={() => onSelect(it.id)}
        >
          {it.label}
        </button>
      ))}
      <div className="outline-spacer" />
      <button type="button" className="outline-add" onClick={addSection}>
        +&nbsp;&nbsp;セクションを追加
      </button>
    </nav>
  );
}

function PreviewToolbar() {
  const { state, dispatch } = useStore();
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  return (
    <div className="preview-toolbar">
      <div className="mode-pill-wrap">
        <div className="mode-pill-active">
          {state.mode === 'edit' ? '編集モード' : 'ディスカスモード'}
        </div>
      </div>

      <div className="view-segment">
        <button
          type="button"
          className={`view-seg-item${state.paperView === 'edit' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'paperView/set', view: 'edit' })}
        >
          編集
        </button>
        <button
          type="button"
          className={`view-seg-item${state.paperView === 'pdf' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'paperView/set', view: 'pdf' })}
        >
          PDF
        </button>
      </div>

      <div className="doc-title-box">{state.doc.title}</div>

      <div className="undo-redo">
        <button
          type="button"
          className={`icon-btn${canUndo ? '' : ' disabled'}`}
          title="元に戻す"
          onClick={() => dispatch({ type: 'undo' })}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className={`icon-btn${canRedo ? '' : ' disabled'}`}
          title="やり直す"
          onClick={() => dispatch({ type: 'redo' })}
        >
          <RedoIcon />
        </button>
      </div>

      {state.compile.status === 'compiling' && (
        <span className="typeset-indicator">
          <span className="spinner-ring small" />
          組版中
        </span>
      )}

      <button
        type="button"
        className="icon-btn"
        title="全画面"
        onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        }}
      >
        <ExpandIcon />
      </button>
    </div>
  );
}

/** ヘッダーの「アウトライン」ビュー — 章立ての一覧(クリックで紙面へ) */
function OutlineFullView() {
  const { state, dispatch } = useStore();
  const items = outlineItems(state.doc);
  return (
    <div className="outline-full">
      <div className="outline-full-inner">
        <div className="outline-full-title">{state.doc.title}</div>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className="outline-full-item"
            onClick={() => {
              dispatch({ type: 'view/set', view: 'preview' });
              dispatch({ type: 'paperView/set', view: 'edit' });
              setTimeout(() => scrollToBlock(it.id), 80);
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PreviewPanel() {
  const { state, dispatch } = useStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const onActiveChange = useCallback((id: string) => setActiveId(id), []);

  const showPdf = state.paperView === 'pdf' && state.compile.pdfUrl !== null;

  const onOutlineSelect = useCallback(
    (id: string) => {
      setActiveId(id);
      if (showPdf) {
        // PDFビューでは文書内位置の比率でスクロール(SyncTeX相当の対応は今後)
        const scroller = document.querySelector('.pdf-scroll');
        const items = outlineItems(state.doc);
        const idx = items.findIndex((it) => it.id === id);
        if (scroller && idx >= 0 && items.length > 1) {
          const ratio = idx / (items.length - 1);
          scroller.scrollTo({
            top: ratio * (scroller.scrollHeight - scroller.clientHeight),
            behavior: 'smooth',
          });
        }
      } else {
        scrollToBlock(id);
      }
    },
    [showPdf, state.doc],
  );

  if (state.build.phase === 'building') {
    return (
      <section className="preview-panel">
        <BuildingView progress={state.build.progress} />
      </section>
    );
  }

  return (
    <section className="preview-panel">
      {state.view === 'outline' ? (
        <OutlineFullView />
      ) : (
        <>
          <PreviewToolbar />
          <div className="preview-body">
            <OutlineSidebar activeId={activeId} onSelect={onOutlineSelect} />
            {showPdf ? (
              <PdfView
                url={state.compile.pdfUrl as string}
                onActivateEdit={() => dispatch({ type: 'paperView/set', view: 'edit' })}
              />
            ) : (
              <PaperArea onActiveChange={onActiveChange} />
            )}
          </div>
        </>
      )}
    </section>
  );
}
