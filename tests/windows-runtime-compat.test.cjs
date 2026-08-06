const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TEXLAB_VERSION,
  TARGETS,
  archiveSuffixFor,
  binaryNameFor,
  extractionArgsFor,
} = require("../scripts/fetch-texlab.cjs");
const {
  resolveShellInvocation,
} = require("../electron/services/agent-tools-file-utils.cjs");
const {
  getManagedTexliveBinDirs,
  getManagedTexliveRoot,
} = require("../electron/services/texlive-paths.cjs");

test("texlab fetch metadata includes the pinned Windows x64 zip", () => {
  const target = TARGETS["win32-x64"];

  assert.equal(TEXLAB_VERSION, "v5.25.1");
  assert.deepEqual(target, {
    asset: "texlab-x86_64-windows.zip",
    sha256: "aa5fc1fe6004c17cd83086a57a8c8f28bb3f360914872711bfbb83490dc3c19e",
    archiveType: "zip",
    binary: "texlab.exe",
  });
  assert.equal(binaryNameFor(target), "texlab.exe");
  assert.equal(archiveSuffixFor(target), ".zip");
  assert.deepEqual(
    extractionArgsFor(target, "C:\\Temp\\texlab.zip", "C:\\texlab"),
    ["-xf", "C:\\Temp\\texlab.zip", "-C", "C:\\texlab", "texlab.exe"]
  );
});

test("Axiom run_command uses COMSPEC without cmd AutoRun hooks on Windows", () => {
  const command = 'printf "safe argument"';
  assert.deepEqual(
    resolveShellInvocation(command, "win32", {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", command],
    }
  );
});

test("Axiom run_command falls back to profile-free PowerShell on Windows", () => {
  const command = "Get-ChildItem -LiteralPath .";
  assert.deepEqual(resolveShellInvocation(command, "win32", {}), {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
  });
  assert.deepEqual(
    resolveShellInvocation(command, "win32", { ComSpec: "pwsh.exe" }),
    {
      executable: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    }
  );
});

test("Axiom run_command preserves Unix login-shell invocation", () => {
  const command = "latexmk -pdf main.tex";
  assert.deepEqual(
    resolveShellInvocation(command, "darwin", { SHELL: "/bin/zsh" }),
    {
      executable: "/bin/zsh",
      args: ["-lc", command],
    }
  );
});

test("Windows packaged GUI smoke tests require explicit success sentinels", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "release.yml"),
    "utf8"
  );
  const smokeStep = workflow
    .split("- name: Smoke-test packaged native modules and texlab")[1]
    ?.split("- name: Capture real Microsoft Store screenshots")[0];

  assert.ok(smokeStep, "Windows packaged smoke-test step must exist");
  const guiChecks = smokeStep.split(
    "Remove-Item Env:ELECTRON_RUN_AS_NODE"
  )[0];
  assert.match(guiChecks, /TEX64_NATIVE_LOAD_OK/);
  assert.match(guiChecks, /TEX64_CONPTY_OK/);
  assert.doesNotMatch(
    guiChecks,
    /\$LASTEXITCODE/,
    "GUI-subsystem TeX64.exe checks must not depend on a stale native exit code"
  );
});

test("Windows Store build remains independent of marketplace actions", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "release.yml"),
    "utf8"
  );
  const windowsJob = workflow
    .split("\n  windows:\n")[1]
    ?.split("\n  publish:\n")[0];

  assert.ok(windowsJob, "Windows Store build job must exist");
  const actionReferences = [...windowsJob.matchAll(/^\s*uses:\s*(\S+)/gmu)].map(
    (match) => match[1]
  );
  assert.ok(actionReferences.length > 0, "Windows artifact upload action must exist");
  assert.ok(
    actionReferences.every((reference) => reference.startsWith("./")),
    "Windows package recovery must not download remote actions"
  );
  assert.match(windowsJob, /permissions:\s*\n\s*contents: read/u);
  assert.match(windowsJob, /uses: \.\/\.github\/actions\/upload-actions-artifact/u);
  assert.match(workflow, /windows_only:\s*\n(?:.*\n){0,5}\s*type: boolean/u);
  assert.match(
    workflow,
    /group: release-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.windows_only && 'windows-only' \|\| 'full' \}\}/u
  );
  const localAction = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      ".github",
      "actions",
      "upload-actions-artifact",
      "action.yml"
    ),
    "utf8"
  );
  assert.match(localAction, /using: node24/u);
  assert.match(localAction, /main: index\.cjs/u);
  const localActionEntrypoint = fs.readFileSync(
    path.join(__dirname, "..", ".github", "actions", "upload-actions-artifact", "index.cjs"),
    "utf8"
  );
  assert.match(localActionEntrypoint, /scripts\/upload-actions-artifact\.cjs/u);
  assert.match(localActionEntrypoint, /INPUT_RETENTION-DAYS/u);
  assert.match(localActionEntrypoint, /INPUT_COMPRESSION-LEVEL/u);
});

test("managed Windows TeX Live is rooted in per-user LocalAppData", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    TEX64_MANAGED_TEXLIVE_YEAR: "2027",
  };
  const root = getManagedTexliveRoot("win32", env);

  assert.equal(
    root,
    "C:\\Users\\Alice\\AppData\\Local\\TeX64\\texlive\\2027"
  );
  assert.deepEqual(getManagedTexliveBinDirs("win32", "x64", root), [
    "C:\\Users\\Alice\\AppData\\Local\\TeX64\\texlive\\2027\\bin\\windows",
  ]);
});

test("managed Windows TeX Live has environment-aware writable fallbacks", () => {
  assert.equal(
    getManagedTexliveRoot("win32", { USERPROFILE: "D:\\Profiles\\Alice" }),
    "D:\\Profiles\\Alice\\AppData\\Local\\TeX64\\texlive\\2026"
  );
  assert.equal(
    getManagedTexliveRoot("win32", {
      APPDATA: "D:\\Profiles\\Alice\\AppData\\Roaming",
    }),
    "D:\\Profiles\\Alice\\AppData\\Local\\TeX64\\texlive\\2026"
  );
  assert.equal(
    getManagedTexliveRoot("win32", {
      TEX64_MANAGED_TEXLIVE_ROOT: "E:\\Portable\\texlive",
    }),
    "E:\\Portable\\texlive"
  );
  assert.equal(getManagedTexliveRoot("win32", {}), "");

  assert.equal(
    getManagedTexliveRoot("darwin", { TEX64_MANAGED_TEXLIVE_YEAR: "2027" }),
    path.join("/Users", "Shared", "TeX64", "texlive", "2027")
  );
});
