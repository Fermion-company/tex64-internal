"use client";

import { useEffect, useRef, useState } from "react";
import { escapeParagraphText, segmentDisplayMath, segmentParagraph, type ParagraphSegment } from "@/domain/source/paragraph-editing";
import { tableCells, replaceTableCells, type TableCell } from "@/domain/source/table-editing";
import { getNativeHost } from "@/lib/client/native-host";
import { ensurePaperMath } from "@/lib/client/mathlive-loader";

type MathfieldElement = HTMLElement & { value: string; getValue?: (format?: string) => string };
const ALIGNED_PREFIX = String.raw`\begin{aligned}`;
const ALIGNED_SUFFIX = String.raw`\end{aligned}`;
const mathfieldValue = (latex: string) => {
  // Do not wrap an existing matrix/aligned environment a second time.
  const aligned = /&|\\\\/u.test(latex) && !/^\s*\\begin\{/u.test(latex);
  return { value: aligned ? `${ALIGNED_PREFIX}${latex}${ALIGNED_SUFFIX}` : latex, aligned };
};
const sourceMathValue = (value: string, aligned: boolean): string => {
  const trimmed = value.trim();
  return aligned && trimmed.startsWith(ALIGNED_PREFIX) && trimmed.endsWith(ALIGNED_SUFFIX)
    ? trimmed.slice(ALIGNED_PREFIX.length, -ALIGNED_SUFFIX.length) : value;
};

/** Mounted once per source range. Drafts are owned by useParagraphEditor. */
export function ParagraphEditCard({ originalText, initialDraft, kind, saving, error, currentText, onAcceptCurrent, onSave, onCancel, onDraftChange, onDiscard, onReload }: {
  originalText: string;
  initialDraft: string | null;
  kind: "text" | "math";
  saving: boolean;
  error: string | null;
  currentText: string | null;
  onAcceptCurrent: () => void;
  onSave: (text: string) => Promise<unknown>;
  onCancel: () => void;
  onDraftChange: (text: string) => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [initialSource] = useState(initialDraft ?? originalText);
  const serializeRef = useRef<() => string>(() => initialSource);
  const callbacks = useRef({ onDraftChange });
  useEffect(() => { callbacks.current = { onDraftChange }; }, [onDraftChange]);
  const [dirty, setDirty] = useState(initialSource !== originalText);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(0);
  const [isTable] = useState(() => kind !== "math" && tableCells(initialSource) !== null);
  const title = isTable ? "表を編集" : kind === "math" ? "数式を編集" : "文章を編集";

  useEffect(() => {
    const host = editorRef.current;
    if (!host) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const source = initialSource;
    const rows = kind === "math" ? null : tableCells(source);
    const segments = kind === "math" ? segmentDisplayMath(source) : segmentParagraph(source);
    const allSegments = rows ? rows.flat().flatMap((cell) => segmentParagraph(source.slice(cell.start, cell.end))) : segments;
    const needsMath = allSegments.some((segment) => segment.kind === "math");
    const build = async () => {
      try {
        const math = needsMath ? await ensurePaperMath() : null;
        if (cancelled) return;
        host.replaceChildren();
        const initializeFields: (() => void)[] = [];
        const makeEditor = (parts: ParagraphSegment[], label: string) => {
          const editor = document.createElement("div");
          editor.className = "paragraph-edit-area";
          editor.contentEditable = kind === "math" ? "false" : "true";
          if (kind !== "math") { editor.setAttribute("role", "textbox"); editor.setAttribute("aria-multiline", "true"); }
          editor.setAttribute("aria-label", label);
          editor.spellcheck = false;
          for (const segment of parts) {
            if (segment.kind === "text") { editor.append(document.createTextNode(segment.latex)); continue; }
            if (segment.kind === "syntax") {
              const syntax = document.createElement("span");
              syntax.className = "paragraph-syntax";
              syntax.contentEditable = "false";
              syntax.dataset.latex = segment.latex;
              editor.append(syntax);
              continue;
            }
            const wrapper = document.createElement("span");
            wrapper.className = "paragraph-math";
            wrapper.contentEditable = "false";
            wrapper.dataset.mathPrefix = segment.prefix;
            wrapper.dataset.mathSuffix = segment.suffix;
            wrapper.dataset.mathOriginal = segment.latex;
            wrapper.dataset.mathDirty = "false";
            const prepared = mathfieldValue(segment.latex);
            wrapper.dataset.mathAligned = String(prepared.aligned);
            const field = document.createElement("math-field") as MathfieldElement;
            field.className = "paragraph-math-field";
            field.setAttribute("aria-label", kind === "math" ? "数式を編集" : `${label}の数式`);
            field.setAttribute("math-virtual-keyboard-policy", "manual");
            wrapper.append(field);
            editor.append(wrapper);
            // Initialize after the whole table/card is connected. Moving an
            // initialized MathLive element would reset its input options.
            initializeFields.push(() => {
              field.value = prepared.value;
              field.addEventListener("input", () => { wrapper.dataset.mathDirty = "true"; });
              if (math) cleanups.push(math.attach(field, wrapper));
              const stabilize = () => {
                if (!field.shadowRoot || field.shadowRoot.querySelector("style[data-paper-editor]")) return;
                const style = document.createElement("style");
                style.dataset.paperEditor = "true";
                style.textContent = ".ML__content{overflow:visible!important}.ML__virtual-keyboard-toggle,.ML__menu-toggle,[part=virtual-keyboard-toggle],[part=menu-toggle]{display:none!important}:host(:focus),:host(:focus-within),.ML__focused{outline:none!important;box-shadow:none!important}";
                field.shadowRoot.append(style);
              };
              stabilize();
              requestAnimationFrame(stabilize);
            });
          }
          return editor;
        };
        if (rows) {
          const table = document.createElement("table");
          table.className = "paragraph-table";
          table.setAttribute("aria-label", "表を編集");
          const body = document.createElement("tbody");
          const editors: { cell: TableCell; editor: HTMLElement; original: string; touched: boolean }[] = [];
          rows.forEach((row, rowIndex) => {
            const tr = document.createElement("tr");
            row.forEach((cell, columnIndex) => {
              const td = document.createElement("td");
              const original = source.slice(cell.start, cell.end);
              const editor = makeEditor(segmentParagraph(original), `${rowIndex + 1}行 ${columnIndex + 1}列`);
              const entry = { cell, editor, original, touched: false };
              editor.addEventListener("input", () => { entry.touched = true; });
              editors.push(entry);
              td.append(editor); tr.append(td);
            });
            body.append(tr);
          });
          table.append(body); host.append(table);
          serializeRef.current = () => replaceTableCells(source, editors.map(({ cell, editor, original, touched }) => ({ cell, text: touched ? serializeEditor(editor) : original })));
        } else {
          const editor = makeEditor(segments, kind === "math" ? "数式を編集" : "文章を編集");
          host.append(editor);
          serializeRef.current = () => serializeEditor(editor);
        }
        initializeFields.forEach((initialize) => initialize());
        setLoadState("ready");
        requestAnimationFrame(() => {
          if (cancelled) return;
          host.querySelector<HTMLElement>(kind === "math" ? "math-field" : '[contenteditable="true"]')?.focus();
        });
      } catch { if (!cancelled) setLoadState("failed"); }
    };
    void build();
    return () => { cancelled = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [initialSource, kind, retry]);

  useEffect(() => getNativeHost()?.onMessage((message) => {
    if (message.type === "paper:command" && message.payload?.command === "save" && !saving && dirty && loadState === "ready") {
      void onSave(serializeRef.current());
    }
  }), [saving, dirty, loadState, onSave]);

  const recordDraft = () => {
    const text = serializeRef.current();
    setDirty(text !== originalText);
    callbacks.current.onDraftChange(text);
  };
  const save = () => { if (!saving && loadState === "ready") void onSave(serializeRef.current()); };
  return (
    <div className={`element-card${kind === "math" ? " is-display-math" : ""}${isTable ? " is-table" : ""}`} aria-label={title}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault(); event.stopPropagation(); save();
        } else if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault(); event.stopPropagation(); onCancel();
        }
      }}>
      <div className="element-card-head">
        <button type="button" className="element-card-close" onClick={onCancel}>閉じる</button>
        <strong>{title}{dirty ? <span className="draft-status">下書き</span> : null}</strong>
        <div className="element-card-head-actions">
          {dirty ? <button type="button" className="element-card-discard" disabled={saving} onClick={onDiscard}>破棄</button> : null}
          <button type="button" className="element-card-confirm" disabled={saving || loadState !== "ready" || !dirty} onClick={save}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
      <div className="element-card-editor" onInput={recordDraft}>
        <div ref={editorRef} />
        {loadState === "loading" ? <span role="status">数式入力を準備中…</span> : null}
        {loadState === "failed" ? <div role="alert">数式入力を読み込めませんでした。<button onClick={() => { setLoadState("loading"); setRetry((value) => value + 1); }}>再試行</button></div> : null}
        {error ? <div className="paragraph-editor-error" role="alert"><p>{error}</p>
          {currentText !== null ? <><strong>現在の本文</strong><pre className="conflict-source">{currentText}</pre><button onClick={onAcceptCurrent}>確認して下書きを使う</button></> : <button onClick={onReload}>最新の本文を確認</button>}
          <button onClick={() => void navigator.clipboard.writeText(serializeRef.current())}>下書きをコピー</button></div> : null}
      </div>
    </div>
  );
}
function serializeEditor(editor: HTMLElement | null): string {
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
        const syntax = child.dataset.latex;
        if (typeof syntax === "string") {
          out += syntax;
          return;
        }
        if (child.dataset.mathPrefix !== undefined) {
          let value = child.dataset.mathOriginal ?? "";
          if (child.dataset.mathDirty === "true") {
            const field = child.querySelector<MathfieldElement>("math-field");
            value = field?.value ?? "";
            try {
              value = field?.getValue?.("latex") ?? value;
            } catch {
              // `.value` is the same LaTeX representation on older MathLive.
            }
            value = sourceMathValue(
              value,
              child.dataset.mathAligned === "true",
            );
          }
          out += `${child.dataset.mathPrefix}${value}${child.dataset.mathSuffix ?? ""}`;
          lineStart = false;
          return;
        }
        if (child.tagName === "BR") {
          out += "\n";
          lineStart = true;
          return;
        }
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
    return walk(editor, true).text.replace(/\n+$/u, "");
}
