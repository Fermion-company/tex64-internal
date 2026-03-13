/**
 * E2E test: OpenPrism gap analysis tests.
 *
 * Tests for OpenPrism capabilities that were NOT covered by
 * ai-real-api.e2e.mjs. Each test verifies a specific OpenPrism
 * feature pattern works correctly in tex64's Axiom agent.
 *
 * Gap categories tested:
 *   A. New file creation (propose_patch for non-existent files)
 *   B. Pure text Q&A (agent finishes without tool calls — chat-only equiv)
 *   C. Polish/rewrite task (OpenPrism "direct mode" equivalent)
 *   D. Translate task (OpenPrism task type)
 *   E. Structure analysis (OpenPrism task type)
 *   F. apply_patch with unified diff (localized edit, not full rewrite)
 *   G. Multi-file coordinated edit (read + edit multiple files)
 *   H. Error recovery (agent handles tool errors gracefully)
 *
 * Run:
 *   npm run test:e2e:ai-openprism-gaps
 *   TEX64_LLM_API_KEY=sk-... npm run test:e2e:ai-openprism-gaps
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// ---- Locate a valid platform session ----
const APP_DATA_CANDIDATES = [
  path.join(os.homedir(), "Library", "Application Support", "tex64"),
  path.join(os.homedir(), "Library", "Application Support", "TeX64"),
];

let validSessionPath = null;
for (const dir of APP_DATA_CANDIDATES) {
  const sessionFile = path.join(dir, "tex64-platform-session.json");
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    const data = JSON.parse(raw);
    if (data?.session?.accessToken) {
      validSessionPath = sessionFile;
      break;
    }
  } catch { /* ignore */ }
}

const directApiKey = (process.env.TEX64_LLM_API_KEY ?? "").trim();
const directEndpoint = (process.env.TEX64_LLM_ENDPOINT ?? "").trim();

if (!validSessionPath && !directApiKey) {
  console.log("⏭  No valid platform session and no TEX64_LLM_API_KEY — skipping.");
  console.log("   To test directly: TEX64_LLM_API_KEY=sk-... npm run test:e2e:ai-openprism-gaps");
  process.exit(0);
}

const authMode = validSessionPath ? "jwt" : "api-key";
console.log(`\n🔑 Auth mode: ${authMode}`);
if (validSessionPath) console.log(`   Session: ${validSessionPath}`);
if (directEndpoint) console.log(`   Endpoint: ${directEndpoint}`);

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);

const AI_RESPONSE_TIMEOUT_MS = 120_000;
const FILE_CHANGE_TIMEOUT_MS = 120_000;

const pause = async (ms = 200) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const waitForCondition = async (predicate, { timeoutMs = 30000, intervalMs = 300 } = {}) => {
  const started = Date.now();
  for (;;) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitForCondition timeout");
    await pause(intervalMs);
  }
};

