"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");
const { WorkspaceWriterCoordinator } = require("../electron/services/workspace-writer-coordinator.cjs");
const { AgentService } = require("../electron/services/agent.cjs");
const { buildAgentPolicy } = require("../electron/services/agent-policy.cjs");
const {
  handleReplaceLines,
  handleProposeWrite,
  handleProposePatch,
  handleReadFiles,
} = require("../electron/services/agent-tools-file.cjs");
const { handleReplaceSection } = require("../electron/services/agent-tools-latex.cjs");
const { deliverFullText, deliverPositions, editBaseOf, recordMentionedPositions, recordOwnWrite } = require("../electron/services/agent-model-view.cjs");
const { buildTools } = require("../electron/services/openprism/tools.cjs");
const Diff = require("diff");

// The text Axiom's next edit of `name` would be based on (null: the disk).
const baseOf = (f, name) => editBaseOf(f.agent, "chat", name).text ?? null;
// Tool results may come back as JSON text.
const parsed = (result) => {
  if (typeof result !== "string") return result;
  try { return JSON.parse(result); } catch { return result; }
};

// The person keeps typing while an in-process (openprism) Axiom turn runs:
// their saves go through (per-file queue, disk re-read), and Axiom's edits,
// placed by what Axiom last saw, are rebased onto the saved text or refused —
// never written over it. Codex and the other runs still hold saves off.
const noop = () => {};
const doc = (count = 40) => Array.from({ length: count }, (_, i) => `line ${i + 1} text`).join("\n") + "\n";

const fixture = async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-axiom-saves-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const events = [];
  const agent = new AgentService({
    workspace,
    sendToRenderer: (type, payload) => events.push({ type, payload }),
    updateWorkspaceIfNeeded: async () => {},
    requestIndex: noop,
    sessionsService: { loadSessions: async () => [], saveSession: async () => {} },
  });
  const coordinator = new WorkspaceWriterCoordinator();
  coordinator.setAgentActiveCheck((rootPath) => agent.activeWriter(rootPath));
  const replies = [];
  const ctx = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state: {},
    sendToRenderer: (type, payload) => replies.push({ type, payload }),
    sendIssues: noop,
    beginRendererWorkspaceMutation: (rootPath, kind) => coordinator.beginRendererMutation(rootPath, kind),
    beforeUserSave: (rootPath, relativePath, previous) => agent.noteUserSave(rootPath, relativePath, previous),
  });
  ctx.updateWorkspaceIfNeeded = async () => {};
  ctx.requestIndex = noop;
  const handlers = createWorkspaceFileHandlers(ctx);
  const policy = buildAgentPolicy();
  return {
    root, workspace, agent, events, handlers, policy,
    read: (name) => fsp.readFile(path.join(root, name), "utf8"),
    // The editor's autosave: disk-checked against what it last saved.
    save: async (name, content, expectedContent) => {
      await handlers.handleSaveFile(name, content, { expectedContent });
      return replies.filter((reply) => reply.type === "saveResult" && reply.payload.path === name).at(-1).payload;
    },
    inProcessTurn: (context = null) => {
      const run = agent.startConversationRun("chat");
      agent.allowSavesDuringRun(run, context);
      t.after(() => agent.finishConversationRun("chat", run.token));
      return run;
    },
    // Axiom's real openprism tools, by name.
    tools: () => Object.fromEntries(
      buildTools(agent, "chat", policy, { rootPath: root, context: {} }).map((tool) => [tool.function.name, tool]),
    ),
    // Axiom reads the whole file through its read_file tool.
    readAll: async (name) => {
      const tools = Object.fromEntries(
        buildTools(agent, "chat", policy, { rootPath: root, context: {} }).map((tool) => [tool.function.name, tool]),
      );
      return parsed(await tools.read_file.execute({ path: name }));
    },
  };
};

test("during an in-process Axiom turn the editor's saves go through; other mutations still wait", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("main.tex", doc());
  f.inProcessTurn();
  assert.equal(f.agent.activeWriter(f.root), "in-process");
  const typed = doc().replace("line 5 text", "line 5 text, typed");
  const result = await f.save("main.tex", typed, doc());
  assert.equal(result.ok, true, result.error);
  assert.equal(await f.read("main.tex"), typed);
  // A save that does not check the disk first, and file operations, wait.
  await f.handlers.handleSaveFile("main.tex", "unchecked", {});
  assert.equal(await f.read("main.tex"), typed);
  await f.handlers.handleCreateFile("new.tex");
  assert.equal(fs.existsSync(path.join(f.root, "new.tex")), false);
});

test("Codex (and Undo/Apply) runs keep refusing saves", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("main.tex", doc());
  const run = f.agent.startConversationRun("chat");
  t.after(() => f.agent.finishConversationRun("chat", run.token));
  assert.equal(f.agent.activeWriter(f.root), "exclusive");
  const result = await f.save("main.tex", "typed", doc());
  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.equal(await f.read("main.tex"), doc());
});

test("Axiom's line edit placed by an earlier read lands on the same text after the person's saved typing", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  await f.readAll("main.tex");
  // The person adds three lines near the top; autosave writes them.
  const typed = original.replace("line 2 text\n", "line 2 text\nnew A\nnew B\nnew C\n");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  // Axiom, by the numbering it read, rewrites line 30.
  const result = await handleReplaceLines(f.agent, { path: "main.tex", startLine: 30, endLine: 30, content: "line 30 by Axiom" }, f.policy, "chat");
  assert.equal(result.status, "applied", result.error);
  assert.match(result.note, /merged/);
  assert.equal(await f.read("main.tex"), typed.replace("line 30 text", "line 30 by Axiom"));
  // The editor is told the new text against what it saved.
  const applied = f.events.filter((e) => e.type === "agent:applyContent").at(-1).payload;
  assert.equal(applied.expectedContent, typed);
});

