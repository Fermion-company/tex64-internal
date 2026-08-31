"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  escapeParagraphText,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";
import { ensureMathLive } from "@/lib/client/mathlive-loader";

type MathfieldElement = HTMLElement & {
  value: string;
  getValue?: (format?: string) => string;
  menuItems?: unknown[];
};

const ALIGNED_PREFIX = String.raw`\begin{aligned}`;
const ALIGNED_SUFFIX = String.raw`\end{aligned}`;

const mathfieldValue = (latex: string): { value: string; aligned: boolean } => {
  const aligned = /&|\\\\/u.test(latex);
  return {
    value: aligned ? `${ALIGNED_PREFIX}${latex}${ALIGNED_SUFFIX}` : latex,
    aligned,
  };
};

const sourceMathValue = (value: string, aligned: boolean): string => {
  if (!aligned) return value;
  const trimmed = value.trim();
  return trimmed.startsWith(ALIGNED_PREFIX) && trimmed.endsWith(ALIGNED_SUFFIX)
    ? trimmed.slice(ALIGNED_PREFIX.length, -ALIGNED_SUFFIX.length)
    : value;
};

/** Direct editing surface: only prose and rendered formulae are visible. */
export function ParagraphEditCard({
  segments,
  saving,
  error,
  onSave,
  onCancel,
}: {
  segments: ParagraphSegment[];
  saving: boolean;
  error: string | null;
  onSave: (replacementText: string) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [mathLoadFailed, setMathLoadFailed] = useState(false);
  const hasMath = segments.some((segment) => segment.kind === "math");
  const hasText = segments.some(
    (segment) => segment.kind === "text" && segment.latex.trim().length > 0,
  );
  const title = hasMath && hasText ? "文章と数式を編集" : hasMath ? "数式を編集" : "文章を編集";
  const segmentKey = useMemo(
    () =>
      segments
        .map((segment) =>
          segment.kind === "math"
            ? `m:${segment.prefix}:${segment.latex}:${segment.suffix}`
            : `${segment.kind}:${segment.latex}`,
        )
        .join("\u0000"),
    [segments],
  );

  // Build once per selected source range. React must not reconcile the DOM
  // while the reader is typing into it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;
    setMathLoadFailed(false);
    const build = async () => {
      if (hasMath) {
        try {
          await ensureMathLive();
        } catch {
          if (!cancelled) setMathLoadFailed(true);
          return;
        }
      }
      if (cancelled) return;
      editor.textContent = "";
      for (const segment of segments) {
        if (segment.kind === "text") {
          editor.appendChild(document.createTextNode(segment.latex));
          continue;
        }
        if (segment.kind === "syntax") {
          const syntax = document.createElement("span");
          syntax.className = "paragraph-syntax";
          syntax.contentEditable = "false";
          syntax.dataset.latex = segment.latex;
          editor.appendChild(syntax);
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
        wrapper.dataset.mathAligned = prepared.aligned ? "true" : "false";
        const field = document.createElement("math-field") as MathfieldElement;
        field.className = "paragraph-math-field";
        field.setAttribute("math-virtual-keyboard-policy", "manual");
        field.setAttribute("aria-label", "数式");
        wrapper.appendChild(field);
        editor.appendChild(wrapper);
        // MathLive creates its private mathfield only after connection.
        try {
          field.menuItems = [];
        } catch {
          // The visible menu toggles are hidden by the field styling below.
        }
        field.value = prepared.value;
        field.addEventListener("input", () => {
          wrapper.dataset.mathDirty = "true";
        });
        const stabilizeShadow = () => {
          const shadow = field.shadowRoot;
          if (!shadow || shadow.querySelector("style[data-tex64-paper-editor]")) return;
          const style = document.createElement("style");
          style.dataset.tex64PaperEditor = "true";
          style.textContent =
            ".ML__content{overflow:visible!important}.ML__virtual-keyboard-toggle,button[part=virtual-keyboard-toggle],.ML__menu-toggle,button[part=menu-toggle]{display:none!important}";
          shadow.appendChild(style);
        };
        stabilizeShadow();
        requestAnimationFrame(stabilizeShadow);
      }
      const firstMath = editor.querySelector<HTMLElement>("math-field");
      if (hasText) editor.focus();
      else firstMath?.focus();
      requestAnimationFrame(() => {
        editor
          .closest<HTMLElement>("[data-pdf-selection-card]")
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    };
    void build();
    return () => {
      cancelled = true;
    };
  }, [hasMath, hasText, segmentKey, segments]);

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
  };

  return (
    <div className="element-card" aria-label={title}>
      <div className="element-card-head">
        <button type="button" className="element-card-close" onClick={onCancel}>
          やめる
        </button>
        <strong>{title}</strong>
        <div className="element-card-head-actions">
          <button
            type="button"
            className="element-card-confirm"
            disabled={saving || mathLoadFailed}
            onClick={() => onSave(serialize())}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      <div className="element-card-editor">
        <div
          ref={editorRef}
          className="paragraph-edit-area"
          contentEditable={!mathLoadFailed}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={title}
          spellCheck={false}
        />
        {mathLoadFailed ? (
          <p className="paragraph-editor-error" role="alert">
            数式入力を読み込めませんでした。
          </p>
        ) : error ? (
          <p className="paragraph-editor-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
