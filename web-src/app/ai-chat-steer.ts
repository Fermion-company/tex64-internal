import type { AiRequestPart } from "./ai-chat-runner.js";

// A follow-up typed while a turn runs goes into that turn, as in the AI
// workspace: the host adds the words before the turn's next model step
// (agent:steer, the same main-process path). A steer carries the words and
// nothing else, so a request that brings more with it (images, @ references,
// a place on the page, a step, another mode, a selection the running turn
// does not have) needs a run of its own and waits in the queue instead.

/** What a running turn was started with, as far as a steer has to match it. */
export type SteerTurnShape = { mode: string; selection: string };

export const steerTurnShape = (contextPayload?: Record<string, unknown> | null): SteerTurnShape => {
  const payload = contextPayload && typeof contextPayload === "object" ? contextPayload : {};
  const mode = payload.axiomMode === "ask" || payload.axiomMode === "plan" ? payload.axiomMode : "agent";
  const range = payload.activeSelection as Record<string, unknown> | undefined;
  const selection =
    range && typeof range === "object"
      ? [range.path, range.startLine, range.startColumn, range.endLine, range.endColumn, range.textLength].join(":")
      : "";
  return { mode, selection };
};

export type SteerCandidate = {
  parts: AiRequestPart[];
  contextPayload: Record<string, unknown>;
  /** The running turn's shape; unknown when this window did not start it. */
  runningShape: SteerTurnShape | null | undefined;
  /** Requests already waiting: a later one must not overtake them. */
  queued: number;
  collabGuest: boolean;
};

export const canSteer = (candidate: SteerCandidate): boolean => {
  const { parts, contextPayload, runningShape } = candidate;
  if (candidate.collabGuest || candidate.queued > 0 || !runningShape) return false;
  if (!Array.isArray(parts) || parts.some((part) => part?.inlineData)) return false;
  if (!parts.some((part) => typeof part?.text === "string" && part.text.trim().length > 0)) return false;
  const refs = contextPayload?.explicitContextRefs;
  if (Array.isArray(refs) && refs.length > 0) return false;
  const paths = contextPayload?.explicitContextPaths;
  if (Array.isArray(paths) && paths.length > 0) return false;
  if (contextPayload?.turnOrigin !== undefined) return false;
  const shape = steerTurnShape(contextPayload);
  return shape.mode === runningShape.mode && shape.selection === runningShape.selection;
};

export type SteerResultPayload = { requestId?: string; conversationId?: string; accepted?: boolean };

type SteeringDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  /** How long to wait for the host's answer before treating it as a refusal. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

const STEER_TIMEOUT_MS = 15000;

export const createAiChatSteering = (deps: SteeringDeps) => {
  const timeoutMs = deps.timeoutMs ?? STEER_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => window.clearTimeout(timer as number));
  const pending = new Map<string, { conversationId: string; settle: (accepted: boolean) => void; timer: unknown }>();

  const finish = (requestId: string, accepted: boolean) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimer(entry.timer);
    entry.settle(accepted);
  };

  /**
   * Hands the words to the running turn. settle runs once, with the host's
   * answer (false also when no answer comes). Returns false when nothing went
   * out; settle is then never called.
   */
  const steer = (conversationId: string, message: string, settle: (accepted: boolean) => void): boolean => {
    const steeringId = `steer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
    // Not "ai-": the AI workspace's correlation ids never match a Code request.
    const requestId = `code-${steeringId}`;
    const timer = setTimer(() => finish(requestId, false), timeoutMs);
    pending.set(requestId, { conversationId, settle, timer });
    const posted = deps.postToNative({ type: "agent:steer", requestId, conversationId, message, steeringId }, true);
    if (!posted) {
      pending.delete(requestId);
      clearTimer(timer);
      return false;
    }
    return true;
  };

  const handleSteerResult = (payload: SteerResultPayload) => {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    const entry = requestId ? pending.get(requestId) : undefined;
    if (!entry || payload.conversationId !== entry.conversationId) return;
    finish(requestId, payload.accepted === true);
  };

  const isPending = (conversationId: string) => {
    for (const entry of pending.values()) if (entry.conversationId === conversationId) return true;
    return false;
  };

  return { steer, handleSteerResult, isPending };
};
