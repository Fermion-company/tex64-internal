"use client";

import { ArrowUp, LoaderCircle, Sigma } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RUN_STAGE_LABELS,
  type AgentRun,
  type DocumentDetail,
} from "@/lib/client/types";
import {
  isRunAwaitingInput,
  selectConversationRun,
  userFacingRunNote,
} from "@/lib/client/run-input";

interface AgentPanelProps {
  document: DocumentDetail | null;
  activeRun: AgentRun | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  submitting: boolean;
  onSubmit: (prompt: string) => void;
}

const QUICK_ACTIONS = ["短くする", "論点を補う", "語調を整える"].map((label) => ({
  label,
  prompt: label,
}));

export function AgentPanel({
  document,
  activeRun,
  composerRef,
  submitting,
  onSubmit,
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => {
    const byId = new Map((document?.runs ?? []).map((run) => [run.id, run]));
    if (activeRun && activeRun.documentId === document?.id) {
      byId.set(activeRun.id, activeRun);
    }
    return [...byId.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [activeRun, document?.id, document?.runs]);
  const conversationRun = useMemo(
    () => selectConversationRun(runs, activeRun),
    [activeRun, runs],
  );
  const needsInput = conversationRun ? isRunAwaitingInput(conversationRun) : false;
  const isWorking =
    conversationRun?.status === "running" || conversationRun?.status === "queued";
  const quickActions = needsInput ? [] : QUICK_ACTIONS;

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [conversationRun?.id, conversationRun?.stage, conversationRun?.status, runs.length]);

  const submit = (value = prompt) => {
    const trimmed = value.trim();
    if (!document || !trimmed || submitting || isWorking) return;
    onSubmit(trimmed);
    setPrompt("");
  };

  return (
    <aside className="agent-panel" aria-label="執筆">
      <div className="agent-panel-scroll" ref={scrollRef}>
        {runs.map((run) => {
          const waiting = isRunAwaitingInput(run);
          const answeredQuestion = run.status === "cancelled" && run.stage === "needs_input";
          const stopped =
            run.status === "failed" ||
            (run.status === "cancelled" && !answeredQuestion) ||
            run.stage === "failed";
          const completed = run.status === "completed" || run.stage === "ready";

          return (
            <div className="conversation-turn" key={run.id}>
              <div className="agent-user-message">{run.prompt}</div>
              {completed ? (
                <AssistantMessage>
                  {userFacingRunNote(run.resultNote, "文書へ反映しました。")}
                </AssistantMessage>
              ) : null}
              {waiting || answeredQuestion ? (
                <AssistantMessage
                  id={waiting && run.id === conversationRun?.id ? "writing-question" : undefined}
                >
                  {userFacingRunNote(run.resultNote, "続けるために、条件を教えてください。")}
                </AssistantMessage>
              ) : null}
              {stopped ? (
                <AssistantMessage error>
                  {run.status === "cancelled"
                    ? "いったん止めました。"
                    : "途中で止まりました。もう一度お試しください。"}
                </AssistantMessage>
              ) : null}
            </div>
          );
        })}

        {isWorking ? (
          <div className="writing-status" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" size={15} />
            <span>{RUN_STAGE_LABELS[conversationRun.stage]}</span>
          </div>
        ) : null}
      </div>

      <div className="agent-composer-wrap">
        {quickActions.length ? (
          <div className="quick-agent-actions" aria-label="書き換えの候補">
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={submitting || isWorking}
                onClick={() => submit(action.prompt)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="agent-composer">
          <textarea
            ref={composerRef}
            rows={3}
            value={prompt}
            disabled={!document || submitting || isWorking}
            placeholder={needsInput ? "回答を入力" : "何を執筆しますか？"}
            aria-label={needsInput ? "確認への回答" : "書きたい内容"}
            aria-describedby={needsInput ? "writing-question" : undefined}
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
            disabled={!document || !prompt.trim() || submitting || isWorking}
            aria-label="送る"
            onClick={() => submit()}
          >
            {submitting ? (
              <span aria-hidden="true" className="button-spinner" />
            ) : (
              <ArrowUp aria-hidden="true" size={16} />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function AssistantMessage({
  children,
  error = false,
  id,
}: {
  children: string;
  error?: boolean;
  id?: string;
}) {
  return (
    <div className={`assistant-message${error ? " is-error" : ""}`} id={id}>
      <div className="assistant-name">
        <span aria-hidden="true">
          <Sigma size={12} strokeWidth={2.2} />
        </span>
        <strong>TeX64</strong>
      </div>
      <p>{children}</p>
    </div>
  );
}