test("without a read in this turn, the text before the person's first save is Axiom's picture (document map)", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  const typed = original.replace("line 1 text\n", "line 1 text\ninserted\n");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const again = typed.replace("line 3 text\n", "line 3 text\nmore\n");
  assert.equal((await f.save("main.tex", again, typed)).ok, true);
  const result = await handleReplaceLines(f.agent, { path: "main.tex", startLine: 20, endLine: 20, content: "line 20 by Axiom" }, f.policy, "chat");
  assert.equal(result.status, "applied", result.error);
  assert.equal(await f.read("main.tex"), again.replace("line 20 text", "line 20 by Axiom"));
});

test("a whole-file write from an older read is rebased, never written over the saved typing", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  await f.readAll("main.tex");
  const typed = original.replace("line 35 text", "line 35 text and the person's sentence");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const axiomText = original.replace("line 4 text", "line 4 text, fixed by Axiom");
  const result = await handleProposeWrite(f.agent, { path: "main.tex", content: axiomText }, f.policy, "chat");
  assert.equal(result.status, "applied", result.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 4 text", "line 4 text, fixed by Axiom"));
});

test("an Axiom edit over text the person changed is refused with the current text; nothing is written", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  await f.readAll("main.tex");
  const typed = original.replace("line 30 text", "line 30 rewritten by the person");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const result = await handleReplaceLines(f.agent, { path: "main.tex", startLine: 30, endLine: 30, content: "line 30 by Axiom" }, f.policy, "chat");
  assert.equal(result.status, "apply_failed");
  assert.equal(result.writeApplied, false);
  assert.equal(result.currentContent, typed);
  assert.equal(await f.read("main.tex"), typed);
  // Axiom now knows the current text: a retry by the new numbering applies.
  assert.equal(baseOf(f, "main.tex"), typed);
  const retry = await handleReplaceLines(f.agent, { path: "main.tex", startLine: 31, endLine: 31, content: "line 31 by Axiom" }, f.policy, "chat");
  assert.equal(retry.status, "applied", retry.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 31 text", "line 31 by Axiom"));
});

test("replace_section by an older read keeps typing saved in another section", async (t) => {
  const f = await fixture(t);
  const original = "\\documentclass{article}\n\\begin{document}\n\\section{A}\nalpha body\n\\section{B}\nbeta body\n\\end{document}\n";
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  await f.readAll("main.tex");
  const typed = original.replace("alpha body\n", "alpha body\nthe person's new paragraph\n");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const result = await handleReplaceSection(f.agent, { path: "main.tex", type: "section", title: "B", content: "beta rewritten" }, f.policy, "chat");
  assert.equal(result.status, "applied", result.error);
  assert.equal(await f.read("main.tex"), typed.replace("beta body", "beta rewritten"));
});

test("a diagnostic naming the file records line numbers only; Axiom's base stays the full text it read", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.root, "chapters"));
  await f.workspace.writeFile("chapters/one.tex", "old\n");
  f.inProcessTurn();
  await f.readAll("chapters/one.tex");
  await f.workspace.writeFile("chapters/one.tex", "new\n");
  await recordMentionedPositions(f.agent, "chat", {}, { issues: [{ file: "one.tex", line: 1 }] });
  assert.equal(baseOf(f, "chapters/one.tex"), "old\n");
});

test("a conflict reported mid-turn does not end the turn in the chat; the turn's own end becomes resumable", async (t) => {
  const f = await fixture(t);
  const run = f.agent.startConversationRun("chat");
  t.after(() => f.agent.finishConversationRun("chat", run.token));
  f.agent.reportContentConflict("chat", "main.tex");
  assert.equal(f.events.some((e) => e.type === "agent:status"), false, "no terminal status while the turn runs");
  assert.ok(f.events.some((e) => e.type === "agent:error"));
  f.agent.finishConversationRun("chat", run.token);
  f.agent.sendStatus("idle", "Done", "chat");
  assert.equal(f.events.filter((e) => e.type === "agent:status").at(-1).payload.state, "resumable");
  // Reported after the turn ended: resumable at once, as before.
  f.events.length = 0;
  f.agent.reportContentConflict("chat", "other.tex");
  assert.equal(f.events.filter((e) => e.type === "agent:status").at(-1).payload.state, "resumable");
});

test("auditor r10: saved sentence, then check_references, then a whole-file write from the earlier read: the sentence stays", async (t) => {
  const f = await fixture(t);
  const src = "\\documentclass{article}\n\\begin{document}\nProse.\nSee \\ref{nope}.\n\\end{document}\n";
  const typed = src.replace("Prose.", "Prose. Author's saved sentence.");
  await f.workspace.writeFile("main.tex", src);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: "main.tex" });
  assert.equal((await f.save("main.tex", typed, src)).ok, true);
  const checked = await tools.check_references.execute({});
  assert.match(typeof checked === "string" ? checked : JSON.stringify(checked), /"line":4/);
  assert.equal(baseOf(f, "main.tex"), src, "the diagnostic did not become Axiom's base");
  const write = parsed(await tools.write_file.execute({ path: "main.tex", content: src.replace("See", "Compare") }));
  assert.equal(write.status, "applied", write.error);
  assert.equal(await f.read("main.tex"), typed.replace("See", "Compare"));
});

