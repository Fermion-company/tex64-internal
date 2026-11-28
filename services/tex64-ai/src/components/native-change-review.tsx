"use client";

import { useEffect, useRef, useState } from "react";
import { acceptNativeChangeReview, loadNativeConversation, type NativeChangeReviewData } from "@/lib/client/native-agent";
import { getNativeHost, hostMessageBody } from "@/lib/client/native-host";
import styles from "./native-change-review.module.css";

const changeLabels: Record<string, string> = { write: "編集", delete: "削除", rename: "名前の変更", mkdir: "フォルダ作成" };

export function NativeChangeReview({ conversationId, busy, onUndo, onReveal }: {
  conversationId: string;
  busy: boolean;
  onUndo: (runId: string) => Promise<void>;
  onReveal?: (path: string, line: number) => Promise<boolean>;
}) {
  const [review, setReview] = useState<NativeChangeReviewData | null>(null);
  const [undoable, setUndoable] = useState(false);
  const pending = useRef(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const latestReveal = useRef(0);
  const [acceptError, setAcceptError] = useState<{ runId: string; message: string } | null>(null);

  useEffect(() => {
    if (busy) return;
    let active = true;
    let version = 0;
    const refresh = async () => {
      const ticket = ++version;
      const state = await loadNativeConversation(conversationId).catch(() => null);
      if (!active || !state || ticket !== version) return;
      setReview(state.changeReview);
      setUndoable(state.undoCount > 0);
    };
    void refresh();
    const unsubscribe = getNativeHost()?.onMessage(message => {
      if (hostMessageBody(message).conversationId !== conversationId) return;
      if (message.type === "agent:reviewAccepted" || message.type === "agent:undoResult" || message.type === "agent:undoAvailability") void refresh();
    });
    return () => { active = false; unsubscribe?.(); };
  }, [busy, conversationId]);

  if (busy || !review) return null;
  const buildText = review.build === "success" ? "PDFを組版しました。"
    : review.build === "failure" ? "PDFの組版に失敗しました。" : "PDFの組版は未確認です。";
  return (
    <section className={styles.card} aria-label="原稿の変更結果">
      <header><strong>原稿に変更を保存しました</strong><span>{buildText}</span></header>
      {review.changes.map((change, index) => {
        const key = `${review.runId}:${index}`;
        const line = change.line;
        return (
          <div className={styles.change} key={key}>
            <div className={styles.changeRow}>
              <details>
                <summary>{change.path}{line ? ` · ${line}行目` : ""}<small>{changeLabels[change.type] ?? "変更"}</small></summary>
                {change.before && <pre className={styles.before} aria-label="変更前">− {change.before}</pre>}
                {change.after && <pre className={styles.after} aria-label="変更後">＋ {change.after}</pre>}
                {!change.before && !change.after && <p>{change.type === "rename" ? `${change.oldPath} → ${change.path}` : change.path}</p>}
              </details>
              {onReveal && review.build === "success" && /\.tex$/i.test(change.path) && typeof line === "number" && Number.isInteger(line) && line > 0 && (
                <button type="button" className={styles.reveal} onClick={async () => {
                  const request = ++latestReveal.current;
                  setRevealError(null);
                  const found = await onReveal(change.path, line).catch(() => false);
                  if (!found && latestReveal.current === request) setRevealError(key);
                }}>紙面で確認</button>
              )}
            </div>
            {revealError === key && <p role="status" className={styles.revealError}>この変更の紙面上の位置を特定できませんでした。</p>}
          </div>
        );
      })}
      {review.count > review.changes.length && <small>直近の{review.changes.length}件を表示しています。</small>}
      {acceptError?.runId === review.runId && <p role="alert">{acceptError.message}</p>}
      <footer>
        <button type="button" onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setAcceptError(null);
          try {
            await acceptNativeChangeReview(conversationId, review.runId);
            setReview(current => current?.runId === review.runId ? null : current);
          } catch (error) {
            setAcceptError({ runId: review.runId, message: error instanceof Error ? error.message : "採用した結果を保存できませんでした。" });
          } finally { pending.current = false; }
        }}>この変更を採用</button>
        <button type="button" disabled={!undoable} onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          try { await onUndo(review.runId); } finally { pending.current = false; }
        }}>この変更を取り消す</button>
      </footer>
    </section>
  );
}
