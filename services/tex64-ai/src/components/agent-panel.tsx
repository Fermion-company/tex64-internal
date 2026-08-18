"use client";

import { ArrowUp, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TOOL_ACTIVITY_LABEL,
  TOOL_ACTIVITY_LABELS,
  type ChatMessage,
  type DocumentDetail,
  type DocumentElement,
} from "@/lib/client/types";

interface AgentPanelProps {
  document: DocumentDetail | null;
  messages: ChatMessage[];
  /** Assistant text of the turn in flight, as it is being written. */
  streamingText: string;
  /** Tool the agent is running right now, or null when it is writing. */
  activityTool: string | null;
  isWorking: boolean;
  queuedPrompt: string | null;
  error: string | null;
  selectedElement: DocumentElement | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (prompt: string) => void;
  onStop: () => void;
  onClearSelection: () => void;
}

export function AgentPanel({
  document,
  messages,
  streamingText,
  activityTool,
  isWorking,
  queuedPrompt,
  error,
  selectedElement,
  composerRef,
  onSubmit,
  onStop,
  onClearSelection,
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages.length, streamingText, activityTool, isWorking]);

  const submit = (value = prompt) => {
    const trimmed = value.trim();
    if (!document || !trimmed) return;
    onSubmit(trimmed);
    setPrompt("");
  };

  return (
    <aside className="agent-panel" aria-label="執筆">
      <div className="agent-panel-scroll" ref={scrollRef}>
        {messages.map((message) =>
          message.role === "user" ? (
            <div className="agent-user-message" key={message.id}>
              {message.text}
            </div>
          ) : (
            <AssistantMessage key={message.id}>{message.text}</AssistantMessage>
          ),
        )}

        {streamingText ? (
          <AssistantMessage streaming>{streamingText}</AssistantMessage>
        ) : null}

        {isWorking ? (
          <p className="writing-status" role="status" aria-live="polite">
            {activityTool
              ? (TOOL_ACTIVITY_LABELS[activityTool] ?? DEFAULT_TOOL_ACTIVITY_LABEL)
              : "考えています"}
          </p>
        ) : null}

        {queuedPrompt ? (
          <div className="agent-user-message is-queued">{queuedPrompt}</div>
        ) : null}

        {error ? <AssistantMessage error>{error}</AssistantMessage> : null}
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
            disabled={!document}
            placeholder={
              selectedElement
                ? `${selectedElement.label}をどう変えますか？`
                : "何でも聞いてください"
            }
            aria-label="メッセージ"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {isWorking ? (
            <button
              type="button"
              className="composer-submit is-stop"
              aria-label="止める"
              onClick={onStop}
            >
              <Square aria-hidden="true" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer-submit"
              disabled={!document || !prompt.trim()}
              aria-label="送る"
              onClick={() => submit()}
            >
              <ArrowUp aria-hidden="true" size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function AssistantMessage({
  children,
  error = false,
  streaming = false,
}: {
  children: string;
  error?: boolean;
  streaming?: boolean;
}) {
  return (
    <div
      className={`assistant-message${error ? " is-error" : ""}${streaming ? " is-streaming" : ""}`}
    >
      <div className="assistant-name">
        <strong>TeX64</strong>
      </div>
      <p>{children}</p>
    </div>
  );
}
