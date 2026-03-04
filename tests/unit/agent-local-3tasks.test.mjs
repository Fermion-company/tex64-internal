import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");

test("agent completes local search → patch auto-apply → auto-build flow", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-local-"));
  const mainFile = path.join(rootPath, "main.tex");

  const original = [
    "\\documentclass{article}",
    "\\title{Old Title}",
    "\\begin{document}",
    "\\maketitle",
    "Hello",
    "\\end{document}",
    "",
  ].join("\n");

  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const rendererEvents = [];
    const buildCalls = [];

    const workspace = {
      getRootPath: () => rootPath,
      resolvePath: (relativePath) => path.join(rootPath, relativePath),
      writeFile: async (relativePath, content) => {
        await fsp.writeFile(path.join(rootPath, relativePath), content, "utf8");
      },
      listFiles: async () => ["main.tex"],
      rootInfo: async () => ({ path: "main.tex" }),
      resolveTexRootFromMagic: async (relativePath) => relativePath,
      loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
    };

    const ensureUserSettings = () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: true,
        allowRunCommand: false,
        maxIterations: 10,
      }),
      updateAgentSettings: async () => ({}),
    });

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        return {
          kind: "success",
          summary: "ok",
          issues: [],
          pdfPath: null,
          log: "",
        };
      },
    };

    let modelCalls = 0;
    const requestAiChat = async () => {
      modelCalls += 1;

      if (modelCalls === 1) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "search_files",
                      args: { query: "Old Title" },
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      if (modelCalls === 2) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "propose_patch",
                      args: {
                        path: "main.tex",
                        search: "Old Title",
                        replace: "New Title",
                        summary: "Update title",
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "提案を作成しました。差分を確認して適用してください。" }],
            },
          },
        ],
      };
    };

    const service = new AgentService({
      workspace,
      searchService: null,
      ensureUserSettings,
      sendToRenderer: (type, payload) => {
        rendererEvents.push({ type, payload });
      },
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService,
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService: null,
      apiUsageService: null,
      auditService: { append: async () => {} },
      sessionsService: null,
      requestAiChat,
    });

    const context = {
      activeFilePath: "main.tex",
      activeFileContent: original,
      activeFileIsDirty: false,
      activeFileContentLength: original.length,
    };

    await service.run({
      message: "main.tex のタイトルを New Title に変えて、ビルドして確認して。",
      context,
      conversationId: "local-3tasks",
    });

    const contentAfterRun = await fsp.readFile(mainFile, "utf8");
    assert.ok(contentAfterRun.includes("New Title"));
    assert.ok(!contentAfterRun.includes("Old Title"));

    const toolNames = rendererEvents
      .filter((event) => event.type === "agent:tool")
      .map((event) => event.payload?.name)
      .filter(Boolean);

    assert.ok(toolNames.includes("search_files"));
    assert.ok(toolNames.includes("propose_patch"));

    const proposals = Array.from(service.proposals.values());
    assert.equal(proposals.length, 0);

    assert.equal(buildCalls.length, 1);
    assert.equal(buildCalls[0][0], rootPath);
    assert.equal(buildCalls[0][1], "main.tex");
    assert.equal(buildCalls[0][2], "lualatex");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("agent forces auto-apply by default for smoother flow", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-autoapply-"));
  const mainFile = path.join(rootPath, "main.tex");

  const original = [
    "\\documentclass{article}",
    "\\title{Old Title}",
    "\\begin{document}",
    "\\maketitle",
    "Hello",
    "\\end{document}",
    "",
  ].join("\n");

  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const rendererEvents = [];
    const auditEvents = [];

    const workspace = {
      getRootPath: () => rootPath,
      resolvePath: (relativePath) => path.join(rootPath, relativePath),
      writeFile: async (relativePath, content) => {
        await fsp.writeFile(path.join(rootPath, relativePath), content, "utf8");
      },
      listFiles: async () => ["main.tex"],
      rootInfo: async () => ({ path: "main.tex" }),
      resolveTexRootFromMagic: async (relativePath) => relativePath,
      loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
    };

    const ensureUserSettings = () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: false,
        autoBuild: false,
        allowRunCommand: false,
        maxIterations: 10,
      }),
      updateAgentSettings: async () => ({}),
    });

    let modelCalls = 0;
    const requestAiChat = async () => {
      modelCalls += 1;

      if (modelCalls === 1) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "propose_patch",
                      args: {
                        path: "main.tex",
                        search: "Old Title",
                        replace: "New Title",
                        summary: "Update title",
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "提案を作成しました。差分を確認して適用してください。" }],
            },
          },
        ],
      };
    };

    const service = new AgentService({
      workspace,
      searchService: null,
      ensureUserSettings,
      sendToRenderer: (type, payload) => {
        rendererEvents.push({ type, payload });
      },
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService: null,
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService: null,
      apiUsageService: null,
      auditService: { append: async (event) => auditEvents.push(event) },
      sessionsService: null,
      requestAiChat,
    });

    const context = {
      activeFilePath: "main.tex",
      activeFileContent: original,
      activeFileIsDirty: false,
      activeFileContentLength: original.length,
    };

    await service.run({
      message: "main.tex のタイトルを New Title に変えて。",
      context,
      conversationId: "auto-apply",
    });

    const contentAfterRun = await fsp.readFile(mainFile, "utf8");
    assert.ok(contentAfterRun.includes("New Title"));
    assert.ok(!contentAfterRun.includes("Old Title"));

    const proposals = Array.from(service.proposals.values());
    assert.equal(proposals.length, 0);

    const toolEventNames = rendererEvents
      .filter((event) => event.type === "agent:tool")
      .map((event) => event.payload?.name)
      .filter(Boolean);
    assert.ok(toolEventNames.includes("propose_patch"));

    const auditTypes = auditEvents.map((event) => event.eventType).filter(Boolean);
    assert.ok(auditTypes.includes("run_start"));
    assert.ok(auditTypes.includes("tool_call"));
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("agent completes build → fix auto-apply → auto-rebuild flow", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-buildfix-"));
  const mainFile = path.join(rootPath, "main.tex");

  const original = [
    "\\documentclass{article}",
    "\\title{Build Fix}",
    "\\begn{document}",
    "\\maketitle",
    "Hello",
    "\\end{document}",
    "",
  ].join("\n");

  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const rendererEvents = [];
    const buildCalls = [];

    const workspace = {
      getRootPath: () => rootPath,
      resolvePath: (relativePath) => path.join(rootPath, relativePath),
      writeFile: async (relativePath, content) => {
        await fsp.writeFile(path.join(rootPath, relativePath), content, "utf8");
      },
      listFiles: async () => ["main.tex"],
      rootInfo: async () => ({ path: "main.tex" }),
      resolveTexRootFromMagic: async (relativePath) => relativePath,
      loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
    };

    const ensureUserSettings = () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: true,
        allowRunCommand: false,
        maxIterations: 10,
      }),
      updateAgentSettings: async () => ({}),
    });

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        if (buildCalls.length === 1) {
          return {
            kind: "failure",
            summary: "Undefined control sequence",
            issues: [
              {
                severity: "error",
                message: "Undefined control sequence \\begn",
                file: "main.tex",
                line: 3,
              },
            ],
            log: "Undefined control sequence",
            pdfPath: null,
          };
        }
        return {
          kind: "success",
          summary: "ok",
          issues: [],
          pdfPath: null,
          log: "",
        };
      },
    };

    let modelCalls = 0;
    const requestAiChat = async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "run_build", args: {} } }],
              },
            },
          ],
        };
      }
      if (modelCalls === 2) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "propose_patch",
                      args: {
                        path: "main.tex",
                        search: "\\begn{document}",
                        replace: "\\begin{document}",
                        summary: "Fix typo",
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "ビルド失敗を修正する提案を作成しました。適用してください。" }],
            },
          },
        ],
      };
    };

    const service = new AgentService({
      workspace,
      searchService: null,
      ensureUserSettings,
      sendToRenderer: (type, payload) => {
        rendererEvents.push({ type, payload });
      },
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService,
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService: null,
      apiUsageService: null,
      auditService: { append: async () => {} },
      sessionsService: null,
      requestAiChat,
    });

    await service.run({
      message: "ビルドして失敗したら直して、もう一度ビルドして。",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "build-fix",
    });

    assert.equal(buildCalls.length, 2);
    const proposals = Array.from(service.proposals.values());
    assert.equal(proposals.length, 0);

    const contentAfterApply = await fsp.readFile(mainFile, "utf8");
    assert.ok(contentAfterApply.includes("\\begin{document}"));
    assert.ok(!contentAfterApply.includes("\\begn{document}"));

    const toolNames = rendererEvents
      .filter((event) => event.type === "agent:tool")
      .map((event) => event.payload?.name)
      .filter(Boolean);
    assert.ok(toolNames.includes("run_build"));
    assert.ok(toolNames.includes("propose_patch"));
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("agent completes style sweep auto-apply across multiple files", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-agent-style-"));
  const mainFile = path.join(rootPath, "main.tex");
  const chaptersDir = path.join(rootPath, "chapters");
  const introFile = path.join(chaptersDir, "intro.tex");

  await fsp.mkdir(chaptersDir, { recursive: true });
  await fsp.writeFile(mainFile, "teh quick brown fox\n", "utf8");
  await fsp.writeFile(introFile, "teh lazy dog\n", "utf8");

  try {
    const buildCalls = [];

    const workspace = {
      getRootPath: () => rootPath,
      resolvePath: (relativePath) => path.join(rootPath, relativePath),
      writeFile: async (relativePath, content) => {
        const absPath = path.join(rootPath, relativePath);
        await fsp.mkdir(path.dirname(absPath), { recursive: true });
        await fsp.writeFile(absPath, content, "utf8");
      },
      listFiles: async () => ["main.tex", "chapters/intro.tex"],
      rootInfo: async () => ({ path: "main.tex" }),
      resolveTexRootFromMagic: async (relativePath) => relativePath,
      loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
    };

    const ensureUserSettings = () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: false,
        allowRunCommand: false,
        maxIterations: 6,
      }),
      updateAgentSettings: async () => ({}),
    });

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
      },
    };

    let modelCalls = 0;
    const requestAiChat = async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "propose_patch",
                      args: {
                        edits: [
                          { path: "main.tex", search: "teh", replace: "the", replaceAll: true },
                          {
                            path: "chapters/intro.tex",
                            search: "teh",
                            replace: "the",
                            replaceAll: true,
                          },
                        ],
                        summary: "Fix common typo",
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "複数ファイルの修正案を作成しました。適用してください。" }] },
          },
        ],
      };
    };

    const service = new AgentService({
      workspace,
      searchService: null,
      ensureUserSettings,
      sendToRenderer: () => {},
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService,
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService: null,
      apiUsageService: null,
      auditService: { append: async () => {} },
      sessionsService: null,
      requestAiChat,
    });

    await service.run({
      message: "表記ゆれを直して、差分を提案して。",
      context: {},
      conversationId: "style-sweep",
    });

    const proposals = Array.from(service.proposals.values());
    assert.equal(proposals.length, 0);

    const updatedMain = await fsp.readFile(mainFile, "utf8");
    const updatedIntro = await fsp.readFile(introFile, "utf8");
    assert.equal(updatedMain.trim(), "the quick brown fox");
    assert.equal(updatedIntro.trim(), "the lazy dog");
    assert.equal(buildCalls.length, 1);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});