test("read_file of a line range is positions, not a base: a whole-file write then needs a full read", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  const tools = f.tools();
  const typed = original.replace("line 3 text", "line 3 text, the person's words");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  await tools.read_file.execute({ path: "main.tex", startLine: 10, endLine: 12 });
  assert.equal(baseOf(f, "main.tex"), original, "still the text before the person's save");
  const write = parsed(await tools.write_file.execute({ path: "main.tex", content: original.replace("line 11 text", "eleven") }));
  assert.match(write.error, /Read it \(read_file\)/);
  assert.equal(await f.read("main.tex"), typed);
  // After a full read the same write goes through, and keeps the typing.
  await tools.read_file.execute({ path: "main.tex" });
  assert.equal(baseOf(f, "main.tex"), typed);
  const again = parsed(await tools.write_file.execute({ path: "main.tex", content: typed.replace("line 11 text", "eleven") }));
  assert.equal(again.status, "applied", again.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 11 text", "eleven"));
});

test("a full read cut at 20,000 characters is positions only", async (t) => {
  const f = await fixture(t);
  const big = Array.from({ length: 1500 }, (_, i) => `paragraph line ${i + 1} with some words`).join("\n") + "\n";
  await f.workspace.writeFile("big.tex", big);
  f.inProcessTurn();
  const read = parsed(await f.tools().read_file.execute({ path: "big.tex" }));
  assert.equal(read.truncated, true);
  assert.equal(baseOf(f, "big.tex"), null, "no base from a cut text");
  const typed = big.replace("paragraph line 2 with", "paragraph line 2, typed, with");
  assert.equal((await f.save("big.tex", typed, big)).ok, true);
  const write = parsed(await f.tools().write_file.execute({ path: "big.tex", content: big.replace("line 1400 with", "line 1400, Axiom, with") }));
  assert.match(write.error ?? "", /read/i);
  assert.equal(await f.read("big.tex"), typed);
});

test("list_sections / read_section give positions only", async (t) => {
  const f = await fixture(t);
  const src = "\\documentclass{article}\n\\begin{document}\n\\section{A}\nalpha\n\\section{B}\nbeta\n\\end{document}\n";
  await f.workspace.writeFile("main.tex", src);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.list_sections.execute({ path: "main.tex" });
  await tools.read_section.execute({ path: "main.tex", type: "section", title: "B" });
  assert.equal(baseOf(f, "main.tex"), null);
  const typed = src.replace("alpha", "alpha and the person's line");
  assert.equal((await f.save("main.tex", typed, src)).ok, true);
  assert.equal(baseOf(f, "main.tex"), src, "the text before the save, not the outline's");
  const write = parsed(await tools.write_file.execute({ path: "main.tex", content: src.replace("beta", "BETA") }));
  assert.ok(write.error, "no whole-file write without a full read");
  const section = parsed(await tools.replace_section.execute({ path: "main.tex", type: "section", title: "B", content: "BETA" }));
  assert.equal(section.status, "applied", section.error);
  assert.equal(await f.read("main.tex"), typed.replace("beta", "BETA"));
});

test("the editor text sent with the request is positions only (Axiom never received it)", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn({ activeFilePath: "main.tex", activeFileContent: original + "unsaved line\n" });
  assert.equal(baseOf(f, "main.tex"), null);
});

test("read_files (other callers) records positions only", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("main.tex", doc());
  f.inProcessTurn();
  await handleReadFiles(f.agent, { paths: ["main.tex"] }, f.policy, "chat");
  assert.equal(baseOf(f, "main.tex"), null);
});

test("after a merged write Axiom's base is what it computed, so its next whole-file write keeps the typing", async (t) => {
  const f = await fixture(t);
  const original = doc();
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: "main.tex" });
  const typed = original.replace("line 35 text", "line 35 text, the person's");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const first = parsed(await tools.replace_lines.execute({ path: "main.tex", startLine: 5, endLine: 5, content: "line 5 by Axiom" }));
  assert.equal(first.status, "applied", first.error);
  const axiomBelief = original.replace("line 5 text", "line 5 by Axiom");
  assert.equal(baseOf(f, "main.tex"), axiomBelief, "not the merged text: Axiom never saw line 35's change");
  const second = parsed(await tools.write_file.execute({ path: "main.tex", content: axiomBelief.replace("line 6 text", "line 6 by Axiom") }));
  assert.equal(second.status, "applied", second.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 5 text", "line 5 by Axiom").replace("line 6 text", "line 6 by Axiom"));
});

test("apply_patch after saved typing applies to Axiom's text; Axiom's base never takes in the typing", async (t) => {
  const f = await fixture(t);
  const original = doc(12);
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: "main.tex" });
  const typed = original.replace("line 11 text", "line 11 text, typed");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  const patched = original.replace("line 3 text", "line 3 by Axiom");
  const result = parsed(await tools.apply_patch.execute({ path: "main.tex", patch: Diff.createPatch("main.tex", original, patched) }));
  assert.equal(result.status, "applied", result.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 3 text", "line 3 by Axiom"));
  assert.equal(baseOf(f, "main.tex"), patched, "Axiom's text plus its patch, not the disk");
  // So a whole-file write from that text keeps the typing.
  const write = parsed(await tools.write_file.execute({ path: "main.tex", content: patched.replace("line 4 text", "four") }));
  assert.equal(write.status, "applied", write.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 3 text", "line 3 by Axiom").replace("line 4 text", "four"));
});

