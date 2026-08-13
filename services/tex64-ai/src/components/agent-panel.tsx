"use client";

import {
  ArrowUp,
  Check,
  LoaderCircle,
  Sigma,
  X,
} from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RUN_PROGRESS_STAGES,
  RUN_STAGE_LABELS,
  type AgentRun,
  type DocumentDetail,
  type DocumentElement,
  type RunProgressEvent,
} from "@/lib/client/types";
import {
  isRunAwaitingInput,
  selectConversationRun,
  userFacingRunNote,
} from "@/lib/client/run-input";

interface AgentPanelProps {
  document: DocumentDetail | null;
  activeRun: AgentRun | null;
  progressEvents: RunProgressEvent[];
  selectedElement: DocumentElement | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  submitting: boolean;
  onSubmit: (prompt: string) => void;
  onClearSelection: () => void;
}

/** After this long without a new progress step, be honest about the wait. */
const SLOW_RUN_AFTER_MS = 240_000;

export function AgentPanel({
  document,
  activeRun,
  progressEvents,
  selectedElement,
  composerRef,
  submitting,
  onSubmit,
  onClearSelection,
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

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [conversationRun?.id, conversationRun?.stage, conversationRun?.status, runs.length, progressEvents.length]);

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

        {isWorking && conversationRun ? (
          <RunTimeline run={conversationRun} events={progressEvents} />
        ) : null}
      </div>

      <div className="agent-composer-wrap">
        {selectedElement ? (
          <div className="selection-chip" role="status">
            <span className="selection-chip-label">
              選択中: {selectedElement.label}
            </span>
            <button
              type="button"
              aria-label="選択を解除"
              onClick={onClearSelection}
            >
              <X aria-hidden="true" size={13} />
            </button>
          </div>
        ) : null}
        <div className="agent-composer">
          <textarea
            ref={composerRef}
            rows={3}
            value={prompt}
            disabled={!document || submitting || isWorking}
            placeholder={
              needsInput
                ? "回答を入力"
                : selectedElement
                  ? `${selectedElement.label}をどう変えますか？`
                  : "何を執筆しますか？"
            }
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

/**
 * Live checklist of the run's stages (Base44-style task list). Stages come
 * from the recorded progress events; repair rounds re-enter earlier stages
 * and surface as「手直ししています (n回目)」.
 */
function RunTimeline({
  run,
  events,
}: {
  run: AgentRun;
  events: RunProgressEvent[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reached = useMemo(() => {
    const map = new Map<string, RunProgressEvent>();
    for (const event of events) map.set(event.stage, event);
    return map;
  }, [events]);
  const currentStage = events.at(-1)?.stage ?? run.stage;
  const currentAttempt = events.at(-1)?.attempt;
  const lastMovementAt = events.at(-1)?.occurredAt ?? run.updatedAt;
  const slow = now - Date.parse(lastMovementAt) > SLOW_RUN_AFTER_MS;

  const currentIndex = RUN_PROGRESS_STAGES.findIndex(
    (stage) => stage === currentStage,
  );

  return (
    <div className="writing-status" role="status" aria-live="polite">
      <ol className="run-timeline">
        {RUN_PROGRESS_STAGES.filter((stage) => stage !== "ready").map(
          (stage, index) => {
            const done =
              currentIndex > index ||
              run.status === "completed" ||
              (reached.has(stage) && stage !== currentStage);
            const active = stage === currentStage;
            if (!done && !active) {
              return (
                <li key={stage} className="is-upcoming">
                  <span className="run-timeline-dot" aria-hidden="true" />
                  <span>{RUN_STAGE_LABELS[stage]}</span>
                </li>
              );
            }
            return (
              <li key={stage} className={active ? "is-active" : "is-done"}>
                {active ? (
                  <LoaderCircle aria-hidden="true" size={13} />
                ) : (
                  <Check aria-hidden="true" size={13} />
                )}
                <span>
                  {active && currentAttempt !== undefined && currentAttempt > 0
                    ? `手直ししています (${currentAttempt}回目)`
                    : RUN_STAGE_LABELS[stage]}
                </span>
              </li>
            );
          },
        )}
      </ol>
      {slow ? (
        <p className="run-timeline-slow">
          時間がかかっています。このまま完了までお待ちください。別の文書の閲覧や編集はいつでもできます。
        </p>
      ) : null}
    </div>
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
