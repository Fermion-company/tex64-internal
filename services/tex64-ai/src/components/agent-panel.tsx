"use client";

import { ArrowUp, File as FileIcon, FileSpreadsheet, FileText, Paperclip, Square, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createPendingAttachment,
  formatAttachmentSize,
  rejectAttachment,
  releasePendingAttachment,
  type PendingAttachment,
} from "@/lib/client/attachments";
import {
  DEFAULT_TOOL_ACTIVITY_LABEL,
  TOOL_ACTIVITY_LABELS,
  type AgentProposal,
  type AgentQuestion,
  type ChatMessage,
  type DocumentDetail,
  type DocumentElement,
} from "@/lib/client/types";

interface AgentPanelProps {
  document: DocumentDetail | null;
  /** Overrides the document gate: the desktop mode has no DocumentDetail. */
  ready?: boolean;
  messages: ChatMessage[];
  /** Assistant text of the turn in flight, as it is being written. */
  streamingText: string;
  /** Tool the agent is running right now, or null when it is writing. */
  activityTool: string | null;
  isWorking: boolean;
  queuedPrompts: string[];
  error: string | null;
  selectedElement: DocumentElement | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Files travel with the message; the workspace saves and describes them. */
  onSubmit: (
    prompt: string,
    attachments?: PendingAttachment[],
    options?: { origin?: "step"; stepKind?: "mechanical" | "writing" },
  ) => void;
  onStop: () => void;
  onClearSelection: () => void;
  /** A step with a question, picked on the page; `pick` counts each pick. */
  chosenProposal?: { proposal: AgentProposal; pick: number } | null;
  /** The step the reader is on, in the chat or on the page; both highlight it. */
  activeProposalId?: string | null;
  onActiveProposalChange?: (id: string | null) => void;
}

