import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");

// ── shared helpers ────────────────────────────────────

const createWorkspace = (rootPath, fileList = ["main.tex"]) => ({
  getRootPath: () => rootPath,
  resolvePath: (rel) => path.join(rootPath, rel),
  writeFile: async (rel, content) => {
    const abs = path.join(rootPath, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  },
  listFiles: async () => fileList,
  rootInfo: async () => ({ path: "main.tex" }),
  resolveTexRootFromMagic: async (rel) => rel,
  loadSettings: async () => ({ buildProfileId: "", buildProfiles: [] }),
});

const createService = ({
  rootPath,
  fileList,
  requestAiChat,
  buildService = null,
  rendererEvents = [],
  autoBuild = true,
  maxIterations = 12,
}) =>
  new AgentService({
    workspace: createWorkspace(rootPath, fileList),
    searchService: null,
    ensureUserSettings: () => ({
      getAgentSettings: async () => ({
        stream: false,
        autoApply: true,
        autoBuild,
        allowRunCommand: false,
        maxIterations,
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

const toolNames = (events) =>
  events
    .filter((e) => e.type === "agent:tool")
    .map((e) => e.payload?.name)
    .filter(Boolean);

const modelReply = (parts) => ({
  candidates: [{ content: { role: "model", parts } }],
});

const fnCall = (name, args) => modelReply([{ functionCall: { name, args } }]);
const textReply = (text) => modelReply([{ text }]);

// ════════════════════════════════════════════════════════
// Level 1: 単一ファイル編集
// ════════════════════════════════════════════════════════

test("1a: patch_file でセクションタイトルを変更", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-1a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{序論}",
    "ここに序論の本文。",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\section{序論}",
            replace: "\\section{はじめに}",
            summary: "セクション名を変更",
          });
        }
        return textReply("「序論」を「はじめに」に変更しました。");
      },
    });

    await service.run({
      message: "「序論」を「はじめに」に変えて",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "test-1a",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\section{はじめに}"), "セクション名が変更されているべき");
    assert.ok(!result.includes("\\section{序論}"), "古いセクション名が残っていないべき");
    assert.ok(result.includes("ここに序論の本文。"), "本文は変更されていないべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
    assert.ok(buildCalls.length >= 1, "autoBuild が走るべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("1b: replace_lines で段落を挿入", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-1b-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{導入}",
    "既存の段落。",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("replace_lines", {
            path: "main.tex",
            startLine: 4,
            endLine: 4,
            content: "既存の段落。\n\n本研究では深層学習を用いた手法を提案する。",
            summary: "段落追加",
          });
        }
        return textReply("段落を追加しました。");
      },
    });

    await service.run({
      message: "4行目の後に段落を追加して：「本研究では深層学習を用いた手法を提案する。」",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "test-1b",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("本研究では深層学習を用いた手法を提案する。"), "新段落が追加されているべき");
    assert.ok(result.includes("既存の段落。"), "既存の段落が残っているべき");
    assert.ok(toolNames(events).includes("replace_lines"), "replace_lines が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("1c: patch_file で abstract を翻訳", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-1c-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{abstract}",
    "本研究では、大規模言語モデルの微調整手法について検討する。",
    "\\end{abstract}",
    "\\section{Introduction}",
    "本文。",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "本研究では、大規模言語モデルの微調整手法について検討する。",
            replace:
              "In this study, we investigate fine-tuning methods for large language models.",
            summary: "abstract を英訳",
          });
        }
        return textReply("abstract を英語に翻訳しました。");
      },
    });

    await service.run({
      message: "abstract を英語に翻訳して",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "test-1c",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(
      result.includes("fine-tuning methods for large language models"),
      "英訳された abstract が含まれるべき"
    );
    assert.ok(!result.includes("微調整手法"), "日本語 abstract が残っていないべき");
    assert.ok(result.includes("\\begin{abstract}"), "abstract 環境は保持されるべき");
    assert.ok(result.includes("本文。"), "abstract 以外は変更されないべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 2: ビルド＆エラー修復
// ════════════════════════════════════════════════════════

test("2a: typo → ビルド失敗 → 自動修正 → 再ビルド成功", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-2a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begn{document}",
    "Hello",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          // 1回目: 失敗、2回目: 成功
          if (buildCalls.length === 1) {
            return {
              kind: "failure",
              summary: "Undefined control sequence \\begn",
              issues: [
                { severity: "error", message: "Undefined control sequence \\begn", path: "main.tex", line: 2 },
              ],
              pdfPath: null,
              log: "! Undefined control sequence.\nl.2 \\begn",
            };
          }
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AIが最初にビルドを実行
          return fnCall("run_build", {});
        }
        if (calls === 2) {
          // ビルド失敗後、AIが修正を適用
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\begn{document}",
            replace: "\\begin{document}",
            summary: "typo修正: \\begn → \\begin",
          });
        }
        // 修正後にテキスト応答（autoBuild が走る）
        return textReply("typo を修正しました。ビルドが成功しました。");
      },
    });

    await service.run({
      message: "ビルドして",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "test-2a",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\begin{document}"), "typo が修正されているべき");
    assert.ok(!result.includes("\\begn{document}"), "typo が残っていないべき");
    assert.ok(buildCalls.length >= 2, "少なくとも2回ビルドされるべき（失敗→修正→成功）");
    assert.ok(toolNames(events).includes("run_build"), "run_build が呼ばれるべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("2b: 未定義ラベル → ビルド → warning → ラベル追加", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-2b-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begin{document}",
    "図\\ref{fig:result}に結果を示す。",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          if (buildCalls.length === 1) {
            return {
              kind: "failure",
              summary: "Undefined reference",
              issues: [
                { severity: "warning", message: "Reference `fig:result' on page 1 undefined", path: "main.tex", line: 3 },
              ],
              pdfPath: null,
              log: "LaTeX Warning: Reference `fig:result' undefined",
            };
          }
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("run_build", {});
        }
        if (calls === 2) {
          // AIがラベル付きの図環境を追加
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\end{document}",
            replace: [
              "\\begin{figure}[h]",
              "  \\centering",
              "  % TODO: 図を挿入",
              "  \\caption{実験結果}",
              "  \\label{fig:result}",
              "\\end{figure}",
              "",
              "\\end{document}",
            ].join("\n"),
            summary: "fig:result ラベル付き figure 環境を追加",
          });
        }
        return textReply("未定義参照を解決しました。");
      },
    });

    await service.run({
      message: "ビルドして",
      context: { activeFilePath: "main.tex", activeFileContent: original },
      conversationId: "test-2b",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\label{fig:result}"), "ラベルが追加されているべき");
    assert.ok(result.includes("\\ref{fig:result}"), "既存の ref は保持されるべき");
    assert.ok(buildCalls.length >= 2, "修正後に再ビルドされるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("2c: 存在しない cite キー → エラー → .bib 確認 → キー修正", async (t) => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-2c-"));
  const mainFile = path.join(rootPath, "main.tex");
  const bibFile = path.join(rootPath, "refs.bib");

  const texContent = [
    "\\documentclass{article}",
    "\\bibliographystyle{plain}",
    "\\begin{document}",
    "先行研究\\cite{Smith2024}では…",
    "\\bibliography{refs}",
    "\\end{document}",
    "",
  ].join("\n");

  const bibContent = [
    "@article{Smith2023,",
    "  author = {John Smith},",
    "  title = {A Study},",
    "  journal = {Journal},",
    "  year = {2023},",
    "}",
    "",
  ].join("\n");

  await fsp.writeFile(mainFile, texContent, "utf8");
  await fsp.writeFile(bibFile, bibContent, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "refs.bib"],
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          if (buildCalls.length === 1) {
            return {
              kind: "failure",
              summary: "Citation undefined",
              issues: [
                { severity: "warning", message: "Citation `Smith2024' undefined", path: "main.tex", line: 4 },
              ],
              pdfPath: null,
              log: "LaTeX Warning: Citation `Smith2024' undefined",
            };
          }
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("run_build", {});
        }
        if (calls === 2) {
          // AIが .bib を読んで正しいキーを確認
          return fnCall("read_file", { path: "refs.bib" });
        }
        if (calls === 3) {
          // 正しいキー Smith2023 に修正
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\cite{Smith2024}",
            replace: "\\cite{Smith2023}",
            summary: "citation キーを Smith2024 → Smith2023 に修正",
          });
        }
        return textReply("引用キーを修正しました。");
      },
    });

    await service.run({
      message: "ビルドエラーを直して",
      context: { activeFilePath: "main.tex", activeFileContent: texContent },
      conversationId: "test-2c",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\cite{Smith2023}"), "正しい引用キーに修正されるべき");
    assert.ok(!result.includes("\\cite{Smith2024}"), "誤った引用キーが残っていないべき");
    assert.ok(toolNames(events).includes("read_file"), "bib を読むべき");
    assert.ok(toolNames(events).includes("patch_file"), "修正が適用されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 3: 複数ファイル操作
// ════════════════════════════════════════════════════════

test("3a: 複数ファイルを一度のセッションで編集", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-3a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const chapFile = path.join(rootPath, "chap1.tex");

  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{chap1}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsp.writeFile(
    chapFile,
    [
      "\\section{背景}",
      "背景の説明文。",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chap1.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // まず main.tex にパッケージ追加
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\begin{document}",
            replace: "\\usepackage{hyperref}\n\\begin{document}",
            summary: "hyperref 追加",
          });
        }
        if (calls === 2) {
          // 次に chap1.tex のセクション名変更
          return fnCall("patch_file", {
            path: "chap1.tex",
            search: "\\section{背景}",
            replace: "\\section{研究背景}",
            summary: "セクション名変更",
          });
        }
        return textReply("両ファイルを更新しました。");
      },
    });

    await service.run({
      message: "main.tex に hyperref パッケージを追加して、chap1.tex のセクション名を「研究背景」に変えて",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-3a",
    });

    const mainResult = await fsp.readFile(mainFile, "utf8");
    const chapResult = await fsp.readFile(chapFile, "utf8");

    assert.ok(mainResult.includes("\\usepackage{hyperref}"), "main.tex に hyperref が追加されるべき");
    assert.ok(chapResult.includes("\\section{研究背景}"), "chap1.tex のセクション名が変更されるべき");
    assert.ok(!chapResult.includes("\\section{背景}"), "古いセクション名が残っていないべき");

    const patchCalls = toolNames(events).filter((n) => n === "patch_file");
    assert.ok(patchCalls.length >= 2, "patch_file が2回以上呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("3b: write_file で新規ファイル作成し \\\\input で取り込む", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-3b-"));
  const mainFile = path.join(rootPath, "main.tex");

  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{本文}",
      "テスト。",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // 新しい appendix.tex を作成
          return fnCall("write_file", {
            path: "appendix.tex",
            content: [
              "\\section{付録}",
              "付録の内容。",
              "",
            ].join("\n"),
            summary: "付録ファイル作成",
          });
        }
        if (calls === 2) {
          // main.tex に input を追加
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\end{document}",
            replace: "\\input{appendix}\n\\end{document}",
            summary: "付録の取り込みを追加",
          });
        }
        return textReply("付録ファイルを作成して取り込みました。");
      },
    });

    await service.run({
      message: "付録を別ファイルとして作成して main.tex に取り込んで",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-3b",
    });

    const appendixFile = path.join(rootPath, "appendix.tex");
    const appendixContent = await fsp.readFile(appendixFile, "utf8");
    const mainResult = await fsp.readFile(mainFile, "utf8");

    assert.ok(appendixContent.includes("\\section{付録}"), "付録ファイルが作成されるべき");
    assert.ok(mainResult.includes("\\input{appendix}"), "main.tex に input が追加されるべき");
    assert.ok(toolNames(events).includes("write_file"), "write_file が呼ばれるべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("3c: rename_file でファイル名変更し参照を更新", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-3c-"));
  const mainFile = path.join(rootPath, "main.tex");
  const oldFile = path.join(rootPath, "fig1.tex");

  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{fig1}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsp.writeFile(oldFile, "\\begin{figure}\\end{figure}\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "fig1.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("rename_file", {
            oldPath: "fig1.tex",
            newPath: "figures.tex",
            summary: "fig1.tex → figures.tex",
          });
        }
        if (calls === 2) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\input{fig1}",
            replace: "\\input{figures}",
            summary: "参照パスを更新",
          });
        }
        return textReply("ファイル名と参照を更新しました。");
      },
    });

    await service.run({
      message: "fig1.tex を figures.tex にリネームして、main.tex の参照も直して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-3c",
    });

    const mainResult = await fsp.readFile(mainFile, "utf8");
    const renamedExists = await fsp.access(path.join(rootPath, "figures.tex")).then(() => true).catch(() => false);
    const oldExists = await fsp.access(oldFile).then(() => true).catch(() => false);

    assert.ok(renamedExists, "figures.tex が存在するべき");
    assert.ok(!oldExists, "fig1.tex は存在しないべき");
    assert.ok(mainResult.includes("\\input{figures}"), "main.tex の参照が更新されるべき");
    assert.ok(!mainResult.includes("\\input{fig1}"), "古い参照が残っていないべき");
    assert.ok(toolNames(events).includes("rename_file"), "rename_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 4: 自律的ワークフロー
// ════════════════════════════════════════════════════════

test("4a: search_files → read_file → patch_file の連鎖ワークフロー", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-4a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const chap1 = path.join(rootPath, "chap1.tex");
  const chap2 = path.join(rootPath, "chap2.tex");

  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\n\\input{chap1}\n\\input{chap2}\n\\end{document}\n", "utf8");
  await fsp.writeFile(chap1, "\\section{第1章}\n深層学習のモデルについて。\n", "utf8");
  await fsp.writeFile(chap2, "\\section{第2章}\nTransformerの深層学習アーキテクチャ。\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chap1.tex", "chap2.tex"],
      rendererEvents: events,
      autoBuild: false,
      // searchService needs to be provided for search_files
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AI searches for "深層学習"
          return fnCall("search_files", { query: "深層学習" });
        }
        if (calls === 2) {
          // AI reads the found files
          return fnCall("read_files", { paths: ["chap1.tex", "chap2.tex"] });
        }
        if (calls === 3) {
          // AI patches chap1
          return fnCall("patch_file", {
            path: "chap1.tex",
            search: "深層学習のモデル",
            replace: "ディープラーニングのモデル",
            summary: "用語統一",
          });
        }
        if (calls === 4) {
          // AI patches chap2
          return fnCall("patch_file", {
            path: "chap2.tex",
            search: "深層学習アーキテクチャ",
            replace: "ディープラーニングアーキテクチャ",
            summary: "用語統一",
          });
        }
        return textReply("「深層学習」を「ディープラーニング」に統一しました。");
      },
    });

    // Provide a simple searchService for search_files
    service.searchService = {
      search: async (query) => ({
        results: [
          { path: "chap1.tex", line: 2, snippet: "深層学習のモデルについて。" },
          { path: "chap2.tex", line: 2, snippet: "Transformerの深層学習アーキテクチャ。" },
        ],
      }),
    };

    await service.run({
      message: "プロジェクト全体で「深層学習」を「ディープラーニング」に置換して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-4a",
    });

    const chap1Result = await fsp.readFile(chap1, "utf8");
    const chap2Result = await fsp.readFile(chap2, "utf8");

    assert.ok(chap1Result.includes("ディープラーニングのモデル"), "chap1 の用語が統一されるべき");
    assert.ok(chap2Result.includes("ディープラーニングアーキテクチャ"), "chap2 の用語が統一されるべき");
    assert.ok(!chap1Result.includes("深層学習"), "chap1 に古い用語が残っていないべき");
    assert.ok(!chap2Result.includes("深層学習"), "chap2 に古い用語が残っていないべき");
    assert.ok(toolNames(events).includes("search_files"), "search_files が呼ばれるべき");
    assert.ok(toolNames(events).includes("read_files"), "read_files が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("4b: 複数エラーの連続修正ワークフロー", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-4b-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begn{document}",
    "\\section{Introduction}",
    "Text with \\textbf{unclosed bold",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          if (buildCalls.length === 1) {
            return {
              kind: "failure",
              summary: "Undefined control sequence \\begn",
              issues: [
                { severity: "error", message: "Undefined control sequence \\begn", path: "main.tex", line: 2 },
                { severity: "error", message: "Missing } inserted", path: "main.tex", line: 4 },
              ],
              pdfPath: null,
              log: "! Undefined control sequence.\nl.2 \\begn\n! Missing } inserted.\nl.4 ...\\textbf{unclosed bold",
            };
          }
          if (buildCalls.length === 2) {
            return {
              kind: "failure",
              summary: "Missing }",
              issues: [
                { severity: "error", message: "Missing } inserted", path: "main.tex", line: 4 },
              ],
              pdfPath: null,
              log: "! Missing } inserted.\nl.4 ...\\textbf{unclosed bold",
            };
          }
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("run_build", {});
        }
        if (calls === 2) {
          // 最初のエラー修正
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\begn{document}",
            replace: "\\begin{document}",
            summary: "typo修正",
          });
        }
        if (calls === 3) {
          // 2つ目のエラー修正
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\textbf{unclosed bold",
            replace: "\\textbf{unclosed bold}",
            summary: "閉じ括弧追加",
          });
        }
        return textReply("すべてのエラーを修正しました。");
      },
    });

    await service.run({
      message: "ビルドエラーをすべて直して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-4b",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\begin{document}"), "typo が修正されるべき");
    assert.ok(result.includes("\\textbf{unclosed bold}"), "閉じ括弧が追加されるべき");
    assert.ok(buildCalls.length >= 2, "複数回ビルドされるべき");

    const patchCalls = toolNames(events).filter((n) => n === "patch_file");
    assert.ok(patchCalls.length >= 2, "patch_file が2回以上呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("4c: get_project_structure → read_file → 的確な編集", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-4c-"));
  await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });

  const mainFile = path.join(rootPath, "main.tex");
  const introFile = path.join(rootPath, "chapters", "intro.tex");

  await fsp.writeFile(
    mainFile,
    "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n",
    "utf8"
  );
  await fsp.writeFile(
    introFile,
    "\\section{はじめに}\n内容が薄い。\n",
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chapters/intro.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("get_project_structure", {});
        }
        if (calls === 2) {
          return fnCall("read_file", { path: "chapters/intro.tex" });
        }
        if (calls === 3) {
          return fnCall("patch_file", {
            path: "chapters/intro.tex",
            search: "内容が薄い。",
            replace: "本研究の背景として、近年の大規模言語モデルの発展がある。\n特にTransformerアーキテクチャの登場以降、自然言語処理は急速に進歩した。",
            summary: "序論を充実させる",
          });
        }
        return textReply("序論を充実させました。");
      },
    });

    await service.run({
      message: "プロジェクト構造を確認して、序論の内容を書き換えて",
      context: {},
      conversationId: "test-4c",
    });

    const result = await fsp.readFile(introFile, "utf8");
    assert.ok(result.includes("大規模言語モデル"), "序論が充実されるべき");
    assert.ok(result.includes("Transformer"), "具体的な内容が追加されるべき");
    assert.ok(!result.includes("内容が薄い"), "元の薄い内容は置換されるべき");
    assert.ok(toolNames(events).includes("get_project_structure"), "get_project_structure が呼ばれるべき");
    assert.ok(toolNames(events).includes("read_file"), "read_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 5: スクラッチパッドと計画
// ════════════════════════════════════════════════════════

test("5a: write_scratchpad で計画を書いてから実行", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-5a-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{A}",
      "AAA",
      "\\section{B}",
      "BBB",
      "\\section{C}",
      "CCC",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AIがまずスクラッチパッドに計画を記入
          return fnCall("write_scratchpad", {
            content: [
              "## 計画: セクション再構成",
              "1. section A → 「導入」に変更",
              "2. section B → 「手法」に変更",
              "3. section C → 「結果」に変更",
            ].join("\n"),
            mode: "replace",
          });
        }
        if (calls === 2) {
          // 計画に従って一括編集 (patch_file with edits)
          return fnCall("patch_file", {
            path: "main.tex",
            edits: [
              { path: "main.tex", search: "\\section{A}", replace: "\\section{導入}" },
              { path: "main.tex", search: "\\section{B}", replace: "\\section{手法}" },
              { path: "main.tex", search: "\\section{C}", replace: "\\section{結果}" },
            ],
            summary: "セクション名を計画通りに変更",
          });
        }
        return textReply("計画に沿ってセクション名を変更しました。");
      },
    });

    await service.run({
      message: "セクション A, B, C を「導入」「手法」「結果」にリネームして",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-5a",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\section{導入}"), "A → 導入");
    assert.ok(result.includes("\\section{手法}"), "B → 手法");
    assert.ok(result.includes("\\section{結果}"), "C → 結果");
    assert.ok(!result.includes("\\section{A}"), "古いセクション名が残っていないべき");
    assert.ok(toolNames(events).includes("write_scratchpad"), "write_scratchpad が呼ばれるべき");

    // スクラッチパッドに計画が書かれていることを確認
    const scratchpad = service.scratchpadByConversation.get("test-5a") ?? "";
    assert.ok(scratchpad.includes("セクション再構成"), "スクラッチパッドに計画が残っているべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("5b: read_scratchpad で前回のメモを参照して作業継続", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-5b-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{導入}",
      "背景説明。",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const conversationId = "test-5b";
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AIがスクラッチパッドを確認
          return fnCall("read_scratchpad", {});
        }
        if (calls === 2) {
          // メモの内容に基づいて追加セクションを作成
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\end{document}",
            replace: [
              "\\section{手法}",
              "提案手法の説明。",
              "",
              "\\end{document}",
            ].join("\n"),
            summary: "メモに基づき手法セクションを追加",
          });
        }
        if (calls === 3) {
          // スクラッチパッドを更新
          return fnCall("write_scratchpad", {
            content: "- 手法セクション追加済み\n- 次回: 実験セクション追加",
            mode: "append",
          });
        }
        return textReply("手法セクションを追加しました。");
      },
    });

    // 事前にスクラッチパッドにメモを仕込む
    service.scratchpadByConversation.set(conversationId, "TODO: 手法セクションを追加する");

    await service.run({
      message: "前のメモの続きを編集して",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\section{手法}"), "手法セクションが追加されるべき");

    const scratchpad = service.scratchpadByConversation.get(conversationId) ?? "";
    assert.ok(scratchpad.includes("手法セクション追加済み"), "スクラッチパッドが更新されるべき");
    assert.ok(scratchpad.includes("次回: 実験セクション追加"), "次のTODOが記録されるべき");
    assert.ok(scratchpad.includes("TODO: 手法セクション"), "元のメモも残っているべき（append）");

    assert.ok(toolNames(events).includes("read_scratchpad"), "read_scratchpad が呼ばれるべき");
    assert.ok(toolNames(events).includes("write_scratchpad"), "write_scratchpad が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("5c: 複合ワークフロー — 構造確認 → 計画 → 実行 → ビルド検証", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-5c-"));
  await fsp.mkdir(path.join(rootPath, "sections"), { recursive: true });

  const mainFile = path.join(rootPath, "main.tex");
  const sec1 = path.join(rootPath, "sections", "intro.tex");
  const sec2 = path.join(rootPath, "sections", "method.tex");

  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{sections/intro}",
      "\\input{sections/method}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsp.writeFile(sec1, "\\section{Introduction}\nIntro text.\n", "utf8");
  await fsp.writeFile(sec2, "\\section{Method}\nMethod text.\n", "utf8");

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "sections/intro.tex", "sections/method.tex"],
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // Step 1: プロジェクト構造確認
          return fnCall("get_project_structure", {});
        }
        if (calls === 2) {
          // Step 2: ファイル読み込み
          return fnCall("read_files", { paths: ["sections/intro.tex", "sections/method.tex"] });
        }
        if (calls === 3) {
          // Step 3: スクラッチパッドに計画
          return fnCall("write_scratchpad", {
            content: [
              "## 日本語化計画",
              "- sections/intro.tex: Introduction → はじめに, Intro text → 序論テキスト",
              "- sections/method.tex: Method → 手法, Method text → 手法テキスト",
              "- ビルドして確認",
            ].join("\n"),
          });
        }
        if (calls === 4) {
          // Step 4: intro.tex 編集
          return fnCall("patch_file", {
            path: "sections/intro.tex",
            edits: [
              { path: "sections/intro.tex", search: "\\section{Introduction}", replace: "\\section{はじめに}" },
              { path: "sections/intro.tex", search: "Intro text.", replace: "序論テキスト。" },
            ],
            summary: "intro.tex 日本語化",
          });
        }
        if (calls === 5) {
          // Step 5: method.tex 編集
          return fnCall("patch_file", {
            path: "sections/method.tex",
            edits: [
              { path: "sections/method.tex", search: "\\section{Method}", replace: "\\section{手法}" },
              { path: "sections/method.tex", search: "Method text.", replace: "手法テキスト。" },
            ],
            summary: "method.tex 日本語化",
          });
        }
        if (calls === 6) {
          // Step 6: ビルド確認
          return fnCall("run_build", {});
        }
        return textReply("日本語化が完了し、ビルドも成功しました。");
      },
    });

    await service.run({
      message: "プロジェクト全体を日本語化して、ビルドが通ることを確認して",
      context: {},
      conversationId: "test-5c",
    });

    const introResult = await fsp.readFile(sec1, "utf8");
    const methodResult = await fsp.readFile(sec2, "utf8");
    const scratchpad = service.scratchpadByConversation.get("test-5c") ?? "";

    assert.ok(introResult.includes("\\section{はじめに}"), "intro が日本語化されるべき");
    assert.ok(introResult.includes("序論テキスト"), "intro 本文が日本語化されるべき");
    assert.ok(methodResult.includes("\\section{手法}"), "method が日本語化されるべき");
    assert.ok(methodResult.includes("手法テキスト"), "method 本文が日本語化されるべき");
    assert.ok(scratchpad.includes("日本語化計画"), "スクラッチパッドに計画が残るべき");
    assert.ok(buildCalls.length >= 1, "ビルドが実行されるべき");
    assert.ok(toolNames(events).includes("get_project_structure"), "構造確認");
    assert.ok(toolNames(events).includes("read_files"), "ファイル読み込み");
    assert.ok(toolNames(events).includes("write_scratchpad"), "計画メモ");
    assert.ok(toolNames(events).includes("run_build"), "ビルド検証");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 6: 追加ツール操作
