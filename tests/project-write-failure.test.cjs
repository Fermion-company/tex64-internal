"use strict";

const assert = require("node:assert/strict");
const { constants } = require("node:fs");
const fs = require("node:fs");
const fsp = fs.promises;
const childProcess = require("node:child_process");
const { execFileSync } = childProcess;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeProjectFile } = require("../electron/services/project-file-writes.cjs");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");

const original = Buffer.from("An exercise on velocity.\n".repeat(320) + "Final exercise.\n");
const replacement = Buffer.concat([Buffer.from("Introductory material.\n"), original]);
const dir = () => path.join(os.tmpdir(), "tex64-write-failure-");

function handlers(root, destination, capture) {
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const context = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state: {},
    dialog: { showSaveDialog: async () => ({ filePath: destination }) },
    sendToRenderer: (event, value) => capture(event, value),
    sendIssues: () => {},
  });
  context.updateWorkspaceIfNeeded = async () => {};
  context.requestIndex = () => {};
  return createWorkspaceFileHandlers(context);
}

if (process.argv[2] === "rlimit-child") {
  const [root, destination, pdf] = process.argv.slice(3);
  const reply = handlers(root, destination, (_event, result) => {
    if (Object.hasOwn(result, "ok")) process.stdout.write(JSON.stringify(result));
  });
  if (pdf === "pdf") void reply.handleExportPdf("export", "new.pdf");
  else void reply.handleSaveFile("lesson.tex", replacement.toString(), { expectedContent: original.toString() });
} else {
  for (const code of ["ENOSPC", "EFBIG", "EDQUOT", "EIO"]) {
    // An in-place write stages one recovery file (old and new bytes) and
    // then rewrites the destination.
    for (const step of ["recovery short write", "recovery fsync",
      "destination short write", "destination truncate", "destination fsync", "destination close"]) {
      test(`in-place ${code} at ${step} keeps the previous bytes on all aliases`, async (t) => {
        const root = fs.mkdtempSync(dir());
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const destination = path.join(root, "lesson.tex");
        const hardlink = path.join(root, "hard.tex");
        const symlink = path.join(root, "symbolic.tex");
        await fsp.writeFile(destination, original);
        await fsp.link(destination, hardlink);
        await fsp.symlink("lesson.tex", symlink);
        const inode = (await fsp.stat(destination)).ino;
        const mode = (await fsp.stat(destination)).mode;
        const failure = Object.assign(new Error(`fault at ${step}`), { code });
        const open = fsp.open;
        let didFail = false;
        function fail() {
          didFail = true;
          throw failure;
        }
        t.mock.method(fsp, "open", async (filename, flags, ...args) => {
          const file = await open(filename, flags, ...args);
          const storage = path.basename(filename);
          const phase = storage.startsWith(".tex64-write.") ? "stage"
            : storage.startsWith(".tex64-recovery.") ? "recovery"
            : filename === await fsp.realpath(destination) && typeof flags === "number" &&
                (flags & constants.O_WRONLY) ? "destination" : null;
          if (!phase || !step.startsWith(phase + " ")) return file;
          switch (step.split(" ").slice(1).join(" ")) {
            case "short write":
              if (phase === "destination") {
                const write = file.write.bind(file);
                file.write = async (bytes, offset, size, position) => {
                  if (didFail) return write(bytes, offset, size, position);
                  if (offset) fail();
                  return write(bytes, offset, Math.min(4096, size - 1), position);
                };
              } else {
                const writeFile = file.writeFile.bind(file);
                file.writeFile = async (bytes) => {
                  await writeFile(bytes.subarray(0, 4096));
                  fail();
                };
              }
              break;
            case "truncate": {
              const truncate = file.truncate.bind(file);
              file.truncate = async (size) => {
                await truncate(size);
                if (!didFail) fail();
              };
              break;
            }
            case "fsync": {
              const sync = file.sync.bind(file);
              file.sync = async () => { if (!didFail) fail(); await sync(); };
              break;
            }
            case "close": {
              const close = file.close.bind(file);
              file.close = async () => { await close(); if (!didFail) fail(); };
              break;
            }
          }
          return file;
        });
        const edit = step.endsWith("truncate") ? Buffer.alloc(6000, 65) : replacement;
        await assert.rejects(writeProjectFile(symlink, edit), (error) => error === failure);
        assert.equal(didFail, true);
        for (const alias of [destination, hardlink, symlink]) {
          assert.deepEqual(await fsp.readFile(alias), original);
          const stat = await fsp.stat(alias);
          assert.equal(stat.ino, inode);
          assert.equal(stat.mode, mode);
        }
        assert.deepEqual((await fsp.readdir(root)).sort(), ["hard.tex", "lesson.tex", "symbolic.tex"]);
      });
    }
  }

  test("the non-Darwin route preserves a backup if the destination permanently refuses recovery", async (t) => {
    const root = await fsp.mkdtemp(dir());
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(await fsp.realpath(root), "lesson.tex");
    await fsp.writeFile(destination, original);
    const open = fsp.open;
    const failure = Object.assign(new Error("destination stopped accepting writes"), { code: "EIO" });
    const warning = t.mock.method(console, "warn", () => {});
    let wrotePrefix = false;
    t.mock.method(fsp, "open", async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (file !== destination || !(flags & constants.O_WRONLY)) return handle;
      const write = handle.write.bind(handle);
      handle.write = async (bytes, start, length, position) => {
        if (wrotePrefix) throw failure;
        wrotePrefix = true;
        return write(bytes, start, Math.min(length, 4096), position);
      };
      return handle;
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      await assert.rejects(writeProjectFile(destination, replacement), (error) => error === failure);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const recovery = (await fsp.readdir(root)).find(file => file.startsWith(".tex64-recovery."));
    assert.ok(recovery, "a second disk failure must leave a recovery file");
    assert.notDeepEqual(await fsp.readFile(destination), original);
    assert.equal(warning.mock.callCount(), 1);
    // The next open of the file puts the old version back from that copy.
    t.mock.restoreAll();
    const workspace = new WorkspaceManager();
    workspace.setRootPath(root);
    assert.equal(await workspace.readFile("lesson.tex"), original.toString());
    assert.deepEqual(await fsp.readdir(root), ["lesson.tex"]);
  });

  // This sandbox adds provenance even after xattr -c. Inject the same ls
  // output as a plain macOS file so the real staging and rename path runs.
  for (const code of ["ENOSPC", "EFBIG", "EDQUOT", "EIO"]) {
    for (const step of ["stage short write", "stage fsync", "publish"]) {
      test(`atomic replace ${code} at ${step} leaves the original in place`, { skip: process.platform !== "darwin" }, async (t) => {
        const root = fs.mkdtempSync(dir());
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const destination = await fsp.realpath(root).then((real) => path.join(real, "lesson.tex"));
        await fsp.writeFile(destination, original);
        const open = fsp.open;
        const failure = Object.assign(new Error(`fault at ${step}`), { code });
        let stage;
        t.mock.method(fsp, "open", async (filename, ...args) => {
          const file = await open(filename, ...args);
          if (!path.basename(filename).startsWith(".tex64-write.")) return file;
          assert.equal(stage, undefined);
          stage = filename;
          if (step === "stage short write") {
            const writeFile = file.writeFile.bind(file);
            file.writeFile = async (bytes) => { await writeFile(bytes.subarray(0, 4096)); throw failure; };
          } else if (step === "stage fsync") {
            file.sync = async () => { throw failure; };
          }
          return file;
        });
        if (step === "publish") t.mock.method(fsp, "rename", async (from, to) => {
          assert.equal(from, stage);
          assert.equal(to, destination);
          throw failure;
        });
        const service = require.resolve("../electron/services/project-file-writes.cjs");
        const previous = require.cache[service];
        const execFile = childProcess.execFile;
        const promisify = require("node:util").promisify;
        const fakeLs = (...args) => execFile(...args);
        fakeLs[promisify.custom] = async (command, args, ...options) => command === "/bin/ls" ? {
          stdout: args.slice(-2).map((file) => `-rw------- 1 501 20 - 0 Jan 1 00:00 ${file}`).join("\n"),
        } : promisify(execFile)(command, args, ...options);
        childProcess.execFile = fakeLs;
        let atomicWrite;
        try {
          delete require.cache[service];
          atomicWrite = require(service).writeProjectFile;
        } finally {
          require.cache[service] = previous;
          childProcess.execFile = execFile;
        }
        await assert.rejects(atomicWrite(destination, replacement, { durable: true }), (error) => error === failure);
        assert.deepEqual(await fsp.readFile(destination), original);
        assert.deepEqual(await fsp.readdir(root), ["lesson.tex"]);
      });
    }
  }

  for (const kind of ["plain Save", "tagged Save", "hard-linked Save", "PDF export outside the workspace"]) {
    test(`OS RLIMIT_FSIZE leaves the previous file complete for ${kind}`, {
      skip: process.platform === "win32" || kind === "tagged Save" && process.platform !== "darwin",
    }, async (t) => {
      const temp = await fsp.mkdtemp(dir());
      t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
      const root = path.join(temp, "project");
      await fsp.mkdir(root);
      const isPdf = kind.startsWith("PDF");
      const target = isPdf ? path.join(temp, "existing.pdf") : path.join(root, "lesson.tex");
      const oldBytes = isPdf ? Buffer.concat([Buffer.from("%PDF-1.4\n"), original]) : original;
      await fsp.writeFile(target, oldBytes);
      if (isPdf) await fsp.writeFile(path.join(root, "new.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), replacement]));
      if (kind === "tagged Save") execFileSync("/usr/bin/xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", "Teaching", target]);
      if (kind === "hard-linked Save") await fsp.link(target, path.join(temp, "hard.tex"));
      const launch = `import os, resource, signal, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (4096, 4096))
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
os.execv(sys.argv[1], sys.argv[1:])`;
      const output = execFileSync("python3", ["-c", launch, process.execPath, __filename, "rlimit-child",
        root, target, isPdf ? "pdf" : "save"], { encoding: "utf8" });
      const result = JSON.parse(output);
      assert.equal(result.ok, false);
      assert.match(result.error, /EFBIG/);
      assert.deepEqual(await fsp.readFile(target), oldBytes);
      if (kind === "hard-linked Save") assert.deepEqual(await fsp.readFile(path.join(temp, "hard.tex")), oldBytes);
    });
  }
}
