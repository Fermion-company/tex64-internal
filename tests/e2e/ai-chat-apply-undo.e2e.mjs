import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const isMac = process.platform === "darwin";
const undoShortcut = isMac ? "Meta+Z" : "Control+Z";

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const waitForCondition = async (predicate, { timeoutMs = 20000, intervalMs = 120 } = {}) => {
  const started = Date.now();
  for (;;) {
    const ok = await predicate();
    if (ok) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitForCondition timeout");
    }
    await pause(intervalMs);
  }
};

const waitForFileMatch = async (filePath, matcher, { timeoutMs = 20000 } = {}) => {
  await waitForCondition(async () => {
    const content = await fs.readFile(filePath, "utf8");
    return matcher.test(content);
  }, { timeoutMs });
};

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // ignore
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-chat-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(60);
};

const readRequestBody = async (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });

const getLastUserText = (contents) => {
  const list = Array.isArray(contents) ? contents : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (!entry || entry.role !== "user") continue;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    return parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const indexOfLastUser = (contents) => {
  const list = Array.isArray(contents) ? contents : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (entry?.role === "user") return i;
  }
  return -1;
};

const countToolResponsesAfter = (contents, startIndex, name) => {
  const list = Array.isArray(contents) ? contents : [];
  const start = Number.isFinite(startIndex) ? Math.max(0, startIndex) : 0;
  let count = 0;
  for (let i = start + 1; i < list.length; i += 1) {
    const entry = list[i];
    if (!entry || entry.role !== "tool") continue;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    if (parts.some((p) => p?.functionResponse?.name === name)) {
      count += 1;
    }
  }
  return count;
};

