"use client";

import { ArrowUp, FileCheck2, FilePenLine, Lightbulb, NotebookPen } from "lucide-react";
import { useRef, useState } from "react";
import type { DocumentKind } from "@/lib/client/types";

interface NewDocumentPanelProps {
  creating: boolean;
  connectionError: boolean;
  onSubmit: (prompt: string, kind: DocumentKind) => void;
}

const DOCUMENT_KINDS: Array<{
  value: DocumentKind;
  label: string;
  icon: typeof FilePenLine;
}> = [
  { value: "proposal", label: "提案書", icon: Lightbulb },
  { value: "report", label: "報告書", icon: FileCheck2 },
  { value: "paper", label: "論文", icon: NotebookPen },
  { value: "memo", label: "メモ", icon: FilePenLine },
];

const STARTERS = ["研究テーマから論文の骨子を作る", "メモから読みやすい報告書にまとめる"];

export function NewDocumentPanel({ creating, connectionError, onSubmit }: NewDocumentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<DocumentKind>("paper");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed || creating) return;
    onSubmit(trimmed, kind);
  };

  return (
    <section className="new-document-panel" aria-busy={creating} aria-label="新しい文書">
      <div className="document-kind-picker" role="group" aria-label="文書の種類">
        {DOCUMENT_KINDS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={kind === item.value}
              className={kind === item.value ? "active" : undefined}
              onClick={() => setKind(item.value)}
            >
              <Icon aria-hidden="true" size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="large-composer">
        <textarea
          ref={textareaRef}
          rows={5}
          value={prompt}
          disabled={creating}
          aria-label="書きたい内容"
          placeholder="何を執筆しますか？"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="composer-submit"
          disabled={!prompt.trim() || creating}
          aria-busy={creating}
          aria-label="書き始める"
          onClick={submit}
        >
          {creating ? (
            <span aria-hidden="true" className="button-spinner" />
          ) : (
            <ArrowUp aria-hidden="true" size={17} />
          )}
        </button>
      </div>

      <div className="starter-prompts" aria-label="入力例">
        {connectionError ? (
          <span role="alert">接続できません。少し待ってから、もう一度お試しください。</span>
        ) : (
          STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => {
                setPrompt(starter);
                textareaRef.current?.focus();
              }}
            >
              {starter}
            </button>
          ))
        )}
      </div>
    </section>
  );
}
