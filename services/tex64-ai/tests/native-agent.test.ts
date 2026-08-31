import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNativeAgentRunPayload,
  conversationIdFor,
  nativeConversationRestoreMode,
  nativeTerminalFailed,
  nativeThreadSessionKey,
  runNativeTurn,
  scheduleAttachedAbortFallback,
  stopWorkspaceTurn,
  undoNativeConversation,
} from "@/lib/client/native-agent";

type TestHostMessage = { type: string; payload?: Record<string, unknown> };

function installHost() {
  const listeners = new Set<(message: TestHostMessage) => void>();
  const sent: { type: string; payload?: Record<string, unknown> }[] = [];
  const host = {
    send(type: string, payload?: Record<string, unknown>) {
      sent.push({ type, payload });
    },
    onMessage(handler: (message: TestHostMessage) => void) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  vi.stubGlobal("window", { tex64Native: { host } });
  return {
    sent,
    emit(message: TestHostMessage) {
      listeners.forEach((listener) => listener(message));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native agent turn scope", () => {
  it("separates threads by both workspace and exact document", () => {
    expect(conversationIdFor("workspace-a", "book/main.tex")).not.toBe(
      conversationIdFor("workspace-b", "book/main.tex"),
    );
    expect(conversationIdFor("workspace-a", "book/main.tex")).not.toBe(
      conversationIdFor("workspace-a", "notes/main.tex"),
    );
    expect(conversationIdFor("workspace-a", "book/main.tex")).toMatch(
      /^tex64-ai-mode:/,
    );
  });

  it("keeps mtime refreshes in one live session but separates real boundaries", () => {
    const current = nativeThreadSessionKey("workspace-a", 7, "book/main.tex");
    expect(current).toBe(nativeThreadSessionKey("workspace-a", 7, "book/main.tex"));
    expect(current).not.toBe(nativeThreadSessionKey("workspace-a", 8, "book/main.tex"));
    expect(current).not.toBe(nativeThreadSessionKey("workspace-a", 7, "notes/main.tex"));
    expect(current).not.toBe(nativeThreadSessionKey("workspace-b", 7, "book/main.tex"));
  });

  it("reattaches persisted running state instead of aborting the current turn", () => {
    const sessionKey = nativeThreadSessionKey("workspace-a", 7, "book/main.tex")!;
    expect(nativeConversationRestoreMode(true, sessionKey, sessionKey)).toBe("active");
    expect(nativeConversationRestoreMode(false, sessionKey, sessionKey)).toBe("active");
    expect(nativeConversationRestoreMode(true, sessionKey, null)).toBe("reattach");
    expect(nativeConversationRestoreMode(false, sessionKey, null)).toBe("idle");
  });

  it("keeps the shared stop button working for non-native hosted turns", () => {
    const fallbackAbort = vi.fn();
    const abortAttached = vi.fn();
    expect(
      stopWorkspaceTurn({
        activeNativeController: null,
        attachedConversationId: null,
        fallbackController: { abort: fallbackAbort },
        abortAttached,
      }),
    ).toBe("fallback");
    expect(fallbackAbort).toHaveBeenCalledOnce();
    expect(abortAttached).not.toHaveBeenCalled();
  });

  it("treats agent:error followed by resumable as a failed terminal state", () => {
    expect(nativeTerminalFailed("idle", false)).toBe(false);
    expect(nativeTerminalFailed("resumable", false)).toBe(false);
    expect(nativeTerminalFailed("resumable", true)).toBe(true);
    expect(nativeTerminalFailed("error", false)).toBe(true);
  });

  it("releases a reattached turn if its abort acknowledgement is lost", () => {
    vi.useFakeTimers();
    let attached = true;
    const onTimeout = vi.fn();
    const cancel = scheduleAttachedAbortFallback(
      "conversation-a",
      () => attached,
      onTimeout,
      10_000,
    );
    vi.advanceTimersByTime(9_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    const cancelledTimeout = vi.fn();
    const cancelSecond = scheduleAttachedAbortFallback(
      "conversation-a",
      () => attached,
      cancelledTimeout,
      10_000,
    );
    cancelSecond();
    vi.advanceTimersByTime(10_000);
    expect(cancelledTimeout).not.toHaveBeenCalled();
    attached = false;
    cancel();
  });

  it("carries the exact workspace generation and document in every run", () => {
    const controller = new AbortController();
    const payload = buildNativeAgentRunPayload({
      prompt: "write",
      onFrame: () => {},
      signal: controller.signal,
      conversationId: conversationIdFor("workspace-a", "book/main.tex"),
      activeFilePath: "book/main.tex",
      workspaceRoot: "/workspace/a",
      workspaceId: "workspace-a",
      workspaceGeneration: 7,
      documentMainFile: "book/main.tex",
    });
    expect(payload).toEqual({
      message: "write",
      conversationId: conversationIdFor("workspace-a", "book/main.tex"),
      workspaceId: "workspace-a",
      workspaceGeneration: 7,
      documentMainFile: "book/main.tex",
      context: {
        activeFilePath: "book/main.tex",
        workspaceRoot: "/workspace/a",
        workspaceId: "workspace-a",
        workspaceGeneration: 7,
        documentMainFile: "book/main.tex",
      },
    });
  });

  it("waits for a scoped terminal event after the user stops", async () => {
    vi.useFakeTimers();
    const host = installHost();
    const controller = new AbortController();
    const conversationId = conversationIdFor("workspace-a", "book/main.tex");
    let resolved = false;
    const resultPromise = runNativeTurn({
      prompt: "write",
      onFrame: () => {},
      signal: controller.signal,
      conversationId,
      workspaceRoot: "/workspace/a",
      workspaceId: "workspace-a",
      workspaceGeneration: 7,
      documentMainFile: "book/main.tex",
    }).then((result) => {
      resolved = true;
      return result;
    });

    controller.abort();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(host.sent.at(-1)).toEqual({
      type: "agent:abort",
      payload: { conversationId },
    });

    host.emit({
      type: "agent:status",
      payload: { conversationId: "code-chat", state: "idle" },
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    host.emit({
      type: "agent:status",
      payload: { conversationId, state: "stopping" },
    });
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(resolved).toBe(false);

    host.emit({
      type: "agent:status",
      payload: { conversationId, state: "idle" },
    });
    await expect(resultPromise).resolves.toMatchObject({ status: "aborted" });
  });

  it("keeps Undo locked after a scoped stopping acknowledgement until its result", async () => {
    vi.useFakeTimers();
    const host = installHost();
    const controller = new AbortController();
    const conversationId = conversationIdFor("workspace-a", "book/main.tex");
    let resolved = false;
    const resultPromise = undoNativeConversation(
      conversationId,
      controller.signal,
    ).then((result) => {
      resolved = true;
      return result;
    });
    const request = host.sent[0]!;
    expect(request.type).toBe("agent:undoLastRunApply");
    const requestId = request.payload?.requestId;
    expect(typeof requestId).toBe("string");

    controller.abort();
    await Promise.resolve();
    expect(host.sent.at(-1)).toEqual({
      type: "agent:abort",
      payload: { conversationId, reason: "user-stop-undo" },
    });
    host.emit({
      type: "agent:status",
      payload: { conversationId: "another-chat", state: "stopping" },
    });
    vi.advanceTimersByTime(9_000);
    await Promise.resolve();
    expect(resolved).toBe(false);

    host.emit({
      type: "agent:status",
      payload: { conversationId, state: "stopping" },
    });
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(resolved).toBe(false);

    host.emit({
      type: "agent:undoResult",
      payload: { conversationId, requestId, ok: true },
    });
    await expect(resultPromise).resolves.toEqual({ ok: true, aborted: true });
  });

  it("keeps a resumable compile error from becoming a completed turn", async () => {
    const host = installHost();
    const controller = new AbortController();
    const conversationId = conversationIdFor("workspace-a", "book/main.tex");
    const frames: string[] = [];
    const resultPromise = runNativeTurn({
      prompt: "write",
      onFrame: (frame) => frames.push(frame.type),
      signal: controller.signal,
      conversationId,
      workspaceRoot: "/workspace/a",
      workspaceId: "workspace-a",
      workspaceGeneration: 7,
      documentMainFile: "book/main.tex",
    });

    host.emit({
      type: "agent:message",
      payload: { conversationId, text: "The edit was saved, but compilation failed." },
    });
    host.emit({
      type: "agent:error",
      payload: { conversationId, message: "A compilation error remains." },
    });
    host.emit({
      type: "agent:status",
      payload: { conversationId, state: "resumable" },
    });

    await expect(resultPromise).resolves.toEqual({
      status: "failed",
      finalText: "The edit was saved, but compilation failed.",
    });
    expect(frames).toContain("error");
  });
});

describe("native workspace lifecycle wiring", () => {
  const source = readFileSync(
    new URL("../src/components/document-workspace.tsx", import.meta.url),
    "utf8",
  );

  it("keeps queued prompts until every native execution gate is ready", () => {
    const drainStart = source.indexOf(
      "const runQueuedTurn = runNativeDocTurnRef.current;",
    );
    const dequeueAt = source.indexOf("takeQueuedPrompt();", drainStart);
    expect(drainStart).toBeGreaterThan(-1);
    expect(dequeueAt).toBeGreaterThan(drainStart);
    const readinessGate = source.slice(drainStart, dequeueAt);
    for (const requiredGate of [
      "queuedPrompts.length === 0",
      "agentWorking",
      "nativeHistoryLoading",
      "nativeTurnStopping",
      "!nativePlatform.canRun",
      "!nativeDocument",
      "!nativeConversationId",
      "!nativeThreadSession",
      "!nativeWorkspaceIdentity.workspaceRoot",
      "!runQueuedTurn",
    ]) {
      expect(readinessGate).toContain(requiredGate);
    }

    const directTurnStart = source.indexOf("const runNativeDocTurn = useCallback");
    expect(source.slice(directTurnStart, drainStart)).not.toContain(
      "takeQueuedPrompt()",
    );
    const runGuardEnd = source.indexOf("onStarted?.();", directTurnStart);
    expect(runGuardEnd).toBeGreaterThan(directTurnStart);
    expect(source.slice(directTurnStart, runGuardEnd)).toContain(
      "!nativePlatform.canRun",
    );
  });

  it("unlocks a recoverable queue even if attached history reload fails", () => {
    const finishStart = source.indexOf("const finishAttachedTurn =");
    const finishEnd = source.indexOf(
      "if (!activeTurnIsCurrent) setNativeHistoryLoading(true);",
      finishStart,
    );
    const finishSource = source.slice(finishStart, finishEnd);
    expect(finishSource).not.toContain("queuedAfterRefresh");
    expect(finishSource).not.toContain("takeQueuedPrompt()");
    expect(finishSource).toContain("setNativeHistoryLoading(false);");
    expect(finishSource).toContain("if (!cancelled && !terminalFailed)");
  });

  it("settles a terminal event that arrives during an idle state lookup", () => {
    const raceBranch = source.match(
      /} else if \(terminalObserved\) \{([\s\S]*?)\n\s*} else if \(/,
    )?.[1];
    expect(raceBranch).toContain("waitingForTerminal = true;");
    expect(raceBranch).toContain("finishAttachedTurn(terminalObserved);");
  });

  it("requests the initial build once per stable workspace/root session", () => {
    const lifecycleStart = source.indexOf(
      "// A desktop conversation is persisted by the app.",
    );
    const lifecycleEnd = source.indexOf(
      "const undoNativeChange = useCallback",
      lifecycleStart,
    );
    const lifecycleSource = source.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycleSource).toContain(
      "nativeInitialBuildSessionRef.current !== nativeThreadSession",
    );
    expect(lifecycleSource).toContain(
      "nativeInitialBuildSessionRef.current = nativeThreadSession",
    );
    expect(lifecycleSource).toContain(
      "requestWorkspaceBuild({ mainFile: nativeMainFile }, nativeWorkspaceIdentity)",
    );
    const dependencies = lifecycleSource.slice(lifecycleSource.lastIndexOf("  }, ["));
    expect(dependencies).toContain("nativeMainFile,");
    expect(dependencies).not.toContain("nativeDocument,");
  });

  it("leaves the post-Undo build exclusively to the desktop host", () => {
    const undoStart = source.indexOf("const undoNativeChange = useCallback");
    const undoEnd = source.indexOf("const confirmSelectionEdit = useCallback", undoStart);
    const undoSource = source.slice(undoStart, undoEnd);
    expect(undoStart).toBeGreaterThanOrEqual(0);
    expect(undoEnd).toBeGreaterThan(undoStart);
    expect(undoSource).toContain("undoNativeConversation(");
    expect(undoSource).toContain("nativeConversationId,");
    expect(undoSource).toContain("controller.signal,");
    expect(undoSource).not.toContain("requestWorkspaceBuild(");
  });
});