const startAiProxy = async () => {
  /** @type {any[]} */
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const body = await readRequestBody(req);
    requests.push(body);

    const contents = body?.contents ?? [];
    const toolMode = body?.toolConfig?.functionCallingConfig?.mode ?? null;
    const lastUserText = getLastUserText(contents);
    const lastUserIndex = indexOfLastUser(contents);
    const proposePatchCount = countToolResponsesAfter(contents, lastUserIndex, "propose_patch");

    const replyJson = (payload) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };

    // Greeting / standalone turns should come in with tools disabled.
    if (toolMode === "NONE") {
      replyJson({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: lastUserText.trim() === "こんにちは" ? "こんにちは！" : "了解しました。" }],
            },
          },
        ],
      });
      return;
    }

    // Multi-step same-run edit: title + author in one run.
    if (/タイトルをhelloに変えて、著者をaliceに変えて/.test(lastUserText)) {
      if (proposePatchCount === 0) {
        replyJson({
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
                        search: "\\title{tex64 Test Workspace}",
                        replace: "\\title{hello}",
                        replaceAll: false,
                        summary: "タイトルをhelloに変更",
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      if (proposePatchCount === 1) {
        replyJson({
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
                        search: "\\author{tex64}",
                        replace: "\\author{alice}",
                        replaceAll: false,
                        summary: "著者をaliceに変更",
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      replyJson({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "2件の変更を適用しました。" }],
            },
          },
        ],
      });
      return;
    }

    // Single-step edit requests.
    if (proposePatchCount === 0 && /タイトルを(?:hello|world)に変えて/.test(lastUserText)) {
      const target = /タイトルをworldに変えて/.test(lastUserText) ? "world" : "hello";
      replyJson({
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
                      search: "\\title{tex64 Test Workspace}",
                      replace: `\\title{${target}}`,
                      replaceAll: false,
                      summary: `タイトルを${target}に変更`,
                    },
                  },
                },
              ],
            },
          },
        ],
      });
      return;
    }

    // After a propose_patch tool response, send a short user-facing summary.
    if (proposePatchCount > 0) {
      replyJson({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "変更を適用しました。" }],
            },
          },
        ],
      });
      return;
    }

    replyJson({
      candidates: [
        { content: { role: "model", parts: [{ text: "OK" }] } },
      ],
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  assert.ok(port, "failed to bind proxy port");
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => new Promise((resolve) => server.close(() => resolve())),
  };
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  const proxy = await startAiProxy();

  try {
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_AI_PROXY_URL: proxy.url,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openSideTab(page, "ai");

    await page.waitForFunction(() => {
      const el = document.getElementById("ai-input");
      return el && el.tagName.toLowerCase() === "textarea" && !(el).disabled;
    });

    const countInChatLog = async (needle) =>
      page.evaluate((value) => {
        const text = document.getElementById("ai-chat-log")?.textContent ?? "";
        if (!value) return 0;
        return text.split(value).length - 1;
      }, needle);

    const mainTexPath = path.join(workspacePath, "main.tex");

    // 1) Ask for an edit (auto-apply expected).
    await page.fill("#ai-input", "タイトルをhelloに変えて");
    await page.click("#ai-send");

    await waitForFileMatch(mainTexPath, /\\title\{hello\}/, { timeoutMs: 25000 });
    await page.waitForFunction(
      () => document.querySelectorAll("#ai-proposals .ai-proposal").length === 0,
      undefined,
      { timeout: 20000 }
    );

    const afterApply = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterApply, /\\title\{hello\}/, "title was not updated on disk");

    // 2) Undo via AI undo button.
    const undoCountBefore = await countInChatLog("取り消し完了");
    await page.click("#ai-undo");
    await page.waitForFunction(
      ({ needle, prior }) => {
        const text = document.getElementById("ai-chat-log")?.textContent ?? "";
        const count = needle ? text.split(needle).length - 1 : 0;
        return count > prior;
      },
      { needle: "取り消し完了", prior: undoCountBefore },
      { timeout: 20000 }
    );

    const afterUndo = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterUndo, /\\title\{tex64 Test Workspace\}/, "undo did not restore title");

    // 3) Apply another auto-applied change -> undo again.
    await page.fill("#ai-input", "タイトルをworldに変えて");
    await page.click("#ai-send");

    await waitForFileMatch(mainTexPath, /\\title\{world\}/, { timeoutMs: 25000 });
    const afterApply2 = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterApply2, /\\title\{world\}/, "second apply did not update title");

    const undoCountBefore2 = await countInChatLog("取り消し完了");
    await page.click("#ai-undo");
    await page.waitForFunction(
      ({ needle, prior }) => {
        const text = document.getElementById("ai-chat-log")?.textContent ?? "";
        const count = needle ? text.split(needle).length - 1 : 0;
        return count > prior;
      },
      { needle: "取り消し完了", prior: undoCountBefore2 },
      { timeout: 20000 }
    );

    const afterUndo2 = await fs.readFile(mainTexPath, "utf8");
    assert.match(afterUndo2, /\\title\{tex64 Test Workspace\}/, "second undo did not restore title");

    // Undo should fail gracefully when there is nothing left to undo.
    const undoFailCountBefore = await countInChatLog("取り消し失敗");
    await page.click("#ai-undo");
    await page.waitForFunction(
      ({ needle, prior }) => {
        const text = document.getElementById("ai-chat-log")?.textContent ?? "";
        const count = needle ? text.split(needle).length - 1 : 0;
        return count > prior;
      },
      { needle: "取り消し失敗", prior: undoFailCountBefore },
      { timeout: 20000 }
    );

    // 4) After edit-heavy turns, a plain greeting must not be interpreted as another edit.
    await page.fill("#ai-input", "こんにちは");
    await page.click("#ai-send");
    await page.waitForFunction(() => {
      const log = document.getElementById("ai-chat-log");
      return Boolean(log && log.textContent && log.textContent.includes("こんにちは！"));
    }, undefined, { timeout: 20000 });

    const lastReq = proxy.requests[proxy.requests.length - 1];
    assert.equal(lastReq?.toolConfig?.functionCallingConfig?.mode, "NONE");
    assert.ok(Array.isArray(lastReq?.tools) && lastReq.tools.length === 0, "tools should be omitted");
    assert.ok(Array.isArray(lastReq?.contents) && lastReq.contents.length === 1, "greeting must isolate history");
    const sys = lastReq?.systemInstruction?.parts?.[0]?.text ?? "";
    assert.match(sys, /挨拶|雑談/);
    assert.doesNotMatch(sys, /run_build|propose_patch|read_file/);

    // 5) Cross-chat isolation: a new chat must not inherit previous chat history in workspace mode.
    await page.click("#ai-chat-new");
    await page.waitForFunction(() => {
      const el = document.getElementById("ai-input");
      return el && el.tagName.toLowerCase() === "textarea" && !(el).disabled;
    });
    const reqBeforeNewChat = proxy.requests.length;
    await page.fill("#ai-input", "タイトルをhelloに変えて");
    await page.click("#ai-send");
    await waitForCondition(() => proxy.requests.length > reqBeforeNewChat, { timeoutMs: 25000 });
    await waitForFileMatch(mainTexPath, /\\title\{hello\}/, { timeoutMs: 25000 });
    await page.waitForFunction(
      () => document.querySelectorAll("#ai-proposals .ai-proposal").length === 0,
      undefined,
      { timeout: 20000 }
    );
    assert.ok(proxy.requests.length > reqBeforeNewChat, "no proxy request captured for new chat");
    const newChatRequests = proxy.requests.slice(reqBeforeNewChat).filter(Boolean);
    assert.ok(newChatRequests.length >= 1, "missing proxy requests for new chat run");
    const firstNewChatReq = newChatRequests[0];
    assert.equal(firstNewChatReq?.toolConfig?.functionCallingConfig?.mode, "ANY");
    assert.ok(
      Array.isArray(firstNewChatReq?.contents) && firstNewChatReq.contents.length === 1,
      "new chat edit request should not inherit old history"
    );
    assert.equal(getLastUserText(firstNewChatReq.contents).trim(), "タイトルをhelloに変えて");

    // Sanity: undo shortcut should not crash even if no entry remains.
    await page.keyboard.press(undoShortcut);

  } finally {
    await proxy.close().catch(() => {});
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        // ignore
      }
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
