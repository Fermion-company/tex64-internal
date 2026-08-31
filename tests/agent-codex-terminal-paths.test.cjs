"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  runCodexConversation,
} = require("../electron/services/codex/axiom-adapter.cjs");
const { CodexService } = require("../electron/services/codex/index.cjs");

const makeDeferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const makeHarness = ({ sendMessage, buildResult } = {}) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-codex-test-"));
  fs.writeFileSync(path.join(rootPath, "main.tex"), "\\documentclass{article}\n");
  const conversationId = "codex-test";
  const threadId = "thread-codex-test";
  const events = [];
  const statuses = [];
  const builds = [];
  const conversations = new Map();
  const runningControllers = new Map();
  const codex = new EventEmitter();
  let tokenCounter = 0;
  codex.getStatus = async () => ({ installed: true, authenticated: true });
  codex.ensureThread = async () => threadId;
  codex.sendMessage =
    sendMessage ??
    (async () => {
      queueMicrotask(() => {
        codex.emit("event", {
          type: "turn-completed",
          threadId,
          turnId: "turn-1",
        });
      });
      return { threadId, turnId: "turn-1" };
    });
  codex.interrupt = async () => {};
  codex.quiesceThread = async () => true;
  const service = {
    codexService: codex,
    workspace: {
      getRootPath: () => rootPath,
      listFiles: async () => ["main.tex"],
    },
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({ model: "codex" }),
    }),
    contextByConversation: new Map(),
    workspaceRootByConversation: new Map(),
    agentOptions: { autoBuild: true },
    resolveAgentOptions: () => {},
    buildConversation: (id) => {
      if (!conversations.has(id)) conversations.set(id, []);
      return conversations.get(id);
    },
    markSessionDirty: () => {},
    updateWorkspaceIfNeeded: async () => {},
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    sendStatus: (state, message, id) =>
      statuses.push({ state, message, conversationId: id }),
    executeToolCall: async (toolCall, id) => {
      builds.push({ toolCall, conversationId: id });
      return buildResult ?? { status: "success" };
    },
    startConversationRun: (id) => {
      const controller = new AbortController();
      const token = `codex-run-${++tokenCounter}`;
      runningControllers.set(id, { controller, token });
      return { conversationId: id, controller, token };
    },
    isRunCurrent: (id, token) => runningControllers.get(id)?.token === token,
    finishConversationRun: (id, token) => {
      if (runningControllers.get(id)?.token === token) runningControllers.delete(id);
    },
  };
  return {
    rootPath,
    conversationId,
    threadId,
    events,
    statuses,
    builds,
    conversations,
    runningControllers,
    codex,
    service,
    run: () =>
      runCodexConversation(service, {
        message: "Update the paper",
        context: { activeFilePath: "main.tex", uiLocale: "en" },
        conversationId,
      }),
    cleanup: () => fs.rmSync(rootPath, { recursive: true, force: true }),
  };
};

