import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { ATTENTION_LATEX, describeToLatex, renderLatex, uid } from '../lib/latex';
import { apiDescribeToLatex, apiOcrToLatex } from '../lib/api';

type Tab = 'describe' | 'photo';

interface PhotoInfo {
  name: string;
  sizeMB: string;
  url: string;
}

export function EquationModal() {
  const { state, dispatch } = useStore();
  const modal = state.eqModal;

  const [tab, setTab] = useState<Tab>('describe');
  const [desc, setDesc] = useState('');
  const [latex, setLatex] = useState(modal?.initialLatex ?? '');
  const [showSrc, setShowSrc] = useState(false);
  const [photo, setPhoto] = useState<PhotoInfo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastGood = useRef('');

  // 説明→数式: 入力停止でデバウンス自動変換(変換ボタンは無い)。AIで変換し、
  // バックエンド未接続時はローカルの簡易変換にフォールバックする。
  useEffect(() => {
    if (tab !== 'describe') return;
    const t = desc.trim();
    if (!t) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const ai = await apiDescribeToLatex(t);
      if (cancelled) return;
      setLatex(ai ?? describeToLatex(t));
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [desc, tab]);

  const html = useMemo(() => {
    if (!latex) return '';
    const h = renderLatex(latex, lastGood.current);
    lastGood.current = h;
    return h;
  }, [latex]);

  const eqNumber = useMemo(() => {
    let n = 0;
    for (const b of state.doc.blocks) {
      if (b.type === 'equation') {
        n += 1;
        if (modal?.targetId && b.id === modal.targetId) return n;
      }
    }
    return n + 1;
  }, [state.doc, modal]);

  if (!modal) return null;

  const close = () => dispatch({ type: 'eqModal/close' });

  const insert = () => {
    if (!latex) return;
    if (modal.targetId) {
      dispatch({ type: 'doc/updateBlock', id: modal.targetId, patch: { latex } });
    } else {
      dispatch({
        type: 'doc/insertBlocks',
        afterId: null,
        blocks: [{ id: uid(), type: 'equation', latex }],
      });
    }
    close();
  };

  const onPhoto = (f: File) => {
    setPhoto({
      name: f.name,
      sizeMB: `${(f.size / (1024 * 1024)).toFixed(1)} MB`,
      url: URL.createObjectURL(f),
    });
    // AIで数式をOCR認識。未接続時はサンプル数式にフォールバック
    const reader = new FileReader();
    reader.onload = async () => {
      const ai = await apiOcrToLatex(reader.result as string);
      setLatex(ai ?? ATTENTION_LATEX);
    };
    reader.readAsDataURL(f);
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="eq-modal">
        <div className="eq-modal-head">
          <div className="eq-modal-title">数式を追加</div>
          <button type="button" className="eq-modal-close" onClick={close}>
            &#10005;
          </button>
        </div>

        <div className="eq-modal-tabs">
          <button
            type="button"
            className={`eq-tab${tab === 'describe' ? ' active' : ''}`}
            onClick={() => setTab('describe')}
          >
            説明する
          </button>
          <button
            type="button"
            className={`eq-tab${tab === 'photo' ? ' active' : ''}`}
            onClick={() => setTab('photo')}
          >
            写真から
          </button>
        </div>

        {tab === 'describe' ? (
          <>
            <div className="eq-modal-label">どんな数式か、自然な言葉で説明してください</div>
            <textarea
              className="eq-desc-input"
              rows={3}
              value={desc}
              spellCheck={false}
              placeholder="例: QとKの転置の積をd_kの平方根で割ってソフトマックスをとり、Vを掛けた形"
              onChange={(e) => setDesc(e.target.value)}
            />
            <div className="eq-modal-note">入力が止まると自動的に数式へ変換されます</div>
          </>
        ) : (
          <>
            <div className="eq-modal-label">数式が写っている画像をドラッグ、またはクリックして選択</div>
            <div
              className="eq-dropzone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f && f.type.startsWith('image/')) onPhoto(f);
              }}
            >
              {photo ? (
                <>
                  <img className="eq-thumb" src={photo.url} alt="" />
                  <div>
                    <div className="eq-file-name">{photo.name}</div>
                    <div className="eq-file-meta">
                      {photo.sizeMB} &middot; アップロード済み
                    </div>
                  </div>
                </>
              ) : (
                <div className="eq-drop-empty">画像をここにドロップ</div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPhoto(f);
                e.target.value = '';
              }}
            />
          </>
        )}

        <div className="eq-preview-head">
          <div className="eq-preview-label">{tab === 'photo' ? '認識結果' : 'プレビュー'}</div>
          <button type="button" className="eq-src-toggle" onClick={() => setShowSrc((v) => !v)}>
            ソースを表示
          </button>
        </div>
        <div className="eq-preview-box">
          {html ? (
            <div className="eq-preview-render">
              <span dangerouslySetInnerHTML={{ __html: html }} />
              <span className="eq-no">({eqNumber})</span>
            </div>
          ) : (
            <div className="eq-preview-empty" />
          )}
        </div>
        {showSrc && (
          <textarea
            className="eq-src-editor"
            rows={2}
            value={latex}
            spellCheck={false}
            onChange={(e) => setLatex(e.target.value)}
          />
        )}

        <div className="eq-modal-footer">
          <button type="button" className="btn-cancel" onClick={close}>
            キャンセル
          </button>
          <button
            type="button"
            className={`btn-cta${latex ? '' : ' disabled'}`}
            onClick={insert}
          >
            挿入
          </button>
        </div>
      </div>
    </div>
  );
}
