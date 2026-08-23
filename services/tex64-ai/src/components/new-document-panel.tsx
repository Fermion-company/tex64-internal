"use client";

import { ArrowUp } from "lucide-react";
import { useRef, useState } from "react";

interface NewDocumentPanelProps {
  creating: boolean;
  connectionError: boolean;
  onSubmit: (prompt: string) => void;
}

/**
 * One input, nothing to classify first. The document kind (企画書 / 報告書 /
 * 論文 / メモ) is inferred server-side from the request text — the request
 * already carries the purpose ("会議用に短く", "ゲームの企画をまとめて"), so
 * asking for it up front only added a choice the user could get wrong.
 */
export function NewDocumentPanel({ creating, connectionError, onSubmit }: NewDocumentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed || creating) return;
    onSubmit(trimmed);
  };

  return (
    <section className="new-document-panel" aria-busy={creating} aria-label="新しい文書">
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

      {connectionError ? (
        <div className="starter-prompts">
          <span role="alert">接続できません。少し待ってから、もう一度お試しください。</span>
        </div>
      ) : null}
    </section>
  );
}
