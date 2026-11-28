"use client";

import { ArrowUp, ChevronDown, ChevronUp, File as FileIcon, FileSpreadsheet, FileText, Paperclip, Square, X } from "lucide-react";
import katex from "katex";
import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

import { RunActivity } from "./run-activity";
import styles from "./desktop-composer.module.css";
import { agentErrorMessage, defaultNextSteps } from "@/lib/client/agent-next-steps";

function useTextareaHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    if (CSS.supports("field-sizing", "content")) {
      input.style.height = "auto";
      return;
    }
    const resize = () => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight + 2}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [ref, value]);
}

type QuestionAnswer = { values: Record<string, string>; free: string };
export type QuestionDraft = { identity: string; answer: QuestionAnswer };
export type ComposerDraft = { prompt: string; attachments: PendingAttachment[] };

interface AgentPanelProps {
  document: DocumentDetail | null;
  /** Overrides the document gate: the desktop mode has no DocumentDetail. */
  ready?: boolean;
  desktop?: boolean;
  nativeConversationId?: string | null;
  drafts?: Map<string, ComposerDraft>;
  questionDrafts?: Map<string, QuestionDraft>;
  stopping?: boolean;
  changeReview?: ReactNode;
  outlineContent?: ReactNode;
  recoveryAction?: { label: string; run: () => void };
  contextSelection?: { page: number; endPage?: number; text: string; previous?: boolean } | null;
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
    options?: { origin?: "step"; stepKind?: "mechanical" | "writing"; displayText?: string },
  ) => void;
  onStop: () => void;
  onClearSelection?: () => void;
  /** A step with a question, picked on the page; `pick` counts each pick. */
  chosenProposal?: { proposal: AgentProposal; pick: number } | null;
  /** The step the reader is on, in the chat or on the page; both highlight it. */
  activeProposalId?: string | null;
  onActiveProposalChange?: (id: string | null) => void;
}