test("Codex turn ignores terminal and transcript events from another thread", async () => {
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    harness.codex.emit("event", {
      type: "item-completed",
      threadId: "thread-other-chat",
      turnId: "turn-other",
      item: { kind: "agentMessage", text: "wrong chat" },
    });
    harness.codex.emit("event", {
      type: "turn-completed",
      threadId: "thread-other-chat",
      turnId: "turn-other",
    });
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-correct",
        item: { kind: "agentMessage", text: "correct chat" },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-correct",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-correct" };
  };
  try {
    await harness.run();
    const messages = harness.events.filter((event) => event.type === "agent:message");
    assert.deepEqual(messages.map((event) => event.payload.text), ["correct chat"]);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex retries interrupt after turn creation when Stop lands during sendMessage", async () => {
  const started = makeDeferred();
  const releaseSend = makeDeferred();
  let turnReady = false;
  const interruptStates = [];
  const harness = makeHarness({
    sendMessage: async () => {
      started.resolve();
      await releaseSend.promise;
      turnReady = true;
      return { threadId: "thread-codex-test", turnId: "turn-delayed" };
    },
  });
  harness.codex.interrupt = async () => {
    interruptStates.push(turnReady);
    if (turnReady) {
      queueMicrotask(() => {
        harness.codex.emit("event", {
          type: "turn-failed",
          threadId: harness.threadId,
          turnId: "turn-delayed",
          error: "interrupted",
        });
      });
    }
  };
  try {
    const pending = harness.run();
    await started.promise;
    harness.runningControllers.get(harness.conversationId).controller.abort();
    releaseSend.resolve();
    await pending;
    assert.deepEqual(interruptStates, [false, true]);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
    assert.equal(harness.builds.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("Codex backend failure after a TeX write performs exactly one real build", async () => {
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      fs.appendFileSync(path.join(harness.rootPath, "main.tex"), "changed\n");
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-failed",
        item: {
          kind: "fileChange",
          status: "completed",
          changes: [{ path: "main.tex", kind: "update" }],
        },
      });
      harness.codex.emit("event", {
        type: "turn-failed",
        threadId: harness.threadId,
        turnId: "turn-failed",
        error: "backend failed",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-failed" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 1);
    assert.equal(harness.builds[0].toolCall.name, "run_build");
    assert.match(
      harness.events.find((event) => event.type === "agent:error")?.payload.message ?? "",
      /backend failed/,
    );
    assert.equal(harness.statuses.at(-1)?.state, "error");
  } finally {
    harness.cleanup();
  }
});

test("Codex compile failure is terminally resumable and is never retried", async () => {
  const harness = makeHarness({ buildResult: { status: "failure" } });
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-build-failed",
        item: {
          kind: "fileChange",
          status: "completed",
          changes: [{ path: "main.tex", kind: "update" }],
        },
      });
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-build-failed",
        item: { kind: "agentMessage", text: "Updated the paper." },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-build-failed",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-build-failed" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 1);
    assert.equal(harness.statuses.at(-1)?.state, "resumable");
    assert.match(
      harness.events.find((event) => event.type === "agent:message")?.payload.text ?? "",
      /compilation error remains/,
    );
  } finally {
    harness.cleanup();
  }
});

