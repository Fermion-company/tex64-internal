"use client";

import {
  Check,
  CircleAlert,
  Download,
  ListPlus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
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
  requestPending: boolean;
  onChange: (patch: DocumentChanges) => void;
  onAskAgent: (prompt: string) => void;
}

export function DocumentCanvas({
  document,
  saveState,
  requestPending,
  onChange,
  onAskAgent,
}: DocumentCanvasProps) {
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
  onChange: (block: DocumentBlock) => void;
  onRemove: () => void;
  onAskAgent: () => void;
  requestPending: boolean;
  readOnly: boolean;
}

function BlockEditor({
  block,
  headingNumber,
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
        <div className="block-equation-fields">
          <label>
            <span className="sr-only">関係式</span>
            <input
              value={block.expression}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...block, expression: event.target.value })}
            />
          </label>
          <label>
            <span className="sr-only">関係式の説明</span>
            <input
              value={block.caption ?? ""}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...block, caption: event.target.value })}
              placeholder="説明"
            />
          </label>
        </div>
      ) : null}
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