export function AgentPanel({
  document,
  ready,
  desktop = false,
  nativeConversationId,
  drafts,
  questionDrafts,
  stopping = false,
  changeReview,
  outlineContent,
  recoveryAction,
  contextSelection = null,
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
  const draftId = nativeConversationId ?? document?.id;
  const initialDraft = () => draftId ? drafts?.get(draftId) : undefined;
  const [prompt, setPrompt] = useState(() => initialDraft()?.prompt ?? "");
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [minimizedActivity, setMinimizedActivity] = useState<string | null>(null);
  const historyId = useId();
  const historyToggle = useRef<HTMLButtonElement>(null);
  const followingLatest = useRef(true);
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => initialDraft()?.attachments ?? []);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const canSubmit = ready ?? document !== null;
  useTextareaHeight(composerRef, prompt);
  useLayoutEffect(() => {
    if (!drafts || !draftId) return;
    if (prompt || attachments.length) drafts.set(draftId, { prompt, attachments });
    else drafts.delete(draftId);
  }, [drafts, draftId, prompt, attachments]);

  const addFiles = (files: Iterable<File>) => {
    if (!desktop) {
      setAttachmentNotice("ファイルの添付はデスクトップアプリで利用できます。");
      return;
    }
    const next = [...attachments];
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
    setAttachments(next);
    setAttachmentNotice(notice);
  };
  const removeAttachment = (id: string) => {
    const target = attachments.find((attachment) => attachment.id === id);
    if (target) releasePendingAttachment(target);
    setAttachments(attachments.filter((attachment) => attachment.id !== id));
    setAttachmentNotice(null);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragging(false);
    if (!canSubmit) return;
    addFiles(Array.from(event.dataTransfer.files));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    if (!desktop && event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    addFiles(files);
  };

  const submit = (value = prompt) => {
    const trimmed = value.trim();
    const files = attachments.length > 0 ? attachments : undefined;
    if (!canSubmit || (!trimmed && !files)) return;
    if (desktop) setHistoryExpanded(true);
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
    // The same request has the same capabilities whether clicked or typed.
    onSubmit(proposal.request, undefined, { origin: "step", stepKind: proposal.kind === "mechanical" ? "mechanical" : "writing", displayText: proposal.title });
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
  const showingLocalSteps = latestProposals.length === 0 || Boolean(error);
  if (showingLocalSteps) {
    const failedRequest = [...messages].reverse().find((message) => message.role === "user");
    latestProposals = defaultNextSteps(Boolean(error), failedRequest?.requestText ?? failedRequest?.text, failedRequest?.text);
    latestProposalMessageId = null;
  }
  const [proposalSource, setProposalSource] = useState(latestProposalMessageId);
  if (proposalSource !== latestProposalMessageId) {
    // Undo or a newer reply invalidates a question about the previous step.
    setProposalSource(latestProposalMessageId);
    setAskingProposal(null);
    setFocusedStep(null);
  }
  const stepIndexOf = (id: string | null) =>
    id === null ? -1 : latestProposals.findIndex((proposal) => proposal.id === id);
  const focusStep = (index: number | null) => {
    setFocusedStep(index);
    onActiveProposalChange?.(index === null ? null : (latestProposals[index]?.id ?? null));
  };
  const moveStep = (direction: 1 | -1) => {
    const current = focusedStep ?? stepIndexOf(activeProposalId);
    const next = current < 0
      ? (direction > 0 ? 0 : latestProposals.length - 1)
      : current + direction;
    if (next < 0 || next >= latestProposals.length) {
      focusStep(null);
      return false;
    }
    focusStep(next);
    return true;
  };

  // A pick on the page opens the same question card as a click on its row.
  const [handledPick, setHandledPick] = useState(chosenProposal?.pick ?? 0);
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
    askingProposal?.asks
      ? { question: askingProposal.asks, proposal: askingProposal }
      : agentQuestion
        ? { question: agentQuestion.question, proposal: null }
        : null;

  const questionIdentity = activeQuestion && JSON.stringify([
    messages.filter(message => message.role === "user" && !message.hidden).length,
    lastMessage?.text, activeQuestion.proposal?.id, activeQuestion.question,
  ]);
  const savedQuestion = draftId ? questionDrafts?.get(draftId) : undefined;
  const questionOpen = Boolean(activeQuestion);
  const hasTranscript = messages.some((message) => !message.hidden) || Boolean(streamingText || activeQuestion || isWorking || queuedPrompts.length);
  const compactError = desktop && !hasTranscript && error;
  const activityKey = activeQuestion
    ? `question:${activeQuestion.proposal?.id ?? agentQuestion?.id}`
    : error && !compactError ? `error:${error}` : isWorking ? `run:${lastMessage?.id ?? ""}` : null;
  const historyOpen = !desktop || hasTranscript && (historyExpanded || Boolean(activityKey && minimizedActivity !== activityKey));
  const activityLabel = activityTool ? TOOL_ACTIVITY_LABELS[activityTool] ?? DEFAULT_TOOL_ACTIVITY_LABEL : "考えています";
  const historyLabel = activeQuestion ? "Axiomからの質問" : error ? "依頼のエラー" : "会話履歴";
  const changeHistory = (open: boolean) => {
    setHistoryExpanded(open);
    setMinimizedActivity(open ? null : activityKey);
    if (open) followingLatest.current = true;
  };

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (historyOpen && container && (!desktop || followingLatest.current || questionOpen || error)) {
      container.scrollTop = container.scrollHeight;
    }
  }, [historyOpen, messages.length, streamingText, activityTool, isWorking, askingProposal, desktop, agentQuestion?.id, error, questionOpen]);

  const focusComposer = () => requestAnimationFrame(() => {
    if (composerRef.current && !composerRef.current.disabled) composerRef.current.focus();
    else historyToggle.current?.focus();
  });

  const answerQuestion = (answer: string) => {
    const trimmed = answer.trim();
    if (!canSubmit || isWorking || !trimmed) return;
    if (draftId) questionDrafts?.delete(draftId);
    if (desktop) { setHistoryExpanded(true); focusComposer(); }
    if (activeQuestion?.proposal) {
      const chosen = activeQuestion.proposal;
      onSubmit(`${trimmed}\n\n（「${chosen.title}」への答え。依頼: ${chosen.request}）`, undefined, { origin: "step", stepKind: chosen.kind, displayText: `${chosen.title}\n${trimmed}` });
      setAskingProposal(null);
    } else {
      if (agentQuestion) setDismissedQuestionId(agentQuestion.id);
      onSubmit(trimmed);
    }
  };
  const dismissQuestion = () => {
    if (draftId) questionDrafts?.delete(draftId);
    if (desktop) focusComposer();
    if (askingProposal) setAskingProposal(null);
    else if (agentQuestion) setDismissedQuestionId(agentQuestion.id);
  };

  const recoveryButton = recoveryAction &&
    <button type="button" className={styles.recovery} onClick={recoveryAction.run}>{recoveryAction.label}</button>;
  return (
    <aside className={`agent-panel${desktop ? ` ${styles.panel}` : ""}`} aria-label={desktop ? "Axiom" : "執筆"}
      onKeyDown={(event) => {
        if (!desktop || !historyOpen || activeQuestion || event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Escape") return;
        event.preventDefault();
        changeHistory(false);
        focusComposer();
      }}>
      {desktop && !hasTranscript && outlineContent ? (
        <div className={styles.outline}>{outlineContent}</div>
      ) : null}
      {desktop && hasTranscript ? (
        <button className={styles.toggle} type="button" ref={historyToggle}
          aria-controls={historyId} aria-expanded={historyOpen}
          onClick={() => changeHistory(!historyOpen)}>
          <span aria-live="polite">{historyLabel}</span>
          {historyOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
        </button>
      ) : null}
      <div className="agent-panel-scroll" ref={scrollRef} id={historyId} hidden={!historyOpen}
        onScroll={desktop ? (event) => {
          const node = event.currentTarget;
          followingLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        } : undefined}>
        {messages.map((message) =>
          message.hidden || (activeQuestion && agentQuestion?.id === message.id) ? null : message.role === "user" ? (
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
              proposalsEnabled={canSubmit && !isWorking && !activeQuestion && message.id === latestProposalMessageId}
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
            key={questionIdentity}
            question={activeQuestion.question}
            initialAnswer={savedQuestion?.identity === questionIdentity ? savedQuestion?.answer : undefined}
            onEdit={answer => {
              if (draftId && questionIdentity) questionDrafts?.set(draftId, { identity: questionIdentity, answer });
            }}
            onAnswer={answerQuestion}
            onDismiss={dismissQuestion}
          />
        ) : null}

        {!activeQuestion && !isWorking && showingLocalSteps ? (
          <ProposalList
            proposals={latestProposals}
            proposalsEnabled={canSubmit}
            onProposal={chooseProposal}
            latest
            activeProposalId={focusedStep !== null ? latestProposals[focusedStep]?.id : activeProposalId}
            onProposalHover={onActiveProposalChange}
          />
        ) : null}

        {streamingText ? (
          <AssistantMessage streaming>{streamingText}</AssistantMessage>
        ) : null}

        {isWorking && !desktop ? (
          <p className="writing-status" role="status" aria-live="polite">{activityLabel}</p>
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

        {error && !compactError ? <div><AssistantMessage error>{agentErrorMessage(error)}</AssistantMessage>{recoveryButton}</div> : null}
      </div>

      {nativeConversationId && isWorking ? <RunActivity conversationId={nativeConversationId} stopping={stopping} writing={Boolean(streamingText)} activity={activityTool} /> : null}
      {changeReview}
      {compactError ? <p className={styles.notice} role="alert">{agentErrorMessage(compactError)} {recoveryButton}</p> : null}
      <div
        className={`agent-composer-wrap${dragging ? " is-dragging" : ""}`}
        hidden={activeQuestion !== null}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (desktop && !dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        {desktop && contextSelection ? (
          <div className={styles.selection} role="status" title={contextSelection.text}>
            <span className={styles.page}>
              {contextSelection.previous ? "更新前の引用" : contextSelection.endPage && contextSelection.endPage !== contextSelection.page
                ? `${contextSelection.page}〜${contextSelection.endPage}ページ` : `${contextSelection.page}ページ`}
            </span>
            <span className={styles.excerpt}>{contextSelection.text}</span>
            {onClearSelection ? (
              <button type="button" aria-label="紙面の選択を解除" onClick={() => { onClearSelection(); focusComposer(); }}>
                <X aria-hidden="true" size={13} />
              </button>
            ) : null}
          </div>
        ) : selectedElement ? (
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
            rows={desktop ? 1 : 2}
            value={prompt}
            disabled={!canSubmit && !desktop}
            onPaste={onPaste}
            placeholder={desktop ? (isWorking ? "追加の指示を入力" : "Axiomに依頼する") : "メッセージ"}
            aria-label={desktop ? "Axiomへの依頼" : "メッセージ"}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
              // At either end of the proposal list, Tab resumes normal focus navigation.
              if (!desktop && event.key === "Tab" && !prompt.trim() && !isWorking && !activeQuestion) {
                if (latestProposals.length && moveStep(event.shiftKey ? -1 : 1)) event.preventDefault();
                return;
              }
              if (event.key === "Escape" && (focusedStep !== null || activeProposalId)) {
                event.preventDefault();
                focusStep(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!prompt.trim() && attachments.length === 0 && latestProposals.length > 0 && !isWorking && !activeQuestion) {
                  const step = latestProposals[focusedStep ?? stepIndexOf(activeProposalId)];
                  if (step) chooseProposal(step);
                  return;
                }
                submit();
              }
            }}
          />
          {desktop && (
            <>
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
            </>
          )}
          {isWorking && !prompt.trim() && attachments.length === 0 ? (
            <button
              type="button"
              className="composer-submit is-stop"
              aria-label={stopping ? "停止中" : "止める"}
              disabled={stopping}
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
      <p><MathText text={children} /></p>
      <ProposalList {...{ proposals, proposalsEnabled, onProposal, latest, activeProposalId, onProposalHover }} />
    </div>
  );
}

function ProposalList({ proposals = [], proposalsEnabled = false, onProposal, latest = false, activeProposalId, onProposalHover }: {
  proposals?: AgentProposal[];
  proposalsEnabled?: boolean;
  onProposal?: (proposal: AgentProposal) => void;
  latest?: boolean;
  activeProposalId?: string | null;
  onProposalHover?: (id: string | null) => void;
}) {
  if (!proposals.length) return null;
  return (
        <ol className={`proposal-list${latest ? " is-latest" : ""}`} aria-label="次の一手">
          {proposals.map((proposal, index) => (
            <li key={proposal.id}>
              <button
                type="button"
                className={`proposal-row${latest && activeProposalId === proposal.id ? " is-active" : ""}`}
                disabled={!proposalsEnabled}
                title={proposal.asks?.question}
                onClick={() => onProposal?.(proposal)}
                onKeyDown={(event) => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
                onMouseEnter={() => onProposalHover?.(proposal.id)}
                onMouseLeave={() => onProposalHover?.(null)}
              >
                <span className="proposal-index">{index + 1}</span>
                <span className="proposal-content">
                  <span className="proposal-title">{proposal.title}</span>
                  {proposal.reason ? <span className="proposal-reason"><MathText text={proposal.reason} /></span> : null}
                  {proposal.previewLatex ? <ProposalMath latex={proposal.previewLatex} /> : null}
                  {proposal.change ? <span className="proposal-change"><MathText text={proposal.change} /></span> : null}
                </span>
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
  );
}

function MathText({ text }: { text: string }) {
  // Only explicit math delimiters are interpreted. Other content stays escaped
  // React text, including incomplete delimiters during streaming.
  return text.split(/(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+(?<!\\)\$)/g).map((part, index) => {
    const display = part.startsWith("\\[") || part.startsWith("$$");
    const math = index % 2 === 1;
    return math ? <ProposalMath key={index} latex={part.slice(display || part.startsWith("\\(") ? 2 : 1, display || part.startsWith("\\(") ? -2 : -1)} display={display} /> : part;
  });
}

function ProposalMath({ latex, display = true }: { latex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxExpand: 200, maxSize: 20 });
    } catch { return null; }
  }, [latex, display]);
  return html ? <span className={display ? "proposal-math" : "chat-inline-math"} dangerouslySetInnerHTML={{ __html: html }} /> : <span>{latex}</span>;
}

/**
 * The agent's question as an input card: choices when it offered some, one
 * input per fact it asked for, otherwise a single answer box. Enter sends.
 */
function QuestionCard({
  question,
  initialAnswer,
  onEdit,
  onAnswer,
  onDismiss,
}: {
  question: AgentQuestion;
  initialAnswer?: QuestionAnswer;
  onEdit: (answer: QuestionAnswer) => void;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const fields = question.fields ?? [];
  const [{ values, free }, setAnswer] = useState<QuestionAnswer>(() => initialAnswer ?? { values: {}, free: "" });
  const edit = (answer: QuestionAnswer) => {
    setAnswer(answer);
    onEdit(answer);
  };
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const freeInputRef = useRef<HTMLTextAreaElement | null>(null);
  useTextareaHeight(freeInputRef, free);

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
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (event.repeat) return;
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
    <div className="question-card" role="group" aria-label="質問" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); onDismiss(); }
    }}>
      <div className="assistant-name question-heading">
        <strong>TeX64</strong>
        <button type="button" className="question-close" aria-label="質問を閉じる" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
      </div>
      <p className="question-text">{question.question}</p>
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
                  edit({ values: { ...values, [field.key]: event.target.value }, free })
                }
                onKeyDown={(event) => onKey(event, index === fields.length - 1)}
              />
            </label>
          ))}
        </div>
      ) : (
        <textarea
          ref={(node) => { freeInputRef.current = node; if (fields.length === 0) firstInputRef.current = node; }}
          className="question-free"
          rows={2}
          value={free}
          placeholder={question.options?.length ? "別の答えを書く" : "答えを書く"}
          onChange={(event) => edit({ values, free: event.target.value })}
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