test("line numbers that differ between the versions Axiom counted in are refused; where they agree the edit applies", async (t) => {
  const f = await fixture(t);
  const original = doc(20);
  await f.workspace.writeFile("main.tex", original);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: "main.tex" });
  // The person inserts a line after line 10; a diagnostic then counts in the new text.
  const typed = original.replace("line 10 text\n", "line 10 text\nthe person's new line\n");
  assert.equal((await f.save("main.tex", typed, original)).ok, true);
  await tools.read_file.execute({ path: "main.tex", startLine: 9, endLine: 13 });
  // Line 12 is "line 12 text" in the full read but "line 11 text" in the range: ambiguous.
  const refused = parsed(await tools.replace_lines.execute({ path: "main.tex", startLine: 12, endLine: 12, content: "twelve" }));
  assert.match(refused.error, /not the same in the versions/);
  assert.equal(await f.read("main.tex"), typed);
  // Line 4 reads the same in both: applied on Axiom's base, typing kept.
  const applied = parsed(await tools.replace_lines.execute({ path: "main.tex", startLine: 4, endLine: 4, content: "four" }));
  assert.equal(applied.status, "applied", applied.error);
  assert.equal(await f.read("main.tex"), typed.replace("line 4 text", "four"));
});

test("too many versions to compare: line-numbered edits need a full read, edits by content still work", async (t) => {
  const f = await fixture(t);
  let text = "\\documentclass{article}\n\\begin{document}\n\\section{A}\nalpha\n\\section{B}\nbeta\n\\end{document}\n";
  await f.workspace.writeFile("main.tex", text);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: "main.tex" });
  for (let i = 0; i < 7; i += 1) {
    const next = text.replace("alpha", `alpha ${i}`);
    assert.equal((await f.save("main.tex", next, text)).ok, true);
    text = next;
    await tools.read_file.execute({ path: "main.tex", startLine: 1, endLine: 3 });
  }
  const lines = parsed(await tools.replace_lines.execute({ path: "main.tex", startLine: 6, endLine: 6, content: "BETA" }));
  assert.match(lines.error, /read it again in full/);
  const section = parsed(await tools.replace_section.execute({ path: "main.tex", type: "section", title: "B", content: "BETA" }));
  assert.equal(section.status, "applied", section.error);
  assert.equal(await f.read("main.tex"), text.replace("beta", "BETA"));
});

test("property: interleaved saves, reads, diagnostics and Axiom edits never lose a saved line of the person's", async (t) => {
  // Deterministic PRNG; each round is a fresh folder and turn.
  let seed = 1234;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  // Every kind of edit must really happen (and be refused) somewhere.
  const outcomes = {};
  let turnsWithRefusals = 0;
  const count = (key) => { outcomes[key] = (outcomes[key] ?? 0) + 1; };
  for (let round = 0; round < 150; round += 1) {
    await t.test(`round ${round}`, async (st) => {
      const f = await fixture(st);
      const original = Array.from({ length: 12 }, (_, i) => `orig ${i + 1}`).join("\n") + "\n";
      await f.workspace.writeFile("main.tex", original);
      f.inProcessTurn();
      const tools = f.tools();
      const userMarks = [];
      let refused = false;
      // Axiom's knowledge: its last full text, and every version it has line
      // numbers from since then (a full read or its own write supersedes older
      // numbers; until one happens, all positional results count). A line edit
      // may count in ANY of those versions.
      let axiomFull = null;
      const numberings = [];
      let mark = 0;
      const log = [];
      // A refused edit returns the file's current text: Axiom now has it in full.
      const received = (result) => {
        refused = true;
        if (typeof result?.currentContent === "string" && !result.currentContentTruncated) {
          axiomFull = result.currentContent;
          numberings.length = 0;
          numberings.push(result.currentContent);
        }
      };
      const disk = () => f.read("main.tex");
      for (let step = 0; step < 18; step += 1) {
        const op = pick(["save", "save", "full", "range", "diag", "write", "lines", "lines", "patch"]);
        log.push(op);
        if (op === "save") {
          const lines = (await disk()).replace(/\n$/, "").split("\n");
          const at = Math.floor(rand() * (lines.length + 1));
          const label = `USER${(mark += 1)}`;
          if (rand() < 0.5) lines.splice(at, 0, label);
          else lines[Math.min(at, lines.length - 1)] += ` ${label}`;
          const before = await disk();
          const next = lines.join("\n") + "\n";
          const result = await f.save("main.tex", next, before);
          if (result.ok) userMarks.push(label);
          log.push(`  ${label} ok=${result.ok}`);
        } else if (op === "full") {
          const read = parsed(await tools.read_file.execute({ path: "main.tex" }));
          if (typeof read?.content === "string" && !read.truncated) {
            axiomFull = read.content;
            numberings.length = 0;
            numberings.push(read.content);
          }
        } else if (op === "range") {
          const text = await disk();
          await tools.read_file.execute({ path: "main.tex", startLine: 1, endLine: 6 });
          numberings.push(text);
        } else if (op === "diag") {
          const text = await disk();
          await tools.list_sections.execute({ path: "main.tex" });
          numberings.push(text);
        } else if (op === "write" && axiomFull !== null) {
          // From its last full text, Axiom changes one original line.
          const lines = axiomFull.replace(/\n$/, "").split("\n");
          const own = lines.map((line, i) => [line, i]).filter(([line]) => line.startsWith("orig") && !line.includes("USER"));
          if (!own.length) continue;
          const [, index] = pick(own);
          lines[index] += ` AX${(mark += 1)}`;
          const content = lines.join("\n") + "\n";
          const result = parsed(await tools.write_file.execute({ path: "main.tex", content }));
          log.push(`  write ${result?.status ?? ""} ${result?.error ?? ""}`);
          count(`write ${result?.status === "applied" ? "applied" : "refused"}`);
          if (result?.status === "applied") { axiomFull = content; numberings.length = 0; numberings.push(content); }
          else received(result);
        } else if (op === "lines" && numberings.length) {
          // Axiom targets an original line it knows, counting in any version it saw.
          const version = pick(numberings);
          const lines = version.replace(/\n$/, "").split("\n");
          const own = lines.map((line, i) => [line, i]).filter(([line]) => line.startsWith("orig") && !line.includes("USER"));
          if (!own.length) continue;
          const [line, index] = pick(own);
          const result = parsed(await tools.replace_lines.execute({
            path: "main.tex", startLine: index + 1, endLine: index + 1, content: `${line} AX${(mark += 1)}`,
          }));
          log.push(`  lines ${index + 1} "${line}" ${result?.status ?? ""} ${(result?.error ?? "").slice(0, 60)}`);
          count(`lines ${result?.status === "applied" ? "applied" : "refused"}`);
          if (result?.status === "applied") {
            // Axiom knows its own edit and gets the outline of the result.
            axiomFull = null;
            numberings.length = 0;
            numberings.push(await disk());
          } else received(result);
        } else if (op === "patch" && (axiomFull !== null || numberings.length)) {
          // A unified diff against a version Axiom has (its full text, or any
          // version it has line numbers from).
          const before = axiomFull ?? pick(numberings);
          const lines = before.replace(/\n$/, "").split("\n");
          const own = lines.map((line, i) => [line, i]).filter(([line]) => /^orig \d+$/.test(line));
          if (!own.length) continue;
          const [, index] = pick(own);
          lines[index] += ` AX${(mark += 1)}`;
          const after = lines.join("\n") + "\n";
          let result;
          try {
            result = parsed(await tools.apply_patch.execute({ path: "main.tex", patch: Diff.createPatch("main.tex", before, after) }));
          } catch (error) {
            result = { error: error.message };
          }
          log.push(`  patch ${index + 1} ${result?.status ?? ""} ${(result?.error ?? "").slice(0, 60)}`);
          count(`patch ${result?.status === "applied" ? "applied" : "refused"}`);
          if (result?.status === "applied") {
            axiomFull = axiomFull !== null ? after : null;
            numberings.length = 0;
            numberings.push(await disk());
          } else received(result);
        }
      }
      if (refused) turnsWithRefusals += 1;
      const final = await disk();
      count(`saves kept ${userMarks.length > 0 ? "some" : "none"}`);
      for (const label of userMarks) {
        assert.ok(final.includes(label), `round ${round}: ${label} was lost\n${final}\n${log.join("\n")}`);
      }
    });
  }
  t.diagnostic(`refusals in ${turnsWithRefusals}/150 turns; ${JSON.stringify(outcomes)}`);
  for (const key of ["write applied", "write refused", "lines applied", "lines refused", "patch applied", "patch refused"]) {
    assert.ok(outcomes[key] > 0, `no "${key}" in ${JSON.stringify(outcomes)}`);
  }
});

