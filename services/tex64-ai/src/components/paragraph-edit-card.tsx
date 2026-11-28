"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { mathFieldSource, preserveMathMetadata, escapeParagraphText, segmentDisplayMath, segmentParagraph, type ParagraphSegment } from "@/domain/source/paragraph-editing";
import { tableCells, replaceTableCells, type TableCell } from "@/domain/source/table-editing";
import { getNativeHost } from "@/lib/client/native-host";
import type { PdfTextHit } from "./pdf-text-blocks";
import { focusClickedContent } from "./paragraph-math-focus";
import { ensurePaperMath } from "@/lib/client/mathlive-loader";

type MathfieldElement = HTMLElement & { value: string; getValue?: (format?: string) => string };
function readFormula(field: MathfieldElement): string {
  try { return field.getValue?.("latex") ?? field.value; }
  catch { return field.value; }
}

const ALIGNED_PREFIX = String.raw`\begin{aligned}`;
const ALIGNED_SUFFIX = String.raw`\end{aligned}`;
const MATHLIVE_PLACEHOLDER_RE = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;

/** `&` and `\\` only need an aligned adapter when they occur in the formula
 * itself. Matrix, cases, and other nested environments own their separators. */
const hasTopLevelAlignmentSeparator = (latex: string): boolean => {
  let groupDepth = 0;
  let environmentDepth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const character = latex[index];
    if (character === "\\") {
      const rest = latex.slice(index);
      const environment = /^\\(begin|end)\s*\{[^}]*\}/u.exec(rest);
      if (environment) {
        environmentDepth += environment[1] === "begin" ? 1 : -1;
        index += environment[0].length - 1;
        continue;
      }
      if (latex[index + 1] === "\\") {
        if (groupDepth === 0 && environmentDepth === 0) return true;
        index += 1;
        continue;
      }
      const command = /^\\[A-Za-z]+/u.exec(rest);
      if (command) {
        index += command[0].length - 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "{") {
      groupDepth += 1;
      continue;
    }
    if (character === "}") {
      groupDepth = Math.max(0, groupDepth - 1);
      continue;
    }
    if (character === "&" && groupDepth === 0 && environmentDepth === 0) return true;
  }
  return false;
};

const mathfieldValue = (latex: string) => {
  const aligned = hasTopLevelAlignmentSeparator(latex);
  return { value: aligned ? `${ALIGNED_PREFIX}${latex}${ALIGNED_SUFFIX}` : latex, aligned };
};
const sourceMathValue = (value: string, aligned: boolean): string => {
  const trimmed = value.trim();
  const source = aligned && trimmed.startsWith(ALIGNED_PREFIX) && trimmed.endsWith(ALIGNED_SUFFIX)
    ? trimmed.slice(ALIGNED_PREFIX.length, -ALIGNED_SUFFIX.length) : value;
  // A placeholder is only an unfinished MathLive cell. It is not valid TeX
  // and must not leak into the workspace when a user saves a new empty cell.
  return source.replace(MATHLIVE_PLACEHOLDER_RE, "");
};

