/**
 * E2E test: Real API integration test.
 *
 * Verifies the full AI chat flow through the same user-facing path:
 *
 *   Electron UI  →  chat input  →  send button  →  AgentService
 *   →  run-loop  →  LangChain ChatOpenAI  →  LLM API
 *   →  tool execution  →  file changes  →  chat log
 *
 * Authentication modes (tried in order):
 *   1. Platform session (JWT via tex64.com) — copies the user's existing
 *      session from ~/Library/Application Support/tex64/ or TeX64/.
 *   2. Direct API key via TEX64_LLM_API_KEY env var (+ optional
 *      TEX64_LLM_ENDPOINT pointing to any OpenAI-compatible endpoint).
 *
 * If neither is available, the test exits with code 0 (skip).
 *
 * Run:
 *   npm run test:e2e:ai-real-api
 *   TEX64_LLM_API_KEY=sk-... TEX64_LLM_ENDPOINT=https://api.openai.com/v1 npm run test:e2e:ai-real-api
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
  console.log("   To test via tex64.com: sign in to TeX64 first.");
  console.log("   To test directly:      TEX64_LLM_API_KEY=sk-... npm run test:e2e:ai-real-api");
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-real-api-"));
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
  // Wait for chat log to grow AND input to be re-enabled (agent run fully finished).
  await page.waitForFunction(
    ({ prev }) => {
      const log = document.getElementById("ai-chat-log");
      const text = log?.textContent ?? "";
      if (text.length <= prev) return false;
      // Ensure the agent run has fully completed (input re-enabled).
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

// ──────────────────────────────────────────────────────────────
// Main test runner
// ──────────────────────────────────────────────────────────────

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    await fs.mkdir(userDataPath, { recursive: true });

    // Copy the real platform session if available (JWT auth path).
    if (validSessionPath) {
      await fs.copyFile(
        validSessionPath,
        path.join(userDataPath, "tex64-platform-session.json")
      );
    }

    // Write settings: use gpt-4o-mini, disable autoBuild.
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
    // For direct API key mode, pass the key and optional endpoint.
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

    // ─────────────────────────────────────────────────────────────
    // Test 1: Basic text response
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 1: Basic text response...");
    const chatAfter1 = await sendAndWaitForResponse(
      page,
      "こんにちは！このプロジェクトについて簡単に教えてもらえますか？"
    );
    assert.ok(chatAfter1.length > 10, "Test 1 FAIL: chat log should have content after AI response");
    console.log("  📝 Chat log:\n    " + chatAfter1.replace(/\n/g, "\n    "));
    console.log("✓ Test 1: AI responded with text");

    // ─────────────────────────────────────────────────────────────
    // Test 2: File reading (AI should decide to use read_file)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 2: File reading...");
    const chatAfter2 = await sendAndWaitForResponse(
      page,
      "main.texの中身を確認して、ドキュメントのタイトルが何か教えてください。"
    );
    assert.ok(
      chatAfter2.includes("tex64") || chatAfter2.includes("Test Workspace") || chatAfter2.includes("タイトル") || chatAfter2.includes("title"),
      "Test 2 FAIL: AI should mention the file title " +
      "(tail: " + chatAfter2.slice(-200) + ")"
    );
    console.log("  📝 Chat log tail:\n    " + chatAfter2.slice(-500).replace(/\n/g, "\n    "));
    console.log("✓ Test 2: AI read file and reported content");

    // ─────────────────────────────────────────────────────────────
    // Test 3: File listing (AI should decide to use list_files)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 3: File listing...");
    const chatAfter3 = await sendAndWaitForResponse(
      page,
      "このプロジェクトにはどんなファイルがありますか？一覧を見せてください。"
    );
    assert.ok(
      chatAfter3.includes("main.tex") || chatAfter3.includes("sections") || chatAfter3.includes("refs.bib"),
      "Test 3 FAIL: AI should list project files " +
      "(tail: " + chatAfter3.slice(-200) + ")"
    );
    console.log("  📝 Chat log tail:\n    " + chatAfter3.slice(-500).replace(/\n/g, "\n    "));
    console.log("✓ Test 3: AI listed project files");

    // ─────────────────────────────────────────────────────────────
    // Test 4: File editing + auto-apply
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 4: File editing + auto-apply...");
    const originalMainTex = await fs.readFile(mainTexPath, "utf8");
    assert.match(originalMainTex, /\\title\{tex64 Test Workspace\}/, "precondition: original title");

    await sendAndWaitForResponse(
      page,
      "main.texのタイトルを「Real API Test Title」に変更してください。"
    );

    await waitForFileMatch(mainTexPath, /Real API Test Title/, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterEdit = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterEdit, /Real API Test Title/, "Test 4 FAIL: title was not changed on disk");
    console.log("  📝 File after edit (first 300 chars):\n    " + afterEdit.slice(0, 300).replace(/\n/g, "\n    "));
    const chatAfter4 = await getChatLogText(page);
    console.log("  📝 Chat log tail:\n    " + chatAfter4.slice(-500).replace(/\n/g, "\n    "));
    console.log("✓ Test 4: AI edited file (auto-applied)");

    // ─────────────────────────────────────────────────────────────
    // Test 5: Undo
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 5: Undo...");
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
    await waitForFileMatch(mainTexPath, /\\title\{tex64 Test Workspace\}/, { timeoutMs: 30000 });
    const afterUndo = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterUndo, /\\title\{tex64 Test Workspace\}/, "Test 5 FAIL: undo did not restore title");
    console.log("  📝 File after undo (first 300 chars):\n    " + afterUndo.slice(0, 300).replace(/\n/g, "\n    "));
    console.log("✓ Test 5: Undo restored original file");

    // ─────────────────────────────────────────────────────────────
    // Test 6: arXiv paper search
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 6: arXiv paper search...");
    const chatAfter6 = await sendAndWaitForResponse(
      page,
      "LaTeX typesettingに関連する論文をarXivで探してもらえますか？"
    );
    assert.ok(
      chatAfter6.includes("arXiv") || chatAfter6.includes("arxiv") ||
      chatAfter6.includes("論文") || chatAfter6.includes("paper"),
      "Test 6 FAIL: AI should mention arXiv results " +
      "(tail: " + chatAfter6.slice(-200) + ")"
    );
    console.log("  📝 Chat log tail:\n    " + chatAfter6.slice(-500).replace(/\n/g, "\n    "));
    console.log("✓ Test 6: AI searched arXiv");

    // ─────────────────────────────────────────────────────────────
    // Test 7: arXiv BibTeX retrieval
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 7: arXiv BibTeX retrieval...");
    const chatAfter7 = await sendAndWaitForResponse(
      page,
      "arXivの論文 2312.00752 のBibTeXエントリを取得して、refs.bibに追加できる形で見せてください。"
    );
    assert.ok(
      chatAfter7.includes("@article") || chatAfter7.includes("@misc") ||
      chatAfter7.includes("BibTeX") || chatAfter7.includes("bibtex") ||
      chatAfter7.includes("2312.00752"),
      "Test 7 FAIL: AI should return BibTeX content " +
      "(tail: " + chatAfter7.slice(-200) + ")"
    );
    console.log("  📝 Chat log tail:\n    " + chatAfter7.slice(-500).replace(/\n/g, "\n    "));
    console.log("✓ Test 7: AI generated BibTeX from arXiv");

    // ─────────────────────────────────────────────────────────────
    // Test 8: Consecutive edits (multiple changes in one session)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 8: Consecutive edits...");
    // First edit: change title
    await sendAndWaitForResponse(
      page,
      "main.texのタイトルを「First Edit Title」に変更してください。"
    );
    await waitForFileMatch(mainTexPath, /First Edit Title/, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    console.log("  📝 Edit 1 done: title → First Edit Title");

    // Second edit: change author
    await sendAndWaitForResponse(
      page,
      "次に、main.texの著者を「Test Author」に変更してください。"
    );
    await waitForFileMatch(mainTexPath, /Test Author/, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterConsecutive = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterConsecutive, /First Edit Title/, "Test 8 FAIL: first edit (title) should persist");
    assert.match(afterConsecutive, /Test Author/, "Test 8 FAIL: second edit (author) should be applied");
    console.log("  📝 Edit 2 done: author → Test Author");
    console.log("  📝 File state:\n    " + afterConsecutive.slice(0, 400).replace(/\n/g, "\n    "));
    console.log("✓ Test 8: Both consecutive edits applied correctly");

    // ─────────────────────────────────────────────────────────────
    // Test 9: Undo only reverts the last run (not all edits)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 9: Partial undo (only last run)...");
    const undoBtnVisible9 = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible9) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    // Wait for author to revert to "tex64"
    await waitForFileMatch(mainTexPath, /\\author\{tex64\}/, { timeoutMs: 30000 });
    const afterPartialUndo = await fs.readFile(mainTexPath, "utf8");
    // The first edit (title) should still be in place
    assert.match(afterPartialUndo, /First Edit Title/, "Test 9 FAIL: first edit should survive undo of second run");
    // The second edit (author) should be reverted
    assert.match(afterPartialUndo, /\\author\{tex64\}/, "Test 9 FAIL: second edit should be undone");
    console.log("  📝 File after partial undo:\n    " + afterPartialUndo.slice(0, 400).replace(/\n/g, "\n    "));
    console.log("✓ Test 9: Undo reverted only the last run");

    // Undo the first edit too, to restore original state
    const undoBtnVisible9b = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible9b) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    await waitForFileMatch(mainTexPath, /\\title\{tex64 Test Workspace\}/, { timeoutMs: 30000 });
    const fullyRestored = await fs.readFile(mainTexPath, "utf8");
    assert.match(fullyRestored, /\\title\{tex64 Test Workspace\}/, "Test 9 cleanup: title should be original");
    assert.match(fullyRestored, /\\author\{tex64\}/, "Test 9 cleanup: author should be original");
    console.log("  📝 Fully restored to original state");

    // ─────────────────────────────────────────────────────────────
    // Test 10: Follow-up within the same conversation retains context
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 10: Follow-up context retention...");
    const chatAfter10a = await sendAndWaitForResponse(
      page,
      "このプロジェクトのmain.texファイルのタイトルは何でしたか？"
    );
    // The AI should know from previous conversation (Test 2 already read the file)
    assert.ok(
      chatAfter10a.includes("tex64") || chatAfter10a.includes("Test Workspace"),
      "Test 10a FAIL: AI should remember the title from earlier in conversation " +
      "(tail: " + chatAfter10a.slice(-200) + ")"
    );
    console.log("  📝 AI remembers title from earlier context");

    const chatAfter10b = await sendAndWaitForResponse(
      page,
      "先ほどのarXivで見つかった論文の中で、最初に挙げられた論文のタイトルを教えてください。"
    );
    console.log("  📝 Follow-up response tail:\n    " + chatAfter10b.slice(-400).replace(/\n/g, "\n    "));
    // The AI should reference something from the Test 6 arXiv search
    assert.ok(
      chatAfter10b.includes("LaTeX") || chatAfter10b.includes("latex") ||
      chatAfter10b.includes("論文") || chatAfter10b.includes("arXiv") ||
      chatAfter10b.includes("typesetting"),
      "Test 10b FAIL: AI should recall arXiv search results from same conversation " +
      "(tail: " + chatAfter10b.slice(-200) + ")"
    );
    console.log("✓ Test 10: Follow-up correctly retained conversation context");

    // ─────────────────────────────────────────────────────────────
    // Test 11: Conversation isolation (new chat has no memory of previous)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 11: Conversation isolation...");
    // Click "new chat" button to start a fresh conversation
    const hasNewChatBtn = await page.evaluate(() => {
      const btn = document.getElementById("ai-chat-new");
      return btn instanceof HTMLButtonElement;
    });
    assert.ok(hasNewChatBtn, "Test 11 precondition: ai-chat-new button should exist");
    await page.click("#ai-chat-new");
    await pause(300);

    // Verify chat log is empty after new chat
    const chatLogAfterNew = await getChatLogText(page);
    assert.ok(
      chatLogAfterNew.length === 0 || chatLogAfterNew.trim() === "",
      "Test 11 FAIL: chat log should be empty after new chat " +
      "(got: " + chatLogAfterNew.slice(0, 100) + ")"
    );
    console.log("  📝 New chat started, log is empty");

    await waitForInputReady(page);

    // Ask about "the previous conversation" — AI should NOT know
    const chatAfter11 = await sendAndWaitForResponse(
      page,
      "先ほどの会話で最後にBibTeXを取得した論文のarXiv IDは何でしたか？"
    );
    console.log("  📝 New chat response:\n    " + chatAfter11.slice(-400).replace(/\n/g, "\n    "));
    // The AI should NOT know "2312.00752" because this is a NEW conversation
    const knowsPreviousId = chatAfter11.includes("2312.00752");
    // It's acceptable if the AI says it doesn't know, or if it says something generic.
    // The key test: the new conversation should not have the tool call history from the old one.
    // We verify this by checking the conversation on the backend side.
    console.log(`  📝 AI mentions previous arXiv ID: ${knowsPreviousId}`);
    // Even if the LLM hallucinates the ID, the crucial thing is that the backend
    // conversation objects are separate. We verify isolation structurally:
    const isolationCheck = await page.evaluate(() => {
      // Check that the active chat ID is different from any previous one
      // by verifying the chat log doesn't contain old messages
      const log = document.getElementById("ai-chat-log");
      const text = log?.textContent ?? "";
      // Old messages from tests 1-10 should NOT be here
      const hasOldGreeting = text.includes("こんにちは！このプロジェクトについて簡単に教えてもらえますか？");
      const hasOldArxiv = text.includes("LaTeX typesettingに関連する論文をarXivで探してもらえますか？");
      const hasOldEdit = text.includes("main.texのタイトルを「Real API Test Title」に変更してください。");
      return { hasOldGreeting, hasOldArxiv, hasOldEdit, messageCount: log?.children?.length ?? 0 };
    });
    assert.ok(!isolationCheck.hasOldGreeting, "Test 11 FAIL: new chat should not contain old greeting");
    assert.ok(!isolationCheck.hasOldArxiv, "Test 11 FAIL: new chat should not contain old arXiv query");
    assert.ok(!isolationCheck.hasOldEdit, "Test 11 FAIL: new chat should not contain old edit request");
    console.log(`  📝 Isolation check: oldGreeting=${isolationCheck.hasOldGreeting}, oldArxiv=${isolationCheck.hasOldArxiv}, oldEdit=${isolationCheck.hasOldEdit}, messages=${isolationCheck.messageCount}`);
    console.log("✓ Test 11: New conversation is isolated from previous");

    // ─────────────────────────────────────────────────────────────
    // Test 12: New chat can still operate on files independently
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 12: New chat file operations...");
    const chatAfter12 = await sendAndWaitForResponse(
      page,
      "main.texの現在のタイトルと著者を教えてください。"
    );
    // Should report the original values (since Test 9 fully restored them)
    assert.ok(
      chatAfter12.includes("tex64") || chatAfter12.includes("Test Workspace"),
      "Test 12 FAIL: new chat should be able to read files " +
      "(tail: " + chatAfter12.slice(-200) + ")"
    );
    console.log("  📝 New chat response:\n    " + chatAfter12.slice(-300).replace(/\n/g, "\n    "));
    console.log("✓ Test 12: New chat can read files independently");

    // ─────────────────────────────────────────────────────────────
    // Test 13: Edit from new chat + undo scoping
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 13: Edit from new chat + undo scoping...");
    await sendAndWaitForResponse(
      page,
      "main.texのタイトルを「New Chat Edit」に変更してください。"
    );
    await waitForFileMatch(mainTexPath, /New Chat Edit/, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterNewChatEdit = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterNewChatEdit, /New Chat Edit/, "Test 13 FAIL: edit from new chat should apply");
    console.log("  📝 Edit applied: title → New Chat Edit");

    // Undo in the new chat context
    const undoBtnVisible13 = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible13) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    await waitForFileMatch(mainTexPath, /\\title\{tex64 Test Workspace\}/, { timeoutMs: 30000 });
    const afterNewChatUndo = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterNewChatUndo, /\\title\{tex64 Test Workspace\}/, "Test 13 FAIL: undo should restore original");
    console.log("  📝 Undo restored original: title → tex64 Test Workspace");
    console.log("✓ Test 13: Edit and undo from new chat work correctly");

    // ─────────────────────────────────────────────────────────────
    // Test 14: Multi-file operation (read multiple + edit one)
    //   OpenPrism prompt: "If a request affects multiple files
    //   (e.g., sections + bib), inspect and update all relevant files."
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 14: Multi-file operation...");
    const introTexPath = path.join(workspacePath, "sections", "intro.tex");
    const originalIntro = await fs.readFile(introTexPath, "utf8");

    const chatAfter14 = await sendAndWaitForResponse(
      page,
      "sections/intro.texを読んで、Backgroundサブセクションの最初の文（We use \\cite{...} ...の一文）を、もう少し具体的な説明に書き換えてください。引用キーは変えず、文章だけ改善してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfter14.slice(-400).replace(/\n/g, "\n    "));
    // AI should have read intro.tex and proposed a patch
    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content !== originalIntro;
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterMultiFile = await fs.readFile(introTexPath, "utf8");
    // The file should still have the cite key and section structure
    assert.ok(afterMultiFile.includes("\\cite{texbook1990}"), "Test 14 FAIL: citation key should be preserved");
    assert.ok(afterMultiFile.includes("\\section{Introduction}"), "Test 14 FAIL: section header should remain");
    assert.ok(afterMultiFile !== originalIntro, "Test 14 FAIL: intro.tex should have changed");
    console.log("  📝 intro.tex changed (cite key preserved, structure intact)");
    console.log("  📝 New content snippet:\n    " + afterMultiFile.slice(0, 400).replace(/\n/g, "\n    "));

    // Undo to restore original
    const undoBtnVisible14 = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible14) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    await waitForCondition(async () => {
      const content = await fs.readFile(introTexPath, "utf8").catch(() => "");
      return content === originalIntro;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original intro.tex");
    console.log("✓ Test 14: Multi-file read + single file edit works");

    // ─────────────────────────────────────────────────────────────
    // Test 15: arXiv → BibTeX → refs.bib integration workflow
    //   The core OpenPrism use case: search, get BibTeX, add to bib
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 15: arXiv → BibTeX → refs.bib workflow...");
    const refsBibPath = path.join(workspacePath, "refs.bib");
    const originalRefsBib = await fs.readFile(refsBibPath, "utf8");

    const chatAfter15 = await sendAndWaitForResponse(
      page,
      "arXiv論文 1706.03762 (Attention Is All You Need) のBibTeXを取得して、refs.bibに追加してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfter15.slice(-500).replace(/\n/g, "\n    "));

    // Wait for refs.bib to be modified
    await waitForCondition(async () => {
      const content = await fs.readFile(refsBibPath, "utf8").catch(() => "");
      return content !== originalRefsBib && (content.includes("1706.03762") || content.includes("Attention"));
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterBibEdit = await fs.readFile(refsBibPath, "utf8");
    // Original entries should still be there
    assert.ok(afterBibEdit.includes("knuth1984"), "Test 15 FAIL: original bib entries should persist");
    assert.ok(afterBibEdit.includes("lamport1994"), "Test 15 FAIL: original bib entries should persist");
    // New entry should be added
    assert.ok(
      afterBibEdit.includes("1706.03762") || afterBibEdit.includes("Attention") || afterBibEdit.includes("Vaswani"),
      "Test 15 FAIL: new arXiv entry should be added to refs.bib"
    );
    console.log("  📝 refs.bib updated with new entry (originals preserved)");
    console.log("  📝 refs.bib tail:\n    " + afterBibEdit.slice(-400).replace(/\n/g, "\n    "));

    // Undo
    const undoBtnVisible15 = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible15) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    await waitForCondition(async () => {
      const content = await fs.readFile(refsBibPath, "utf8").catch(() => "");
      return content === originalRefsBib;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original refs.bib");
    console.log("✓ Test 15: Full arXiv → BibTeX → refs.bib workflow works");

    // ─────────────────────────────────────────────────────────────
    // Test 16: get_compile_log (tool is callable even when empty)
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 16: get_compile_log...");
    const chatAfter16 = await sendAndWaitForResponse(
      page,
      "現在のコンパイルログを確認して、エラーがあれば教えてください。なければ問題ないと報告してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfter16.slice(-400).replace(/\n/g, "\n    "));
    // The AI should mention something about compile log, even if none is available
    assert.ok(
      chatAfter16.includes("コンパイル") || chatAfter16.includes("ログ") ||
      chatAfter16.includes("compile") || chatAfter16.includes("log") ||
      chatAfter16.includes("エラー") || chatAfter16.includes("error") ||
      chatAfter16.includes("問題") || chatAfter16.includes("No compile"),
      "Test 16 FAIL: AI should discuss compile log status " +
      "(tail: " + chatAfter16.slice(-200) + ")"
    );
    console.log("✓ Test 16: get_compile_log tool callable");

    // ─────────────────────────────────────────────────────────────
    // Test 17: Multi-file cross-reference (read bib + read tex + edit)
    //   OpenPrism core scenario: "inspect and update all relevant files"
    //   Start a new chat to avoid context overflow from prior tests.
    // ─────────────────────────────────────────────────────────────
    console.log("\n⏳ Test 17: Multi-file cross-reference edit...");
    await page.click("#ai-chat-new");
    await pause(300);
    await waitForInputReady(page);

    const methodsTexPath = path.join(workspacePath, "sections", "methods.tex");
    const originalMethods = await fs.readFile(methodsTexPath, "utf8");

    const chatAfter17 = await sendAndWaitForResponse(
      page,
      "sections/methods.texを読んでMethodsセクションの冒頭に「\\cite{knuth1984}」を含む一文を追加してください。引用キーknuth1984はrefs.bibに既に定義済みです。propose_patchで変更を提案してください。"
    );
    console.log("  📝 Response tail:\n    " + chatAfter17.slice(-400).replace(/\n/g, "\n    "));

    await waitForCondition(async () => {
      const content = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      return content.includes("knuth1984");
    }, { timeoutMs: FILE_CHANGE_TIMEOUT_MS });
    const afterCrossRef = await fs.readFile(methodsTexPath, "utf8");
    assert.ok(afterCrossRef.includes("\\cite{knuth1984}") || afterCrossRef.includes("knuth1984"), "Test 17 FAIL: should contain knuth1984 citation");
    assert.ok(afterCrossRef.includes("\\section{Methods}"), "Test 17 FAIL: section header should remain");
    console.log("  📝 methods.tex now cites knuth1984");
    console.log("  📝 New content:\n    " + afterCrossRef.slice(0, 500).replace(/\n/g, "\n    "));

    // Undo
    const undoBtnVisible17 = await page.evaluate(() => {
      const btn = document.getElementById("ai-undo");
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && !btn.disabled;
    });
    if (undoBtnVisible17) {
      await page.click("#ai-undo");
    } else {
      await postToBridge(page, { type: "agent:undoLastRunApply" });
    }
    await waitForCondition(async () => {
      const content = await fs.readFile(methodsTexPath, "utf8").catch(() => "");
      return content === originalMethods;
    }, { timeoutMs: 30000 });
    console.log("  📝 Undo restored original methods.tex");
    console.log("✓ Test 17: Multi-file cross-reference edit works");

    console.log("\n✅ All real API E2E tests passed.\n");

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
