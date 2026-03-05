/**
 * E2E-style unit tests for autonomous paper writing capabilities.
 *
 * Verifies that the agent can perform the full range of operations needed for
 * a paper-writing workflow similar to Codex / Cursor / Claude Code:
 *
 *  1. Scaffold a multi-file LaTeX project from scratch
 *  2. Use get_index to guide edits (label/section/citation awareness)
 *  3. Read multiple files then produce coordinated edits
 *  4. Use the scratchpad for planning before writing
 *  5. Manage bibliography files and citations
 *  6. Run build → detect failure → patch → rebuild autonomously
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const createWorkspace = (rootPath, fileList = null) => ({
  getRootPath: () => rootPath,
  resolvePath: (relativePath) => path.join(rootPath, relativePath),
  writeFile: async (relativePath, content) => {
    const absPath = path.join(rootPath, relativePath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, content, "utf8");
  },
  listFiles: async () => {
    if (fileList) return fileList;
    const walk = async (dir, base = "") => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const result = [];
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) {
          result.push(...(await walk(path.join(dir, e.name), rel)));
        } else {
          result.push(rel);
        }
      }
      return result;
    };
    return walk(rootPath);
  },
  rootInfo: async () => ({ path: "main.tex" }),
  resolveTexRootFromMagic: async (relativePath) => relativePath,
  loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
});

const createService = (rootPath, overrides = {}) =>
  new AgentService({
    workspace: createWorkspace(rootPath),
    searchService: null,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild: overrides.autoBuild ?? false,
        allowRunCommand: true,
        maxIterations: overrides.maxIterations ?? 15,
      }),
      updateAgentSettings: async () => ({}),
    }),
    sendToRenderer: () => {},
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: () => {},
    buildService: overrides.buildService ?? null,
    sendBuildState: () => {},
    sendBuildLog: () => {},
    sendIssues: () => {},
    indexerService: overrides.indexerService ?? null,
    apiUsageService: null,
    auditService: { append: async () => {} },
    sessionsService: null,
    requestAiChat: overrides.requestAiChat ?? null,
  });

const fileExists = async (p) => fsp.stat(p).then((s) => s.isFile()).catch(() => false);
const dirExists = async (p) => fsp.stat(p).then((s) => s.isDirectory()).catch(() => false);

// ---------------------------------------------------------------------------
// Test 1: Scaffold a complete multi-file LaTeX paper from scratch
// ---------------------------------------------------------------------------
test("agent scaffolds a multi-file paper project from scratch", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-scaffold-"));
  const buildCalls = [];
  const rendererEvents = [];

  try {
    const mainTexContent = [
      "\\documentclass{article}",
      "\\title{深層学習による画像認識}",
      "\\author{山田太郎}",
      "\\begin{document}",
      "\\maketitle",
      "\\input{chapters/introduction}",
      "\\input{chapters/methodology}",
      "\\input{chapters/conclusion}",
      "\\bibliography{references}",
      "\\bibliographystyle{plain}",
      "\\end{document}",
      "",
    ].join("\n");

    const introContent = [
      "\\section{はじめに}\\label{sec:intro}",
      "画像認識は、コンピュータビジョンの中心的な課題の一つである。",
      "深層学習の登場により、この分野は飛躍的に発展した。",
      "",
    ].join("\n");

    const methodContent = [
      "\\section{手法}\\label{sec:method}",
      "本研究では、畳み込みニューラルネットワーク (CNN) を用いた手法を提案する。",
      "",
    ].join("\n");

    const conclusionContent = [
      "\\section{結論}\\label{sec:conclusion}",
      "本論文では、深層学習を用いた画像認識手法を提案・評価した。",
      "実験により、提案手法の有効性を確認した。",
      "",
    ].join("\n");

    const bibContent = [
      "@article{lecun1989,",
      "  author  = {LeCun, Yann and others},",
      "  title   = {Backpropagation Applied to Handwritten Zip Code Recognition},",
      "  journal = {Neural Computation},",
      "  year    = {1989},",
      "}",
      "",
    ].join("\n");

    let modelCalls = 0;
    const requestAiChat = async () => {
      modelCalls += 1;
      // Turn 1: create chapters/ directory
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_create_directory",
              args: { path: "chapters", summary: "章ディレクトリを作成" },
            }}] },
          }],
        };
      }
      // Turn 2: write main.tex
      if (modelCalls === 2) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: { path: "main.tex", content: mainTexContent, summary: "main.tex を作成" },
            }}] },
          }],
        };
      }
      // Turn 3: write introduction
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: { path: "chapters/introduction.tex", content: introContent, summary: "はじめにセクション" },
            }}] },
          }],
        };
      }
      // Turn 4: write methodology
      if (modelCalls === 4) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: { path: "chapters/methodology.tex", content: methodContent, summary: "手法セクション" },
            }}] },
          }],
        };
      }
      // Turn 5: write conclusion
      if (modelCalls === 5) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: { path: "chapters/conclusion.tex", content: conclusionContent, summary: "結論セクション" },
            }}] },
          }],
        };
      }
      // Turn 6: write bibliography
      if (modelCalls === 6) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: { path: "references.bib", content: bibContent, summary: "参考文献ファイル" },
            }}] },
          }],
        };
      }
      // Turn 7: run build to verify
      if (modelCalls === 7) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "run_build",
              args: { mainFile: "main.tex", engine: "lualatex" },
            }}] },
          }],
        };
      }
      // Turn 8: final message
      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "論文プロジェクトを作成しました。全セクションと参考文献ファイルが用意されています。" }] },
        }],
      };
    };

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        return { kind: "success", summary: "ビルド成功", issues: [], pdfPath: null, log: "" };
      },
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 15,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      message: "画像認識の深層学習に関する論文プロジェクトを作成して。タイトルは「深層学習による画像認識」、著者は「山田太郎」。chapters/ ディレクトリにセクションを分けて、参考文献ファイルも作成して、最後にビルドして確認して。",
      context: {},
      conversationId: "paper-scaffold",
    });

    // Verify directory was created
    assert.ok(await dirExists(path.join(rootPath, "chapters")), "chapters/ ディレクトリが存在しない");

    // Verify all files were created
    assert.ok(await fileExists(path.join(rootPath, "main.tex")), "main.tex が存在しない");
    assert.ok(await fileExists(path.join(rootPath, "chapters/introduction.tex")), "chapters/introduction.tex が存在しない");
    assert.ok(await fileExists(path.join(rootPath, "chapters/methodology.tex")), "chapters/methodology.tex が存在しない");
    assert.ok(await fileExists(path.join(rootPath, "chapters/conclusion.tex")), "chapters/conclusion.tex が存在しない");
    assert.ok(await fileExists(path.join(rootPath, "references.bib")), "references.bib が存在しない");

    // Verify content
    const main = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(main, /深層学習による画像認識/, "main.tex にタイトルがない");
    assert.match(main, /山田太郎/, "main.tex に著者がない");
    assert.match(main, /\\input\{chapters\/introduction\}/, "main.tex に \\input がない");

    const intro = await fsp.readFile(path.join(rootPath, "chapters/introduction.tex"), "utf8");
    assert.match(intro, /\\section\{はじめに\}/, "introduction.tex にセクションがない");
    assert.match(intro, /\\label\{sec:intro\}/, "introduction.tex にラベルがない");

    const bib = await fsp.readFile(path.join(rootPath, "references.bib"), "utf8");
    assert.match(bib, /lecun1989/, "references.bib に引用エントリがない");

    // Verify build was called
    assert.equal(buildCalls.length, 1, "ビルドが呼ばれていない");

    // Verify tool event sequence
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name)
      .filter(Boolean);
    assert.ok(toolNames.includes("propose_create_directory"), "create_directory が呼ばれていない");
    assert.ok(toolNames.includes("write_file"), "write_file が呼ばれていない");
    assert.ok(toolNames.includes("run_build"), "run_build が呼ばれていない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: get_index guided editing — agent reads existing structure before editing
// ---------------------------------------------------------------------------
test("agent uses get_index to inspect labels and citations before adding content", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-index-"));

  try {
    // Create an existing paper with some structure
    const mainTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{はじめに}\\label{sec:intro}",
      "% TODO: write introduction",
      "\\section{手法}\\label{sec:method}",
      "% TODO: write methodology",
      "\\end{document}",
      "",
    ].join("\n");
    await fsp.writeFile(path.join(rootPath, "main.tex"), mainTex, "utf8");

    // Mock indexer that returns existing structure
    const indexerService = {
      buildIndex: async () => ({
        labels: [
          { key: "sec:intro", file: "main.tex", line: 3 },
          { key: "sec:method", file: "main.tex", line: 5 },
        ],
        references: [],
        citations: [],
        sections: [
          { title: "はじめに", key: "sec:intro", file: "main.tex", line: 3 },
          { title: "手法", key: "sec:method", file: "main.tex", line: 5 },
        ],
        figures: [],
        tables: [],
        todos: [
          { key: "write introduction", file: "main.tex", line: 4 },
          { key: "write methodology", file: "main.tex", line: 6 },
        ],
      }),
    };

    const rendererEvents = [];
    let modelCalls = 0;
    let indexCallMade = false;

    const requestAiChat = async (payload) => {
      modelCalls += 1;

      // Turn 1: agent consults the index
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "get_index",
              args: { kinds: ["sections", "labels", "todos"] },
            }}] },
          }],
        };
      }

      // Turn 2: after seeing the index, agent writes the introduction
      if (modelCalls === 2) {
        // Check that the tool response contains the index data
        const contents = payload?.contents ?? [];
        const lastTool = contents.slice().reverse().find((c) => c.role === "tool");
        if (lastTool) {
          const resp = lastTool.parts?.[0]?.functionResponse?.response;
          if (resp?.index?.sections?.length > 0) {
            indexCallMade = true;
          }
        }
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "% TODO: write introduction",
                replace: "画像認識は、コンピュータビジョンの中心的な課題である。\n深層学習の登場により、この分野は急速に発展した。",
                summary: "はじめにセクションを執筆",
              },
            }}] },
          }],
        };
      }

      // Turn 3: write methodology too
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "% TODO: write methodology",
                replace: "本研究では、ResNet アーキテクチャに基づく手法を提案する。\n各レイヤーに残差接続を導入することで、勾配消失問題を解決した。",
                summary: "手法セクションを執筆",
              },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "インデックスを確認の上、はじめにと手法セクションを執筆しました。" }] },
        }],
      };
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService: null,
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService,
      apiUsageService: null,
      auditService: { append: async () => {} },
      sessionsService: null,
      requestAiChat,
    });

    await service.run({
      message: "インデックスを確認してから、はじめにと手法のセクションを執筆してください。",
      context: { activeFilePath: "main.tex", activeFileContent: mainTex },
      conversationId: "index-guided",
    });

    // Verify index was consulted
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("get_index"), "get_index が呼ばれていない");
    assert.ok(indexCallMade, "インデックスの内容がAIに渡されていない");

    // Verify content was written
    const updated = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(updated, /画像認識は、コンピュータビジョン/, "はじめにセクションが書かれていない");
    assert.match(updated, /ResNet アーキテクチャ/, "手法セクションが書かれていない");
    assert.doesNotMatch(updated, /% TODO: write introduction/, "TODO が残っている");
    assert.doesNotMatch(updated, /% TODO: write methodology/, "TODO が残っている");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: Multi-file reading then coordinated edits across files
// ---------------------------------------------------------------------------
test("agent reads multiple chapter files and produces coordinated cross-file edits", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-multifile-"));

  try {
    // Create project structure
    await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });
    await fsp.writeFile(path.join(rootPath, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{chapters/introduction}",
      "\\input{chapters/methodology}",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(rootPath, "chapters/introduction.tex"), [
      "\\section{Introduction}",
      "This paper presents a novel approach.",
      "",
    ].join("\n"), "utf8");
    await fsp.writeFile(path.join(rootPath, "chapters/methodology.tex"), [
      "\\section{Methodology}",
      "We use a CNN-based approach.",
      "",
    ].join("\n"), "utf8");

    const rendererEvents = [];
    let modelCalls = 0;
    let readFilesCallMade = false;

    const requestAiChat = async (payload) => {
      modelCalls += 1;

      // Turn 1: agent reads both chapter files
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "read_files",
              args: { paths: ["chapters/introduction.tex", "chapters/methodology.tex"] },
            }}] },
          }],
        };
      }

      // Turn 2: after reading, apply coordinated batch edits
      if (modelCalls === 2) {
        const contents = payload?.contents ?? [];
        const lastTool = contents.slice().reverse().find((c) => c.role === "tool");
        if (lastTool?.parts?.[0]?.functionResponse?.response?.files) {
          readFilesCallMade = true;
        }
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                edits: [
                  {
                    path: "chapters/introduction.tex",
                    search: "This paper presents a novel approach.",
                    replace: "This paper presents a novel deep learning approach for image recognition.\n\\cite{lecun1989} pioneered this field.",
                  },
                  {
                    path: "chapters/methodology.tex",
                    search: "We use a CNN-based approach.",
                    replace: "We use a ResNet-based CNN architecture \\cite{he2016resnet}.\nThe model is trained on ImageNet for 100 epochs.",
                  },
                ],
                summary: "両章に詳細な内容を追加",
              },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "複数ファイルを読み取り、協調的に内容を更新しました。" }] },
        }],
      };
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      requestAiChat,
    });

    await service.run({
      message: "introduction と methodology の章を読んで、それぞれに詳細な内容と引用を追加してください。",
      context: {},
      conversationId: "multifile-edit",
    });

    // Verify read_files was used
    assert.ok(readFilesCallMade, "read_files の結果がAIに渡されていない");

    // Verify both files were updated
    const intro = await fsp.readFile(path.join(rootPath, "chapters/introduction.tex"), "utf8");
    assert.match(intro, /deep learning approach for image recognition/, "introduction が更新されていない");
    assert.match(intro, /\\cite\{lecun1989\}/, "introduction に引用が追加されていない");

    const method = await fsp.readFile(path.join(rootPath, "chapters/methodology.tex"), "utf8");
    assert.match(method, /ResNet-based CNN architecture/, "methodology が更新されていない");
    assert.match(method, /\\cite\{he2016resnet\}/, "methodology に引用が追加されていない");

    // Verify batch edit tool was used
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("read_files"), "read_files が呼ばれていない");
    assert.ok(toolNames.includes("propose_patch"), "propose_patch が呼ばれていない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: Scratchpad-guided writing — plan first, then write
// ---------------------------------------------------------------------------
test("agent uses scratchpad for outlining before writing paper sections", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-scratch-"));

  try {
    await fsp.writeFile(path.join(rootPath, "main.tex"), [
      "\\documentclass{article}",
      "\\title{Deep Learning Survey}",
      "\\begin{document}",
      "\\maketitle",
      "% sections will be added here",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");

    const rendererEvents = [];
    let modelCalls = 0;

    const requestAiChat = async () => {
      modelCalls += 1;

      // Turn 1: write plan to scratchpad
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_scratchpad",
              args: {
                content: [
                  "論文構成計画:",
                  "1. はじめに: 深層学習の歴史と重要性 (2段落)",
                  "2. 手法: CNNアーキテクチャの説明 (3段落)",
                  "3. 実験: ImageNet データセットでの評価 (2段落)",
                  "4. 結論: まとめと今後の展望 (1段落)",
                ].join("\n"),
                mode: "replace",
              },
            }}] },
          }],
        };
      }

      // Turn 2: read scratchpad to confirm plan
      if (modelCalls === 2) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "read_scratchpad",
              args: {},
            }}] },
          }],
        };
      }

      // Turn 3: based on plan, write the sections into main.tex
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "% sections will be added here",
                replace: [
                  "\\section{はじめに}",
                  "深層学習は、人工知能の一分野であり、多層のニューラルネットワークを用いた学習手法である。",
                  "LeCun らによる研究 \\cite{lecun1989} 以来、この分野は急速に発展してきた。",
                  "",
                  "\\section{手法}",
                  "本研究では、残差接続を持つ畳み込みニューラルネットワーク (ResNet) を採用する。",
                  "各ブロックは 3×3 の畳み込み層とバッチ正規化層から構成される。",
                  "",
                  "\\section{実験}",
                  "ImageNet ILSVRC 2012 データセットを用いて評価を行った。",
                  "提案手法は Top-1 精度 76.1\\% を達成した。",
                  "",
                  "\\section{結論}",
                  "本論文では、深層学習を用いた画像認識手法を提案・評価した。",
                  "今後の課題として、少量データへの対応と計算効率の改善が挙げられる。",
                ].join("\n"),
                summary: "スクラッチパッドの計画に基づいてセクションを執筆",
              },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "計画を立てた後、スクラッチパッドに基づいて論文セクションを執筆しました。" }] },
        }],
      };
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      requestAiChat,
    });

    await service.run({
      message: "まずスクラッチパッドに論文の構成計画を書いてから、その計画に基づいて main.tex にセクションを執筆してください。",
      context: { activeFilePath: "main.tex" },
      conversationId: "scratchpad-plan",
    });

    // Verify scratchpad was used
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("write_scratchpad"), "write_scratchpad が呼ばれていない");
    assert.ok(toolNames.includes("read_scratchpad"), "read_scratchpad が呼ばれていない");
    assert.ok(toolNames.includes("propose_patch"), "propose_patch が呼ばれていない");

    // Verify scratchpad has the plan
    const cid = "scratchpad-plan";
    const scratchpad = service.scratchpadByConversation.get(cid) ?? "";
    assert.match(scratchpad, /論文構成計画/, "スクラッチパッドに計画がない");
    assert.match(scratchpad, /はじめに/, "スクラッチパッドにセクション情報がない");

    // Verify content was written to main.tex
    const updated = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(updated, /\\section\{はじめに\}/, "はじめにセクションが書かれていない");
    assert.match(updated, /\\section\{手法\}/, "手法セクションが書かれていない");
    assert.match(updated, /\\section\{実験\}/, "実験セクションが書かれていない");
    assert.match(updated, /\\section\{結論\}/, "結論セクションが書かれていない");
    assert.doesNotMatch(updated, /% sections will be added here/, "プレースホルダーが残っている");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: Bibliography workflow — create bib + integrate into document
// ---------------------------------------------------------------------------
test("agent creates bibliography file and integrates it into the paper", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-bib-"));
  const buildCalls = [];

  try {
    await fsp.writeFile(path.join(rootPath, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "深層学習は画像認識に革命をもたらした \\cite{goodfellow2016}。",
      "% bibliography goes here",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");

    const rendererEvents = [];
    let modelCalls = 0;

    const requestAiChat = async () => {
      modelCalls += 1;

      // Turn 1: create bibliography file
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: {
                path: "references.bib",
                content: [
                  "@book{goodfellow2016,",
                  "  author    = {Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron},",
                  "  title     = {Deep Learning},",
                  "  publisher = {MIT Press},",
                  "  year      = {2016},",
                  "  url       = {http://www.deeplearningbook.org},",
                  "}",
                  "",
                  "@inproceedings{krizhevsky2012imagenet,",
                  "  author    = {Krizhevsky, Alex and Sutskever, Ilya and Hinton, Geoffrey E},",
                  "  title     = {ImageNet Classification with Deep Convolutional Neural Networks},",
                  "  booktitle = {Advances in Neural Information Processing Systems},",
                  "  year      = {2012},",
                  "}",
                  "",
                ].join("\n"),
                summary: "参考文献ファイルを作成",
              },
            }}] },
          }],
        };
      }

      // Turn 2: integrate bibliography into main.tex
      if (modelCalls === 2) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "% bibliography goes here",
                replace: "\\bibliographystyle{plain}\n\\bibliography{references}",
                summary: "参考文献コマンドを追加",
              },
            }}] },
          }],
        };
      }

      // Turn 3: run build to verify
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "run_build",
              args: { mainFile: "main.tex" },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "参考文献ファイルを作成し、論文に統合しました。ビルドも成功しています。" }] },
        }],
      };
    };

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        return { kind: "success", summary: "ビルド成功", issues: [], pdfPath: null, log: "" };
      },
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      message: "main.tex に \\cite{goodfellow2016} が使われているので、参考文献ファイルを作成して論文に統合してください。その後ビルドして確認してください。",
      context: { activeFilePath: "main.tex" },
      conversationId: "bibliography",
    });

    // Verify bib file was created
    assert.ok(await fileExists(path.join(rootPath, "references.bib")), "references.bib が存在しない");

    const bib = await fsp.readFile(path.join(rootPath, "references.bib"), "utf8");
    assert.match(bib, /goodfellow2016/, "goodfellow の引用エントリがない");
    assert.match(bib, /krizhevsky2012imagenet/, "krizhevsky の引用エントリがない");

    // Verify main.tex was updated
    const main = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(main, /\\bibliography\{references\}/, "\\bibliography コマンドが追加されていない");
    assert.match(main, /\\bibliographystyle\{plain\}/, "\\bibliographystyle コマンドが追加されていない");

    // Verify build was called
    assert.equal(buildCalls.length, 1, "ビルドが呼ばれていない");

    // Verify tool sequence
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("write_file"), "write_file が呼ばれていない");
    assert.ok(toolNames.includes("propose_patch"), "propose_patch が呼ばれていない");
    assert.ok(toolNames.includes("run_build"), "run_build が呼ばれていない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6: Build → failure → fix → rebuild autonomous loop
// ---------------------------------------------------------------------------
test("agent detects LaTeX build failure in paper, fixes it, and rebuilds", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-buildfix-"));
  const buildCalls = [];

  try {
    // Paper with a LaTeX error: missing \end{abstract}
    const brokenTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{abstract}",
      "This paper presents a deep learning approach.",
      "% Missing \\end{abstract}",
      "\\section{Introduction}",
      "This is the introduction.",
      "\\end{document}",
      "",
    ].join("\n");

    await fsp.writeFile(path.join(rootPath, "main.tex"), brokenTex, "utf8");

    const rendererEvents = [];
    let modelCalls = 0;

    const requestAiChat = async () => {
      modelCalls += 1;

      // Turn 1: run build first (it will fail)
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "run_build",
              args: { mainFile: "main.tex" },
            }}] },
          }],
        };
      }

      // Turn 2: after build failure, read the file to find the error
      if (modelCalls === 2) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "read_file",
              args: { path: "main.tex" },
            }}] },
          }],
        };
      }

      // Turn 3: fix the missing \end{abstract}
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "% Missing \\end{abstract}\n\\section{Introduction}",
                replace: "\\end{abstract}\n\\section{Introduction}",
                summary: "\\end{abstract} が抜けていたので追加",
              },
            }}] },
          }],
        };
      }

      // Turn 4: rebuild
      if (modelCalls === 4) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "run_build",
              args: { mainFile: "main.tex" },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "ビルドエラーを修正し、再ビルドに成功しました。" }] },
        }],
      };
    };

    const buildService = {
      build: async (...args) => {
        buildCalls.push(args);
        // First build fails, second succeeds
        if (buildCalls.length === 1) {
          return {
            kind: "failure",
            summary: "LaTeX Error: \\begin{abstract} ended by \\end{document}",
            issues: [{
              severity: "error",
              message: "LaTeX Error: \\begin{abstract} ended by \\end{document}",
              file: "main.tex",
              line: 8,
            }],
            log: "! LaTeX Error: \\begin{abstract} ended by \\end{document}",
            pdfPath: null,
          };
        }
        return { kind: "success", summary: "ビルド成功", issues: [], pdfPath: null, log: "" };
      },
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 12,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      message: "ビルドして、エラーがあれば修正して、再ビルドして成功を確認してください。",
      context: { activeFilePath: "main.tex", activeFileContent: brokenTex },
      conversationId: "build-fix-paper",
    });

    // Verify two builds were called
    assert.equal(buildCalls.length, 2, "ビルドが2回呼ばれていない");

    // Verify the fix was applied
    const fixed = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(fixed, /\\end\{abstract\}/, "\\end{abstract} が追加されていない");
    assert.doesNotMatch(fixed, /% Missing \\end\{abstract\}/, "エラーのコメントが残っている");

    // Verify tool sequence
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.equal(toolNames.filter((n) => n === "run_build").length, 2, "run_build が2回呼ばれていない");
    assert.ok(toolNames.includes("read_file"), "read_file が呼ばれていない");
    assert.ok(toolNames.includes("propose_patch"), "propose_patch が呼ばれていない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7: list_files-guided project overview before writing
// ---------------------------------------------------------------------------
test("agent inspects project structure with list_files and get_project_structure before writing", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-structure-"));

  try {
    // Create an existing project
    await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });
    await fsp.mkdir(path.join(rootPath, "figures"), { recursive: true });
    await fsp.writeFile(path.join(rootPath, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\end{document}\n", "utf8");
    await fsp.writeFile(path.join(rootPath, "chapters/intro.tex"), "\\section{Introduction}\n", "utf8");

    const rendererEvents = [];
    let modelCalls = 0;

    const requestAiChat = async (payload) => {
      modelCalls += 1;

      // Turn 1: get project structure
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "get_project_structure",
              args: { maxDepth: 3 },
            }}] },
          }],
        };
      }

      // Turn 2: list files in chapters directory
      if (modelCalls === 2) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "list_files",
              args: { directory: "chapters" },
            }}] },
          }],
        };
      }

      // Turn 3: based on structure, add a new chapter
      if (modelCalls === 3) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "write_file",
              args: {
                path: "chapters/related_work.tex",
                content: "\\section{Related Work}\\label{sec:related}\n深層学習の先行研究として、AlexNet \\cite{krizhevsky2012imagenet} が挙げられる。\n",
                summary: "関連研究セクションを追加",
              },
            }}] },
          }],
        };
      }

      // Turn 4: update main.tex to include new chapter
      if (modelCalls === 4) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "propose_patch",
              args: {
                path: "main.tex",
                search: "\\end{document}",
                replace: "\\input{chapters/intro}\n\\input{chapters/related_work}\n\\end{document}",
                summary: "main.tex に新しい章を追加",
              },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "プロジェクト構造を確認し、関連研究セクションを追加しました。" }] },
        }],
      };
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      requestAiChat,
    });

    await service.run({
      message: "プロジェクト構造を確認してから、関連研究 (Related Work) セクションを新しいファイルとして追加してください。",
      context: {},
      conversationId: "structure-check",
    });

    // Verify structure inspection tools were used
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("get_project_structure"), "get_project_structure が呼ばれていない");
    assert.ok(toolNames.includes("list_files"), "list_files が呼ばれていない");

    // Verify new file was created
    assert.ok(await fileExists(path.join(rootPath, "chapters/related_work.tex")), "related_work.tex が作成されていない");

    const relWork = await fsp.readFile(path.join(rootPath, "chapters/related_work.tex"), "utf8");
    assert.match(relWork, /\\section\{Related Work\}/, "Related Work セクションがない");

    // Verify main.tex was updated
    const main = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.match(main, /\\input\{chapters\/related_work\}/, "main.tex に related_work が追加されていない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 8: rename_latex_symbol — symbol refactoring across files
// ---------------------------------------------------------------------------
test("agent renames LaTeX labels across multiple files for paper reorganization", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-paper-rename-"));

  try {
    // Create files with references to each other
    await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });

    await fsp.writeFile(path.join(rootPath, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "See Section~\\ref{sec:intro} for details.",
      "As shown in \\ref{sec:intro}, the method works.",
      "\\input{chapters/introduction}",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");

    await fsp.writeFile(path.join(rootPath, "chapters/introduction.tex"), [
      "\\section{Introduction}\\label{sec:intro}",
      "This is the introduction.",
      "",
    ].join("\n"), "utf8");

    const rendererEvents = [];
    let modelCalls = 0;

    const requestAiChat = async () => {
      modelCalls += 1;

      // Turn 1: rename the label across files
      if (modelCalls === 1) {
        return {
          candidates: [{
            content: { role: "model", parts: [{ functionCall: {
              name: "rename_latex_symbol",
              args: {
                from: "sec:intro",
                to: "sec:introduction",
                kinds: ["label", "ref"],
              },
            }}] },
          }],
        };
      }

      return {
        candidates: [{
          content: { role: "model", parts: [{ text: "ラベルを sec:intro から sec:introduction にリネームしました。" }] },
        }],
      };
    };

    const service = new AgentService({
      workspace: createWorkspace(rootPath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({
          stream: false,
          autoApply: true,
          autoBuild: false,
          allowRunCommand: true,
          maxIterations: 10,
        }),
        updateAgentSettings: async () => ({}),
      }),
      sendToRenderer: (type, payload) => rendererEvents.push({ type, payload }),
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
      requestAiChat,
    });

    await service.run({
      message: "sec:intro ラベルを sec:introduction にリネームしてください。全ファイルの \\label と \\ref を更新してください。",
      context: {},
      conversationId: "rename-label",
    });

    // Verify tool was used
    const toolNames = rendererEvents
      .filter((e) => e.type === "agent:tool")
      .map((e) => e.payload?.name);
    assert.ok(toolNames.includes("rename_latex_symbol"), "rename_latex_symbol が呼ばれていない");

    // Verify all occurrences were renamed
    const main = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.doesNotMatch(main, /sec:intro(?!duction)/, "main.tex に古いラベルが残っている");
    assert.match(main, /\\ref\{sec:introduction\}/, "main.tex の \\ref が更新されていない");

    const intro = await fsp.readFile(path.join(rootPath, "chapters/introduction.tex"), "utf8");
    assert.doesNotMatch(intro, /\\label\{sec:intro\}(?!\{)/, "introduction.tex の \\label が更新されていない");
    assert.match(intro, /\\label\{sec:introduction\}/, "introduction.tex に新しいラベルがない");

  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});
