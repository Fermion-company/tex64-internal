/**
 * Real-LLM E2E tests for the autonomous paper-writing agent.
 *
 * Uses the app's own PlatformAccessService + macOS safe storage to authenticate
 * exactly as the running Electron app does. Falls back to GEMINI_API_KEY.
 *
 * Run:
 *   node --test tests/e2e/agent-real-llm.test.mjs
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");
const { PlatformAccessService } = require("../../electron/services/platform-access.cjs");

const TEST_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// Auth: try macOS safe storage → PlatformAccessService
// ---------------------------------------------------------------------------

const tryCreatePlatform = async () => {
  const candidatePaths = [
    path.join(os.homedir(), "Library/Application Support/TeX64 Dev"),
    path.join(os.homedir(), "Library/Application Support/TeX64"),
  ];
  for (const userDataPath of candidatePaths) {
    const sessionFile = path.join(userDataPath, "tex64-platform-session.json");
    const sessionRaw = await fsp.readFile(sessionFile, "utf8").catch(() => null);
    if (!sessionRaw) continue;

    const keychainNames = ["TeX64 Dev Safe Storage", "TeX64 Safe Storage", "tex64 Safe Storage"];
    let keychainKey = null;
    for (const name of keychainNames) {
      try {
        keychainKey = execSync(`security find-generic-password -s "${name}" -w 2>/dev/null`, { timeout: 3000 }).toString().trim();
        if (keychainKey) break;
      } catch { /* try next */ }
    }
    if (!keychainKey) continue;

    const aesKey = crypto.pbkdf2Sync(keychainKey, "saltysalt", 1003, 16, "sha1");
    const decryptString = (buffer) => {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const ciphertext = buf.slice(3); // strip "v10" prefix
      const iv = Buffer.alloc(16, " ");
      const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    };

    const platform = new PlatformAccessService({
      userDataPath,
      decryptString,
      encryptString: () => "",
      isEncryptionAvailable: () => true,
    });

    try {
      const state = await platform.ensureLoadedState();
      if (state?.session?.accessToken) {
        console.log(`[E2E] Platform auth from: ${path.basename(userDataPath)}`);
        return platform;
      }
    } catch (err) {
      console.warn(`[E2E] Platform load failed for ${path.basename(userDataPath)}: ${err.message}`);
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Auth: GEMINI_API_KEY fallback via local proxy
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const startGeminiProxy = (apiKey, model) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400); res.end(); return; }
      const modelName = (typeof body?.model === "string" ? body.model : "").replace(/^models\//i, "") || model;
      const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(modelName)}:generateContent?key=${apiKey}`;
      const upBody = { contents: body.contents, systemInstruction: body.systemInstruction, tools: body.tools, toolConfig: body.toolConfig, generationConfig: body.generationConfig };
      try {
        const up = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upBody) });
        const text = await up.text();
        let payload = text;
        try { const p = JSON.parse(text); p.resolvedModel = modelName; payload = JSON.stringify(p); } catch { /* keep raw */ }
        res.writeHead(up.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err?.message })); }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    server.on("error", reject);
  });

// ---------------------------------------------------------------------------
// Global setup (runs once for all tests)
// ---------------------------------------------------------------------------

let platform = null;
let geminiProxy = null;

const ensureAuth = (() => {
  let cache = null;
  return async () => {
    if (cache !== null) return cache;
    platform = await tryCreatePlatform();
    if (platform) { cache = { mode: "platform" }; return cache; }
    if (GEMINI_API_KEY) {
      geminiProxy = await startGeminiProxy(GEMINI_API_KEY, GEMINI_MODEL);
      process.env.TEX64_AI_PROXY_URL = geminiProxy.url;
      console.log(`[E2E] GEMINI_API_KEY proxy at ${geminiProxy.url}`);
      cache = { mode: "gemini_proxy" }; return cache;
    }
    console.error("\n[SKIP] No auth available. Install TeX64 and log in, or set GEMINI_API_KEY.\n");
    cache = null;
    return null;
  };
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createWorkspace = (rootPath) => ({
  getRootPath: () => rootPath,
  resolvePath: (rel) => path.join(rootPath, rel),
  writeFile: async (rel, content) => {
    const abs = path.join(rootPath, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  },
  listFiles: async () => {
    const walk = async (dir, base = "") => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const result = [];
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) result.push(...await walk(path.join(dir, e.name), rel));
        else result.push(rel);
      }
      return result;
    };
    return walk(rootPath);
  },
});

const createService = (rootPath, overrides = {}) => {
  const service = new AgentService({
    workspace: createWorkspace(rootPath),
    searchService: null,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        model: "gemini-3-flash-preview",
        stream: false,
        autoApply: true,
        autoBuild: false,
        allowRunCommand: false,
        maxIterations: 30,
        maxOutputTokens: 16384,
        temperature: 0.2,
        maxFileBytes: 400_000,
        maxReadFiles: 16,
      }),
      updateAgentSettings: async () => ({}),
    }),
    sendToRenderer: () => {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    buildService: null,
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
    indexerService: null,
    apiUsageService: null,
    auditService: { append: async () => {} },
    sessionsService: null,
    ...overrides,
  });
  if (platform) {
    service.requestAiChat = (payload, options) => platform.requestAiChat(payload, options);
  }
  return service;
};

const collectTools = (service) => {
  const names = [];
  const orig = service.sendToRenderer.bind(service);
  service.sendToRenderer = (type, payload) => {
    if (type === "agent:tool" && payload?.name) names.push(payload.name);
    orig(type, payload);
  };
  return names;
};

// ---------------------------------------------------------------------------
// Test 1: Scaffold a multi-file LaTeX project from scratch
// ---------------------------------------------------------------------------

test("real LLM: agent scaffolds a LaTeX project from scratch", { timeout: TEST_TIMEOUT_MS }, async () => {
  if (!await ensureAuth()) return;

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-scaffold-"));
  try {
    const service = createService(rootPath);
    const tools = collectTools(service);

    await service.run({
      message:
        "空のワークスペースに「深層学習による画像認識」という論文の LaTeX プロジェクトを作成してください。" +
        "main.tex（プリアンブルと \\input）と chapters/introduction.tex（はじめにセクション）を作成してください。",
      context: {},
      conversationId: "e2e-scaffold",
    });

    console.log("[T1] Tools called:", tools);

    const writeTools = tools.filter((n) => ["write_file", "propose_write"].includes(n));
    assert.ok(writeTools.length > 0, `ファイル作成ツールが呼ばれていない (${tools.join(",")})`);

    const mainTex = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8").catch(() => null);
    assert.ok(mainTex !== null, "main.tex が作成されていない");
    assert.match(mainTex, /\\documentclass/, "main.tex に \\documentclass がない");

    const files = await service.workspace.listFiles();
    const texFiles = files.filter((f) => f.endsWith(".tex"));
    assert.ok(texFiles.length >= 2, `複数の .tex ファイルが作成されていない (${files.join(",")})`);

    console.log("[T1] Created files:", files);
    console.log("[T1] main.tex preview:", mainTex.slice(0, 400));
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: Sequential patches — write two sections in one run
// ---------------------------------------------------------------------------

test("real LLM: agent writes multiple sections sequentially (sequential patch fix verified)", { timeout: TEST_TIMEOUT_MS }, async () => {
  if (!await ensureAuth()) return;

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-sections-"));
  try {
    const mainTex = [
      "\\documentclass{article}",
      "\\usepackage[utf8]{inputenc}",
      "\\title{深層学習による画像認識}",
      "\\author{山田太郎}",
      "\\begin{document}",
      "\\maketitle",
      "\\section{はじめに}\\label{sec:intro}",
      "% TODO: write introduction here",
      "\\section{手法}\\label{sec:method}",
      "% TODO: write methodology here",
      "\\end{document}",
    ].join("\n");
    await fsp.writeFile(path.join(rootPath, "main.tex"), mainTex, "utf8");

    const service = createService(rootPath);
    const tools = collectTools(service);

    await service.run({
      message:
        "main.tex の「はじめに」セクションと「手法」セクションの両方を執筆してください。" +
        "% TODO コメントを実際の日本語コンテンツに置き換えてください。",
      context: { activeFilePath: "main.tex", activeFileContent: mainTex },
      conversationId: "e2e-sections",
    });

    console.log("[T2] Tools called:", tools);

    const updated = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    console.log("[T2] Updated main.tex:\n", updated);

    assert.doesNotMatch(updated, /% TODO: write introduction/, "はじめに TODO が残っている");
    assert.doesNotMatch(updated, /% TODO: write methodology/, "手法 TODO が残っている");
    assert.match(updated, /\\documentclass/, "\\documentclass が消えた");
    assert.match(updated, /\\section\{はじめに\}/, "はじめにセクションが消えた");
    assert.match(updated, /\\section\{手法\}/, "手法セクションが消えた");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: get_index guided editing
// ---------------------------------------------------------------------------

test("real LLM: agent uses get_index to read structure before editing", { timeout: TEST_TIMEOUT_MS }, async () => {
  if (!await ensureAuth()) return;

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-index-"));
  try {
    const mainTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{関連研究}\\label{sec:related}",
      "% TODO: survey related work on deep learning",
      "\\end{document}",
    ].join("\n");
    await fsp.writeFile(path.join(rootPath, "main.tex"), mainTex, "utf8");

    const indexerService = {
      buildIndex: async () => ({
        labels: [{ key: "sec:related", file: "main.tex", line: 3 }],
        sections: [{ title: "関連研究", key: "sec:related", file: "main.tex", line: 3 }],
        todos: [{ key: "survey related work", file: "main.tex", line: 4 }],
        references: [], citations: [], figures: [], tables: [],
      }),
    };

    const service = createService(rootPath, { indexerService });
    const tools = collectTools(service);

    await service.run({
      message: "まず get_index でプロジェクト構造を確認してから、関連研究セクションを日本語で執筆してください。",
      context: { activeFilePath: "main.tex", activeFileContent: mainTex },
      conversationId: "e2e-index",
    });

    console.log("[T3] Tools called:", tools);
    assert.ok(tools.includes("get_index"), `get_index が呼ばれていない (${tools.join(",")})`);

    const editTools = ["propose_patch", "patch_file", "write_file", "propose_write"];
    assert.ok(tools.some((n) => editTools.includes(n)), `編集ツールが使われていない (${tools.join(",")})`);

    const updated = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8").catch(() => mainTex);
    console.log("[T3] Updated:", updated);
    assert.ok(updated.length > mainTex.length, "ファイルが変更されていない");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: Build failure → fix → rebuild loop
// ---------------------------------------------------------------------------

test("real LLM: agent detects build failure and applies fix", { timeout: TEST_TIMEOUT_MS }, async () => {
  if (!await ensureAuth()) return;

  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-buildfail-"));
  try {
    const brokenTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "This paper is about \\textbf{deep learning.",  // missing closing brace
      "\\end{document}",
    ].join("\n");
    await fsp.writeFile(path.join(rootPath, "main.tex"), brokenTex, "utf8");

    let buildCallCount = 0;
    const buildService = {
      build: async () => {
        buildCallCount += 1;
        if (buildCallCount === 1) {
          return {
            success: false,
            log: "! Missing } inserted.\n<inserted text> }\nl.4 \\textbf{deep learning.",
            errors: [{ file: "main.tex", line: 4, message: "Missing } inserted." }],
          };
        }
        return { success: true, log: "Build succeeded.", errors: [] };
      },
    };

    const service = createService(rootPath, { buildService });
    const tools = collectTools(service);

    await service.run({
      message: "main.tex をビルドして、エラーがあれば修正し、ビルドが成功するまで繰り返してください。",
      context: { activeFilePath: "main.tex", activeFileContent: brokenTex },
      conversationId: "e2e-buildfail",
    });

    console.log("[T4] Tools called:", tools);
    console.log("[T4] Build call count:", buildCallCount);

    assert.ok(tools.includes("run_build"), `run_build が呼ばれていない (${tools.join(",")})`);

    const editTools = ["propose_patch", "patch_file", "write_file", "propose_write"];
    assert.ok(tools.some((n) => editTools.includes(n)), `修正ツールが使われていない (${tools.join(",")})`);

    const updated = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8").catch(() => brokenTex);
    console.log("[T4] Fixed main.tex:", updated);
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

process.on("exit", () => geminiProxy?.server?.close());
