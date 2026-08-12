import { useStore } from '../state/store';
import { ClockIcon, SigmaLogo } from './icons';

export function Header() {
  const { state, dispatch } = useStore();

  return (
    <header className="header">
      <div className="header-left">
        <SigmaLogo />
        <span className="header-slash">/</span>
        <div className="ws-icon">{state.project.title.charAt(0).toUpperCase()}</div>
        <div className="project-meta">
          <span className="project-name">{state.project.title}</span>
          <span className="project-ws">{state.project.workspace}</span>
        </div>
        <div className="header-vsep" />
        <button className="icon-btn" title="履歴" type="button">
          <ClockIcon />
        </button>
      </div>

      <div className="segment">
        <button
          type="button"
          className={`segment-item${state.view === 'preview' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'view/set', view: 'preview' })}
        >
          プレビュー
        </button>
        <button
          type="button"
          className={`segment-item${state.view === 'outline' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'view/set', view: 'outline' })}
        >
          アウトライン
        </button>
      </div>

      <div className="header-right">
        <div className="avatar">Y</div>
        <button className="overflow-btn" title="その他" type="button">
          &#8943;
        </button>
        <button className="btn-upgrade" type="button">
          アップグレード
        </button>
        <button
          className={`btn-publish${state.compile.pdfUrl ? '' : ' disabled'}`}
          type="button"
          title="PDFをダウンロード"
          onClick={() => {
            if (!state.compile.pdfUrl) return;
            const a = document.createElement('a');
            a.href = state.compile.pdfUrl;
            a.download = `${state.project.title}.pdf`;
            a.click();
          }}
        >
          公開
        </button>
      </div>
    </header>
  );
}
