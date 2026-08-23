"use client";

import { useState } from "react";

/**
 * 新規文書はここから: 題名ひとつで、フォルダも main.tex もホストが用意する。
 * ファイルの話は一切出さない — 以後の中身はチャットで頼む。
 */
export function NativeNewDocumentPanel({
  creating,
  error,
  canCancel,
  onCancel,
  onSubmit,
}: {
  creating: boolean;
  error: string | null;
  /** True when there is a document to go back to. */
  canCancel: boolean;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState("");

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    onSubmit(trimmed);
  };

  return (
    <section className="new-document-panel" aria-busy={creating} aria-label="新しい文書">
      <div className="native-new-document">
        <h2>新しい文書</h2>
        <p>題名を決めると、書く場所はこちらで用意します。内容はチャットで頼めます。</p>
        <input
          type="text"
          value={title}
          disabled={creating}
          aria-label="文書の題名"
          placeholder="例: 学部量子力学の教科書"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="native-new-document-actions">
          {canCancel ? (
            <button type="button" disabled={creating} onClick={onCancel}>
              やめる
            </button>
          ) : null}
          <button
            type="button"
            className="native-new-document-create"
            disabled={!title.trim() || creating}
            onClick={submit}
          >
            {creating ? "作成しています…" : "作成"}
          </button>
        </div>
        {error ? <p className="native-new-document-error">{error}</p> : null}
      </div>
    </section>
  );
}
