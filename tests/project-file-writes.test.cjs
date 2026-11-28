"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { WorkspaceWindowLock } = require("../electron/services/workspace-window-lock.cjs");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");
const { AgentService } = require("../electron/services/agent.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");
const { handleProposeWrite } = require("../electron/services/agent-tools-file.cjs");
const { appendEntry } = require("../electron/services/bib-append.cjs");

const noop = () => {};

function openWorkspace(root, userData) {
  const workspace = new WorkspaceManager({ fileLockDirectory: () => path.join(userData, "project-writes") });
  workspace.setRootPath(root);
  return workspace;
}

function fileHandlers(workspace, reply) {
  const ctx = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state: {}, sendIssues: noop,
    sendToRenderer: (type, payload) => { if (type === "saveResult") reply(payload); },
  });
  ctx.updateWorkspaceIfNeeded = async () => {};
  ctx.requestIndex = noop;
  return createWorkspaceFileHandlers(ctx);
}

if (process.argv[2] === "worker") {
  const [root, userData, storageFailure] = process.argv.slice(3);
  if (storageFailure) {
    const write = fsp.writeFile;
    const primary = path.join(userData, "project-writes") + path.sep;
    const user = process.getuid?.() ??
      require("node:crypto").createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
    const fallback = path.join(os.tmpdir(), `tex64-locks-${user}`) + path.sep;
    fsp.writeFile = (file, ...args) => {
      if (file.startsWith(primary) || (storageFailure === "all" && file.startsWith(fallback))) {
        return Promise.reject(Object.assign(new Error("simulated full lock disk"), { code: "ENOSPC" }));
      }
      return write.call(fsp, file, ...args);
    };
  }
  const folderLock = new WorkspaceWindowLock({ directory: () => path.join(userData, "open-workspaces") });
  const claimed = folderLock.claim(root);
  const workspace = openWorkspace(root, userData);
  const handlers = fileHandlers(workspace, (result) => process.send(result));
  let axiom;
  process.on("disconnect", () => {
    axiom?.agent.finishConversationRun("chat", axiom.run.token);
    folderLock.releaseAll();
  });
  process.on("message", async ({ file, content, expected, pauseBeforePublish, holdForMs, bibliography, axiomAction }) => {
    if (axiomAction) {
      if (axiomAction === "start") {
        const agent = new AgentService({
          workspace, sendToRenderer: noop, updateWorkspaceIfNeeded: async () => {}, requestIndex: noop,
          sessionsService: { loadSessions: async () => [], saveSession: async () => {} },
        });
        const policy = buildAgentPolicy();
        const run = agent.startConversationRun("chat");
        agent.allowSavesDuringRun(run);
        const read = buildTools(agent, "chat", policy, { rootPath: root, context: {} })
          .find((tool) => tool.function.name === "read_file");
        axiom = { agent, policy, run, read };
        process.send({ started: true });
      } else if (axiomAction === "write") {
        process.send(await handleProposeWrite(axiom.agent, { path: file, content }, axiom.policy, "chat"));
      } else {
        const range = axiomAction === "read-range" ? { startLine: 2, endLine: 3 } : {};
        process.send(JSON.parse(await axiom.read.execute({ path: file, ...range })));
      }
      return;
    }
    if (pauseBeforePublish || holdForMs) {
      const open = fsp.open;
      const rename = fsp.rename;
      const pause = async (pathKind) => {
        fsp.open = open;
        fsp.rename = rename;
        process.send({ beforePublish: pathKind });
        await new Promise((resolve) => { if (holdForMs) setTimeout(resolve, holdForMs); });
      };
      fsp.open = async (file, flags, ...args) => {
        if (path.basename(file) === "chapter.tex" && typeof flags === "number" && (flags & fs.constants.O_WRONLY)) {
          await pause("in-place");
        }
        return open(file, flags, ...args);
      };
      fsp.rename = async (from, to) => {
        if (path.basename(to) === "chapter.tex") await pause("rename");
        return rename(from, to);
      };
    }
    if (bibliography) {
      const result = await appendEntry({ workspace, bibPath: file, bibtex: content });
      process.send(result);
    } else {
      await handlers.handleSaveFile(file, content, { expectedContent: expected });
    }
  });
  process.send({ claimed });
} else {
  const receive = async (child) => (await once(child, "message"))[0];

  async function fixture(t) {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-project-write-"));
    const book = path.join(sandbox, "book");
    const chapters = path.join(book, "chapters");
    const userData = path.join(sandbox, "userdata");
    await fsp.mkdir(chapters, { recursive: true });
    const temp = path.join(sandbox, "os-temp");
    await fsp.mkdir(temp);
    const children = [];
    t.after(async () => {
      await fsp.chmod(userData, 0o755).catch(() => {});
      await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        if (child.connected) child.disconnect();
        await exited;
      }));
      await fsp.rm(sandbox, { recursive: true, force: true });
    });
    const launch = async (root, storageFailure = "") => {
      const child = fork(__filename, ["worker", root, userData, storageFailure], {
        env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      assert.equal((await receive(child)).claimed, true);
      return child;
    };
    const chapter = path.join(chapters, "chapter.tex");
    return {
      book, chapters, userData, launch, temp,
      seed: (text) => fsp.writeFile(chapter, text),
      read: () => fsp.readFile(chapter, "utf8"),
    };
  }

  const save = (child, file, expected, content, extra = {}) => {
    const received = receive(child);
    child.send({ file, content, expected, ...extra });
    return received;
  };

  const finderTag = "com.apple.metadata:_kMDItemUserTags";
  const finderComment = "com.apple.metadata:kMDItemFinderComment";
  const quarantine = "com.apple.quarantine";
  const plist = (xml) => execFileSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
    input: `<?xml version="1.0"?><plist version="1.0">${xml}</plist>`,
  });
  const setAttribute = (file, name, value) =>
    execFileSync("/usr/bin/xattr", ["-wx", name, Buffer.from(value).toString("hex"), file]);
  const getAttribute = (file, name) => execFileSync("/usr/bin/xattr", ["-px", name, file], { encoding: "utf8" });
  const metadata = (file) => execFileSync("/bin/ls", ["-lde@", file], { encoding: "utf8" }).split("\n").slice(1);
  const pdf = Buffer.from("%PDF-1.5\nreplacement content\n");

  // Replaced: an ordinary macOS file is atomically renamed over (as in
  // v0.1.32) once the new inode carries the same metadata; links, ACLs, an
  // unwritable folder and a file outside the project are written in place.
  for (const [kind, macOnly, setup, outside = false, replaced = false] of [
    ["an ordinary file inside the project", false, async () => {}, false, true],
    ["a Finder-tagged file inside the project", true, async ({ target }) => {
      setAttribute(target, finderTag, plist("<array><string>Marking copy</string></array>"));
    }, false, true],
    ["a file with a Finder comment and quarantine", true, async ({ target }) => {
      setAttribute(target, finderComment, plist("<string>Keep until grading finishes</string>"));
      setAttribute(target, quarantine, "0081;00000000;TeX64;");
    }, false, true],
    ["a hidden file with its last-opened date and text encoding", true, async ({ target }) => {
      execFileSync("/usr/bin/chflags", ["hidden", target]);
      setAttribute(target, "com.apple.lastuseddate#PS", Buffer.from("00112233445566778899aabbccddeeff", "hex"));
      setAttribute(target, "com.apple.TextEncoding", "utf-8;134217984");
    }, false, true],
    ["a symlink", false, async ({ target, entry }) => fsp.symlink(path.basename(target), entry)],
    ["a hard link", false, async ({ target, entry }) => fsp.link(target, entry)],
    ["a writable file in a read-only directory", false, async ({ directory }) => fsp.chmod(directory, 0o555)],
    ["a file with an ACL", true, async ({ target }) => {
      execFileSync("/bin/chmod", ["+a", "everyone deny execute", target]);
    }],
    ["a file whose ACL permits writing but denies replacement", true, async ({ target }) => {
      execFileSync("/bin/chmod", ["+a", "everyone deny delete", target]);
    }],
    ["a writable file with a set-group-ID mode", true, async ({ target }) => fsp.chmod(target, 0o2640), false, true],
    ["an existing untagged file outside the project", false, async () => {}, true],
  ]) {
    test(`PDF export preserves ${kind}`, {
      skip: (macOnly && process.platform !== "darwin") || process.platform === "win32" ||
        (kind.includes("read-only") && process.getuid?.() === 0),
    }, async (t) => {
      const f = await fixture(t);
      const directory = outside ? f.temp : path.join(f.book, "exports");
      await fsp.mkdir(directory, { recursive: true });
      t.after(async () => fsp.chmod(directory, 0o755).catch(() => {}));
      const target = path.join(directory, "exam.pdf");
      const link = kind.endsWith("link");
      const entry = link ? path.join(directory, "selected.pdf") : target;
      await fsp.writeFile(target, "%PDF-1.4\nold");
      await fsp.chmod(target, 0o640);
      await fsp.writeFile(path.join(f.book, "main.pdf"), pdf);
      await setup({ target, entry, directory });
      const before = await fsp.stat(target);
      const entryBefore = await fsp.lstat(entry);
      const mac = process.platform === "darwin";
      const extras = mac ? metadata(target) : null;
      const attributes = mac ? execFileSync("/usr/bin/xattr", [target], { encoding: "utf8" }).trim().split("\n")
        .filter((name) => name && name !== "com.apple.provenance")
        .map((name) => [name, getAttribute(target, name)]) : [];
      const flags = mac ? execFileSync("/usr/bin/stat", ["-f", "%Xf", target], { encoding: "utf8" }) : null;
      const replies = [];
      const ctx = createWorkspaceContext({
        fs, fsp, path, workspace: openWorkspace(f.book, f.userData), WorkspaceError, state: {},
        dialog: { showSaveDialog: async () => ({ filePath: entry }) },
        sendToRenderer: (type, payload) => replies.push({ type, ...payload }), sendIssues: noop,
      });
      try {
        await createWorkspaceFileHandlers(ctx).handleExportPdf("export", "main.pdf");
        assert.deepEqual(replies.map(({ type, ok }) => [type, ok]), [["file:exportPdfResult", true]], JSON.stringify(replies));
        assert.deepEqual(await fsp.readFile(entry), pdf);
        assert.deepEqual(await fsp.readFile(target), pdf);
        const after = await fsp.stat(target);
        assert.deepEqual([after.mode, after.uid, after.gid], [before.mode, before.uid, before.gid]);
        if (replaced && mac) assert.notEqual(after.ino, before.ino);
        else assert.equal(after.ino, before.ino);
        assert.equal((await fsp.lstat(entry)).isSymbolicLink(), entryBefore.isSymbolicLink());
        if (mac) assert.deepEqual(metadata(target), extras);
        if (mac) assert.equal(execFileSync("/usr/bin/stat", ["-f", "%Xf", target], { encoding: "utf8" }), flags);
        for (const [name, value] of attributes) assert.equal(getAttribute(target, name), value);
        assert.deepEqual((await fsp.readdir(directory)).filter((name) => name.startsWith(".tex64-")), []);
      } finally {
        if (mac) execFileSync("/usr/bin/chflags", ["0", target]);
        if (kind.includes("read-only")) await fsp.chmod(directory, 0o755);
        if (kind.includes("denies replacement")) {
          execFileSync("/bin/chmod", ["-N", target]);
        }
      }
    });
  }

  test("editor, bibliography and project settings writes preserve existing Finder tags", {
    skip: process.platform !== "darwin",
  }, async (t) => {
    const f = await fixture(t);
    const ws = openWorkspace(f.book, f.userData);
    const chapter = path.join(f.chapters, "chapter.tex");
    const bib = path.join(f.book, "refs.bib");
    const settings = path.join(f.book, ".tex64/settings.json");
    await f.seed("Edited chapter.");
    await fsp.writeFile(bib, "");
    await ws.saveSettings({ rootFile: "main.tex" });
    const tag = plist("<array><string>Marking copy</string></array>");
    for (const file of [chapter, bib, settings]) setAttribute(file, finderTag, tag);
    const expected = getAttribute(chapter, finderTag);
    const [worker] = await Promise.all([f.launch(f.book)]);
    assert.equal((await save(worker, "chapters/chapter.tex", "Edited chapter.", "New text.")).ok, true);
    await appendEntry({ workspace: ws, bibPath: "refs.bib", bibtex: "@book{work, title={Work}}" });
    await ws.updateSettings((previous) => ({ ...previous, rootFile: "new.tex" }));
    assert.match(await fsp.readFile(bib, "utf8"), /@book\{work/);
    assert.equal((await ws.loadSettings()).rootFile, "new.tex");
    for (const file of [chapter, bib, settings]) assert.equal(getAttribute(file, finderTag), expected);
  });

  for (const variant of ["a non-private directory", "an owner-only directory without write access", "a symlink to a private directory"]) {
    test(`alternate lock lookups ignore ${variant}`, { skip: process.platform === "win32" }, async (t) => {
      const f = await fixture(t);
      await f.seed("before");
      const fallback = path.join(f.temp, `tex64-locks-${process.getuid()}`);
      const directory = variant.startsWith("a symlink") ? path.join(f.temp, "substitute") : fallback;
      await fsp.mkdir(directory, { mode: 0o700 });
      if (directory !== fallback) await fsp.symlink(directory, fallback);
      const chapter = fs.realpathSync.native(path.join(f.chapters, "chapter.tex"));
      const key = createHash("sha256").update(chapter).digest("hex");
      await fsp.writeFile(path.join(directory, `${key}.0.lock`), "untrusted live-looking record");
      if (directory === fallback) await fsp.chmod(directory, variant.startsWith("an owner") ? 0o500 : 0o755);
      try {
        const worker = await f.launch(f.book);
        assert.equal((await save(worker, "chapters/chapter.tex", "before", "after")).ok, true);
        assert.equal(await f.read(), "after");
      } finally {
        await fsp.chmod(directory, 0o700);
      }
    });
  }

  test("Axiom apply keeps external hard links attached to the edited project file", async (t) => {
    const f = await fixture(t);
    const worker = await f.launch(f.book);
    const linked = path.join(f.temp, "marking-copy.tex");
    const edited = "The published chapter.";
    await f.seed("The original chapter.");
    await fsp.link(path.join(f.chapters, "chapter.tex"), linked);
    const ask = (axiomAction, content) =>
      save(worker, "chapters/chapter.tex", undefined, content, { axiomAction });
    assert.equal((await ask("start")).started, true);
    await ask("read");
    assert.equal((await ask("write", edited)).status, "applied");
    assert.equal(await fsp.readFile(linked, "utf8"), edited);
  });

  test("compare-and-save serializes two paths to the same hard-linked inode", async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    await f.seed("original");
    const linked = path.join(f.chapters, "linked.tex");
    await fsp.link(path.join(f.chapters, "chapter.tex"), linked);
    assert.equal((await save(book, "chapters/chapter.tex", "original", "winner", { holdForMs: 225 })).beforePublish, "in-place");
    const finished = receive(book);
    const stale = await save(chapters, "linked.tex", "original", "stale");
    assert.equal((await finished).ok, true);
    assert.equal(stale.ok, false);
    assert.equal(stale.currentContent, "winner");
    assert.equal(await fsp.readFile(linked, "utf8"), "winner");
  });

  test("overlapping book and chapter windows serialize simultaneous saves to one real path", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    const base = "Question one.\n\nQuestion two.\n";
    const left = base.replace("one", "ONE");
    const right = base.replace("two", "TWO");
    await f.seed(base);
    if (process.platform !== "win32") await fsp.symlink("chapter.tex", path.join(f.chapters, "alias.tex"), "file");
    for (let round = 0; round < 12; round++) {
      await f.seed(base);
      const results = await Promise.all([
        save(book, "chapters/chapter.tex", base, left),
        save(chapters, round % 2 && process.platform !== "win32" ? "alias.tex" : "chapter.tex", base, right),
      ]);
      const disk = await f.read();
      assert.equal(results.filter(({ ok }) => ok).length, 1, `round ${round}`);
      assert.equal(disk, results[0].ok ? left : right);
      assert.equal(results.find(({ ok }) => !ok).currentContent, disk);
      const retry = await save(chapters, "chapter.tex", disk, "Question ONE.\n\nQuestion TWO.\n");
      assert.equal(retry.ok, true);
      assert.equal(await f.read(), "Question ONE.\n\nQuestion TWO.\n");
    }
  });

  test("Axiom cannot replace a chapter after receiving only a range, and can rebase a known full text", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const [editor, axiom] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    const ask = (axiomAction, content) =>
      save(axiom, "chapter.tex", undefined, content, { axiomAction });
    const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1} text\n`).join("");
    const typed = base.replace("line 14 text", "writer saved new copy");
    const proposal = base.replace("line 3 text", "revised line three");
    await f.seed(base);
    assert.equal((await ask("start")).started, true);
    assert.equal((await save(editor, "chapters/chapter.tex", base, typed)).ok, true);
    assert.match((await ask("read-range")).content, /line 3 text/);
    const refused = await ask("write", proposal);
    assert.equal(refused.conflict, true);
    assert.equal(refused.currentContent, typed);
    assert.equal(await f.read(), typed);

    assert.match((await ask("read")).content, /writer saved new copy/);
    const newer = typed.replace("line 18 text", "writer saved a second sentence");
    assert.equal((await save(editor, "chapters/chapter.tex", typed, newer)).ok, true);
    const applied = await ask("write", typed.replace("line 3 text", "revised line three"));
    assert.equal(applied.status, "applied");
    assert.equal(await f.read(), newer.replace("line 3 text", "revised line three"));
  });

  test("bibliography appends in overlapping windows preserve both entries", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    const bib = path.join(f.chapters, "library.bib");
    const first = "@book{first, title={First book}, year={2020}}";
    const second = "@book{second, title={Second book}, year={2021}}";
    for (let round = 0; round < 4; round++) {
      await fsp.writeFile(bib, "");
      const results = await Promise.all([
        save(book, "chapters/library.bib", undefined, first, { bibliography: true }),
        save(chapters, "library.bib", undefined, second, { bibliography: true }),
      ]);
      assert.ok(results.every(({ appended }) => appended));
      const disk = await fsp.readFile(bib, "utf8");
      assert.ok(disk.includes(first) && disk.includes(second), disk);
    }
  });

  test("a process killed before publishing a save leaves the old file and its lock can be recovered", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    await f.seed("original");
    assert.match((await save(book, "chapters/chapter.tex", "original", "interrupted", { pauseBeforePublish: true })).beforePublish, /^(rename|in-place)$/);
    assert.equal(await f.read(), "original");
    const waiting = save(chapters, "chapter.tex", "original", "replacement");
    const resultBeforeCrash = await Promise.race([waiting, delay(50, null)]);
    const exited = once(book, "exit");
    book.kill("SIGKILL");
    await exited;
    assert.equal(resultBeforeCrash, null);
    assert.equal((await waiting).ok, true);
    assert.equal(await f.read(), "replacement");
  });

  test("a live holder keeps its lock when another save times out", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    await f.seed("original");
    assert.match((await save(book, "chapters/chapter.tex", "original", "first", { holdForMs: 1250 })).beforePublish, /^(rename|in-place)$/);
    const finished = receive(book);
    const occupied = await save(chapters, "chapter.tex", "original", "stale");
    assert.equal(occupied.ok, false);
    assert.equal(occupied.busy, true);
    assert.equal((await finished).ok, true);
    assert.equal(await f.read(), "first");
  });

  test("a range-based line edit follows the observed lines after the other window inserts a line", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const editor = await f.launch(f.book);
    const workspace = openWorkspace(f.chapters, f.userData);
    const agent = new AgentService({
      workspace, sendToRenderer: noop, updateWorkspaceIfNeeded: async () => {}, requestIndex: noop,
      sessionsService: { loadSessions: async () => [], saveSession: async () => {} },
    });
    const base = "First line.\nSecond line.\nThird line.\nFourth line.\n";
    await f.seed(base);
    const run = agent.startConversationRun("chat");
    agent.allowSavesDuringRun(run);
    t.after(() => agent.finishConversationRun("chat", run.token));
    const tools = Object.fromEntries(buildTools(agent, "chat", buildAgentPolicy(), {
      rootPath: f.chapters, context: {},
    }).map((tool) => [tool.function.name, tool]));
    await tools.read_file.execute({ path: "chapter.tex", startLine: 3, endLine: 3 });
    const typed = "The editor added this line.\n" + base;
    assert.equal((await save(editor, "chapters/chapter.tex", base, typed)).ok, true);
    const result = JSON.parse(await tools.replace_lines.execute({
      path: "chapter.tex", startLine: 3, endLine: 3, content: "Axiom replaced line three.",
    }));
    assert.equal(result.status, "applied", result.error);
    assert.equal(await f.read(), typed.replace("Third line.", "Axiom replaced line three."));
  });

  test("History and Git restore validate after a waiting editor save reaches disk", { timeout: 10_000 }, async (t) => {
    const { configureProjectFileLocks } = require("../electron/services/project-file-writes.cjs");
    const { HistoryStore } = require("../electron/services/history-store.cjs");
    const { HistoryTransaction } = require("../electron/services/history-transaction.cjs");
    const { GitTransaction } = require("../electron/services/git-transaction.cjs");
    const f = await fixture(t);
    configureProjectFileLocks(() => path.join(f.userData, "project-writes"));
    const editor = await f.launch(f.chapters);
    const store = await new HistoryStore({ root: f.book, directory: path.join(f.userData, "history") }).initialize();
    const history = new HistoryTransaction(store);
    await f.seed("previous version");
    const version = await store.publish(await store.capture(), { label: "Previous" });
    await f.seed("draft");
    const plan = await history.plan(version.id);
    const tx = new GitTransaction({
      runner: { run: noop, root: store.root },
      vault: { capture: noop, maxEntries: 100 },
      directory: path.join(f.userData, "git"),
    });
    tx.write = async () => {};
    const expected = await tx.pathEntry("chapters/chapter.tex");
    const gitRestore = () => tx.replacePath({ id: "test" }, "chapters/chapter.tex", expected, null);
    for (const [restore, code] of [[() => history.restore(plan), "PLAN_STALE"], [gitRestore, "STATE_CHANGED"]]) {
      await f.seed("draft");
      assert.match((await save(editor, "chapter.tex", "draft", "editor saved", { holdForMs: 225 })).beforePublish, /^(rename|in-place)$/);
      const saved = receive(editor);
      await assert.rejects(restore, { code });
      assert.equal((await saved).ok, true);
      assert.equal(await f.read(), "editor saved");
    }
  });

  test("collaboration merges an editor save made while disk synchronization is waiting", { timeout: 10_000 }, async (t) => {
    const { configureProjectFileLocks } = require("../electron/services/project-file-writes.cjs");
    const { DiskSync } = require("../electron/services/collab/disk-sync.cjs");
    const Y = require("yjs");
    const f = await fixture(t);
    configureProjectFileLocks(() => path.join(f.userData, "project-writes"));
    const editor = await f.launch(f.book);
    const base = "First line.\nAnother line.\n";
    const typed = base.replace("First", "Editor");
    await f.seed(base);
    const doc = new Y.Doc();
    const sync = new DiskSync({ rootPath: () => f.chapters });
    t.after(() => {
      sync.stop();
      doc.destroy();
    });
    const text = doc.getText("body");
    text.insert(0, base.replace("Another", "Collaborator"));
    sync.attach("chapter.tex", text, base);
    assert.match((await save(editor, "chapters/chapter.tex", base, typed, { holdForMs: 225 })).beforePublish, /^(rename|in-place)$/);
    const saved = receive(editor);
    await sync.writeNow("chapter.tex");
    assert.equal((await saved).ok, true);
    assert.equal(await f.read(), typed.replace("Another", "Collaborator"));
  });

  for (const scenario of ["obstruction", "read-only", "ENOSPC", "removed at runtime"]) {
    test(`independent saves share a writable lock directory after ${scenario}`, {
      timeout: 10_000,
      skip: scenario === "read-only" && (process.platform === "win32" || process.getuid() === 0),
    }, async (t) => {
      const f = await fixture(t);
      const directory = path.join(f.userData, "project-writes");
      const issue = scenario === "ENOSPC" ? "primary" : "";
      const [book, chapters] = await Promise.all([f.launch(f.book, issue), f.launch(f.chapters, issue)]);
      await f.seed("original");
      if (scenario === "obstruction") await fsp.writeFile(directory, "obstruct the lock directory");
      if (scenario === "read-only") {
        await fsp.chmod(f.userData, 0o555);
      }
      if (scenario === "removed at runtime") {
        assert.equal((await save(book, "chapters/chapter.tex", "original", "warm")).ok, true);
        await fsp.rename(directory, path.join(f.userData, "removed-locks"));
        await f.seed("original");
      }
      const results = await Promise.all([
        save(book, "chapters/chapter.tex", "original", "book edit"),
        save(chapters, "chapter.tex", "original", "chapter edit"),
      ]);
      const disk = await f.read();
      assert.equal(results.filter(({ ok }) => ok).length, 1, JSON.stringify(results));
      assert.equal(disk, results[0].ok ? "book edit" : "chapter edit");
      assert.equal(results.find(({ ok }) => !ok).currentContent, disk);
      assert.deepEqual(await fsp.readdir(f.chapters), ["chapter.tex"]);
      const fallback = path.join(f.temp, `tex64-locks-${process.getuid?.() ?? "user"}`);
      if (scenario === "removed at runtime") assert.ok((await fsp.stat(directory)).isDirectory());
      else if (process.platform !== "win32") assert.equal((await fsp.stat(fallback)).mode & 0o777, 0o700);
    });
  }

  test("a live fallback writer stays protected when app data becomes writable again", {
    timeout: 10_000, skip: process.platform === "win32" || process.getuid() === 0,
  }, async (t) => {
    const f = await fixture(t);
    const [book, chapters] = await Promise.all([f.launch(f.book), f.launch(f.chapters)]);
    await fsp.chmod(f.userData, 0o555);
    await f.seed("original");
    assert.match((await save(book, "chapters/chapter.tex", "original", "winner", { holdForMs: 225 })).beforePublish, /^(rename|in-place)$/);
    const first = receive(book);
    await fsp.chmod(f.userData, 0o755);
    const stale = await save(chapters, "chapter.tex", "original", "stale");
    assert.equal((await first).ok, true);
    assert.equal(stale.currentContent, "winner");
    assert.equal(await f.read(), "winner");
  });

  test("full primary and fallback lock storage still allow atomic saves and reject stale content", { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const editor = await f.launch(f.book, "all");
    await f.seed("original");
    assert.equal((await save(editor, "chapters/chapter.tex", "original", "edited")).ok, true);
    const stale = await save(editor, "chapters/chapter.tex", "original", "stale");
    assert.equal(stale.currentContent, "edited");
    assert.equal(await f.read(), "edited");
    assert.deepEqual(await fsp.readdir(f.chapters), ["chapter.tex"]);
  });

  test("the in-process queue serializes baseline checks when both lock locations fail", async (t) => {
    const f = await fixture(t);
    const write = fsp.writeFile;
    t.mock.method(fsp, "writeFile", (file, ...args) => {
      if (args.at(-1)?.flag === "wx" && !path.basename(file).startsWith(".tex64-write.tmp-")) {
        return Promise.reject(Object.assign(new Error("no space for locks"), { code: "ENOSPC" }));
      }
      return write.call(fsp, file, ...args);
    });
    const warning = t.mock.method(console, "warn", () => {});
    const results = [];
    const editor = fileHandlers(openWorkspace(f.book, f.userData), (result) => results.push(result));
    await f.seed("original");
    await Promise.all(["first", "second"].map((edit) =>
      editor.handleSaveFile("chapters/chapter.tex", edit, { expectedContent: "original" })));
    const disk = await f.read();
    assert.equal(results.filter(({ ok }) => ok).length, 1);
    assert.equal(results.find(({ ok }) => !ok).currentContent, disk);
    assert.equal(warning.mock.callCount(), 1);
  });
}