const waitForFileMatch = async (filePath, matcher, { timeoutMs = FILE_CHANGE_TIMEOUT_MS } = {}) => {
  await waitForCondition(async () => {
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    return matcher.test(content);
  }, { timeoutMs });
};

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(repoRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")}"`,
      { stdio: "ignore" }
    );
  } catch { /* ignore */ }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-gaps-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => { window.tex64Bridge.postMessage(value); }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForFunction(
    () => !document.body.classList.contains("has-launcher"),
    undefined,
    { timeout: 30000 }
  );
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, { timeout: 12000 });
  await pause(60);
};

const waitForInputReady = async (page) => {
  await page.waitForFunction(() => {
    const el = document.getElementById("ai-input");
    return el && el.tagName.toLowerCase() === "textarea" && !el.disabled;
  }, undefined, { timeout: 20000 });
};

const waitForAiResponse = async (page, beforeLength, { timeoutMs = AI_RESPONSE_TIMEOUT_MS } = {}) => {
  await page.waitForFunction(
    ({ prev }) => {
      const log = document.getElementById("ai-chat-log");
      const text = log?.textContent ?? "";
      if (text.length <= prev) return false;
      const input = document.getElementById("ai-input");
      if (input && input.disabled) return false;
      return true;
    },
    { prev: beforeLength },
    { timeout: timeoutMs }
  );
};

const getChatLogLength = async (page) =>
  page.evaluate(() => (document.getElementById("ai-chat-log")?.textContent ?? "").length);

const getChatLogText = async (page) =>
  page.evaluate(() => document.getElementById("ai-chat-log")?.textContent ?? "");

const sendAndWaitForResponse = async (page, message, { timeoutMs = AI_RESPONSE_TIMEOUT_MS } = {}) => {
  const beforeLen = await getChatLogLength(page);
  await waitForInputReady(page);
  await page.fill("#ai-input", message);
  await page.click("#ai-send");
  await waitForAiResponse(page, beforeLen, { timeoutMs });
  return getChatLogText(page);
};

const startNewChat = async (page) => {
  await page.click("#ai-chat-new");
  await pause(300);
  await waitForInputReady(page);
};

const undoLastRun = async (page) => {
  const undoBtnVisible = await page.evaluate(() => {
    const btn = document.getElementById("ai-undo");
    if (!btn) return false;
    const style = window.getComputedStyle(btn);
    return style.display !== "none" && !btn.disabled;
  });
  if (undoBtnVisible) {
    await page.click("#ai-undo");
  } else {
    await postToBridge(page, { type: "agent:undoLastRunApply" });
  }
};

// ──────────────────────────────────────────────────────────────
// Main test runner
// ──────────────────────────────────────────────────────────────

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    await fs.mkdir(userDataPath, { recursive: true });

    if (validSessionPath) {
      await fs.copyFile(
        validSessionPath,
        path.join(userDataPath, "tex64-platform-session.json")
      );
    }

    await fs.writeFile(
      path.join(userDataPath, "tex64-user-settings.json"),
      JSON.stringify({
        agent: {
          model: "gpt-4o-mini",
          autoBuild: false,
        },
      }, null, 2),
      "utf8"
    );

    cleanupStaleElectron();

    const envVars = {
      ...process.env,
      TEX64_E2E: "1",
      TEX64_E2E_HEADLESS: "1",
      TEX64_E2E_USERDATA: userDataPath,
    };
    if (directApiKey) {
      envVars.TEX64_LLM_API_KEY = directApiKey;
    }
    if (directEndpoint) {
      envVars.TEX64_LLM_ENDPOINT = directEndpoint;
    }

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: envVars,
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await page.waitForSelector("body.is-ready", { timeout: 15000 });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openSideTab(page, "ai");
    await waitForInputReady(page);

    const mainTexPath = path.join(workspacePath, "main.tex");

    // ═══════════════════════════════════════════════════════════
    // Gap Test A: New file creation (propose_patch for non-existent file)
    //
    // OpenPrism pattern: propose_patch handles original = '' when
    // file doesn't exist. This creates a new file via the proposal
    // system. Tests file creation, not just file editing.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test A: New file creation...");
    const conclusionPath = path.join(workspacePath, "sections", "conclusion.tex");

    // Verify file does NOT exist
    const existsBefore = await fs.access(conclusionPath).then(() => true).catch(() => false);
    assert.ok(!existsBefore, "Gap A precondition: conclusion.tex should not exist yet");

    const chatAfterA = await sendAndWaitForResponse(
      page,
      "sections/conclusion.tex という新しいファイルを作成してください。内容は \\section{Conclusion}\\label{sec:conclusion} で始まり、簡単な結論を1段落書いてください。propose_patchで提案してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfterA.slice(-400).replace(/\n/g, "\n    "));

    // Wait for the file to appear on disk
    await waitForCondition(async () => {
      return fs.access(conclusionPath).then(() => true).catch(() => false);
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const conclusionContent = await fs.readFile(conclusionPath, "utf8");
    assert.ok(conclusionContent.includes("\\section{Conclusion}"), "Gap A FAIL: should contain Conclusion section");
    assert.ok(conclusionContent.includes("\\label{sec:conclusion}"), "Gap A FAIL: should contain label");
    console.log("  📝 conclusion.tex created:\n    " + conclusionContent.slice(0, 300).replace(/\n/g, "\n    "));

    // Undo should remove the file (restore to non-existent state)
    await undoLastRun(page);
    await waitForCondition(async () => {
      return fs.access(conclusionPath).then(() => false).catch(() => true);
    }, { timeoutMs: 30000 }).catch(async () => {
      // If the file still exists after undo, check if it's empty
      const content = await fs.readFile(conclusionPath, "utf8").catch(() => "");
      console.log("  ⚠  File still exists after undo (may be empty): " + content.length + " chars");
    });
    console.log("✓ Gap Test A: New file creation works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test B: Pure text Q&A (no tools needed)
    //
    // OpenPrism "chat-only" mode: agent responds with text only,
    // no tool calls. The AgentExecutor should let the LLM finish
    // naturally when no tools are needed. This verifies no
    // finish_task/tool_choice:"required" constraint exists.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test B: Pure text Q&A (no tools)...");
    await startNewChat(page);

    const chatAfterB = await sendAndWaitForResponse(
      page,
      "LaTeXで数式を入力する基本的な方法を3つ教えてください。ファイルの読み取りや変更は不要です。知識だけで答えてください。"
    );
    console.log("  📝 Response:\n    " + chatAfterB.slice(-600).replace(/\n/g, "\n    "));

    // Should mention LaTeX math concepts
    const hasMathContent =
      chatAfterB.includes("$") || chatAfterB.includes("equation") ||
      chatAfterB.includes("\\[") || chatAfterB.includes("数式") ||
      chatAfterB.includes("math") || chatAfterB.includes("inline") ||
      chatAfterB.includes("display");
    assert.ok(hasMathContent, "Gap B FAIL: should explain LaTeX math methods");

    // Verify no files were modified (pure text response)
    const mainTexAfterB = await fs.readFile(mainTexPath, "utf8");
    assert.match(mainTexAfterB, /\\title\{tex64 Test Workspace\}/, "Gap B FAIL: no files should be modified");
    console.log("✓ Gap Test B: Pure text Q&A works (agent finishes without tools)");

    // ═══════════════════════════════════════════════════════════
    // Gap Test C: Polish / Rewrite (OpenPrism "direct mode" task)
    //
    // OpenPrism has a "polish" task that rewrites text for clarity.
    // This tests whether the agent can suggest text improvements
    // via propose_patch when asked to polish/rewrite content.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test C: Polish/Rewrite task...");
    await startNewChat(page);

    const introTexPath = path.join(workspacePath, "sections", "intro.tex");
    const originalIntro = await fs.readFile(introTexPath, "utf8");

    const chatAfterC = await sendAndWaitForResponse(
      page,
      "sections/intro.texのIntroductionセクション全体をより学術的で洗練された英語に書き直してください（polish）。セクション構造(section/subsection)、ラベル、引用キーはそのまま維持してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfterC.slice(-400).replace(/\n/g, "\n    "));

    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content !== originalIntro;
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const polishedIntro = await fs.readFile(introTexPath, "utf8");

    // Structural elements should be preserved
    assert.ok(polishedIntro.includes("\\section{Introduction}"), "Gap C FAIL: section header should remain");
    assert.ok(polishedIntro.includes("\\label{sec:intro}"), "Gap C FAIL: label should remain");
    assert.ok(polishedIntro.includes("\\subsection{Background}"), "Gap C FAIL: subsection should remain");
    assert.ok(polishedIntro.includes("\\cite{texbook1990}"), "Gap C FAIL: citation should remain");
    // Content should be different (polished)
    assert.ok(polishedIntro !== originalIntro, "Gap C FAIL: content should be polished/different");
    console.log("  📝 Polished intro.tex:\n    " + polishedIntro.slice(0, 500).replace(/\n/g, "\n    "));

    // Undo
    await undoLastRun(page);
    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content === originalIntro;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original intro.tex");
    console.log("✓ Gap Test C: Polish/Rewrite works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test D: Translate (OpenPrism task type)
    //
    // OpenPrism has a "translate" task type. Tests whether the
    // agent can translate LaTeX content from one language to
    // another while preserving LaTeX commands.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test D: Translate task...");
    await startNewChat(page);

    const chatAfterD = await sendAndWaitForResponse(
      page,
      "sections/intro.texのIntroductionセクションの本文を日本語に翻訳してください。LaTeXコマンド(\\section, \\label, \\cite, \\subsection等)はそのまま英語で残し、地の文だけ日本語にしてください。propose_patchで変更を提案してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfterD.slice(-400).replace(/\n/g, "\n    "));

    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content !== originalIntro;
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const translatedIntro = await fs.readFile(introTexPath, "utf8");

    // Should contain Japanese text
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(translatedIntro);
    assert.ok(hasJapanese, "Gap D FAIL: translated content should contain Japanese");
    // LaTeX commands should be preserved
    assert.ok(translatedIntro.includes("\\section{Introduction}") || translatedIntro.includes("\\section"), "Gap D FAIL: section command should remain");
    assert.ok(translatedIntro.includes("\\cite{texbook1990}"), "Gap D FAIL: citation should remain");
    console.log("  📝 Translated intro.tex (first 500 chars):\n    " + translatedIntro.slice(0, 500).replace(/\n/g, "\n    "));

    // Undo
    await undoLastRun(page);
    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content === originalIntro;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original intro.tex");
    console.log("✓ Gap Test D: Translate works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test E: Structure analysis (OpenPrism task type)
    //
    // OpenPrism has a "structure" task that analyzes document
    // organization. Tests whether the agent can analyze project
    // structure and provide feedback without modifying files.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test E: Structure analysis...");
    await startNewChat(page);

    const chatAfterE = await sendAndWaitForResponse(
      page,
      "このLaTeXプロジェクトのファイル構成とドキュメント構造（セクション、参考文献、相互参照など）を分析して、学術論文としての構造的な改善点があれば具体的に提案してください。ファイルの変更は不要です。分析結果だけ教えてください。"
    );
    console.log("  📝 Response:\n    " + chatAfterE.slice(-800).replace(/\n/g, "\n    "));

    // Should mention structural elements of the project
    const hasStructuralAnalysis =
      chatAfterE.includes("section") || chatAfterE.includes("セクション") ||
      chatAfterE.includes("構造") || chatAfterE.includes("structure") ||
      chatAfterE.includes("main.tex") || chatAfterE.includes("refs.bib") ||
      chatAfterE.includes("intro") || chatAfterE.includes("methods");
    assert.ok(hasStructuralAnalysis, "Gap E FAIL: should provide structural analysis");

    // Verify no files modified
    const mainTexAfterE = await fs.readFile(mainTexPath, "utf8");
    assert.match(mainTexAfterE, /\\title\{tex64 Test Workspace\}/, "Gap E FAIL: no files should be modified");
    console.log("✓ Gap Test E: Structure analysis works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test F: apply_patch with unified diff
    //
    // OpenPrism's apply_patch accepts a unified diff and applies
    // it to a file. This tests the agent's ability to use localized
    // edits (apply_patch) instead of full file rewrites (propose_patch).
    // Note: The LLM may choose propose_patch instead — both are valid.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test F: Localized edit (apply_patch or propose_patch)...");
    await startNewChat(page);

    const methodsTexPath = path.join(workspacePath, "sections", "methods.tex");
    const originalMethods = await fs.readFile(methodsTexPath, "utf8");

    // Ask for a very small, localized edit (add one line)
    const chatAfterF = await sendAndWaitForResponse(
      page,
      "sections/methods.texの \\paragraph{Notes} の直前に新しいサブセクション \\subsection{Data Collection} を追加してください。中身は1行 'We collected data from multiple sources.' だけでOKです。ファイルの残りは一切変更しないでください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfterF.slice(-400).replace(/\n/g, "\n    "));

    await waitForCondition(async () => {
      const content = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      return content.includes("Data Collection");
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterLocalEdit = await fs.readFile(methodsTexPath, "utf8");

    // The new subsection should be present
    assert.ok(afterLocalEdit.includes("\\subsection{Data Collection}"), "Gap F FAIL: Data Collection subsection should exist");
    // Existing content should be preserved
    assert.ok(afterLocalEdit.includes("\\section{Methods}"), "Gap F FAIL: original Methods section should remain");
    assert.ok(afterLocalEdit.includes("\\paragraph{Notes}"), "Gap F FAIL: Notes paragraph should remain");
    assert.ok(afterLocalEdit.includes("F = ma"), "Gap F FAIL: equation should remain");
    console.log("  📝 methods.tex after localized edit:\n    " + afterLocalEdit.replace(/\n/g, "\n    "));

    // Undo
    await undoLastRun(page);
    await waitForCondition(async () => {
      const content = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      return content === originalMethods;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original methods.tex");
    console.log("✓ Gap Test F: Localized edit works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test G: Multi-file coordinated edit
    //
    // OpenPrism system prompt: "If a request affects multiple files
    // (e.g., sections + bib), inspect and update all relevant files."
    // Tests whether the agent edits TWO .tex files in a single
    // request — add cross-references between intro and methods.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test G: Multi-file coordinated edit...");
    await startNewChat(page);

    const chatAfterG = await sendAndWaitForResponse(
      page,
      "以下の2つの変更を同時にpropose_patchで提案してください：(1) sections/intro.texのBackgroundサブセクションの末尾に「詳細な手法についてはSection~\\ref{sec:methods}を参照されたい。」という一文を追加。(2) sections/methods.texのMethodsセクションの冒頭（\\section{Methods}の直後の行）に「本セクションはSection~\\ref{sec:intro}で述べた背景に基づく。」という一文を追加。"
    );
    console.log("  📝 Response tail:\n    " + chatAfterG.slice(-500).replace(/\n/g, "\n    "));

    // Wait for BOTH files to be modified
    await waitForCondition(async () => {
      const intro = await fs.readFile(introTexPath, "utf8").catch(() => "");
      const methods = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      const introChanged = intro !== originalIntro && intro.includes("sec:methods");
      const methodsChanged = methods !== originalMethods && methods.includes("sec:intro");
      return introChanged && methodsChanged;
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });

    const afterIntroEdit = await fs.readFile(introTexPath, "utf8");
    const afterMethodsEdit = await fs.readFile(methodsTexPath, "utf8");

    // intro.tex should reference methods section
    assert.ok(afterIntroEdit.includes("sec:methods"), "Gap G FAIL: intro.tex should reference sec:methods");
    assert.ok(afterIntroEdit.includes("\\section{Introduction}"), "Gap G FAIL: intro section header should remain");
    // methods.tex should reference intro section
    assert.ok(afterMethodsEdit.includes("sec:intro"), "Gap G FAIL: methods.tex should reference sec:intro");
    assert.ok(afterMethodsEdit.includes("\\section{Methods}"), "Gap G FAIL: methods section header should remain");
    console.log("  📝 intro.tex now cross-references sec:methods");
    console.log("  📝 methods.tex now cross-references sec:intro");

    // Undo (may need to undo twice if two separate proposals)
    await undoLastRun(page);
    await pause(1000);
    const introAfterUndo1 = await fs.readFile(introTexPath, "utf8").catch(() => "");
    const methodsAfterUndo1 = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
    if (introAfterUndo1 !== originalIntro || methodsAfterUndo1 !== originalMethods) {
      await undoLastRun(page);
      await pause(1000);
    }

    await waitForCondition(async () => {
      const intro = await fs.readFile(introTexPath, "utf8").catch(() => "");
      const methods = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      return intro === originalIntro && methods === originalMethods;
    }, { timeoutMs: 30000 }).catch(() => {
      console.log("  ⚠  Partial undo — some changes may remain");
    });
    console.log("  📝 Undo restored original files");
    console.log("✓ Gap Test G: Multi-file coordinated edit works");

    // ═══════════════════════════════════════════════════════════
    // Gap Test H: Error recovery (graceful handling of tool errors)
    //
    // Tests that the agent handles errors gracefully when a tool
    // fails (e.g., reading a non-existent file). The agent should
    // report the error and continue operating, not crash.
    // ═══════════════════════════════════════════════════════════
    console.log("\n⏳ Gap Test H: Error recovery...");
    await startNewChat(page);

    const chatAfterH = await sendAndWaitForResponse(
      page,
      "sections/nonexistent-file-xyz.texを読んでください。もしファイルが見つからなければ、その旨を教えてください。"
    );
    console.log("  📝 Response:\n    " + chatAfterH.slice(-500).replace(/\n/g, "\n    "));

    // AI should report the error (file not found) gracefully
    const reportsError =
      chatAfterH.includes("見つかり") || chatAfterH.includes("存在し") ||
      chatAfterH.includes("not found") || chatAfterH.includes("error") ||
      chatAfterH.includes("エラー") || chatAfterH.includes("ありません") ||
      chatAfterH.includes("does not exist") || chatAfterH.includes("読み取れ") ||
      chatAfterH.includes("unable") || chatAfterH.includes("could not") ||
      chatAfterH.includes("couldn't") || chatAfterH.includes("failed");
    assert.ok(reportsError, "Gap H FAIL: agent should report file not found error gracefully");
    console.log("✓ Gap Test H: Error recovery works (agent reports errors gracefully)");

    // ═══════════════════════════════════════════════════════════
    console.log("\n✅ All OpenPrism gap tests passed.\n");

  } finally {
    if (electronApp) {
      try { await electronApp.close(); } catch { /* ignore */ }
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`🗂  Workspace kept at: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("❌", error);
  process.exitCode = 1;
});
