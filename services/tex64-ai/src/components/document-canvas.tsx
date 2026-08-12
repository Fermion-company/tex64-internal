"use client";

import katex from "katex";
import {
  Check,
  CircleAlert,
  Download,
  ListPlus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  DocumentBlock,
  DocumentChanges,
  DocumentDetail,
  ListBlock,
} from "@/lib/client/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface DocumentCanvasProps {
  document: DocumentDetail;
  saveState: SaveState;
  outlineVisible: boolean;
  requestPending: boolean;
  onChange: (patch: DocumentChanges) => void;
  onAskAgent: (prompt: string) => void;
}

export function DocumentCanvas({
  document,
  saveState,
  outlineVisible,
  requestPending,
  onChange,
  onAskAgent,
}: DocumentCanvasProps) {
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const headingNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    let number = 0;
    document.blocks.forEach((block) => {
      if (block.type === "heading" && block.level === 1) {
        number += 1;
        numbers.set(block.id, number);
      }
    });
    return numbers;
  }, [document.blocks]);
  const equationNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    let number = 0;
    document.blocks.forEach((block) => {
      if (block.type === "equation") {
        number += 1;
        numbers.set(block.id, number);
      }
    });
    return numbers;
  }, [document.blocks]);
  const outlineItems = useMemo(
    () =>
      document.blocks
        .filter((block) => block.type === "heading")
        .map((block) => ({
          id: block.id,
          text: block.text,
          number: headingNumbers.get(block.id) ?? null,
        })),
    [document.blocks, headingNumbers],
  );

  const scrollToBlock = (id: string) => {
    setActiveOutlineId(id);
    window.document
      .getElementById(`block-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const updateBlock = (id: string, nextBlock: DocumentBlock) => {
    onChange({
      blocks: document.blocks.map((block) => (block.id === id ? nextBlock : block)),
    });
  };

  const removeBlock = (id: string) => {
    onChange({ blocks: document.blocks.filter((block) => block.id !== id) });
  };

  return (
    <section className="document-canvas" aria-label="文書">
      <header className="canvas-toolbar">
        <span
          className={`canvas-mode-pill${requestPending ? " is-working" : ""}`}
          role="status"
        >
          {requestPending ? "生成中" : "編集モード"}
        </span>
        <strong className="canvas-document-title">{document.title}</strong>
        <div className={`save-indicator save-${saveState}`} aria-live="polite">
          {saveState === "saving" ? <span className="button-spinner" /> : null}
          {saveState === "saved" ? <Check aria-hidden="true" size={14} /> : null}
          {saveState === "error" ? <CircleAlert aria-hidden="true" size={14} /> : null}
          <span>
            {saveState === "saving" ? "保存中" : saveState === "error" ? "未保存" : "保存済み"}
          </span>
        </div>
        {document.artifactUrl ? (
          <a
            className="toolbar-action"
            href={document.artifactUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="PDFを開く"
          >
            <Download aria-hidden="true" size={15} />
            <span>PDF</span>
          </a>
        ) : null}
      </header>

      <div className="document-stage">
        {outlineVisible ? (
          <nav className="outline-rail" aria-label="アウトライン">
            <span className="outline-label">アウトライン</span>
            <div className="outline-items">
              {outlineItems.length ? (
                outlineItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={activeOutlineId === item.id ? "is-active" : undefined}
                    onClick={() => scrollToBlock(item.id)}
                  >
                    {item.number ? `${item.number}. ` : ""}
                    {item.text || "無題の見出し"}
                  </button>
                ))
              ) : (
                <span className="outline-empty">見出しはまだありません</span>
              )}
            </div>
          </nav>
        ) : null}
        <div className="paper-viewport">
          <article className="paper-sheet" aria-label={document.title}>
            <label className="paper-title-field">
              <span className="sr-only">文書タイトル</span>
              <textarea
                rows={1}
                value={document.title}
                readOnly={requestPending}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            </label>
            <label className="paper-author-field">
              <span className="sr-only">作成者</span>
              <input
                value={document.author ?? ""}
                readOnly={requestPending}
                onChange={(event) => onChange({ author: event.target.value })}
                placeholder="作成者"
              />
            </label>

            <div className="paper-blocks">
              {document.blocks.map((block) => (
                <BlockEditor
                  key={block.id}
                  block={block}
                  headingNumber={headingNumbers.get(block.id)}
                  equationNumber={equationNumbers.get(block.id)}
                  onChange={(nextBlock) => updateBlock(block.id, nextBlock)}
                  onRemove={() => removeBlock(block.id)}
                  onAskAgent={() => onAskAgent(blockPrompt(block))}
                  requestPending={requestPending}
                  readOnly={requestPending}
                />
              ))}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function blockPrompt(block: DocumentBlock): string {
  if (block.type === "heading") return `「${block.text}」の節を読みやすく整えて`;
  if (block.type === "list") return "この箇条書きを、重要度が伝わる順序に整えて";
  if (block.type === "equation") return "この関係式を読み手に伝わる表現に整えて";
  return "選んだ段落を、意味を変えずに読みやすく整えて";
}

interface BlockEditorProps {
  block: DocumentBlock;
  headingNumber?: number;
  equationNumber?: number;
  onChange: (block: DocumentBlock) => void;
  onRemove: () => void;
  onAskAgent: () => void;
  requestPending: boolean;
  readOnly: boolean;
}

function BlockEditor({
  block,
  headingNumber,
  equationNumber,
  onChange,
  onRemove,
  onAskAgent,
  requestPending,
  readOnly,
}: BlockEditorProps) {
  return (
    <div className={`paper-block block-${block.type}`} id={`block-${block.id}`}>
      <div className="block-actions" aria-label="この部分の操作">
        <button
          type="button"
          title="書き直す"
          disabled={requestPending}
          onClick={onAskAgent}
        >
          <Sparkles aria-hidden="true" size={14} />
          <span className="sr-only">この部分を書き直す</span>
        </button>
        <button
          type="button"
          title="削除"
          disabled={readOnly}
          onClick={() => {
            if (window.confirm("この部分を削除しますか？")) onRemove();
          }}
        >
          <Trash2 aria-hidden="true" size={14} />
          <span className="sr-only">この部分を削除</span>
        </button>
      </div>

      {block.type === "heading" ? (
        <label className="block-heading-field">
          <span className="heading-number" aria-hidden="true">
            {headingNumber ? `${headingNumber}.` : ""}
          </span>
          <span className="sr-only">見出し</span>
          <textarea
            rows={1}
            value={block.text}
            readOnly={readOnly}
            onChange={(event) => onChange({ ...block, text: event.target.value })}
          />
        </label>
      ) : null}

      {block.type === "paragraph" ? (
        <label>
          <span className="sr-only">本文</span>
          <textarea
            className="block-paragraph-field"
            rows={2}
            value={block.text}
            readOnly={readOnly}
            onChange={(event) => onChange({ ...block, text: event.target.value })}
          />
        </label>
      ) : null}

      {block.type === "quote" ? (
        <div className="block-quote-fields">
          <label>
            <span className="sr-only">引用</span>
            <textarea
              rows={2}
              value={block.text}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...block, text: event.target.value })}
            />
          </label>
          <label>
            <span className="sr-only">引用元</span>
            <input
              value={block.attribution ?? ""}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...block, attribution: event.target.value })}
              placeholder="引用元"
            />
          </label>
        </div>
      ) : null}

      {block.type === "list" ? (
        <ListEditor block={block} readOnly={readOnly} onChange={onChange} />
      ) : null}

      {block.type === "equation" ? (
        <EquationBlock
          expression={block.expression}
          caption={block.caption ?? ""}
          number={equationNumber}
          readOnly={readOnly}
          onExpressionChange={(expression) => onChange({ ...block, expression })}
          onCaptionChange={(caption) => onChange({ ...block, caption })}
        />
      ) : null}
    </div>
  );
}

function EquationBlock({
  expression,
  caption,
  number,
  readOnly,
  onExpressionChange,
  onCaptionChange,
}: {
  expression: string;
  caption: string;
  number?: number;
  readOnly: boolean;
  onExpressionChange: (expression: string) => void;
  onCaptionChange: (caption: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const rendered = useMemo(() => {
    if (!expression.trim()) return null;
    try {
      return katex.renderToString(expression, {
        displayMode: true,
        throwOnError: false,
        strict: "ignore",
      });
    } catch {
      return null;
    }
  }, [expression]);
  const showEditor = editing || !rendered;

  return (
    <div className="block-equation-fields">
      {rendered && !showEditor ? (
        <button
          type="button"
          className="equation-render"
          title={readOnly ? undefined : "クリックして数式を編集"}
          disabled={readOnly}
          onClick={() => setEditing(true)}
        >
          <span dangerouslySetInnerHTML={{ __html: rendered }} />
          {number ? (
            <span className="equation-number" aria-hidden="true">
              ({number})
            </span>
          ) : null}
        </button>
      ) : (
        <label className="equation-source">
          <span className="sr-only">関係式</span>
          <input
            value={expression}
            readOnly={readOnly}
            autoFocus={editing}
            placeholder="E = mc^2"
            onChange={(event) => onExpressionChange(event.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        </label>
      )}
      <label className="equation-caption">
        <span className="sr-only">関係式の説明</span>
        <input
          value={caption}
          readOnly={readOnly}
          onChange={(event) => onCaptionChange(event.target.value)}
          placeholder="説明"
        />
      </label>
    </div>
  );
}

function ListEditor({
  block,
  readOnly,
  onChange,
}: {
  block: ListBlock;
  readOnly: boolean;
  onChange: (block: DocumentBlock) => void;
}) {
  return (
    <div className="block-list-fields">
      {block.items.map((item, index) => (
        <div key={`${block.id}-${index}`}>
          <span aria-hidden="true" />
          <label>
            <span className="sr-only">箇条書き {index + 1}</span>
            <textarea
              rows={1}
              value={item}
              readOnly={readOnly}
              onChange={(event) => {
                const items = [...block.items];
                items[index] = event.target.value;
                onChange({ ...block, items });
              }}
            />
          </label>
          {block.items.length > 1 ? (
            <button
              type="button"
              aria-label={`箇条書き ${index + 1} を削除`}
              disabled={readOnly}
              onClick={() =>
                onChange({
                  ...block,
                  items: block.items.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <Trash2 aria-hidden="true" size={13} />
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="add-list-item"
        disabled={readOnly}
        onClick={() => onChange({ ...block, items: [...block.items, ""] })}
      >
        <ListPlus aria-hidden="true" size={14} />
        項目を追加
      </button>
    </div>
  );
}