test("Codex Stop after a completed TeX write settles one build before idle", async () => {
  const fileWritten = makeDeferred();
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-stop-after-write",
        item: {
          kind: "fileChange",
          status: "completed",
          changes: [{ path: "main.tex", kind: "update" }],
        },
      });
      fileWritten.resolve();
    });
    return { threadId: harness.threadId, turnId: "turn-stop-after-write" };
  };
  harness.codex.interrupt = async () => {
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "turn-failed",
        threadId: harness.threadId,
        turnId: "turn-stop-after-write",
        error: "interrupted",
      });
    });
  };
  try {
    const pending = harness.run();
    await fileWritten.promise;
    harness.runningControllers.get(harness.conversationId).controller.abort();
    await pending;
    assert.equal(harness.builds.length, 1);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex read-only command reconciles snapshots without an unnecessary build", async () => {
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-read-only",
        item: { kind: "commandExecution", command: "find . -name '*.tex'", exitCode: 0 },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-read-only",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-read-only" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 0);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex command-only file mutation refreshes the buffer and builds exactly once", async () => {
  const harness = makeHarness();
  const original = fs.readFileSync(path.join(harness.rootPath, "main.tex"), "utf8");
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      fs.appendFileSync(path.join(harness.rootPath, "main.tex"), "changed by command\n");
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-command-write",
        item: {
          kind: "commandExecution",
          command: "sed -n '1,10w main.tex' source.tex",
          exitCode: 0,
        },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-command-write",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-command-write" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 1);
    const apply = harness.events.find((event) => event.type === "agent:applyContent");
    assert.equal(apply?.payload.path, "main.tex");
    assert.equal(apply?.payload.expectedContent, original);
    assert.match(apply?.payload.content ?? "", /changed by command/);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex discards a stale event from another turn in the same thread", async () => {
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    harness.codex.emit("event", {
      type: "item-completed",
      threadId: harness.threadId,
      turnId: "turn-stale",
      item: {
        kind: "fileChange",
        status: "completed",
        changes: [{ path: "main.tex", kind: "update" }],
      },
    });
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-current",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-current" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 0);
    assert.equal(
      harness.events.some((event) => event.type === "agent:applyContent"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("Codex Stop during auth finishes without starting a workspace scan", async () => {
  const authStarted = makeDeferred();
  const never = new Promise(() => {});
  const harness = makeHarness();
  let listCalls = 0;
  harness.codex.getStatus = async () => {
    authStarted.resolve();
    return never;
  };
  harness.service.workspace.listFiles = async () => {
    listCalls += 1;
    return never;
  };
  try {
    const pending = harness.run();
    await authStarted.promise;
    harness.runningControllers.get(harness.conversationId).controller.abort();
    const outcome = await Promise.race([
      pending.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(outcome, "settled");
    assert.equal(listCalls, 0);
    assert.equal(harness.builds.length, 0);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex terminal snapshot timeout refreshes known buffers and stays resumable", async () => {
  const never = new Promise(() => {});
  const harness = makeHarness();
  const original = fs.readFileSync(path.join(harness.rootPath, "main.tex"), "utf8");
  let listCalls = 0;
  harness.service.codexWorkspaceSnapshotTimeoutMs = 50;
  harness.service.codexWorkspaceEnumerator = async () => {
    listCalls += 1;
    return listCalls === 1
      ? { files: ["main.tex"], complete: true }
      : never;
  };
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      fs.appendFileSync(path.join(harness.rootPath, "main.tex"), "changed before timeout\n");
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-snapshot-timeout",
        item: { kind: "commandExecution", command: "find . -name '*.tex'", exitCode: 0 },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-snapshot-timeout",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-snapshot-timeout" };
  };
  try {
    const startedAt = Date.now();
    await harness.run();
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(listCalls, 2);
    assert.equal(harness.builds.length, 1);
    const apply = harness.events.find((event) => event.type === "agent:applyContent");
    assert.equal(apply?.payload.expectedContent, original);
    assert.match(apply?.payload.content ?? "", /changed before timeout/);
    assert.match(
      harness.events.find((event) => event.type === "agent:error")?.payload.message ?? "",
      /Reload TeX64/,
    );
    assert.equal(harness.statuses.at(-1)?.state, "resumable");
  } finally {
    harness.cleanup();
  }
});

test("Codex snapshots extensionless TeX inputs and latexmk configuration", async () => {
  const harness = makeHarness();
  fs.writeFileSync(path.join(harness.rootPath, "preamble"), "before\n");
  fs.writeFileSync(path.join(harness.rootPath, ".latexmkrc"), "$pdf_mode = 1;\n");
  harness.service.workspace.listFiles = async () => ["main.tex", "preamble", ".latexmkrc"];
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      fs.writeFileSync(path.join(harness.rootPath, "preamble"), "after\n");
      fs.appendFileSync(path.join(harness.rootPath, ".latexmkrc"), "$silent = 1;\n");
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-config-write",
        item: { kind: "commandExecution", command: "update build inputs", exitCode: 0 },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-config-write",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-config-write" };
  };
  try {
    await harness.run();
    assert.equal(harness.builds.length, 1);
    const applies = harness.events
      .filter((event) => event.type === "agent:applyContent")
      .map((event) => event.payload.path)
      .sort();
    assert.deepEqual(applies, [".latexmkrc", "preamble"]);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex does not start when the initial workspace snapshot fails", async () => {
  const harness = makeHarness();
  let sends = 0;
  harness.service.codexWorkspaceEnumerator = async () => {
    throw new Error("list failed");
  };
  harness.codex.sendMessage = async () => {
    sends += 1;
    return { threadId: harness.threadId, turnId: "must-not-start" };
  };
  try {
    await harness.run();
    assert.equal(sends, 0);
    assert.equal(harness.builds.length, 0);
    assert.match(
      harness.events.find((event) => event.type === "agent:error")?.payload.message ?? "",
      /list failed/,
    );
    assert.equal(harness.statuses.at(-1)?.state, "error");
  } finally {
    harness.cleanup();
  }
});

test("Codex waits for background terminal cleanup before snapshot and build", async () => {
  const harness = makeHarness();
  const original = fs.readFileSync(path.join(harness.rootPath, "main.tex"), "utf8");
  let cleanupCalls = 0;
  harness.codex.quiesceThread = async () => {
    cleanupCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.appendFileSync(path.join(harness.rootPath, "main.tex"), "late background write\n");
    return true;
  };
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-background",
        item: {
          kind: "commandExecution",
          command: "background writer",
          exitCode: 0,
        },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-background",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-background" };
  };

  try {
    await harness.run();
    assert.equal(cleanupCalls, 1);
    assert.equal(harness.builds.length, 1);
    const apply = harness.events.find((event) => event.type === "agent:applyContent");
    assert.equal(apply?.payload.expectedContent, original);
    assert.match(apply?.payload.content ?? "", /late background write/);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex background terminal cleanup terminates and verifies every writer", async () => {
  const requests = [];
  let listCount = 0;
  const service = new CodexService();
  service.client = {
    isRunning: () => true,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method.endsWith("/list")) {
        listCount += 1;
        return listCount === 1
          ? {
              data: [{ processId: "process-1" }],
              nextCursor: null,
            }
          : { data: [], nextCursor: null };
      }
      if (method.endsWith("/terminate")) return { terminated: true };
      return {};
    },
  };
  service.sessions.set("conversation", {
    threadId: "thread-1",
    cwd: "/workspace",
  });

  assert.equal(await service.quiesceThread("conversation", "thread-1"), true);
  assert.deepEqual(
    requests.map((entry) => entry.method),
    [
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/terminate",
      "thread/backgroundTerminals/clean",
      "thread/backgroundTerminals/list",
    ],
  );
});

