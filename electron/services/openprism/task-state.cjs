"use strict";

const clip = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const readTask = (service, id) => {
  try {
    const value = JSON.parse(service.scratchpadByConversation?.get(id) || "{}");
    return value.version === 1 && Array.isArray(value.steps) ? value : null;
  } catch { return null; }
};
const saveTask = (service, id, task) => {
  service.scratchpadByConversation.set(id, JSON.stringify(task));
  service.markSessionDirty(id);
  return task;
};
const beginTaskTurn = (service, id, request, steering = false) => {
  const previous = readTask(service, id);
  const finished = previous?.status === "complete" || previous?.status === "cancelled";
  return saveTask(service, id, {
    version: 1, goal: (!finished && previous?.goal) || clip(request, 4000),
    turn: steering ? previous?.turn || 1 : (previous?.turn || 0) + 1,
    request: clip(request, 4000), artifact: finished && !steering ? null : previous?.artifact || null, constraints: previous?.constraints || [],
    steps: finished && !steering ? [] : previous?.steps || [], receipts: previous?.receipts || [],
    status: "working", updatedAt: Date.now(),
  });
};
const recordUndo = (service, id, result) => {
  const task = readTask(service, id);
  if (!task) return;
  // Undo changes the source outside the model loop. Its previous PDF proof and
  // suggested follow-ups must not describe the restored document as completed.
  saveTask(service, id, { ...task, status: "cancelled", artifact: null, steps: [], proposals: [],
    receipts: [...(task.receipts || []), { tool: "undo", turn: task.turn, ok: result.ok === true,
      runId: result.runId || null, paths: result.paths || [result.path].filter(Boolean), at: Date.now() }].slice(-30), updatedAt: Date.now(),
  });
};
const updateTask = (service, id, args = {}) => {
  const current = readTask(service, id);
  if (!current) return { error: "No active task." };
  const steps = Array.isArray(args.steps) ? args.steps.filter((step) => step && typeof step === "object").slice(0, 20).map((step, index) => ({
    id: clip(step.id, 60) || `s${index + 1}`, title: clip(step.title, 300),
    status: ["pending", "working", "done", "blocked"].includes(step.status) ? step.status : "pending",
    evidence: clip(step.evidence, 800),
  })).filter((step) => step.title) : current.steps;
  if (steps.some((step) => step.status === "done" && !step.evidence)) {
    return { error: "A completed step needs concrete evidence from a tool result; otherwise keep it pending." };
  }
  const status = ["working", "blocked", "complete"].includes(args.status) ? args.status : "working";
  if (status === "complete" && (!steps.length || steps.some((step) => step.status !== "done"))) {
    return { error: "Finish every requested step before marking the task complete. Optional future work belongs in proposals." };
  }
  if (status === "complete") {
    const gaps = verificationGaps(current);
    if (gaps.length) return { error: gaps.join(" ") };
  }
  return saveTask(service, id, { ...current, goal: clip(args.goal, 4000) || current.goal,
    constraints: Array.isArray(args.constraints) ? args.constraints.map((v) => clip(v, 500)).filter(Boolean).slice(0, 30) : current.constraints,
    steps, status, updatedTurn: current.turn, updatedAt: Date.now(),
  });
};
const recordReceipt = (service, id, name, args, result, isWrite = false) => {
  const task = readTask(service, id);
  if (!task) return;
  const safe = result && typeof result === "object" ? { ...result } : { result };
  delete safe.images;
  delete safe.content;
  const ok = !safe.error && safe.status !== "failure" && safe.status !== "cancelled";
  const applied = isWrite && (safe.writeApplied === true || safe.status === "applied" ||
    safe.status === "partially_applied" && safe.files?.some((file) => file.ok === true));
  let artifact = task.artifact;
  if (applied) {
    const ids = [safe.proposalId, ...(safe.proposalIds || [])].filter(Boolean);
    const changes = (service.proposalScopesByConversation?.get(id) || []).filter((scope) => ids.includes(scope.proposalId));
    let earlier = artifact?.changes || [];
    for (const change of changes) {
      if (!Number.isInteger(change.lineDelta) || !Number.isInteger(change.previousEndLine)) continue;
      const relocate = (line, end = false) => line < change.line ? line : line > change.previousEndLine
        ? Math.max(1, line + change.lineDelta) : end ? change.endLine : change.line;
      earlier = earlier.map((entry) => entry.path !== change.path ? entry : {
        ...entry, line: relocate(entry.line), endLine: relocate(entry.endLine || entry.line, true),
      });
    }
    artifact = { revision: (artifact?.revision || 0) + 1, changes: [...earlier, ...changes] };
  }
  if (name === "compile_document" && safe.status === "success") artifact = {
    ...artifact, revision: artifact?.revision || 0, compiled: artifact?.revision || 0, pdfPath: safe.pdfPath,
    requiredPages: safe.affectedPages || [], observedPages: [], inspected: undefined,
  };
  if (name === "inspect_pdf" && ok && safe.pdfVersion && safe.compiledPdf && safe.compiledPdf === artifact?.pdfPath) {
    artifact = { ...artifact, rendered: artifact.compiled, pages: safe.pages, pdfVersion: safe.pdfVersion };
  }
  const receipt = { tool: name, turn: task.turn, ok: name === "compile_document" ? safe.status === "success" : ok, applied, pdfPath: name === "compile_document" ? safe.pdfPath : safe.compiledPdf, path: clip(args?.path || args?.mainFile, 1000),
    result: JSON.stringify(safe).slice(0, 1800), at: Date.now() };
  saveTask(service, id, { ...task, artifact, ...(applied ? { status: "working" } : {}), receipts: [...task.receipts, receipt].slice(-30), updatedAt: Date.now() });
};
// Successful tools must observe the latest edit, never an older PDF.
const verificationGaps = (task) => {
  const artifact = task?.artifact;
  if (!artifact?.revision) return [];
  if (artifact.compiled !== artifact.revision) return ["Compile the latest changes successfully."];
  const missing = (artifact.requiredPages || []).filter((page) => !(artifact.observedPages || []).includes(page));
  if (missing.length) return [`Inspect changed PDF pages ${missing.join(", ")} before marking the work complete.`];
  return artifact.inspected === artifact.revision ? [] : ["Inspect the affected pages of the latest compiled PDF and record the observed result."];
};
const markPdfObserved = (service, id, observation) => {
  const task = readTask(service, id);
  const artifact = task?.artifact;
  if (artifact && observation && artifact.revision === observation.revision && artifact.pdfVersion === observation.pdfVersion) {
    saveTask(service, id, { ...task, artifact: { ...artifact, inspected: artifact.rendered,
      observedPages: [...new Set([...(artifact.observedPages || []), ...(observation.pages || [])])] } });
  }
};
const mergePdfObservation = (pending, current) => {
  if (!current) return null;
  const same = pending?.revision === current.revision && pending?.pdfVersion === current.pdfVersion;
  return { ...current, pages: [...new Set([...(same ? pending.pages || [] : []), ...(current.pages || [])])] };
};
const completedEditReceipt = (task, locale) => {
  if (task?.status !== "complete" || !task.steps?.length || task.steps.some((step) => step.status !== "done") || verificationGaps(task).length) return null;
  if (!task.receipts?.some((receipt) => receipt.turn === task.turn && receipt.applied)) return null;
  const lead = locale === "en"
    ? "The changes were saved, compiled and the PDF was checked. The final response could not be received; completed work has been preserved."
    : "変更の保存・組版・PDF確認まで完了しました。最後の返答を受信できませんでしたが、作業結果は保存されています。";
  return `${lead}\n\n${task.steps.map((step) => `${step.title}: ${step.evidence}`).join("\n")}`;
};
module.exports = { recordUndo, mergePdfObservation, completedEditReceipt, markPdfObserved, readTask, saveTask, beginTaskTurn, updateTask, recordReceipt, verificationGaps };