export function AgentPanel({
  document,
  ready,
  messages,
  streamingText,
  activityTool,
  isWorking,
  queuedPrompts,
  error,
  selectedElement,
  composerRef,
  onSubmit,
  onStop,
  onClearSelection,
  chosenProposal = null,
  activeProposalId = null,
  onActiveProposalChange,
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  /** Keyboard position among the latest next steps: Tab moves, Enter runs. */
  const [focusedStep, setFocusedStep] = useState<number | null>(null);
  /** The agent's own question the user closed without answering. */
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(null);
  /**
   * A proposed step that first needs something only the user knows. The
   * question is shown as the agent's turn; the answer travels with the step.
   */
  const [askingProposal, setAskingProposal] = useState<AgentProposal | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Files waiting in the composer to go with the next message. */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const canSubmit = ready ?? document !== null;

  const addFiles = (files: Iterable<File>) => {
    setAttachments((current) => {
      const next = [...current];
      let notice: string | null = null;
      for (const file of files) {
        const rejected = rejectAttachment(file, next);
        if (rejected) {
          notice = rejected;
          continue;
        }
        const pending = createPendingAttachment(file);
        if (pending) next.push(pending);
      }
      setAttachmentNotice(notice);
      return next;
    });
  };
  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) releasePendingAttachment(target);
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentNotice(null);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canSubmit) return;
    addFiles(Array.from(event.dataTransfer.files));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages.length, streamingText, activityTool, isWorking, askingProposal]);

  const submit = (value = prompt) => {
    const trimmed = value.trim();
    const files = attachments.length > 0 ? attachments : undefined;
    if (!canSubmit || (!trimmed && !files)) return;
    if (askingProposal) {
      // The answer leads; the step it answers follows as context, so the
      // transcript reads as a conversation and the agent knows what to do.
      onSubmit(
        `${trimmed}\n\n（「${askingProposal.title}」への答え。依頼: ${askingProposal.request}）`,
        files,
      );
      setAskingProposal(null);
    } else {
      onSubmit(trimmed, files);
    }
    setPrompt("");
    setAttachments([]);
    setAttachmentNotice(null);
  };

  const chooseProposal = (proposal: AgentProposal) => {
    if (!canSubmit || isWorking) return;
    setFocusedStep(null);
    onActiveProposalChange?.(null);
    if (proposal.asks) {
      setAskingProposal(proposal);
      return;
    }
    if (!canSubmit) return;
    // A chosen step starts with the brief: the agent asks before it writes.
    onSubmit(proposal.request, undefined, { origin: "step", stepKind: proposal.kind === "mechanical" ? "mechanical" : "writing" });
    setPrompt("");
    setAttachments([]);
    setAttachmentNotice(null);
  };

  // The next steps the agent last offered are what Enter and Tab act on.
  let latestProposals: AgentProposal[] = [];
  let latestProposalMessageId: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.proposals && message.proposals.length > 0) {
      latestProposals = message.proposals;
      latestProposalMessageId = message.id;
    }
    break;
  }
  const stepIndexOf = (id: string | null) =>
    id === null ? -1 : latestProposals.findIndex((proposal) => proposal.id === id);
  const focusStep = (index: number | null) => {
    setFocusedStep(index);
    onActiveProposalChange?.(index === null ? null : (latestProposals[index]?.id ?? null));
  };
  const cycleStep = (direction: 1 | -1) => {
    if (latestProposals.length === 0) return;
    const current = focusedStep ?? (activeProposalId ? stepIndexOf(activeProposalId) : -1);
    const next =
      current < 0
        ? direction > 0 ? 0 : latestProposals.length - 1
        : (current + direction + latestProposals.length) % latestProposals.length;
    focusStep(next);
  };

  // A pick on the page opens the same question card as a click on its row.
  const [handledPick, setHandledPick] = useState(0);
  if (chosenProposal && chosenProposal.pick !== handledPick) {
    setHandledPick(chosenProposal.pick);
    if (chosenProposal.proposal.asks) setAskingProposal(chosenProposal.proposal);
  }

  // The last thing the agent said may be a question; it stays open until the
  // user answers or closes it.
  const lastMessage = messages[messages.length - 1];
  const agentQuestion =
    !isWorking &&
    lastMessage &&
    lastMessage.role === "assistant" &&
    lastMessage.question &&
    dismissedQuestionId !== lastMessage.id
      ? { id: lastMessage.id, question: lastMessage.question }
      : null;
  const activeQuestion: { question: AgentQuestion; proposal: AgentProposal | null } | null =
    askingProposal
      ? { question: askingProposal.asks ?? { question: "答えを書いてください。" }, proposal: askingProposal }
      : agentQuestion
        ? { question: agentQuestion.question, proposal: null }
        : null;

  const answerQuestion = (answer: string) => {
    const trimmed = answer.trim();
    if (!canSubmit || !trimmed) return;
    if (activeQuestion?.proposal) {
      const chosen = activeQuestion.proposal;
      onSubmit(`${trimmed}\n\n（「${chosen.title}」への答え。依頼: ${chosen.request}）`);
      setAskingProposal(null);
    } else {
      if (agentQuestion) setDismissedQuestionId(agentQuestion.id);
      onSubmit(trimmed);
    }
  };
  const dismissQuestion = () => {
    if (askingProposal) setAskingProposal(null);
    else if (agentQuestion) setDismissedQuestionId(agentQuestion.id);
  };

  return (
    <aside className="agent-panel" aria-label="執筆">
      <div className="agent-panel-scroll" ref={scrollRef}>
        {messages.map((message) =>
          message.hidden ? null : message.role === "user" ? (
            <div className="agent-user-message" key={message.id}>
              {message.text}
              {message.attachments && message.attachments.length > 0 ? (
                <ul className="message-attachments" aria-label="添付ファイル">
                  {message.attachments.map((attachment, index) => (
                    <li key={`${attachment.name}-${index}`}>
                      <AttachmentIcon kind={attachment.kind} />
                      <span>{attachment.name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <AssistantMessage
              key={message.id}
              proposals={message.proposals}
              proposalsEnabled={canSubmit && !isWorking}
              onProposal={chooseProposal}
              latest={message.id === latestProposalMessageId}
              activeProposalId={
                message.id === latestProposalMessageId
                  ? (focusedStep !== null ? (latestProposals[focusedStep]?.id ?? null) : activeProposalId)
                  : null
              }
              onProposalHover={(id) => {
                if (message.id !== latestProposalMessageId) return;
                setFocusedStep(null);
                onActiveProposalChange?.(id);
              }}
            >
              {message.text}
            </AssistantMessage>
          ),
        )}

        {activeQuestion ? (
          <QuestionCard
            key={activeQuestion.proposal?.id ?? agentQuestion?.id ?? "question"}
            lead={activeQuestion.proposal ? `「${activeQuestion.proposal.title}」を進めます。` : null}
            question={activeQuestion.question}
            onAnswer={answerQuestion}
            onDismiss={dismissQuestion}
          />
        ) : null}

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

        {queuedPrompts.map((queuedPrompt, index) => (
          <div
            className="agent-user-message is-queued"
            key={`queued-${index}-${queuedPrompt}`}
          >
            <span className="queued-message-state">待機中</span>
            <span>{queuedPrompt}</span>
          </div>
        ))}

        {error ? <AssistantMessage error>{error}</AssistantMessage> : null}
      </div>

      <div
        className={`agent-composer-wrap${dragging ? " is-dragging" : ""}`}
        hidden={activeQuestion !== null}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={onDrop}
      >
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
          {attachments.length > 0 ? (
            <ul className="composer-attachments" aria-label="送る添付ファイル">
              {attachments.map((attachment) => (
                <li className="attachment-chip" key={attachment.id}>
                  {attachment.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL
                    <img src={attachment.previewUrl} alt="" />
                  ) : (
                    <AttachmentIcon kind={attachment.kind} />
                  )}
                  <span className="attachment-chip-name">{attachment.name}</span>
                  <span className="attachment-chip-size">{formatAttachmentSize(attachment.size)}</span>
                  <button
                    type="button"
                    aria-label={`${attachment.name} を外す`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <X aria-hidden="true" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={composerRef}
            rows={3}
            value={prompt}
            disabled={!canSubmit}
            onPaste={onPaste}
            placeholder={
              selectedElement
                ? `${selectedElement.label}をどう変えますか？`
                : "この文書について何でも"
            }
            aria-label="メッセージ"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              // The next steps answer to the keyboard like the math suggestions:
              // Tab moves between them, Enter takes the highlighted one, Esc lets go.
              if (event.key === "Tab" && latestProposals.length > 0 && !prompt.trim()) {
                event.preventDefault();
                cycleStep(event.shiftKey ? -1 : 1);
                return;
              }
              if (event.key === "Escape" && (focusedStep !== null || activeProposalId)) {
                event.preventDefault();
                focusStep(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!prompt.trim() && attachments.length === 0 && latestProposals.length > 0 && !isWorking) {
                  const step = latestProposals[focusedStep ?? Math.max(0, stepIndexOf(activeProposalId))];
                  if (step) chooseProposal(step);
                  return;
                }
                submit();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept="image/*,.pdf,.xlsx,.xls,.csv,.tsv,.txt,.md,.json,.tex,.bib,.dat,.svg"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="composer-attach"
            aria-label="ファイルを添付"
            title="画像・PDF・Excel・CSV・テキストを添付"
            disabled={!canSubmit}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip aria-hidden="true" size={15} />
          </button>
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
              disabled={!canSubmit || (!prompt.trim() && attachments.length === 0)}
              aria-label="送る"
              onClick={() => submit()}
            >
              <ArrowUp aria-hidden="true" size={16} />
            </button>
          )}
        </div>
        {attachmentNotice ? (
          <p className="composer-notice" role="status">
            {attachmentNotice}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function AttachmentIcon({ kind }: { kind: string }) {
  const size = 13;
  if (kind === "sheet") return <FileSpreadsheet aria-hidden="true" size={size} />;
  if (kind === "pdf" || kind === "text") return <FileText aria-hidden="true" size={size} />;
  return <FileIcon aria-hidden="true" size={size} />;
}

function AssistantMessage({
  children,
  error = false,
  streaming = false,
  proposals,
  proposalsEnabled = false,
  onProposal,
  latest = false,
  activeProposalId = null,
  onProposalHover,
}: {
  children: string;
  error?: boolean;
  streaming?: boolean;
  proposals?: AgentProposal[];
  proposalsEnabled?: boolean;
  onProposal?: (proposal: AgentProposal) => void;
  /** True for the newest set of steps: the ones Enter, Tab and the page point at. */
  latest?: boolean;
  activeProposalId?: string | null;
  onProposalHover?: (id: string | null) => void;
}) {
  return (
    <div
      className={`assistant-message${error ? " is-error" : ""}${streaming ? " is-streaming" : ""}`}
    >
      <div className="assistant-name">
        <strong>TeX64</strong>
      </div>
      <p>{children}</p>
      {proposals && proposals.length > 0 ? (
        <ol className={`proposal-list${latest ? " is-latest" : ""}`} aria-label="次の一手">
          {proposals.map((proposal, index) => (
            <li key={proposal.id}>
              <button
                type="button"
                className={`proposal-row${latest && activeProposalId === proposal.id ? " is-active" : ""}`}
                disabled={!proposalsEnabled}
                title={proposal.asks ? `${proposal.asks.question}` : proposal.request}
                onClick={() => onProposal?.(proposal)}
                onMouseEnter={() => onProposalHover?.(proposal.id)}
                onMouseLeave={() => onProposalHover?.(null)}
              >
                <span className="proposal-index">{index + 1}</span>
                <span className="proposal-title">{proposal.title}</span>
                <span className="proposal-meta">
                  {proposal.asks ? (
                    <span className="proposal-asks" aria-label="答えを聞いてから進みます">?</span>
                  ) : null}
                  {proposal.scope ? <span className="proposal-scope">{proposal.scope}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * The agent's question as an input card: choices when it offered some, one
 * input per fact it asked for, otherwise a single answer box. Enter sends.
 */
function QuestionCard({
  lead,
  question,
  onAnswer,
  onDismiss,
}: {
  lead: string | null;
  question: AgentQuestion;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const fields = question.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [free, setFree] = useState("");
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const composed = (): string => {
    const lines = fields
      .map((field) => {
        const value = (values[field.key] ?? "").trim();
        return value ? `${field.label}: ${value}` : "";
      })
      .filter(Boolean);
    const extra = free.trim();
    if (extra) lines.push(extra);
    return lines.join("\n");
  };
  const canSend = composed().trim() !== "";
  const send = () => {
    if (canSend) onAnswer(composed());
  };
  const onKey = (event: React.KeyboardEvent, isLast: boolean) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (isLast) {
        send();
        return;
      }
      const form = (event.currentTarget as HTMLElement).closest(".question-card");
      const inputs = form ? Array.from(form.querySelectorAll<HTMLElement>("input, textarea")) : [];
      const index = inputs.indexOf(event.currentTarget as HTMLElement);
      inputs[index + 1]?.focus();
    }
  };

  return (
    <div className="question-card" role="group" aria-label="質問">
      <div className="assistant-name">
        <strong>TeX64</strong>
      </div>
      <p className="question-text">
        {lead ? `${lead} ` : ""}
        {question.question}
      </p>
      {question.options && question.options.length > 0 ? (
        <div className="question-options">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="question-option"
              onClick={() => onAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {fields.length > 0 ? (
        <div className="question-fields">
          {fields.map((field, index) => (
            <label className="question-field" key={field.key}>
              <span>{field.label}</span>
              <input
                ref={index === 0 ? (node) => { firstInputRef.current = node; } : undefined}
                type="text"
                value={values[field.key] ?? ""}
                placeholder={field.placeholder ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                onKeyDown={(event) => onKey(event, index === fields.length - 1)}
              />
            </label>
          ))}
        </div>
      ) : (
        <textarea
          ref={(node) => { if (fields.length === 0) firstInputRef.current = node; }}
          className="question-free"
          rows={2}
          value={free}
          placeholder={question.options?.length ? "別の答えを書く" : "答えを書く"}
          onChange={(event) => setFree(event.target.value)}
          onKeyDown={(event) => onKey(event, true)}
        />
      )}
      <div className="question-actions">
        <button type="button" className="question-send" disabled={!canSend} onClick={send}>
          送る
        </button>
      </div>
    </div>
  );
}