test("property: first-save bases and refused text at the byte and delivery limits", async (t) => {
  const modelLimit = 2 * 1024 * 1024;
  const deliveryLimit = 20_000;
  for (const bytes of [modelLimit - 1, modelLimit, modelLimit + 1, modelLimit + 251]) {
    for (const chars of [260, deliveryLimit - 1, deliveryLimit, deliveryLimit + 1]) {
      await t.test(`${bytes} bytes before save, ${chars} characters after`, async (st) => {
        const f = await fixture(st);
        const name = "chapter.tex";
        const draft = doc(20);
        const original = draft + "語".repeat(Math.floor((bytes - draft.length) / 3))
          + "x".repeat((bytes - draft.length) % 3);
        const sentence = draft.replace("line 14 text", "writer saved new copy");
        const saved = sentence + "x".repeat(chars - sentence.length);
        await f.workspace.writeFile(name, original);
        f.inProcessTurn();
        const tools = f.tools();
        assert.equal((await f.save(name, saved, original)).ok, true);
        assert.equal((await f.save(name, saved.replace("new copy", "new text"), saved)).ok, true);
        const latest = saved.replace("new copy", "new text");
        await tools.read_file.execute({ path: name, startLine: 2, endLine: 3 });
        const proposal = draft.replace("line 3 text", "Axiom's revised line");
        const write = parsed(await tools.write_file.execute({ path: name, content: proposal }));
        assert.equal(write.conflict, true);
        assert.equal(await f.read(name), latest);
        if (bytes <= modelLimit) {
          assert.equal(baseOf(f, name), original);
          return;
        }
        assert.equal(write.currentContent, latest.slice(0, deliveryLimit));
        assert.equal(write.currentContentTruncated, chars > deliveryLimit);
        const replace = parsed(await tools.replace_lines.execute({
          path: name, startLine: 3, endLine: 3, content: "Axiom's revised line",
        }));
        assert.equal(replace.conflict, true);
        assert.equal(replace.currentContent, write.currentContent);
        const patch = parsed(await tools.apply_patch.execute({
          path: name, patch: Diff.createPatch(name, draft, proposal),
        }));
        assert.equal(patch.conflict, true);
        assert.equal(patch.currentContent, write.currentContent);
        const section = parsed(await tools.replace_section.execute({
          path: name, type: "section", title: "Unseen", content: "Axiom's revision",
        }));
        assert.equal(section.conflict, true);
        assert.equal(section.currentContent, write.currentContent);
        assert.equal(await f.read(name), latest);
        const read = parsed(await tools.read_file.execute({ path: name }));
        assert.equal(read.truncated, chars > deliveryLimit);
        const edit = parsed(await tools.replace_lines.execute({
          path: name, startLine: 3, endLine: 3, content: "Axiom's revised line",
        }));
        if (read.truncated) {
          assert.equal(edit.conflict, true);
          assert.equal(await f.read(name), latest);
        } else {
          assert.equal(edit.status, "applied", edit.error);
          assert.equal(await f.read(name), latest.replace("line 3 text", "Axiom's revised line"));
        }
      });
    }
  }
});