/** Mounted once per source range. Drafts are owned by useParagraphEditor. */
export function ParagraphEditCard({ originalText, initialDraft, focusText, textHit, kind, saving, error, currentText, onAcceptCurrent, onSave, onCancel, onDraftChange, onReload }: {
  originalText: string;
  initialDraft: string | null;
  focusText: string;
  textHit?: PdfTextHit;
  kind: "text" | "math";
  saving: boolean;
  error: string | null;
  currentText: string | null;
  onAcceptCurrent: () => void;
  onSave: (text: string) => Promise<unknown>;
  onCancel: () => void;
  onDraftChange: (text: string) => void;
  onReload: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [initialSource] = useState(initialDraft ?? originalText);
  const serializeRef = useRef<() => string>(() => initialSource);
  const callbacks = useRef({ onDraftChange });
  useEffect(() => { callbacks.current = { onDraftChange }; }, [onDraftChange]);
  const dirty = (initialDraft ?? originalText) !== originalText;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(0);
  const [copyResult, setCopyResult] = useState<"copied" | { manual: string } | null>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (copyResult && copyResult !== "copied") {
      copyField.current?.focus();
      copyField.current?.select();
    }
  }, [copyResult]);
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
        const tableEditors: { cell: TableCell; editor: HTMLElement; original: string; touched: boolean }[] = [];
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
            const prepared = mathfieldValue(mathFieldSource(segment.latex).visible);
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
              if (math) cleanups.push(math.attach(field, wrapper));
              // MathLive updates its model before it queues the input event.
              // Save must see the new formula even on that same keystroke.
              wrapper.dataset.initialFormula = readFormula(field);
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
          rows.forEach((row, rowIndex) => {
            const tr = document.createElement("tr");
            row.forEach((cell, columnIndex) => {
              const td = document.createElement("td");
              // Chromium can drop collapsible spaces at the edge of a
              // contenteditable. Keep the TeX column padding in the source.
              const raw = source.slice(cell.start, cell.end);
              const start = cell.start + raw.length - raw.trimStart().length;
              const original = raw.trim();
              const body = { start, end: start + original.length };
              const editor = makeEditor(segmentParagraph(original), `${rowIndex + 1}行 ${columnIndex + 1}列`);
              const entry = { cell: body, editor, original, touched: false };
              const markTouched = () => { entry.touched = true; };
              editor.addEventListener("beforeinput", markTouched);
              editor.addEventListener("input", markTouched);
              tableEditors.push(entry);
              td.append(editor); tr.append(td);
            });
            body.append(tr);
          });
          table.append(body); host.append(table);
          serializeRef.current = () => replaceTableCells(source, tableEditors.map(({ cell, editor, original, touched }) => ({ cell, text: touched ? serializeEditor(editor) : original })));
        } else {
          const editor = makeEditor(segments, kind === "math" ? "数式を編集" : "文章を編集");
          host.append(editor);
          serializeRef.current = () => serializeEditor(editor);
        }
        initializeFields.forEach((initialize) => initialize());
        setLoadState("ready");
        requestAnimationFrame(() => {
          if (cancelled) return;
          if (textHit && focusClickedContent(host, textHit)) return;
          if (!rows) {
            host.querySelector<HTMLElement>(kind === "math" ? "math-field" : '[contenteditable="true"]')?.focus();
            return;
          }
          if (textHit) return;
          const normalizedFocus = focusText.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
          if (normalizedFocus.length < 3) return;
          const candidates = tableEditors.filter(({ original }) => {
            const normalizedCell = original
              .normalize("NFKC")
              .toLowerCase()
              .replace(/\\(?:operatorname|mathrm|mathbf|mathit|mathsf|mathtt|text)\s*\{([^{}]*)\}/gu, "$1")
              .replace(/\\[A-Za-z]+\b/gu, "")
              .replace(/[^\p{L}\p{N}]+/gu, "");
            return normalizedCell && (normalizedCell.includes(normalizedFocus) || normalizedFocus.includes(normalizedCell));
          });
          if (candidates.length === 1) candidates[0]!.editor.focus();
        });
      } catch { if (!cancelled) setLoadState("failed"); }
    };
    void build();
    return () => { cancelled = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [focusText, textHit, initialSource, kind, retry]);

  useEffect(() => getNativeHost()?.onMessage((message) => {
    if (message.type === "paper:command" && message.payload?.command === "save" && !saving && loadState === "ready") {
      const text = serializeRef.current();
      if (text !== originalText) void onSave(text);
    }
  }), [saving, loadState, onSave, originalText]);

  const recordDraft = () => {
    setCopyResult(null);
    const text = serializeRef.current();
    callbacks.current.onDraftChange(text);
  };
  const copyDraft = async () => {
    const text = serializeRef.current();
    try {
      await navigator.clipboard.writeText(text);
      if (serializeRef.current() === text) setCopyResult("copied");
    } catch {
      if (serializeRef.current() === text) setCopyResult({ manual: text });
    }
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
        <button type="button" className="element-card-close element-card-close-icon" aria-label="閉じる" onClick={onCancel}>
          <X aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
        <strong>{title}{dirty ? <span className="draft-status">下書き</span> : null}</strong>
        <div className="element-card-head-actions">
          <button type="button" className="element-card-confirm" disabled={saving || loadState !== "ready" || !dirty} onClick={save}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
      <div className="element-card-editor" onInput={recordDraft}>
        <div ref={editorRef} />
        {loadState === "loading" ? <span role="status">数式入力を準備中…</span> : null}
        {loadState === "failed" ? <div role="alert">数式入力を読み込めませんでした。<button onClick={() => { setLoadState("loading"); setRetry((value) => value + 1); }}>再試行</button></div> : null}
        {error ? <div className="paragraph-editor-error" role="alert"><p>{error}</p>
          {currentText !== null ? <><strong>現在の本文</strong><pre className="conflict-source">{currentText}</pre><button onClick={onAcceptCurrent}>確認して下書きを使う</button></> : <button onClick={onReload}>最新の本文を確認</button>}
          <button onClick={copyDraft} aria-live="polite">{copyResult === "copied" ? "コピーしました" : "下書きをコピー"}</button>
          {copyResult && copyResult !== "copied" &&
            <label className="draft-copy-fallback">選択中の下書きをコピーしてください。
              <textarea ref={copyField} readOnly value={copyResult.manual} />
            </label>}
        </div> : null}
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
          const field = child.querySelector<MathfieldElement>("math-field");
          if (field) {
            const current = readFormula(field);
            if (current !== child.dataset.initialFormula) {
              value = preserveMathMetadata(value, sourceMathValue(current, child.dataset.mathAligned === "true"));
            }
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
