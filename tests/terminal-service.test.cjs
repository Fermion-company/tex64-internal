const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TerminalService } = require("../electron/services/terminal.cjs");

test("terminal sessions use interactive PTYs and report the actual cwd", (t) => {
  const calls = [];
  const service = new TerminalService({ ptyModule: { spawn: (shell, args, options) => {
    const proc = { onData: () => {}, onExit: (fn) => { proc.exit = fn; }, write: (data) => calls.push(data), resize: () => {}, kill: () => calls.push("kill") };
    calls.push({ shell, args, options, proc });
    return proc;
  } } });
  t.after(() => service.killAll());
  const result = service.create({ cwd: os.tmpdir(), shell: "/bin/zsh", cols: -1, rows: 40 });
  assert.equal(result.cwd, os.tmpdir());
  assert.deepEqual(calls[0].args, process.platform === "win32" ? [] : ["-il"]);
  assert.equal(calls[0].options.cols, 80);
  assert.equal(calls[0].options.rows, 40);
  assert.equal(calls[0].options.env.TERM_PROGRAM, "TeX64");
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  service.write(result.id, "cd sub\r");
  assert.equal(calls[1], "cd sub\r");
  service.kill(result.id);
  service.write(result.id, "ignored");
  assert.equal(calls.at(-1), "kill");
  assert.equal(service.sessions.size, 0);
  assert.throws(() => service.create({ cwd: path.join(os.tmpdir(), "tex64-missing-cwd-000000") }));
});

test("real PTY preserves cd, shell variables, pipes, Unicode, interrupts and independent sessions", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-terminal-"));
  fs.mkdirSync(path.join(root, "child space"));
  const output = new Map();
  const service = new TerminalService({ onData: (id, data) => output.set(id, (output.get(id) || "") + data) });
  t.after(() => { service.killAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const waitFor = async (id, pattern) => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (pattern.test(output.get(id) || "")) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(output.get(id) || "", pattern);
  };
  const a = service.create({ cwd: root, shell: "/bin/sh" }).id;
  const b = service.create({ cwd: root, shell: "/bin/sh" }).id;
  service.write(a, "cd 'child space'\r");
  service.write(a, "TEX64_CHECK=retained; printf '__CWD__%s__\\n' \"$PWD\"; printf '日本語\\n' | wc -l\r");
  await waitFor(a, /__CWD__[^\r\n]+child space__/);
  service.write(a, "printf '__VAR__%s__\\n' \"$TEX64_CHECK\"\r");
  await waitFor(a, /__VAR__retained__/);
  service.write(b, "printf '__SECOND__%s__\\n' \"$PWD\"\r");
  await waitFor(b, new RegExp("__SECOND__" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "__"));
  service.write(a, "sleep 30\r");
  await new Promise((resolve) => setTimeout(resolve, 150));
  service.write(a, "\x03");
  service.write(a, "printf '__%s__\\n' INTERRUPTED\r");
  await waitFor(a, /__INTERRUPTED__/);
  service.resize(a, 111, 31);
  service.write(a, "stty size\r");
  await waitFor(a, /31 111/);
  service.write(a, "test -t 0 && test -t 1 && printf '__%s__\\n' REAL_TTY\r");
  await waitFor(a, /__REAL_TTY__/);
  service.write(a, "read answer; printf '__ANSWER__%s__\\n' \"$answer\"\r");
  service.write(a, "interactive input\r");
  await waitFor(a, /__ANSWER__interactive input__/);
  service.write(a, "exit\r");
  const deadline = Date.now() + 3000;
  while (service.sessions.has(a) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.sessions.has(a), false);
  assert.equal(service.sessions.has(b), true);
});

test("a keystroke racing PTY exit reports a stopped session instead of crashing main", () => {
  const exits = [];
  const service = new TerminalService({ onExit: (...args) => exits.push(args) });
  let killed = false;
  service.sessions.set("racing", { write: () => { throw new Error("EIO"); }, kill: () => { killed = true; } });
  assert.doesNotThrow(() => service.write("racing", "c"));
  assert.equal(killed, true);
  assert.equal(service.sessions.size, 0);
  assert.deepEqual(exits, [["racing", -1]]);
});
