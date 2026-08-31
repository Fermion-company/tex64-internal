"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const processTreePath = path.join(
  __dirname,
  "../electron/services/process-tree.cjs",
);
const windowsJobPath = path.join(
  __dirname,
  "../electron/services/windows-job.ps1",
);

const createMockChild = (pid = 4312) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.kill = () => true;
  return child;
};

const loadAsWindows = () => {
  const source = readFileSync(processTreePath, "utf8");
  const files = new Map();
  const writes = [];
  const spawns = [];
  const helper = createMockChild();
  const fsMock = {
    mkdtempSync: () => "/tmp/tex64-job-test",
    writeFileSync: (filePath, value, options = {}) => {
      if (options.flag === "wx" && files.has(filePath)) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      files.set(filePath, String(value));
      writes.push({ filePath, value: String(value), options });
    },
    readFileSync: (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return files.get(filePath);
    },
    rmSync: () => {},
  };
  const spawnMock = (command, args, options) => {
    spawns.push({ command, args, options });
    if (command.toLowerCase().endsWith("powershell.exe")) return helper;
    const utility = createMockChild(9981);
    queueMicrotask(() => utility.emit("close", 0));
    return utility;
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    Buffer,
    __dirname: path.dirname(processTreePath),
    clearTimeout,
    console,
    module,
    process: {
      platform: "win32",
      pid: 2121,
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      cwd: () => "C:\\workspace",
    },
    queueMicrotask,
    require: (name) => {
      if (name === "fs") return fsMock;
      if (name === "os") return { tmpdir: () => "/tmp" };
      if (name === "path") return path;
      if (name === "child_process") return { spawn: spawnMock };
      throw new Error(`unexpected require: ${name}`);
    },
    setTimeout,
  });
  return { api: module.exports, files, helper, spawns, writes };
};

