import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { EditableHTML } from './EditableHTML';
import { escapeHtml, renderLatex } from '../lib/latex';
import { isAutoScrolling } from '../lib/outline';
import type { Block, EquationBlock, FigureBlock } from '../types';

/* ---------- 文章選択時のフローティングツールバー ---------- */

type TextCmd = 'bold' | 'italic' | 'quote' | 'footnote';

function execTextCommand(cmd: TextCmd) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  if (cmd === 'bold') document.execCommand('bold');
  else if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'quote') {
    const t = sel.toString();
    document.execCommand('insertHTML', false, `「${escapeHtml(t)}」`);
  } else {
    // 脚注: 選択末尾に†を付与(実際の脚注生成は裏側でAIが同期する想定)
    sel.collapseToEnd();
    document.execCommand('insertHTML', false, '<sup>†</sup>');
  }
}

function TextToolbar({ x, y }: { x: number; y: number }) {
  const btn = (cmd: TextCmd, label: string, cls = '') => (
    <button
      type="button"
      className={`wtb-btn ${cls}`}
      onMouseDown={(e) => {
        e.preventDefault();
        execTextCommand(cmd);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="white-toolbar text-toolbar" style={{ left: x, top: y }}>
      {btn('bold', 'B', 'wtb-bold')}
      {btn('italic', 'I', 'wtb-italic')}
      <span className="wtb-sep" />
      {btn('quote', '”')}
      {btn('footnote', '†')}
      <span className="wtb-tail" />
    </div>
  );
}

/* ---------- 数式ブロック ---------- */

function SourcePopover({ block }: { block: EquationBlock }) {
  const { dispatch } = useStore();
  const [src, setSrc] = useState(block.latex);

  useEffect(() => {
    const t = setTimeout(() => {
      if (src !== block.latex) {
        dispatch({ type: 'doc/updateBlock', id: block.id, patch: { latex: src } });
      }
    }, 600);
    return () => clearTimeout(t);
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="source-popover" onMouseDown={(e) => e.stopPropagation()}>
      <div className="source-popover-label">LaTeXソース</div>
      <textarea
        value={src}
        rows={3}
        spellCheck={false}
        onChange={(e) => setSrc(e.target.value)}
      />
    </div>
  );
}

function EquationView({
  block,
  n,
  selected,
  onSelect,
  onDeselect,
}: {
  block: EquationBlock;
  n: number;
  selected: boolean;
  onSelect: () => void;
  onDeselect: () => void;
}) {
  const { dispatch } = useStore();
  const [showSrc, setShowSrc] = useState(false);
  const [pulse, setPulse] = useState(false);
  const lastGood = useRef('');

  const html = useMemo(() => {
    const h = renderLatex(block.latex, lastGood.current);
    lastGood.current = h;
    return h;
  }, [block.latex]);

  useEffect(() => {
    if (!selected) setShowSrc(false);
  }, [selected]);

  return (
    <div className="blk-eq" id={`blk-${block.id}`} data-eq-block onMouseDown={(e) => e.stopPropagation()}>
      <div
        className={`eq-box${selected ? ' selected' : ''}${pulse ? ' pulse' : ''}`}
        onClick={onSelect}
      >
        <span className="eq-katex" dangerouslySetInnerHTML={{ __html: html }} />
        <span className="eq-no">({n})</span>
      </div>

      {selected && (
        <div className="eq-toolbar-wrap">
          <span className="wtb-tail-up" />
          <div className="white-toolbar eq-toolbar">
            <button
              type="button"
              className="wtb-btn"
              title="AIで再生成"
              onClick={() => {
                setPulse(true);
                setTimeout(() => setPulse(false), 600);
              }}
            >
              &#8635;
            </button>
            <button
              type="button"
              className="wtb-btn wtb-primary"
              onClick={() =>
                dispatch({
                  type: 'eqModal/open',
                  state: { targetId: block.id, initialLatex: block.latex },
                })
              }
            >
              編集
            </button>
            <span className="wtb-sep" />
            <button
              type="button"
              className="wtb-btn wtb-quiet"
              onClick={() => setShowSrc((v) => !v)}
            >
              ソースを表示
            </button>
            <button type="button" className="wtb-btn wtb-quiet wtb-close" onClick={onDeselect}>
              &#10005;
            </button>
          </div>
          {showSrc && <SourcePopover block={block} />}
        </div>
      )}
    </div>
  );
}

/* ---------- 図版ブロック ---------- */

function FigureView({ block, n }: { block: FigureBlock; n: number }) {
  const { dispatch } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const readFile = (f: File) => {
    const rd = new FileReader();
    rd.onload = () =>
      dispatch({ type: 'doc/updateBlock', id: block.id, patch: { src: rd.result as string } });
    rd.readAsDataURL(f);
  };

  return (
    <div className="blk-fig" id={`blk-${block.id}`}>
      {block.src ? (
        <img className="fig-img" src={block.src} alt="" />
      ) : (
        <div
          className={`fig-placeholder${drag ? ' drag' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f && f.type.startsWith('image/')) readFile(f);
          }}
        >
          <div className="fig-plus">+</div>
          <div className="fig-label">画像を挿入</div>
          <div className="fig-sub">ドラッグ&amp;ドロップ&nbsp;/&nbsp;AIで生成</div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) readFile(f);
          e.target.value = '';
        }}
      />
      <div className="fig-caption">
        図 {n}&nbsp;&mdash;&nbsp;
        <EditableHTML
          inline
          html={block.caption}
          onCommit={(h) => dispatch({ type: 'doc/updateBlock', id: block.id, patch: { caption: h } })}
        />
      </div>
    </div>
  );
}

/* ---------- 紙面全体 ---------- */

export function PaperArea({ onActiveChange }: { onActiveChange: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [textTb, setTextTb] = useState<{ x: number; y: number } | null>(null);
  const [selEq, setSelEq] = useState<string | null>(null);
  const { doc } = state;

  // テキスト選択→ツールバー表示位置の計算
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setTextTb(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node instanceof Element ? node : node.parentElement;
      const editable = el?.closest('[data-editable="text"]');
      const stage = stageRef.current;
      if (!editable || !stage || !stage.contains(editable)) {
        setTextTb(null);
        return;
      }
      const r = range.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      setTextTb({ x: r.left - s.left + r.width / 2, y: r.top - s.top });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  // スクロール位置→アウトラインのアクティブ項目
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () => {
      if (isAutoScrolling()) return;
      const anchors = scroller.querySelectorAll<HTMLElement>('[data-outline-anchor]');
      const top = scroller.getBoundingClientRect().top;
      let active: string | null = null;
      anchors.forEach((a) => {
        if (a.getBoundingClientRect().top - top <= 110) active = a.dataset.outlineAnchor ?? null;
      });
      if (!active && anchors.length > 0) active = anchors[0].dataset.outlineAnchor ?? null;
      if (active) onActiveChange(active);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [onActiveChange, doc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelEq(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commit = (id: string, html: string) =>
    dispatch({ type: 'doc/updateBlock', id, patch: { html } });

  let headingNo = 0;
  let eqNo = 0;
  let figNo = 0;

  const renderBlock = (b: Block) => {
    switch (b.type) {
      case 'abstract':
        return (
          <div key={b.id} id={`blk-${b.id}`} data-outline-anchor={b.id} className="blk-abstract">
            <div className="abstract-label">概要</div>
            <EditableHTML
              className="abstract-body"
              html={b.html}
              onCommit={(h) => commit(b.id, h)}
            />
          </div>
        );
      case 'heading': {
        headingNo += 1;
        return (
          <div key={b.id} id={`blk-${b.id}`} data-outline-anchor={b.id} className="blk-heading">
            <span className="heading-no">{headingNo}.&nbsp;&nbsp;</span>
            <EditableHTML inline html={b.html} onCommit={(h) => commit(b.id, h)} />
          </div>
        );
      }
      case 'paragraph':
        return (
          <EditableHTML
            key={b.id}
            className="blk-paragraph"
            html={b.html}
            onCommit={(h) => commit(b.id, h)}
          />
        );
      case 'equation': {
        eqNo += 1;
        return (
          <EquationView
            key={b.id}
            block={b}
            n={eqNo}
            selected={selEq === b.id}
            onSelect={() => setSelEq(b.id)}
            onDeselect={() => setSelEq(null)}
          />
        );
      }
      case 'figure': {
        figNo += 1;
        return <FigureView key={b.id} block={b} n={figNo} />;
      }
      case 'references':
        return (
          <div key={b.id} id={`blk-${b.id}`} data-outline-anchor={b.id} className="blk-refs">
            <div className="blk-heading refs-heading">参考文献</div>
            {b.items.map((it, i) => (
              <div key={i} className="ref-item">
                <span className="ref-no">[{i + 1}]</span>
                <span>{it}</span>
              </div>
            ))}
          </div>
        );
    }
  };

  return (
    <div className="paper-scroll" ref={scrollRef}>
      <div
        className="paper-stage"
        ref={stageRef}
        onMouseDown={(e) => {
          const t = e.target as Element;
          if (!t.closest('[data-eq-block]')) setSelEq(null);
        }}
      >
        <div className="paper">
          <div className="paper-title">{doc.title}</div>
          <div className="paper-meta">{doc.meta}</div>
          {doc.blocks.map(renderBlock)}
        </div>
        {textTb && <TextToolbar x={textTb.x} y={textTb.y} />}
      </div>
    </div>
  );
}