test("oversized delivered text, own writes and oversized numbering cannot replace the edit base", async (t) => {
  const f = await fixture(t);
  const large = "語".repeat(699_051);
  const small = doc();
  f.inProcessTurn();
  deliverFullText(f.agent, "chat", "full.tex", large);
  assert.match(editBaseOf(f.agent, "chat", "full.tex").error, /Read it again/);
  deliverPositions(f.agent, "chat", "full.tex", small);
  assert.match(editBaseOf(f.agent, "chat", "full.tex").error, /Read it again/);
  recordOwnWrite(f.agent, "chat", "own.tex", large, large, true);
  assert.match(editBaseOf(f.agent, "chat", "own.tex").error, /Read it again/);

  await f.workspace.writeFile("merged.tex", small);
  recordOwnWrite(f.agent, "chat", "merged.tex", small, large, true);
  const tools = f.tools();
  const replace = parsed(await tools.replace_lines.execute({
    path: "merged.tex", startLine: 3, endLine: 3, content: "three",
  }));
  assert.match(replace.error, /read it again in full/);
  assert.equal(baseOf(f, "merged.tex"), small, "the oversized numbering is independent of the retained base");
  assert.equal(await f.read("merged.tex"), small);
});

test("a truncated read without a full base cannot authorize a whole-file replacement", async (t) => {
  const f = await fixture(t);
  const name = "chapter.tex";
  const original = doc(20) + "x".repeat(20_000);
  await f.workspace.writeFile(name, original);
  f.inProcessTurn();
  const tools = f.tools();
  const read = parsed(await tools.read_file.execute({ path: name }));
  assert.equal(read.truncated, true);
  const write = parsed(await tools.write_file.execute({
    path: name, content: read.content.replace("line 3 text", "three"), allowFullRewrite: true,
  }));
  assert.equal(write.conflict, true);
  assert.equal(await f.read(name), original);
});

test("ordinary autosaves in paragraph A allow fresh edits of paragraph B", async (t) => {
  const f = await fixture(t);
  const name = "main.tex";
  const edits = ["replace_section", "replace_lines", "apply_patch"];
  const outcomes = Object.fromEntries(edits.map((tool) => [tool, { refused: 0, total: 0 }]));
  let disk = "\\documentclass{article}\n\\begin{document}\n\\section{A}\nFirst paragraph.\n\n"
    + "\\section{B}\nSecond paragraph.\n\\end{document}\n";
  await f.workspace.writeFile(name, disk);
  f.inProcessTurn();
  const tools = f.tools();
  let turnsWithRefusals = 0;
  for (let round = 1; round <= 6; round += 1) {
    for (const tool of edits) {
      const typed = disk.replace("First paragraph.", `First paragraph. Sentence ${round} (${tool}).\nContinued.`);
      assert.equal((await f.save(name, typed, disk)).ok, true);
      const read = parsed(await tools.read_file.execute({ path: name }));
      assert.equal(read.truncated, false);
      assert.equal(read.content, typed);
      const before = read.content.split("\n").find((line) => line.startsWith("Second paragraph."));
      const replacement = `Second paragraph. Revision ${round} (${tool}).`;
      const after = read.content.replace(before, replacement);
      const args = tool === "replace_section" ? { type: "section", title: "B", content: replacement }
        : tool === "replace_lines" ? {
          startLine: read.content.split("\n").indexOf(before) + 1,
          endLine: read.content.split("\n").indexOf(before) + 1, content: replacement,
        } : { patch: Diff.createPatch(name, read.content, after, "", "", { context: 1 }) };
      let result;
      try {
        result = parsed(await tools[tool].execute({ path: name, ...args }));
      } catch (error) {
        result = { error: error.message };
      }
      outcomes[tool].total += 1;
      if (result.status !== "applied") {
        outcomes[tool].refused += 1;
        turnsWithRefusals = 1;
      }
      disk = await f.read(name);
      assert.equal(disk, result.status === "applied" ? typed.replace(before, replacement) : typed);
    }
  }
  t.diagnostic(`refusals in ${turnsWithRefusals}/1 turn; ${JSON.stringify(outcomes)}`);
  assert.equal(turnsWithRefusals, 0);
});

test("a dot-relative spelling cannot bypass an unavailable base", async (t) => {
  const f = await fixture(t);
  const name = "chapter.tex";
  const original = doc() + "x".repeat(2 * 1024 * 1024);
  const saved = doc().replace("line 3 text", "writer saved new copy");
  await f.workspace.writeFile(name, original);
  f.inProcessTurn();
  assert.equal((await f.save(name, saved, original)).ok, true);
  const write = parsed(await f.tools().write_file.execute({ path: "./chapter.tex", content: doc() }));
  assert.equal(write.conflict, true);
  assert.equal(write.currentContent, saved);
  assert.equal(await f.read(name), saved);
});