test("Windows command lines preserve spaces, quotes, and trailing slashes", () => {
  const {
    _quoteWindowsArgument: quote,
    _windowsInvocation: invocation,
  } = require(processTreePath);
  assert.equal(quote("plain"), "plain");
  assert.equal(quote("two words"), '"two words"');
  assert.equal(quote(""), '""');
  assert.equal(quote("C:\\folder with space\\"), '"C:\\folder with space\\\\"');
  assert.equal(quote('a"b'), '"a\\"b"');

  assert.deepEqual(
    invocation(
      "C:\\Program Files\\Codex\\codex.exe",
      ["app-server", "a b"],
      { env: {} },
    ),
    {
      executable: "C:\\Program Files\\Codex\\codex.exe",
      commandLine:
        '"C:\\Program Files\\Codex\\codex.exe" app-server "a b"',
    },
  );
  const batch = invocation("C:\\TeX Live\\install.cmd", ["100%", "a&b"], {
    shell: true,
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(batch.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.match(batch.commandLine, /\/D \/V:OFF \/S \/C/u);
  assert.match(batch.commandLine, /"100%"/u);
  assert.match(batch.commandLine, /"a&b"/u);
});

test("owned Windows cancellation is safe only after the helper verifies an empty job", async () => {
  const { api, files, helper, spawns, writes } = loadAsWindows();
  const child = api.spawnOwnedProcess(
    "C:\\Program Files\\Codex\\codex.exe",
    ["app-server"],
    { cwd: "C:\\paper", env: { PATH: "C:\\bin" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  assert.equal(child, helper);
  assert.equal(spawns.length, 1);
  assert.ok(spawns[0].command.toLowerCase().endsWith("powershell.exe"));
  assert.equal(spawns[0].options.detached, false);
  assert.equal(spawns[0].options.shell, undefined);

  const launchWrite = writes.find(({ filePath }) => filePath.endsWith("launch.json"));
  const launch = JSON.parse(launchWrite.value);
  assert.equal(launch.executable, "C:\\Program Files\\Codex\\codex.exe");
  assert.equal(launch.workingDirectory, "C:\\paper");
  assert.equal(launch.parentPid, 2121);

  const stopping = api.terminateWindowsProcessTree(child);
  assert.equal(files.get(launch.cancelPath), "cancel\n");
  files.set(
    launch.statusPath,
    JSON.stringify({ cleanupOk: true, cancelled: true, targetExitCode: 1, error: "" }),
  );
  helper.emit("close", 1);
  assert.equal(await stopping, true);
});

test("missing or failed Windows cleanup status is never upgraded from taskkill success", async () => {
  {
    const { api, helper } = loadAsWindows();
    const child = api.spawnOwnedProcess("codex.exe", ["app-server"], {});
    const stopping = api.terminateWindowsProcessTree(child);
    helper.emit("close", 253);
    assert.equal(await stopping, false);
    assert.notEqual(api.getOwnedProcessCompletion(child)?.cleanupOk, true);
  }

  {
    const { api, spawns } = loadAsWindows();
    assert.equal(await api.terminateWindowsProcessTree(7319), false);
    assert.equal(spawns.at(-1).command, "taskkill.exe");
    assert.deepEqual(
      Array.from(spawns.at(-1).args),
      ["/pid", "7319", "/T", "/F"],
    );
  }
});

test("Codex stop rejects when Windows descendant cleanup is unverified", async () => {
  const clientPath = path.join(
    __dirname,
    "../electron/services/codex/app-server-client.cjs",
  );
  const source = readFileSync(clientPath, "utf8");
  const module = { exports: {} };
  vm.runInNewContext(source, {
    __dirname: path.dirname(clientPath),
    clearTimeout,
    module,
    process: {
      platform: "win32",
      kill: () => {},
    },
    require: (name) => {
      if (name === "events") return { EventEmitter };
      if (name === "../process-tree.cjs") {
        return {
          spawnOwnedProcess: () => {
            throw new Error("must not spawn");
          },
          terminateWindowsProcessTree: async () => false,
        };
      }
      throw new Error(`unexpected require: ${name}`);
    },
    setTimeout,
  });
  const { CodexAppServerClient } = module.exports;
  const client = new CodexAppServerClient("codex.exe");
  const child = createMockChild(5512);
  client.child = child;

  await assert.rejects(
    client.stop(),
    /Windows process-tree cleanup could not be verified/u,
  );
  assert.equal(client.child, null);
});

test("Build returns an explicit failure when Windows cleanup cannot be verified", async () => {
  const runtimePath = path.join(
    __dirname,
    "../electron/services/build/runtime.cjs",
  );
  const source = readFileSync(runtimePath, "utf8");
  const proc = createMockChild(6912);
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    __dirname: path.dirname(runtimePath),
    clearTimeout,
    module,
    process: { platform: "win32" },
    require: (name) => {
      if (name === "../process-tree.cjs") {
        return { spawnOwnedProcess: () => proc };
      }
      if (name === "./utils.cjs") return { shouldForceMissingTool: () => false };
      if (name === "../texlive-paths.cjs") {
        return { extendTexlivePath: (value) => value, findTexCommand: () => null };
      }
      throw new Error(`unexpected require: ${name}`);
    },
    setTimeout,
  });
  class BuildService {
    constructor() {
      this.cancelRequested = false;
      this.activeProcess = null;
      this.activeProcessTerminationPromise = null;
      this.activeProcessForceFinish = null;
      this.processTimeoutMs = 10000;
    }
  }
  module.exports(BuildService);
  const service = new BuildService();
  const running = service.runProcess("latexmk.exe", [], "C:\\paper", {});
  service.cancelRequested = true;
  service.activeProcessTerminationPromise = Promise.resolve(false);
  proc.emit("close", 1);
  const result = await running;
  assert.equal(result.status, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanupFailed, true);
  assert.match(result.output, /cleanup could not be verified/u);
});

test("Build fails closed when a naturally exiting Windows Job reports unverified cleanup", async () => {
  const runtimePath = path.join(
    __dirname,
    "../electron/services/build/runtime.cjs",
  );
  const source = readFileSync(runtimePath, "utf8");
  const proc = createMockChild(6913);
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    __dirname: path.dirname(runtimePath),
    clearTimeout,
    module,
    process: { platform: "win32" },
    require: (name) => {
      if (name === "../process-tree.cjs") {
        return {
          spawnOwnedProcess: () => proc,
          getOwnedProcessCompletion: () => ({ cleanupOk: false }),
        };
      }
      if (name === "./utils.cjs") return { shouldForceMissingTool: () => false };
      if (name === "../texlive-paths.cjs") {
        return { extendTexlivePath: (value) => value, findTexCommand: () => null };
      }
      throw new Error(`unexpected require: ${name}`);
    },
    setTimeout,
  });
  class BuildService {
    constructor() {
      this.cancelRequested = false;
      this.activeProcess = null;
      this.activeProcessTerminationPromise = null;
      this.activeProcessForceFinish = null;
      this.processTimeoutMs = 10000;
    }
  }
  module.exports(BuildService);
  const service = new BuildService();
  const running = service.runProcess("latexmk.exe", [], "C:\\paper", {});
  proc.emit("close", 253);
  const result = await running;
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.status, 253);
  assert.match(result.output, /cleanup could not be verified/u);
});

test("Windows launcher assigns the suspended root atomically and drains the Job Object", () => {
  const helper = readFileSync(windowsJobPath, "utf8");
  const processTree = readFileSync(processTreePath, "utf8");
  const buildRuntime = readFileSync(
    path.join(__dirname, "../electron/services/build/runtime.cjs"),
    "utf8",
  );
  const buildActions = readFileSync(
    path.join(__dirname, "../electron/services/build/actions.cjs"),
    "utf8",
  );
  const codexClient = readFileSync(
    path.join(__dirname, "../electron/services/codex/app-server-client.cjs"),
    "utf8",
  );
  const envService = readFileSync(
    path.join(__dirname, "../electron/services/env.cjs"),
    "utf8",
  );
  const codexAdapter = readFileSync(
    path.join(__dirname, "../electron/services/codex/axiom-adapter.cjs"),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(path.join(__dirname, "../package.json"), "utf8"),
  );

  assert.match(helper, /PROC_THREAD_ATTRIBUTE_JOB_LIST/u);
  assert.match(helper, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.match(helper, /CREATE_SUSPENDED/u);
  assert.match(helper, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(helper, /TerminateJobObject/u);
  assert.match(helper, /ActiveProcesses/u);
  assert.match(helper, /OpenProcess\(SYNCHRONIZE/u);
  assert.ok(
    helper.indexOf("UpdateProcThreadAttribute(JOB_LIST)") <
      helper.indexOf("ResumeThread(process.hThread)"),
  );
  assert.doesNotMatch(processTree, /Get-CimInstance\s+Win32_Process/u);
  assert.match(buildRuntime, /spawnOwnedProcess/u);
  assert.match(buildRuntime, /getOwnedProcessCompletion\(proc\)\?\.cleanupOk === true/u);
  assert.match(buildActions, /terminateWindowsProcessTree\(proc\)/u);
  assert.match(codexClient, /spawnOwnedProcess/u);
  assert.match(codexClient, /cleanup could not be verified/u);
  assert.match(codexAdapter, /failed stop as quiescence/u);
  assert.match(envService, /spawnOwnedProcess/u);
  assert.match(envService, /getOwnedProcessCompletion\(child\)\?\.cleanupOk === true/u);
  assert.ok(
    packageJson.build.asarUnpack.includes("electron/services/windows-job.ps1"),
  );
});

test("spawnOwnedProcess leaves POSIX spawning and stdio unchanged", async () => {
  if (process.platform === "win32") return;
  const { spawnOwnedProcess } = require(processTreePath);
  const child = spawnOwnedProcess(
    process.execPath,
    ["-e", "process.stdout.write('owned-ok')"],
    { stdio: ["ignore", "pipe", "pipe"], detached: false },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, "owned-ok");
});