test("Codex publishes a newly created text file with missing-file CAS", async () => {
  const harness = makeHarness();
  harness.codex.sendMessage = async () => {
    queueMicrotask(() => {
      fs.writeFileSync(path.join(harness.rootPath, "chapter.tex"), "New chapter\n");
      harness.codex.emit("event", {
        type: "item-completed",
        threadId: harness.threadId,
        turnId: "turn-create-file",
        item: {
          kind: "fileChange",
          status: "completed",
          changes: [{ path: "chapter.tex", kind: "create" }],
        },
      });
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-create-file",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-create-file" };
  };

  try {
    await harness.run();
    const applies = harness.events.filter(
      (event) =>
        event.type === "agent:applyContent" && event.payload.path === "chapter.tex",
    );
    assert.equal(applies.length, 1);
    assert.equal(applies[0].payload.content, "New chapter\n");
    assert.equal(applies[0].payload.expectedFileMissing, true);
    assert.equal(harness.builds.length, 1);
    assert.equal(harness.statuses.at(-1)?.state, "idle");
  } finally {
    harness.cleanup();
  }
});

test("Codex normalizes failed and interrupted completed-turn statuses", () => {
  for (const [status, error, expectedMessage] of [
    ["failed", { message: "sandbox denied" }, "sandbox denied"],
    ["interrupted", null, "Codex turn was interrupted."],
  ]) {
    const service = new CodexService();
    const events = [];
    service.on("event", (event) => events.push(event));
    service.turnByThread.set("thread-status", "turn-status");

    service._onNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-status",
        turn: { id: "turn-status", status, error },
      },
    });

    assert.deepEqual(events, [
      {
        type: "turn-failed",
        threadId: "thread-status",
        turnId: "turn-status",
        error: expectedMessage,
      },
    ]);
    assert.equal(service.turnByThread.has("thread-status"), false);
  }
});

test("Codex bootstraps bounded persisted chat context only for a recreated thread", async () => {
  const sentTexts = [];
  const harness = makeHarness();
  harness.conversations.set(harness.conversationId, [
    { role: "user", content: "Use theorem style A." },
    { role: "assistant", content: "I updated the theorem style." },
  ]);
  harness.codex.threadIdFor = () => null;
  harness.codex.sendMessage = async ({ text: prompt }) => {
    sentTexts.push(prompt);
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-restored",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-restored" };
  };

  try {
    await harness.run();
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0], /Codex thread was recreated/);
    assert.match(sentTexts[0], /User: Use theorem style A\./);
    assert.match(sentTexts[0], /Assistant: I updated the theorem style\./);
    assert.match(sentTexts[0], /User prompt: Update the paper/);
  } finally {
    harness.cleanup();
  }
});

test("Codex does not replay persisted chat into an already-bound thread", async () => {
  let sentText = "";
  const harness = makeHarness();
  harness.conversations.set(harness.conversationId, [
    { role: "user", content: "Earlier request" },
    { role: "assistant", content: "Earlier response" },
  ]);
  harness.codex.threadIdFor = () => harness.threadId;
  harness.codex.sendMessage = async ({ text: prompt }) => {
    sentText = prompt;
    queueMicrotask(() => {
      harness.codex.emit("event", {
        type: "turn-completed",
        threadId: harness.threadId,
        turnId: "turn-bound",
      });
    });
    return { threadId: harness.threadId, turnId: "turn-bound" };
  };

  try {
    await harness.run();
    assert.doesNotMatch(sentText, /Earlier request|Earlier response|recreated/);
    assert.match(sentText, /User prompt: Update the paper/);
  } finally {
    harness.cleanup();
  }
});