test("a save queued after proposal preparation still invalidates an unavailable base", async (t) => {
  const f = await fixture(t);
  const name = "chapter.tex";
  const original = doc() + "x".repeat(2 * 1024 * 1024);
  const saved = doc().replace("line 3 text", "writer saved new copy") + "x".repeat(20_000);
  await f.workspace.writeFile(name, original);
  f.inProcessTurn();
  const apply = f.agent.applyProposal.bind(f.agent);
  f.agent.applyProposal = async (...args) => {
    assert.equal((await f.save(name, saved, original)).ok, true);
    return apply(...args);
  };
  const write = parsed(await f.tools().write_file.execute({ path: name, content: doc(), allowFullRewrite: true }));
  assert.equal(write.conflict, true);
  assert.match(write.error, /edit base is unavailable/);
  assert.equal(write.currentContent, saved.slice(0, 20_000));
  assert.equal(write.currentContentTruncated, true);
  assert.equal(write.apply.currentContent, write.currentContent);
  assert.equal(await f.read(name), saved);
});

test("a content edit cannot reset overflowed positional history", async (t) => {
  const f = await fixture(t);
  const name = "main.tex";
  const original = "\\documentclass{article}\n\\begin{document}\n\\section{A}\nalpha\n\\section{B}\nbeta\n\\end{document}\n";
  await f.workspace.writeFile(name, original);
  f.inProcessTurn();
  const tools = f.tools();
  await tools.read_file.execute({ path: name });
  let disk = original;
  for (let i = 1; i <= 6; i += 1) {
    const next = "\n" + disk;
    assert.equal((await f.save(name, next, disk)).ok, true);
    disk = next;
    await tools.read_file.execute({ path: name, startLine: 1, endLine: 3 });
  }
  const section = parsed(await tools.replace_section.execute({ path: name, type: "section", title: "A", content: "ALPHA" }));
  assert.equal(section.status, "applied", section.error);
  const replace = { path: name, startLine: 3, endLine: 3, content: "UNSAFE" };
  const line = parsed(await tools.replace_lines.execute(replace));
  assert.match(line.error, /read it again in full/);
  assert.equal(await f.read(name), disk.replace("alpha", "ALPHA"));
  const read = parsed(await tools.read_file.execute({ path: name }));
  const betaLine = read.content.split("\n").indexOf("beta") + 1;
  const resolved = parsed(await tools.replace_lines.execute({
    path: name, startLine: betaLine, endLine: betaLine, content: "BETA",
  }));
  assert.equal(resolved.status, "applied", resolved.error);
  assert.equal(await f.read(name), disk.replace("alpha", "ALPHA").replace("beta", "BETA"));
});

test("a temporary disk-read failure cannot send a line edit through a truncated snapshot", async (t) => {
  const f = await fixture(t);
  const name = "chapter.tex";
  const original = doc(1000);
  await f.workspace.writeFile(name, original);
  f.inProcessTurn();
  f.agent.contextByConversation.set("chat", {
    activeFilePath: name,
    activeFileContent: original.slice(0, 10_000),
    activeFileContentTruncated: true,
    activeFileContentLength: original.length,
  });
  const readFile = fsp.readFile;
  let failed = false;
  fsp.readFile = async (file, ...args) => {
    if (!failed && file === path.join(f.root, name)) {
      failed = true;
      throw Object.assign(new Error("temporary read failure"), { code: "EIO" });
    }
    return readFile(file, ...args);
  };
  try {
    const edit = parsed(await f.tools().replace_lines.execute({
      path: name, startLine: 3, endLine: 3, content: "three", allowFullRewrite: true,
    }));
    assert.equal(edit.conflict, true);
    assert.equal(edit.currentContent, original);
    assert.equal(await f.read(name), original);
  } finally {
    fsp.readFile = readFile;
  }
});

for (const [kind, name, alias] of [
  ["case", "chapter.tex", "Chapter.tex"],
  ["symlink", "chapter.tex", "link.tex"],
  ["dot segments", "chapter.tex", "a/../chapter.tex"],
  ["trailing separator", "chapter.tex", "chapter.tex/"],
  ["Japanese normalization", "が.tex", "が.tex".normalize("NFD")],
]) {
  test(`file aliases share the Axiom edit base and keep the author's save (${kind})`, async (t) => {
    const f = await fixture(t);
    const draft = doc(20);
    await f.workspace.writeFile(name, draft);
    if (kind === "symlink") await fsp.symlink(name, path.join(f.root, alias));
    if (kind === "dot segments") await fsp.mkdir(path.join(f.root, "a"));
    if (!fs.existsSync(f.workspace.resolvePath(alias))) {
      t.skip(`This volume distinguishes the ${kind} spellings.`);
      return;
    }
    f.inProcessTurn();
    const saved = draft.replace("line 14 text", "writer saved new copy");
    assert.equal((await f.save(name, saved, draft)).ok, true);
    await f.tools().read_file.execute({ path: name, startLine: 2, endLine: 3 });
    const edited = draft.replace("line 3 text", "Axiom revised line three");
    const blind = await handleProposeWrite(f.agent, { path: alias, content: edited }, f.policy, "chat");
    assert.notEqual(blind.status, "applied");
    assert.equal(await f.read(name), saved);

    await f.readAll(name);
    const savedAgain = saved.replace("writer saved new copy", "writer saved again");
    assert.equal((await f.save(name, savedAgain, saved)).ok, true);
    const rebased = await handleProposeWrite(f.agent, {
      path: alias, content: saved.replace("line 3 text", "Axiom revised line three"),
    }, f.policy, "chat");
    assert.equal(rebased.status, "applied", JSON.stringify(rebased));
    assert.equal(await f.read(name), savedAgain.replace("line 3 text", "Axiom revised line three"));
    if (kind === "symlink") assert.equal((await fsp.lstat(path.join(f.root, alias))).isSymbolicLink(), true);
  });
}

