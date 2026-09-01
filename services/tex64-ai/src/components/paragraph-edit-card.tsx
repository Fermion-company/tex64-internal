"use client";

import { useEffect, useRef } from "react";

import {
  escapeParagraphText,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";

/**
 * The editable face of one paragraph: prose as text, commands as chips.
 *
 * The reader edits the words; chips (emphasis, math, citations…) are opaque —
 * they can be deleted with backspace but never opened or altered. On save the
 * DOM is read back in order: text nodes are escaped, chips contribute their
 * stored LaTeX verbatim.
 */
export function ParagraphEditCard({
  segments,
  saving,
  onSave,
  onCancel,
}: {
  segments: ParagraphSegment[];
  saving: boolean;
  onSave: (replacementText: string) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);

  // The editable DOM is built once per paragraph, imperatively: React must
  // not reconcile what the reader is typing into.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.textContent = "";
    for (const segment of segments) {
      if (segment.kind === "text") {
        editor.appendChild(document.createTextNode(segment.latex));
        continue;
      }
      const chip = document.createElement("span");
      chip.className = "paragraph-chip";
      chip.contentEditable = "false";
      chip.dataset.latex = segment.latex;
      chip.textContent = segment.label;
      chip.title = "この部分はそのまま残ります（削除はできます）";
      editor.appendChild(chip);
    }
    editor.focus();
  }, [segments]);

  const serialize = (): string => {
    const editor = editorRef.current;
    if (!editor) return "";
    const walk = (node: Node, atLineStart: boolean): { text: string; atLineStart: boolean } => {
      let out = "";
      let lineStart = atLineStart;
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const typed = child.textContent ?? "";
          if (typed) {
            out += escapeParagraphText(typed);
            lineStart = typed.endsWith("\n");
          }
          return;
        }
        if (!(child instanceof HTMLElement)) return;
        const latex = child.dataset.latex;
        if (typeof latex === "string") {
          out += latex;
          lineStart = false;
          return;
        }
        if (child.tagName === "BR") {
          out += "\n";
          lineStart = true;
          return;
        }
        // Enter in contenteditable wraps lines in blocks; each starts a line.
        const isBlock = child.tagName === "DIV" || child.tagName === "P";
        if (isBlock && !lineStart) {
          out += "\n";
          lineStart = true;
        }
        const inner = walk(child, lineStart);
        out += inner.text;
        lineStart = inner.atLineStart;
        if (isBlock && !lineStart) {
          lineStart = true;
          out += "\n";
        }
      });
      return { text: out, atLineStart: lineStart };
    };
    // A trailing newline from block wrapping would grow the file on each save.
    return walk(editor, true).text.replace(/\n+$/, "");
  };

  return (
    <div className="element-card" aria-label="この文章を直す">
      <div className="element-card-head">
        <button type="button" className="element-card-close" onClick={onCancel}>
          やめる
        </button>
        <strong>この文章を直す</strong>
        <div className="element-card-head-actions">
          <button
            type="button"
            className="element-card-confirm"
            disabled={saving}
            onClick={() => onSave(serialize())}
          >
            {saving ? "書き戻しています…" : "保存"}
          </button>
        </div>
      </div>
      <div className="element-card-editor">
        <div
          ref={editorRef}
          className="paragraph-edit-area"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="段落の文章"
          spellCheck={false}
        />
        <p className="paragraph-edit-note">
          文章はそのまま打ち直せます。角丸の部分（数式・引用など）は保たれます。
        </p>
      </div>
    </div>
  );
}
