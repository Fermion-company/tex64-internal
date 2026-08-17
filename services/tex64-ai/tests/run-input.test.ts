import { describe, expect, it } from "vitest";
import {
  createRunReplyInput,
  isRunAwaitingInput,
  recoverableReplySource,
  runRequestIdentity,
  selectConversationRun,
  userFacingRunNote,
} from "@/lib/client/run-input";
import type { AgentRun } from "@/lib/client/types";

function waiting(inputKind: AgentRun["inputKind"] = "clarification"): AgentRun {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    documentId: "30000000-0000-4000-8000-000000000002",
    prompt: "結論を削除して",
    stage: "needs_input",
    status: "waiting_approval",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:01.000Z",
    inputKind,
  };
}

describe("run reply input", () => {
  it("targets a clarification without treating a short answer as approval", () => {
    expect(createRunReplyInput(waiting("clarification"), "はい")).toEqual({
      prompt: "はい",
      replyToRunId: "30000000-0000-4000-8000-000000000001",
    });
  });

  it.each([
    "はい",
    "この変更を承認します",
    "いいえ",
    "キャンセルします",
  ] as const)(
    "keeps %s as a plain free-text reply (no structured decision)",
    (prompt) => {
      expect(createRunReplyInput(waiting(), prompt)).toEqual({
        prompt,
        replyToRunId: "30000000-0000-4000-8000-000000000001",
      });
    },
  );

  it("does not reuse an idempotency identity for the same answer to another question", () => {
    const first = runRequestIdentity(
      "30000000-0000-4000-8000-000000000002",
      "はい",
      {
        prompt: "はい",
        replyToRunId: "30000000-0000-4000-8000-000000000003",
      },
    );
    const second = runRequestIdentity(
      "30000000-0000-4000-8000-000000000002",
      "はい",
      {
        prompt: "はい",
        replyToRunId: "30000000-0000-4000-8000-000000000004",
      },
    );

    expect(first).not.toBe(second);
  });

  it("keeps the persisted clarification target recoverable after a transport failure", () => {
    const source = waiting("clarification");
    const completed: AgentRun = {
      ...source,
      id: "30000000-0000-4000-8000-000000000003",
      status: "completed",
      stage: "ready",
    };

    expect(
      recoverableReplySource([completed, source], {
        prompt: "学部生向けです",
        replyToRunId: source.id,
      }),
    ).toBe(source);
    expect(
      createRunReplyInput(
        recoverableReplySource([completed, source], {
          prompt: "学部生向けです",
          replyToRunId: source.id,
        }),
        "大学院生向けに変更します",
      ),
    ).toEqual({
      prompt: "大学院生向けに変更します",
      replyToRunId: source.id,
    });
  });

  it("does not recover a terminal or unrelated reply source", () => {
    const source = waiting("clarification");
    expect(
      recoverableReplySource(
        [{ ...source, status: "cancelled" }],
        { prompt: "回答", replyToRunId: source.id },
      ),
    ).toBeNull();
    expect(
      recoverableReplySource([source], {
        prompt: "回答",
        replyToRunId: "30000000-0000-4000-8000-000000000099",
      }),
    ).toBeNull();
  });

  it("keeps a still-open question active when its newer response run fails", () => {
    const source = waiting("clarification");
    const failedResponse: AgentRun = {
      ...source,
      id: "30000000-0000-4000-8000-000000000003",
      prompt: "学部生向けです",
      status: "failed",
      stage: "failed",
      createdAt: "2026-08-07T00:00:02.000Z",
      updatedAt: "2026-08-07T00:00:03.000Z",
      inputKind: null,
    };

    const selected = selectConversationRun([failedResponse, source]);
    expect(selected).toBe(source);
    expect(createRunReplyInput(selected, "大学院生向けに変更します")).toEqual({
      prompt: "大学院生向けに変更します",
      replyToRunId: source.id,
    });
  });

  it("selects the newest valid question and lets work in progress take priority", () => {
    const first = waiting("clarification");
    const second: AgentRun = {
      ...first,
      id: "30000000-0000-4000-8000-000000000003",
      createdAt: "2026-08-07T00:00:02.000Z",
      updatedAt: "2026-08-07T00:00:02.000Z",
    };
    const running: AgentRun = {
      ...second,
      id: "30000000-0000-4000-8000-000000000004",
      status: "running",
      stage: "understanding",
      createdAt: "2026-08-07T00:00:03.000Z",
      updatedAt: "2026-08-07T00:00:03.000Z",
      inputKind: null,
    };

    expect(selectConversationRun([first, second])).toBe(second);
    expect(selectConversationRun([first, second, running])).toBe(running);
  });

  it("does not revive an answered question after the flow completes", () => {
    const source = waiting("clarification");
    const answered = { ...source, status: "cancelled" } satisfies AgentRun;
    const completed: AgentRun = {
      ...source,
      id: "30000000-0000-4000-8000-000000000003",
      prompt: "この条件で進めてください",
      status: "completed",
      stage: "ready",
      createdAt: "2026-08-07T00:00:02.000Z",
      updatedAt: "2026-08-07T00:00:03.000Z",
      inputKind: null,
    };

    expect(isRunAwaitingInput(answered)).toBe(false);
    expect(selectConversationRun([completed, answered])).toBe(completed);
    expect(createRunReplyInput(answered, "追記して")).toEqual({ prompt: "追記して" });
  });

  it.each([
    "AIエージェントの自律性について論文を書きます。",
    "agent architectureを比較します。",
    "LaTeXとTeXの歴史を扱います。",
    "コンパイル技術の読者層を教えてください。",
    "最終確認です。題目は「LaTeXコンパイル処理」、この条件で進めますか？",
    "最終確認です。題目は「AIエージェントのtool callingワークフロー」です。",
    "ワークフロー実行とtool callを比較します。",
  ])("keeps ordinary domain content visible: %s", (note) => {
    expect(userFacingRunNote(note, "fallback")).toBe(note);
  });

  it.each([
    "workflowRunId=run_123",
    "toolCallId: call_456",
    "storageKey=/private/artifacts/document.pdf",
    "Error: provider request failed\n    at execute (/workspace/src/run.ts:12:4)",
    "生成元は /private/tmp/tex64/build/main.tex です",
    "providerMetadata: { requestId: 'secret' }",
  ])("withholds concrete internal execution copy: %s", (note) => {
    expect(userFacingRunNote(note, "文書を確認しています。")).toBe(
      "文書を確認しています。",
    );
  });
});