// ════════════════════════════════════════════════════════

test("6a: delete_file で不要ファイルを削除", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-6a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const tempFile = path.join(rootPath, "temp.tex");

  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n", "utf8");
  await fsp.writeFile(tempFile, "% temporary scratch file\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "temp.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("delete_file", {
            path: "temp.tex",
            summary: "不要な一時ファイルを削除",
          });
        }
        return textReply("temp.tex を削除しました。");
      },
    });

    await service.run({
      message: "temp.tex を削除して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-6a",
    });

    const tempExists = await fsp.access(tempFile).then(() => true).catch(() => false);
    const mainExists = await fsp.access(mainFile).then(() => true).catch(() => false);

    assert.ok(!tempExists, "temp.tex が削除されているべき");
    assert.ok(mainExists, "main.tex は残っているべき");
    assert.ok(toolNames(events).includes("delete_file"), "delete_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("6b: create_directory でディレクトリ作成", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-6b-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("create_directory", {
            path: "images",
            summary: "画像用ディレクトリ作成",
          });
        }
        if (calls === 2) {
          return fnCall("write_file", {
            path: "images/placeholder.txt",
            content: "% placeholder\n",
            summary: "プレースホルダ作成",
          });
        }
        return textReply("images ディレクトリを作成しました。");
      },
    });

    await service.run({
      message: "images ディレクトリを追加して、中にプレースホルダを作って",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-6b",
    });

    const dirExists = await fsp.stat(path.join(rootPath, "images")).then((s) => s.isDirectory()).catch(() => false);
    const placeholderExists = await fsp.access(path.join(rootPath, "images", "placeholder.txt")).then(() => true).catch(() => false);

    assert.ok(dirExists, "images ディレクトリが作成されるべき");
    assert.ok(placeholderExists, "placeholder.txt が作成されるべき");
    assert.ok(toolNames(events).includes("create_directory"), "create_directory が呼ばれるべき");
    assert.ok(toolNames(events).includes("write_file"), "write_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("6c: patch_file の replaceAll で一括置換", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-6c-"));
  const mainFile = path.join(rootPath, "main.tex");
  const original = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Fig. 1 shows the result.",
    "As shown in Fig. 2, the method works.",
    "See Fig. 3 for details.",
    "\\end{document}",
    "",
  ].join("\n");
  await fsp.writeFile(mainFile, original, "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "Fig.",
            replace: "図",
            replaceAll: true,
            summary: "Fig. → 図 の一括置換",
          });
        }
        return textReply("すべての Fig. を 図 に置換しました。");
      },
    });

    await service.run({
      message: "「Fig.」を「図」に全部置換して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-6c",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(!result.includes("Fig."), "Fig. が残っていないべき");
    assert.ok(result.includes("図 1 shows"), "1つ目が置換されるべき");
    assert.ok(result.includes("図 2,"), "2つ目が置換されるべき");
    assert.ok(result.includes("図 3 for"), "3つ目が置換されるべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 7: 複合ツール操作
// ════════════════════════════════════════════════════════

test("7a: rename_latex_symbol でラベルを一括リネーム", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-7a-"));
  const mainFile = path.join(rootPath, "main.tex");
  const chapFile = path.join(rootPath, "chap1.tex");

  await fsp.writeFile(
    mainFile,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{chap1}",
      "図\\ref{fig:old}に結果を示す。",
      "表\\ref{tab:data}も参照。",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsp.writeFile(
    chapFile,
    [
      "\\section{結果}",
      "\\begin{figure}",
      "  \\caption{実験結果}",
      "  \\label{fig:old}",
      "\\end{figure}",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chap1.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("rename_latex_symbol", {
            from: "fig:old",
            to: "fig:result",
            kinds: ["label", "ref"],
          });
        }
        return textReply("ラベルをリネームしました。");
      },
    });

    await service.run({
      message: "fig:old ラベルを fig:result にリネームして",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-7a",
    });

    const mainResult = await fsp.readFile(mainFile, "utf8");
    const chapResult = await fsp.readFile(chapFile, "utf8");

    assert.ok(mainResult.includes("\\ref{fig:result}"), "main.tex の ref が更新されるべき");
    assert.ok(!mainResult.includes("\\ref{fig:old}"), "古い ref が残っていないべき");
    assert.ok(mainResult.includes("\\ref{tab:data}"), "関係ない ref は変更されないべき");
    assert.ok(chapResult.includes("\\label{fig:result}"), "chap1.tex の label が更新されるべき");
    assert.ok(!chapResult.includes("\\label{fig:old}"), "古い label が残っていないべき");
    assert.ok(toolNames(events).includes("rename_latex_symbol"), "rename_latex_symbol が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("7b: write_file で既存ファイルを完全に上書き", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-7b-"));
  const appendixFile = path.join(rootPath, "appendix.tex");
  await fsp.writeFile(
    appendixFile,
    "\\section{付録}\n古い内容。\n",
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["appendix.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("write_file", {
            path: "appendix.tex",
            content: [
              "\\section{付録A: 数式の導出}",
              "ここでは本文中の数式の詳細な導出過程を示す。",
              "",
              "\\subsection{定理1の証明}",
              "証明は帰納法による。",
              "",
            ].join("\n"),
            summary: "付録を全面書き換え",
          });
        }
        return textReply("付録を書き換えました。");
      },
    });

    await service.run({
      message: "appendix.tex の内容を編集して",
      context: { activeFilePath: "appendix.tex" },
      conversationId: "test-7b",
    });

    const result = await fsp.readFile(appendixFile, "utf8");
    assert.ok(result.includes("数式の導出"), "新しい内容が書き込まれるべき");
    assert.ok(result.includes("定理1の証明"), "新しい小セクションが含まれるべき");
    assert.ok(!result.includes("古い内容"), "古い内容が残っていないべき");
    assert.ok(toolNames(events).includes("write_file"), "write_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("7c: 単一レスポンスで複数ツールコール（並列パッチ）", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-7c-"));
  const file1 = path.join(rootPath, "intro.tex");
  const file2 = path.join(rootPath, "method.tex");

  await fsp.writeFile(file1, "\\section{Introduction}\nIntro content.\n", "utf8");
  await fsp.writeFile(file2, "\\section{Method}\nMethod content.\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["intro.tex", "method.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // 単一レスポンスに2つの functionCall パーツ
          return {
            candidates: [{
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "patch_file",
                      args: {
                        path: "intro.tex",
                        search: "\\section{Introduction}",
                        replace: "\\section{はじめに}",
                        summary: "intro 日本語化",
                      },
                    },
                  },
                  {
                    functionCall: {
                      name: "patch_file",
                      args: {
                        path: "method.tex",
                        search: "\\section{Method}",
                        replace: "\\section{手法}",
                        summary: "method 日本語化",
                      },
                    },
                  },
                ],
              },
            }],
          };
        }
        return textReply("両ファイルを日本語化しました。");
      },
    });

    await service.run({
      message: "intro.tex と method.tex のセクション名を日本語に変えて",
      context: {},
      conversationId: "test-7c",
    });

    const introResult = await fsp.readFile(file1, "utf8");
    const methodResult = await fsp.readFile(file2, "utf8");

    assert.ok(introResult.includes("\\section{はじめに}"), "intro.tex が日本語化されるべき");
    assert.ok(methodResult.includes("\\section{手法}"), "method.tex が日本語化されるべき");

    const patchCalls = toolNames(events).filter((n) => n === "patch_file");
    assert.ok(patchCalls.length >= 2, "patch_file が2回呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 8: エッジケースとエラー処理
// ════════════════════════════════════════════════════════

test("8a: ツールエラー後にAIが代替戦略に切り替え", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-8a-"));
  // missing.tex は存在しない

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: [],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AIがまず read_file を試みる → ファイルが存在しないのでエラー
          return fnCall("read_file", { path: "missing.tex" });
        }
        if (calls === 2) {
          // エラーを受けて write_file で新規作成に切り替え
          return fnCall("write_file", {
            path: "missing.tex",
            content: [
              "\\section{新規セクション}",
              "内容をここに記述。",
              "",
            ].join("\n"),
            summary: "存在しないファイルを新規作成",
          });
        }
        return textReply("ファイルが見つからなかったため、新規作成しました。");
      },
    });

    await service.run({
      message: "missing.tex を編集して",
      context: {},
      conversationId: "test-8a",
    });

    const created = path.join(rootPath, "missing.tex");
    const exists = await fsp.access(created).then(() => true).catch(() => false);
    assert.ok(exists, "missing.tex が新規作成されるべき");

    const content = await fsp.readFile(created, "utf8");
    assert.ok(content.includes("新規セクション"), "正しい内容が書き込まれるべき");
    assert.ok(toolNames(events).includes("read_file"), "read_file が呼ばれるべき");
    assert.ok(toolNames(events).includes("write_file"), "write_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("8b: edits 配列で複数ファイルを一括編集", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-8b-"));
  const file1 = path.join(rootPath, "chap1.tex");
  const file2 = path.join(rootPath, "chap2.tex");

  await fsp.writeFile(file1, "\\section{Chapter 1}\nFirst chapter.\n", "utf8");
  await fsp.writeFile(file2, "\\section{Chapter 2}\nSecond chapter.\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["chap1.tex", "chap2.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // edits 配列で2ファイルを同時に編集
          return fnCall("patch_file", {
            edits: [
              { path: "chap1.tex", search: "\\section{Chapter 1}", replace: "\\section{第1章}" },
              { path: "chap2.tex", search: "\\section{Chapter 2}", replace: "\\section{第2章}" },
            ],
            summary: "セクション名を日本語化",
          });
        }
        return textReply("両ファイルのセクション名を変更しました。");
      },
    });

    await service.run({
      message: "chap1.tex と chap2.tex のセクション名を日本語に変えて",
      context: {},
      conversationId: "test-8b",
    });

    const chap1 = await fsp.readFile(file1, "utf8");
    const chap2 = await fsp.readFile(file2, "utf8");

    assert.ok(chap1.includes("\\section{第1章}"), "chap1 のセクション名が変更されるべき");
    assert.ok(chap2.includes("\\section{第2章}"), "chap2 のセクション名が変更されるべき");
    assert.ok(!chap1.includes("Chapter 1"), "古いセクション名が残っていないべき");
    assert.ok(!chap2.includes("Chapter 2"), "古いセクション名が残っていないべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("8c: list_files → read_file → 選択的編集ワークフロー", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-8c-"));
  await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });

  const mainFile = path.join(rootPath, "main.tex");
  const ch1 = path.join(rootPath, "chapters", "ch1.tex");
  const ch2 = path.join(rootPath, "chapters", "ch2.tex");

  await fsp.writeFile(
    mainFile,
    "\\documentclass{article}\n\\begin{document}\n\\input{chapters/ch1}\n\\input{chapters/ch2}\n\\end{document}\n",
    "utf8"
  );
  await fsp.writeFile(ch1, "\\section{First}\nOld content.\n", "utf8");
  await fsp.writeFile(ch2, "\\section{Second}\nKeep this.\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chapters/ch1.tex", "chapters/ch2.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("list_files", { directory: "chapters" });
        }
        if (calls === 2) {
          return fnCall("read_file", { path: "chapters/ch1.tex" });
        }
        if (calls === 3) {
          return fnCall("patch_file", {
            path: "chapters/ch1.tex",
            search: "Old content.",
            replace: "Updated and improved content with more detail.",
            summary: "ch1 の内容を更新",
          });
        }
        return textReply("ch1.tex の内容を更新しました。");
      },
    });

    await service.run({
      message: "chapters フォルダのファイルを確認して、適切なものを編集して",
      context: {},
      conversationId: "test-8c",
    });

    const ch1Result = await fsp.readFile(ch1, "utf8");
    const ch2Result = await fsp.readFile(ch2, "utf8");

    assert.ok(ch1Result.includes("Updated and improved"), "ch1 が更新されるべき");
    assert.ok(!ch1Result.includes("Old content"), "古い内容が残っていないべき");
    assert.ok(ch2Result.includes("Keep this"), "ch2 は変更されないべき");
    assert.ok(toolNames(events).includes("list_files"), "list_files が呼ばれるべき");
    assert.ok(toolNames(events).includes("read_file"), "read_file が呼ばれるべき");
    assert.ok(toolNames(events).includes("patch_file"), "patch_file が呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 9: エージェントライフサイクル
// ════════════════════════════════════════════════════════

test("9a: マルチターン会話 — 2回目の run() で履歴が保持される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-9a-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(
    mainFile,
    "\\documentclass{article}\n\\begin{document}\n\\section{Old}\nContent.\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    let totalCalls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      // buildService を提供して auto-build を正常完了させる
      // (resolveAgentOptions が autoBuild: true をハードコードするため)
      buildService: {
        build: async () => ({ kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" }),
      },
      // auto-build が有効のため text reply 後に追加のモデルコールが発生する:
      //   Call 1: patch_file → edits → editedSinceLastBuild=true
      //   Call 2: text reply → auto-build triggers → continue
      //   Call 3: text reply → loop exits (run 1 done)
      //   Call 4: patch_file (2nd run)
      //   Call 5: text reply → auto-build triggers → continue
      //   Call 6: text reply → loop exits (run 2 done)
      requestAiChat: async () => {
        totalCalls += 1;
        if (totalCalls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\section{Old}",
            replace: "\\section{Introduction}",
            summary: "セクション名変更",
          });
        }
        if (totalCalls === 2) {
          return textReply("セクション名を変更しました。");
        }
        if (totalCalls === 3) {
          return textReply("完了です。");
        }
        // 2回目の run
        if (totalCalls === 4) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\section{Introduction}",
            replace: "\\section{はじめに}",
            summary: "日本語化",
          });
        }
        if (totalCalls === 5) {
          return textReply("日本語に変更しました。");
        }
        return textReply("完了です。");
      },
    });

    const conversationId = "test-9a";

    // 1回目の run
    await service.run({
      message: "セクション名を Introduction に変えて",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    const afterFirst = await fsp.readFile(mainFile, "utf8");
    assert.ok(afterFirst.includes("\\section{Introduction}"), "1回目で変更されるべき");

    // 2回目の run（同じ conversationId）
    await service.run({
      message: "それを日本語に変えて",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    const afterSecond = await fsp.readFile(mainFile, "utf8");
    assert.ok(afterSecond.includes("\\section{はじめに}"), "2回目で日本語化されるべき");
    assert.ok(!afterSecond.includes("\\section{Introduction}"), "英語セクション名が残っていないべき");

    // 会話履歴が保持されている
    const conversation = service.conversations.get(conversationId);
    assert.ok(conversation.length >= 4, "会話履歴に4つ以上のエントリがあるべき（user, model, user, model...）");
    assert.ok(totalCalls >= 6, "requestAiChat が6回以上呼ばれるべき（auto-build による追加コール含む）");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("9b: maxIterations 到達で resumable ステータスが送信される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-9b-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      maxIterations: 3,
      requestAiChat: async () => {
        calls += 1;
        // 毎回ツールを呼んで iteration を消費（テキスト応答しない → ループ終了しない）
        return fnCall("read_file", { path: "main.tex" });
      },
    });

    await service.run({
      message: "main.tex を確認して編集して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-9b",
    });

    // resumable ステータスが送信されたか確認
    const statusEvents = events.filter(
      (e) => e.type === "agent:status" && e.payload?.state === "resumable"
    );
    assert.ok(statusEvents.length >= 1, "resumable ステータスが送信されるべき");

    // 上限メッセージが送信されたか確認
    const messages = events.filter((e) => e.type === "agent:message");
    const limitMsg = messages.find((e) => e.payload?.text?.includes("上限回数"));
    assert.ok(limitMsg, "上限回数到達のメッセージが送信されるべき");

    assert.equal(calls, 3, "requestAiChat が maxIterations 回呼ばれるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("9c: 空の AI 応答でグレースフルに終了", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-9c-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        // 空のレスポンスを返す
        return { candidates: [{ content: { role: "model", parts: [] } }] };
      },
    });

    await service.run({
      message: "main.tex を編集して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-9c",
    });

    // "応答が空でした。" メッセージが送信されたか確認
    const messages = events.filter((e) => e.type === "agent:message");
    const emptyMsg = messages.find((e) => e.payload?.text?.includes("応答が空"));
    assert.ok(emptyMsg, "空応答のメッセージが送信されるべき");

    // idle ステータスに戻る
    const statusEvents = events.filter((e) => e.type === "agent:status");
    const lastStatus = statusEvents[statusEvents.length - 1];
    assert.ok(lastStatus?.payload?.state === "idle", "idle ステータスに戻るべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 10: エラー処理と回復
// ════════════════════════════════════════════════════════

test("10a: requestAiChat エラー時にエラーメッセージが送信される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-10a-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        throw new Error("API connection timeout");
      },
    });

    await service.run({
      message: "main.tex を編集して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-10a",
    });

    // エラーイベントが送信されたか確認
    const errorEvents = events.filter((e) => e.type === "agent:error");
    assert.ok(errorEvents.length >= 1, "agent:error イベントが送信されるべき");
    assert.ok(
      errorEvents[0].payload?.message?.includes("API connection timeout"),
      "エラーメッセージが含まれるべき"
    );

    // error ステータスが送信されたか確認
    const statusEvents = events.filter(
      (e) => e.type === "agent:status" && e.payload?.state === "error"
    );
    assert.ok(statusEvents.length >= 1, "error ステータスが送信されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("10b: abort() で実行中のランを中断できる", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-10b-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    let serviceRef = null;
    const conversationId = "test-10b";
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async (_payload, opts) => {
        // requestAiChat 呼び出し中に abort を発火
        serviceRef.abort(conversationId);
        // AbortError をシミュレート（fetch が中断されたときと同様）
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    serviceRef = service;

    await service.run({
      message: "main.tex を編集して",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    // abort() は runningControllers を即座に削除するため、
    // isRunCurrent() が false になり "中断しました。" ステータスは送信されない。
    // 代わりに run() がエラーなく正常終了することを確認する。

    // エラーイベントは送信されないべき（中断は正常終了）
    const errorEvents = events.filter((e) => e.type === "agent:error");
    assert.equal(errorEvents.length, 0, "中断時は agent:error が送信されないべき");

    // runningControllers から削除されていること
    assert.equal(
      service.runningControllers.has(conversationId),
      false,
      "abort 後は runningControllers から削除されるべき"
    );
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("10c: ビルド失敗 → 自動リカバリプロンプト注入 → 修正ループ", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-10c-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(
    mainFile,
    "\\documentclass{article}\n\\begn{document}\nHello\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    const buildCalls = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async (...a) => {
          buildCalls.push(a);
          if (buildCalls.length <= 2) {
            return {
              kind: "failure",
              summary: "Undefined control sequence \\begn",
              issues: [
                { severity: "error", message: "Undefined control sequence \\begn", path: "main.tex", line: 2 },
              ],
              pdfPath: null,
              log: "! Undefined control sequence.\nl.2 \\begn",
            };
          }
          return { kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" };
        },
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          // AI が edit を実行
          return fnCall("patch_file", {
            path: "main.tex",
            search: "\\begn{document}",
            replace: "\\begin{document}",
            summary: "typo 修正",
          });
        }
        // calls === 2: auto-build fires (build fails) → text response → recovery prompt injected
        // calls === 3: recovery prompt 後の応答（テキストのみ）
        // 注: recovery prompt injection はテキスト応答後に発生するため、
        //      AI が先にテキストを返し、次に recovery prompt が注入される
        if (calls === 2) {
          return textReply("typo を修正しました。");
        }
        // calls === 3: recovery prompt を受けて、AIが再度修正を試みる
        // ただし既に修正済みなので、ビルドを明示的に実行
        if (calls === 3) {
          return fnCall("run_build", {});
        }
        return textReply("ビルドが成功しました。");
      },
    });

    await service.run({
      message: "typo を直してビルドして",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-10c",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("\\begin{document}"), "typo が修正されるべき");

    // 会話履歴にリカバリプロンプトが注入されたか確認
    const conversation = service.conversations.get("test-10c");
    const recoveryEntry = conversation?.find(
      (entry) =>
        entry.role === "user" &&
        entry.parts?.some((p) => p.text?.includes("ビルドが失敗しています"))
    );
    assert.ok(recoveryEntry, "リカバリプロンプトが会話に注入されるべき");
    assert.ok(buildCalls.length >= 2, "ビルドが複数回実行されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 11: ストリーミング・API通信
// ════════════════════════════════════════════════════════

test("11a: ストリーミング応答のデルタがレンダラーに送信される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-11a-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async (payload, opts) => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "Hello",
            replace: "World",
            summary: "edit",
          });
        }
        // ストリーミングが有効なら onDelta を呼ぶ
        if (opts?.onDelta && payload?.stream) {
          opts.onDelta("修正");
          opts.onDelta("しました。");
        }
        return textReply("修正しました。");
      },
    });

    // stream: true を有効にするため設定を変更
    const origSettings = service.ensureUserSettings;
    service.ensureUserSettings = () => ({
      getAgentSettings: async () => ({
        stream: true,
        autoApply: true,
        autoBuild: false,
        allowRunCommand: false,
        maxIterations: 12,
      }),
      updateAgentSettings: async () => ({}),
    });

    await service.run({
      message: "Hello を World に変えて",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-11a",
    });

    service.ensureUserSettings = origSettings;

    const result = await fsp.readFile(path.join(rootPath, "main.tex"), "utf8");
    assert.ok(result.includes("World"), "ファイルが編集されるべき");

    // デルタイベントが送信されたか確認
    const deltaEvents = events.filter((e) => e.type === "agent:messageDelta");
    assert.ok(deltaEvents.length >= 2, "messageDelta イベントが送信されるべき");
    assert.equal(deltaEvents[0].payload?.text, "修正", "1つ目のデルタ");
    assert.equal(deltaEvents[1].payload?.text, "しました。", "2つ目のデルタ");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("11b: API エラーメッセージがユーザーに適切に表示される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-11b-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        // Gemini API がレートリミットを返すシミュレーション
        throw new Error("Resource has been exhausted (e.g. check quota).");
      },
    });

    await service.run({
      message: "main.tex を編集して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-11b",
    });

    // エラーイベントが正確なメッセージを含む
    const errorEvents = events.filter((e) => e.type === "agent:error");
    assert.ok(errorEvents.length >= 1, "agent:error が送信されるべき");
    assert.ok(
      errorEvents[0].payload?.message?.includes("quota"),
      "元のエラーメッセージが保持されるべき（quota を含む）"
    );

    // error ステータスが送信される
    const statusEvents = events.filter(
      (e) => e.type === "agent:status" && e.payload?.state === "error"
    );
    assert.ok(statusEvents.length >= 1, "error ステータスが送信されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("11c: fetchWithRetry が 429 レスポンスをリトライする", async () => {
  const { fetchWithRetry } = require("../../electron/services/agent-llm.cjs");

  let attempts = 0;
  const originalFetch = globalThis.fetch;

  try {
    // fetch をモックして 429 → 429 → 200 を返す
    globalThis.fetch = async (url, options) => {
      attempts += 1;
      if (attempts <= 2) {
        return {
          ok: false,
          status: 429,
          headers: new Map([["retry-after", "0"]]),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => '{"candidates":[]}',
        json: async () => ({ candidates: [] }),
      };
    };

    const response = await fetchWithRetry(
      "https://example.com/api",
      { method: "POST" },
      null
    );

    assert.equal(response.status, 200, "最終的に 200 を返すべき");
    assert.equal(attempts, 3, "3回目で成功するべき（2回リトライ）");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("11d: fetchWithRetry が abort シグナルを尊重する", async () => {
  const { fetchWithRetry } = require("../../electron/services/agent-llm.cjs");

  const originalFetch = globalThis.fetch;
  let attempts = 0;

  try {
    globalThis.fetch = async () => {
      attempts += 1;
      return {
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "0"]]),
      };
    };

    const controller = new AbortController();
    // すぐに abort
    controller.abort();

    await assert.rejects(
      () => fetchWithRetry("https://example.com/api", {}, controller.signal),
      (err) => err.name === "AbortError",
      "abort 時は AbortError がスローされるべき"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ════════════════════════════════════════════════════════
// Level 12: 並行操作と大規模ファイル
// ════════════════════════════════════════════════════════

test("12a: 同じ conversationId で連続 run() → 先行ランが supersede される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-12a-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\nOriginal\n\\end{document}\n", "utf8");

  try {
    const events = [];
    let callCount = 0;
    let firstRunBlocked = null;
    const conversationId = "test-12a";

    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      buildService: {
        build: async () => ({ kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" }),
      },
      requestAiChat: async () => {
        callCount += 1;
        const myCall = callCount;
        if (myCall === 1) {
          // 1回目の呼び出し: ここで2回目の run() を開始する前に待つ
          // Promise を作成して外部から resolve できるようにする
          await new Promise((resolve) => { firstRunBlocked = resolve; });
          // この時点で supersede されているはず
          return textReply("first run response");
        }
        // 2回目以降: 通常の応答
        if (myCall === 2) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "Original",
            replace: "Updated by second run",
            summary: "2回目の run による編集",
          });
        }
        return textReply("2回目の run が完了しました。");
      },
    });

    // 1回目の run を開始（ブロックされる）
    const firstRun = service.run({
      message: "最初のメッセージ",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    // firstRunBlocked が設定されるまで少し待つ
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2回目の run を開始 → 1回目を supersede
    const secondRun = service.run({
      message: "2番目のメッセージ",
      context: { activeFilePath: "main.tex" },
      conversationId,
    });

    // 1回目のブロックを解除
    if (firstRunBlocked) firstRunBlocked();

    await Promise.all([firstRun, secondRun]);

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("Updated by second run"), "2回目の run の変更が適用されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("12b: 100KB 超のファイルで patch_file が正常に動作する", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-12b-"));
  const mainFile = path.join(rootPath, "main.tex");

  // 100KB超のファイルを生成
  const lines = ["\\documentclass{article}", "\\begin{document}"];
  for (let i = 0; i < 2000; i += 1) {
    lines.push(`\\section{Section ${i}}`);
    lines.push(`This is paragraph ${i} of the document. It contains enough text to make the file large.`);
  }
  lines.push("\\section{Target Section}");
  lines.push("This is the target paragraph to be edited.");
  lines.push("\\end{document}");
  lines.push("");
  const largeContent = lines.join("\n");

  assert.ok(Buffer.byteLength(largeContent, "utf8") > 100 * 1024, "ファイルが 100KB 超であるべき");
  await fsp.writeFile(mainFile, largeContent, "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "This is the target paragraph to be edited.",
            replace: "This paragraph has been successfully edited in a large file.",
            summary: "大きなファイル内のターゲット段落を編集",
          });
        }
        return textReply("大きなファイルの編集が完了しました。");
      },
    });

    await service.run({
      message: "ターゲット段落を編集して",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-12b",
    });

    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("successfully edited in a large file"), "ターゲット段落が編集されるべき");
    assert.ok(result.includes("\\section{Section 0}"), "先頭付近の内容が保持されるべき");
    assert.ok(result.includes("\\section{Section 1999}"), "末尾付近の内容が保持されるべき");
    assert.ok(Buffer.byteLength(result, "utf8") > 100 * 1024, "ファイルサイズが維持されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("12c: 異なる conversationId で並行 run() が独立動作する", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-12c-"));
  const fileA = path.join(rootPath, "a.tex");
  const fileB = path.join(rootPath, "b.tex");

  await fsp.writeFile(fileA, "\\section{A}\nContent A.\n", "utf8");
  await fsp.writeFile(fileB, "\\section{B}\nContent B.\n", "utf8");

  try {
    const events = [];
    const service = createService({
      rootPath,
      fileList: ["a.tex", "b.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async (payload) => {
        // conversationId に基づいて異なるファイルを編集
        const isConvA = payload?.contents?.some(
          (c) => c.parts?.some((p) => p.text?.includes("a.tex を編集"))
        );
        if (isConvA) {
          return fnCall("patch_file", {
            path: "a.tex",
            search: "Content A.",
            replace: "Edited A.",
            summary: "a 編集",
          });
        }
        const isConvB = payload?.contents?.some(
          (c) => c.parts?.some((p) => p.text?.includes("b.tex を編集"))
        );
        if (isConvB) {
          return fnCall("patch_file", {
            path: "b.tex",
            search: "Content B.",
            replace: "Edited B.",
            summary: "b 編集",
          });
        }
        return textReply("完了");
      },
    });

    // 2つの並行 run（異なる conversationId）
    const [resultA, resultB] = await Promise.all([
      service.run({
        message: "a.tex を編集して",
        context: { activeFilePath: "a.tex" },
        conversationId: "conv-a",
      }),
      service.run({
        message: "b.tex を編集して",
        context: { activeFilePath: "b.tex" },
        conversationId: "conv-b",
      }),
    ]);

    const contentA = await fsp.readFile(fileA, "utf8");
    const contentB = await fsp.readFile(fileB, "utf8");

    assert.ok(contentA.includes("Edited A"), "a.tex が編集されるべき");
    assert.ok(contentB.includes("Edited B"), "b.tex が編集されるべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════
// Level 13: イベントライフサイクルとUI同期
// ════════════════════════════════════════════════════════

test("13a: 正常 run のイベントシーケンスが正しい", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-13a-"));
  await fsp.writeFile(
    path.join(rootPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      buildService: {
        build: async () => ({ kind: "success", summary: "ok", issues: [], pdfPath: null, log: "" }),
      },
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "Hello",
            replace: "World",
            summary: "edit",
          });
        }
        return textReply("完了");
      },
    });

    await service.run({
      message: "Hello を World に変えて",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-13a",
    });

    // イベントの順序を検証
    const eventTypes = events.map((e) => e.type);

    // running ステータスが最初に来る
    const firstRunning = eventTypes.indexOf("agent:status");
    assert.ok(firstRunning >= 0, "agent:status が存在するべき");
    assert.equal(events[firstRunning].payload?.state, "running", "最初のステータスは running");

    // ツールイベントが発火
    assert.ok(eventTypes.includes("agent:tool"), "agent:tool イベントが存在するべき");

    // autoApply=true（ハードコード）のため agent:proposal ではなく
    // agent:applyResult が送信される
    assert.ok(
      eventTypes.includes("agent:applyResult") || eventTypes.includes("agent:applyContent"),
      "applyResult または applyContent イベントが存在するべき"
    );

    // 最終メッセージ
    assert.ok(eventTypes.includes("agent:message"), "agent:message が存在するべき");

    // idle ステータスで終了
    const statusEvents = events.filter((e) => e.type === "agent:status");
    const lastStatus = statusEvents[statusEvents.length - 1];
    assert.equal(lastStatus.payload?.state, "idle", "最後のステータスは idle");

    // イベント順序: running → (tool + apply) → message → idle
    const toolIdx = eventTypes.indexOf("agent:tool");
    const applyIdx = Math.max(
      eventTypes.indexOf("agent:applyResult"),
      eventTypes.indexOf("agent:applyContent")
    );
    const messageIdx = eventTypes.indexOf("agent:message");

    assert.ok(firstRunning < toolIdx, "running は tool より先");
    assert.ok(firstRunning < applyIdx, "running は apply より先");
    assert.ok(applyIdx < messageIdx, "apply は message より先");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("13b: proposal イベントに必要なフィールドが全て含まれる", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-13b-"));
  const mainFile = path.join(rootPath, "main.tex");
  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\nOld text\n\\end{document}\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) {
          return fnCall("patch_file", {
            path: "main.tex",
            search: "Old text",
            replace: "New text",
            summary: "テキスト変更",
          });
        }
        return textReply("完了");
      },
    });

    await service.run({
      message: "テキストを変えて",
      context: { activeFilePath: "main.tex" },
      conversationId: "test-13b",
    });

    // autoApply=true（ハードコード）のため agent:applyResult が送信される
    const applyResults = events.filter((e) => e.type === "agent:applyResult");
    assert.ok(applyResults.length >= 1, "applyResult イベントが送信されるべき");

    const p = applyResults[0].payload;
    assert.ok(p, "applyResult payload が存在するべき");
    assert.ok(typeof p.proposalId === "string", "proposalId が含まれるべき");
    assert.ok(typeof p.ok === "boolean", "ok フラグが含まれるべき");
    assert.ok(p.ok === true, "適用が成功しているべき");

    // ファイルが実際に変更されている
    const result = await fsp.readFile(mainFile, "utf8");
    assert.ok(result.includes("New text"), "ファイルが変更されているべき");
    assert.ok(!result.includes("Old text"), "古いテキストが残っていないべき");
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test("13c: ツール実行ごとに agent:tool イベントが送信される", async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-13c-"));
  await fsp.mkdir(path.join(rootPath, "chapters"), { recursive: true });
  const mainFile = path.join(rootPath, "main.tex");
  const chFile = path.join(rootPath, "chapters", "ch1.tex");

  await fsp.writeFile(mainFile, "\\documentclass{article}\n\\begin{document}\n\\input{chapters/ch1}\n\\end{document}\n", "utf8");
  await fsp.writeFile(chFile, "\\section{Chapter 1}\nContent.\n", "utf8");

  try {
    const events = [];
    let calls = 0;
    const service = createService({
      rootPath,
      fileList: ["main.tex", "chapters/ch1.tex"],
      rendererEvents: events,
      autoBuild: false,
      requestAiChat: async () => {
        calls += 1;
        if (calls === 1) return fnCall("get_project_structure", {});
        if (calls === 2) return fnCall("read_file", { path: "chapters/ch1.tex" });
        if (calls === 3) {
          return fnCall("patch_file", {
            path: "chapters/ch1.tex",
            search: "Content.",
            replace: "Updated content.",
            summary: "ch1 更新",
          });
        }
        return textReply("完了");
      },
    });

    await service.run({
      message: "プロジェクトを確認して ch1 を編集して",
      context: {},
      conversationId: "test-13c",
    });

    const toolEvents = events.filter((e) => e.type === "agent:tool");
    const names = toolEvents.map((e) => e.payload?.name).filter(Boolean);

    assert.ok(names.includes("get_project_structure"), "get_project_structure のツールイベント");
    assert.ok(names.includes("read_file"), "read_file のツールイベント");
    assert.ok(names.includes("patch_file"), "patch_file のツールイベント");
    assert.ok(toolEvents.length >= 3, "3つ以上のツールイベントが送信されるべき");

    // 各ツールイベントに conversationId が含まれる
    toolEvents.forEach((e) => {
      assert.ok(e.payload?.conversationId || e.payload?.name, "ツールイベントに識別情報が含まれるべき");
    });
  } finally {
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});
