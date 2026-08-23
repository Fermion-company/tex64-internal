"use client";

import katex from "katex";
import { ListPlus, Trash2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentBlock, ListBlock } from "@/lib/client/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface BlockEditorProps {
  block: DocumentBlock;
  headingNumber?: number;
  equationNumber?: number;
  selected?: boolean;
  fresh?: boolean;
  onChange: (block: DocumentBlock) => void;
  readOnly: boolean;
}

/**
 * A textarea that grows with its content. A fixed-height field inside the
 * selection card silently hid the rest of a paragraph, and the wheel then
 * scrolled the page behind it because the field had nothing to scroll.
 */
function AutoTextarea(props: ComponentProps<"textarea">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}

export function BlockEditor({
  block,
  headingNumber,
  equationNumber,
  selected = false,
  fresh = false,
  onChange,
  readOnly,
}: BlockEditorProps) {
  return (
    <div
      className={`paper-block block-${block.type}${selected ? " is-selected" : ""}${fresh ? " is-fresh" : ""}`}
      id={`block-${block.id}`}
    >
      {block.type === "heading" ? (
        <label className="block-heading-field">
          <span className="heading-number" aria-hidden="true">
            {headingNumber ? `${headingNumber}.` : ""}
          </span>
          <span className="sr-only">見出し</span>
          <AutoTextarea
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
          <AutoTextarea
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
            <AutoTextarea
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
            <AutoTextarea
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