test("queued editor saves through a symlink and its target perform one CAS at a time", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("chapter.tex", "draft");
  await fsp.symlink("chapter.tex", path.join(f.root, "link.tex"));
  const replies = await Promise.all([
    f.save("chapter.tex", "first save", "draft"),
    f.save("link.tex", "second save", "draft"),
  ]);
  assert.deepEqual(replies.map(({ ok }) => ok).sort(), [false, true]);
  assert.equal(await f.read("chapter.tex"), await f.read("link.tex"));
});

test("the queue canonicalizes an existing parent for a new file", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.root, "chapters"));
  await fsp.symlink("chapters", path.join(f.root, "alias"), "dir");
  const order = [];
  const first = f.workspace.withFileMutation("chapters/new.tex", () => order.push("first"));
  const second = f.workspace.withFileMutation("alias/new.tex", () => order.push("second"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("a multi-edit patch groups aliases before computing any replacements", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("chapter.tex", doc());
  await fsp.symlink("chapter.tex", path.join(f.root, "alias.tex"));
  f.inProcessTurn();
  const result = await handleProposePatch(f.agent, {
    edits: [
      { path: "chapter.tex", search: "line 1 text", replace: "first replacement" },
      { path: "alias.tex", search: "first replacement", replace: "final replacement" },
    ],
  }, f.policy, "chat");
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(await f.read("chapter.tex"), doc().replace("line 1 text", "final replacement"));
});

test("a repeated full read recognizes another spelling of the same file", async (t) => {
  const f = await fixture(t);
  await f.workspace.writeFile("chapter.tex", doc());
  await fsp.symlink("chapter.tex", path.join(f.root, "alias.tex"));
  f.inProcessTurn();
  const tools = f.tools();
  assert.equal(parsed(await tools.read_file.execute({ path: "chapter.tex" })).content, doc());
  assert.match(parsed(await tools.read_file.execute({ path: "alias.tex" })).error, /already read in full/);
});

test("an alternate folder spelling cannot bypass an active writer or renderer-save lease", async (t) => {
  const f = await fixture(t);
  await fsp.symlink(".", path.join(f.root, "alias"), "dir");
  const alternativeRoot = path.join(f.root, "alias");
  f.inProcessTurn();
  assert.equal(f.agent.activeWriter(alternativeRoot), "in-process");
  f.agent.reportContentConflict("chat", "chapter.tex");
  assert.equal(f.agent.hasContentConflictInWorkspace(alternativeRoot), true);
  const coordinator = new WorkspaceWriterCoordinator();
  const release = coordinator.beginRendererMutation(f.root, "save");
  try {
    assert.ok(coordinator.hasRendererMutation(alternativeRoot));
  } finally {
    release();
  }
});

test("a queued write cannot follow a symlink that moved to a different file while it waited", async (t) => {
  const f = await fixture(t);
  for (const name of ["chapter.tex", "other.tex"]) await f.workspace.writeFile(name, "draft");
  await fsp.symlink("chapter.tex", path.join(f.root, "alias.tex"));
  let resume;
  let entered;
  const acquired = new Promise((resolve) => { entered = resolve; });
  const blocker = f.workspace.withFileMutation("chapter.tex", () => new Promise((done) => {
    resume = done;
    entered();
  }));
  await acquired;
  const queued = f.workspace.withFileMutation("alias.tex", () => f.workspace.writeFile("alias.tex", "stale write"));
  const rejected = assert.rejects(queued, { message: WorkspaceError.invalidPath });
  await fsp.symlink("other.tex", path.join(f.root, "next.tex"));
  await fsp.rename(path.join(f.root, "next.tex"), path.join(f.root, "alias.tex"));
  resume();
  await blocker;
  await rejected;
  assert.equal(await f.read("chapter.tex"), "draft");
  assert.equal(await f.read("other.tex"), "draft");
});

test("a write through a symlink still honors Axiom's protected directories", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.root, ".tex64"));
  await f.workspace.writeFile(".tex64/state.tex", doc());
  await fsp.symlink(".tex64/state.tex", path.join(f.root, "alias.tex"));
  const result = await handleProposeWrite(f.agent, {
    path: "alias.tex", content: doc().replace("line 3 text", "replacement"),
  }, f.policy, "chat");
  assert.notEqual(result.status, "applied");
  assert.equal(await f.read(".tex64/state.tex"), doc());
  assert.equal((await fsp.lstat(path.join(f.root, "alias.tex"))).isSymbolicLink(), true);
});

test("a diagnostic through an unread alias invalidates old line numbers for the same file", async (t) => {
  const f = await fixture(t);
  const draft = doc();
  await f.workspace.writeFile("chapter.tex", draft);
  await fsp.symlink("chapter.tex", path.join(f.root, "alias.tex"));
  f.inProcessTurn();
  await f.readAll("chapter.tex");
  const saved = "new first line\n" + draft;
  assert.equal((await f.save("chapter.tex", saved, draft)).ok, true);
  await recordMentionedPositions(f.agent, "chat", {}, { issues: [{ path: "alias.tex", line: 2 }] });
  const result = await handleReplaceLines(f.agent, {
    path: "chapter.tex", startLine: 2, endLine: 2, content: "Axiom line replacement",
  }, f.policy, "chat");
  assert.notEqual(result.status, "applied");
  assert.equal(await f.read("chapter.tex"), saved);
});
