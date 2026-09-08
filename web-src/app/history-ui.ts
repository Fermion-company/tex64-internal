import { historyDateLabels, historyVersionTitle } from "./history-format.js";
import { createActionsMenu } from "./actions-menu.js";
import { getEditorOperationGuard } from "./editor-operation-guard.js";
import { uiText } from "./i18n.js";
import type { DiffModalApi } from "./diff-modal.js";
import type { EditorSessionApi } from "./editor-session.js";

type Version = { id: string; kind: string; label: string; labelRevision: number; createdAt: string; preRestore?: string; restoredFrom?: string; summary: { added: number; changed: number; deleted: number } };
type Change = { path: string; kind: string; originalSize?: number; modifiedSize?: number };
type HistoryBridge = { call: (action: string, payload?: Record<string, unknown>) => Promise<any>; onChange: (listener: (message: any) => void) => () => void };

export const initHistoryUi = (editor: EditorSessionApi, diff: DiffModalApi) => {
  const bridge = (window as unknown as { tex64History?: HistoryBridge }).tex64History;
  const host = document.getElementById("history-panel");
  if (!host || !bridge) return;
  let versions: Version[] = [];
  let selected = "";
  let workspace = "";
  let phase = "idle";
  let busy = false;
  let poll = 0;
  let refreshGeneration = 0;
  let comparisonGeneration = 0;
  let comparisonTimer = 0;
  const operationGuard = getEditorOperationGuard(editor);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (label: string, handler: () => void) => {
    const node = el("button", "history-button", label); node.type = "button"; node.addEventListener("click", handler); return node;
  };
  const error = el("div", "history-error"); error.setAttribute("role", "status");
  const heading = el("div", "history-heading");
  const reload = button(uiText("Refresh history", "履歴を再読み込み"), () => void refresh());
  const name = el("input", "history-name"); name.placeholder = uiText("Version name (optional)", "版名（任意）"); name.setAttribute("aria-label", name.placeholder); name.maxLength = 120; name.hidden = true;
  const record = button(uiText("Record version", "版を記録"), () => void perform("record"));
  record.classList.add("is-primary");
  const list = el("div", "history-list"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", uiText("Versions", "記録した版"));
  const selection = el("div", "history-selection");
  const pinned = el("div", "history-pinned"); pinned.hidden = true;
  const compareTo = el("select", "history-name"); compareTo.setAttribute("aria-label", uiText("Compare from", "比較元"));
  const restore = button(uiText("Restore this version…", "この版に復元…"), () => void prepareRestore(selected));
  const undo = button(uiText("Return to before this restore…", "この復元の直前に戻す…"), () => { const version = versions.find((v) => v.id === selected); if (version?.preRestore) void prepareRestore(version.preRestore); });
  const rename = button(uiText("Rename version…", "版の名前を変更…"), () => {
    const version = versions.find((v) => v.id === selected); if (!version) return;
    name.hidden = false; name.value = version.label; name.focus();
    renameSave.hidden = false;
  });
  const renameSave = button(uiText("Save name", "版名を保存"), () => void run(async () => {
    const version = versions.find((v) => v.id === selected); if (!version) return;
    await call("label", { id: selected, label: name.value, revision: version.labelRevision });
    renameSave.hidden = true; name.hidden = true; name.value = ""; await refresh();
  })); renameSave.hidden = true;
  const details = button(uiText("Version details…", "版の詳細…"), () => void run(showDetails));
  const settings = button(uiText("Storage settings…", "保存設定…"), () => showStorage());
  heading.append(el("h2", "", uiText("History", "履歴")), record, createActionsMenu([rename, reload, details, settings, undo]));
  const compareRow = el("label", "history-compare-row"); compareRow.append(el("span", "", uiText("Compare from", "比較元")), compareTo);
  compareTo.addEventListener("change", scheduleComparison);
  const comparison = el("div", "history-comparison"); comparison.setAttribute("aria-live", "polite");
  selection.append(compareRow, comparison, restore);
  const storage = el("div", "history-storage"); const usage = el("p");
  const limit = el("input", "history-limit"); limit.type = "number"; limit.min = "1"; limit.max = "100"; limit.value = "2"; limit.setAttribute("aria-label", uiText("History limit in GiB", "履歴の容量上限 GiB"));
  storage.append(usage, el("p", "", uiText("Stored on this computer. Not a cloud backup.", "このPCに保存。クラウドバックアップではありません。")),
    el("p", "", uiText("Private files, Git settings and build logs are excluded. Source files and input images are kept. Files over 128 MiB stop recording; nothing is silently omitted.", "秘密情報・Git設定・組版ログは対象外です。ソースと入力画像は記録します。128 MiBを超えるファイルがあれば記録を中止し、黙って除外しません。")), limit,
    button(uiText("Set limit (GiB)", "上限を変更（GiB）"), () => void run(async () => { await call("limit", { gib: Number(limit.value) }); await refresh(); })));
  function showDialog(title: string, content: HTMLElement) {
    const modal = el("dialog", "history-confirm");
    const heading = el("h2", "", title); heading.id = "history-detail-title"; modal.setAttribute("aria-labelledby", heading.id);
    modal.append(heading, content, button(uiText("Close", "閉じる"), () => modal.close()));
    modal.addEventListener("close", () => modal.remove()); document.body.append(modal); modal.showModal();
  }
  function showStorage() { showDialog(uiText("Storage settings", "保存設定"), storage); }
  async function showDetails() {
    const version = versions.find((v) => v.id === selected); if (!version) return;
    const { excluded: excludedFiles } = await call("inspect", { id: version.id });
    const content = el("div", "history-version-details");
    const identity = (item: Version) => `${versionTitle(item)} · ${historyDateLabels(versions).get(item.id)?.exact || item.createdAt}`;
    const title = el("p", "history-full-name", identity(version)); title.dataset.noI18n = "true"; content.append(title);
    content.append(el("p", "history-date", `ID: ${version.id}`));
    const target = versions.find((v) => v.id === version.restoredFrom);
    if (target) content.append(el("p", "", `${uiText("Restore target", "復元先")}：${identity(target)}`));
    const safety = versions.find((v) => v.id === version.preRestore);
    if (safety) content.append(el("p", "", `${uiText("Before this restore", "この復元の直前")}：${identity(safety)}`));
    content.append(el("p", "", uiText("Changes recorded since the preceding version", "直前の記録からの変更")), el("p", "", changeCounts(version.summary)));
    if (excludedFiles.length) {
      const excluded = el("details"); excluded.append(el("summary", "", uiText(`${excludedFiles.length} excluded`, `対象外 ${excludedFiles.length}件`)));
      for (const file of excludedFiles) excluded.append(el("div", "history-excluded", `${file.path} · ${file.reason}`));
      content.append(excluded);
    }
    showDialog(uiText("Version details", "版の詳細"), content);
  }
  function changeCounts(counts: { added: number; changed: number; deleted: number }) {
    return [counts.changed ? `${uiText("Changed", "変更")} ${counts.changed}` : "", counts.added ? `${uiText("Added", "追加")} ${counts.added}` : "", counts.deleted ? `${uiText("Deleted", "削除")} ${counts.deleted}` : ""].filter(Boolean).join(" · ") || uiText("No recorded changes", "記録対象に変更なし");
  }
  function updatePinned() {
    const row = Array.from(list.children).find((child) => child.getAttribute("aria-selected") === "true") as HTMLElement | undefined;
    const version = versions.find((v) => v.id === selected);
    if (!row || !version) { pinned.hidden = true; return; }
    const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect();
    pinned.hidden = item.top >= bounds.top && item.bottom <= bounds.bottom;
    pinned.textContent = `${versionTitle(version)} · ${historyDateLabels(visibleVersions()).get(version.id)?.compact || ""}`;
    pinned.title = pinned.textContent;
  }
  list.addEventListener("scroll", updatePinned);
  new ResizeObserver(updatePinned).observe(list);
  const recovery = button(uiText("Retry recovery", "復旧を再試行"), () => void run(async () => {
    const value = await call(phase === "syncing" ? "sync" : "recover", { buffers: editor.getHistoryBuffers() });
    editor.applyHistoryFiles(value.files);
    await call("ack", { buffers: editor.getHistoryBuffers() });
    phase = "idle"; freeze(false); await refresh();
  })); recovery.hidden = true;
  host.append(heading, name, renameSave, error, recovery, list, pinned, selection);

  const call = async (action: string, payload: Record<string, unknown> = {}) => {
    const result = await bridge.call(action, payload);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    return result;
  };
  const freeze = (locked: boolean) => {
    operationGuard.setLocked("history-ui", locked);
  };
  const versionTitle = (version: Version): string => historyVersionTitle(version, versions, {
    unnamed: uiText("Unnamed version", "名前なし"), beforeRestore: uiText("Work before this restore", "この復元の直前の作業"),
    interruptedRestore: uiText("Work before interrupted restore", "中断した復元の直前の作業"), returned: uiText("Returned to pre-restore state", "復元前の作業に戻した"),
    restored: (label) => `${uiText("Restored", "復元")}：${label}`,
  });
  const visibleVersions = () => versions.filter((v) => v.kind !== "safety" || !versions.some((item) => item.preRestore === v.id));
  list.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = visibleVersions(); if (!items.length) return;
    event.preventDefault();
    const index = Math.max(0, items.findIndex((version) => version.id === selected));
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    selected = items[next].id; name.hidden = true; renameSave.hidden = true; render(); scheduleComparison();
    (Array.from(list.children).find((row) => row.getAttribute("aria-selected") === "true") as HTMLElement)?.focus();
  });
  const updateCurrent = () => {
    const dirty = editor.getDirtyPaths().size;
    record.textContent = dirty ? uiText("Save & record version", "保存して版を記録") : uiText("Record version", "版を記録");
  };
  const render = () => {
    updateCurrent();
    record.disabled = busy || phase !== "idle" || !workspace;
    name.disabled = busy || phase !== "idle";
    const focusedId = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.versionId : null;
    const scrollTop = list.scrollTop;
    const dates = historyDateLabels(visibleVersions());
    list.replaceChildren();
    let dateGroup = "";
    for (const version of visibleVersions()) {
      const date = dates.get(version.id)!;
      const group = date.today ? uiText("Today", "今日") : date.group;
      if (dateGroup !== group) { const heading = el("div", "history-day", group); heading.setAttribute("role", "presentation"); list.append(heading); dateGroup = group; }
      const row = button("", () => { selected = version.id; name.hidden = true; renameSave.hidden = true; render(); scheduleComparison(); });
      row.className = "history-version"; row.dataset.versionId = version.id;
      row.tabIndex = selected === version.id ? 0 : -1;
      row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(selected === version.id));
      const title = el("span", "history-version-name", versionTitle(version)); title.dataset.noI18n = "true";
      row.title = `${versionTitle(version)} · ${date.exact}`;
      row.append(title, el("span", "history-date", date.time));
      list.append(row);
    }
    if (!versions.some((v) => v.kind !== "safety")) list.append(el("p", "history-empty", uiText("Record a version at a milestone.", "節目の状態を版として記録できます。")));
    list.scrollTop = scrollTop;
    if (focusedId) (Array.from(list.children).find((row) => (row as HTMLElement).dataset.versionId === focusedId) as HTMLElement)?.focus({ preventScroll: true });
    window.requestAnimationFrame(updatePinned);
    const target = compareTo.value;
    compareTo.replaceChildren(new Option(uiText("Current work", "現在の作業"), ""));
    for (const version of versions.filter((v) => v.kind !== "safety" && v.id !== selected)) compareTo.add(new Option(`${versionTitle(version)} · ${dates.get(version.id)?.compact || ""}`, version.id));
    compareTo.value = versions.some((v) => v.id === target && v.id !== selected) ? target : "";
    selection.hidden = !selected;
    for (const control of [restore, undo, rename, reload, details, settings, compareTo]) control.disabled = busy || phase !== "idle";
    rename.disabled ||= !selected; details.disabled ||= !selected;
    const selectedVersion = versions.find((v) => v.id === selected);
    undo.hidden = !selectedVersion?.preRestore;
    recovery.hidden = !["recovery-required", "syncing"].includes(phase);
    recovery.textContent = phase === "syncing" ? uiText("Retry editor synchronization", "画面の同期を再試行") : uiText("Retry recovery", "復旧を再試行");
  };
  async function refresh() {
    if (!workspace) { render(); return; }
    const generation = ++refreshGeneration;
    try {
      const data = await call("list");
      if (generation !== refreshGeneration) return;
      versions = data.versions;
      phase = data.phase;
      if (!versions.some((v) => v.id === selected)) selected = versions.find((v) => v.kind !== "safety")?.id || "";
      usage.textContent = uiText("Storage", "保存容量") + ` ${(data.bytes / 1024 ** 2).toFixed(1)} MiB / ${(data.maxBytes / 1024 ** 3).toFixed(0)} GiB`;
      if (document.activeElement !== limit) limit.value = String(data.maxBytes / 1024 ** 3);
      if (data.error) error.textContent = data.error;
      render(); scheduleComparison();
    } catch (reason) { error.textContent = String(reason instanceof Error ? reason.message : reason); }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; invalidateComparison(); error.textContent = ""; render();
    try { await action(); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; render(); scheduleComparison(); }
  }
  async function withSaved(purpose: string, action: () => Promise<any>) {
    if (editor.isAnyGroupComposing()) throw new Error(uiText("Finish text conversion before using history.", "文字の変換を確定してから履歴を操作してください。"));
    freeze(true);
    let started = false;
    try {
      await call("begin", { purpose }); started = true;
      if (!await editor.saveDirtyFiles()) throw new Error(uiText("Resolve the save conflict before continuing.", "保存の競合を解消してから続けてください。"));
      return await action();
    } finally {
      if (started) {
        const state = await call("status"); phase = state.phase;
        if (phase === "saving") { await call("release"); phase = "idle"; }
      }
      freeze(phase !== "idle");
    }
  }
  async function perform(action: string) {
    await run(async () => {
      const result = await withSaved("record", () => call(action, { label: "" }));
      selected = result.record.id; name.value = ""; name.hidden = true; renameSave.hidden = true; await refresh();
    });
  }
  function invalidateComparison() {
    comparisonGeneration++; window.clearTimeout(comparisonTimer); comparison.replaceChildren();
  }
  function scheduleComparison() {
    invalidateComparison();
    if (!selected || phase !== "idle" || busy) return;
    comparisonTimer = window.setTimeout(() => void compareVersions(), 150);
  }
  async function compareVersions() {
    if (!selected || phase !== "idle" || busy) return;
    const generation = comparisonGeneration;
    comparison.replaceChildren(el("p", "", uiText("Comparing…", "比較中…")));
    try {
      const data = await call("compare", { left: selected, right: compareTo.value || null, direction: "to-selected", buffers: editor.getHistoryBuffers() });
      if (generation !== comparisonGeneration) return;
      const comparisonLabel = (id: string) => {
        const version = versions.find((item) => item.id === id);
        return version ? `${versionTitle(version)} · ${historyDateLabels(visibleVersions()).get(version.id)?.compact || ""}` : uiText("Current work", "現在の作業");
      };
      const comparisonTitle = `${comparisonLabel(compareTo.value)} → ${comparisonLabel(selected)}`;
      comparison.replaceChildren();
      const counts = { added: 0, changed: 0, deleted: 0 };
      for (const file of data.changes as Change[]) counts[file.kind as keyof typeof counts]++;
      comparison.append(el("p", "history-change-counts", changeCounts(counts)));
      for (const file of data.changes as Change[]) {
        const label = file.kind === "added" ? uiText("Added", "追加") : file.kind === "deleted" ? uiText("Deleted", "削除") : uiText("Changed", "変更");
        comparison.append(button(`${label} · ${file.path}`, () => void run(async () => {
          const generation = comparisonGeneration;
          const value = await call("diff", { comparisonId: data.comparisonId, path: file.path });
          if (generation !== comparisonGeneration) return;
          if (value.text) diff.showDiffModal(value.original, value.modified, 0, { title: comparisonTitle, fileName: file.path, viewOnly: true, closeLabel: uiText("Close", "閉じる") });
          else if (value.originalImage || value.modifiedImage) {
            const modal = el("dialog", "history-confirm history-image-compare");
            modal.append(el("h2", "", file.path), el("p", "history-local", comparisonTitle));
            const columns = el("div", "history-image-columns");
            for (const [label, src, size] of [[uiText("Before", "変更前"), value.originalImage, value.originalSize], [uiText("After", "変更後"), value.modifiedImage, value.modifiedSize]]) {
              const column = el("div"); column.append(el("strong", "", `${label} · ${size} bytes`));
              if (src) { const img = el("img"); img.src = src; img.alt = `${label}: ${file.path}`; column.append(img); }
              else column.append(el("p", "", size ? uiText("Preview unavailable", "プレビュー対象外") : uiText("No file", "ファイルなし")));
              columns.append(column);
            }
            modal.append(columns, button(uiText("Close", "閉じる"), () => modal.close()));
            modal.addEventListener("close", () => modal.remove()); document.body.append(modal); modal.showModal();
          } else error.textContent = uiText(`${file.path}: binary change (${value.originalSize} → ${value.modifiedSize} bytes).`, `${file.path}：バイナリ変更（${value.originalSize} → ${value.modifiedSize} bytes）。`);
        })));
      }
    } catch (reason) {
      if (generation === comparisonGeneration) comparison.replaceChildren(el("p", "history-error", reason instanceof Error ? reason.message : String(reason)));
    }
  }
  async function prepareRestore(id: string) {
    await run(async () => {
      const data = await withSaved("restore", () => call("plan", { id }));
      const version = versions.find((v) => v.id === id);
      const modal = el("dialog", "history-confirm");
      const title = el("h2", "", version?.kind === "safety" ? uiText("Return to before this restore", "この復元の直前に戻す") : uiText("Restore version", "この版に復元")); title.id = "history-confirm-title"; modal.setAttribute("aria-labelledby", title.id);
      modal.append(title, el("p", "", `${version ? versionTitle(version) : ""} · ${(version ? historyDateLabels(versions).get(version.id)?.exact : "")}`),
        el("p", "", uiText("The current work will be kept as a version before restoring.", "現在の作業は、戻す前に版として残します。")));
      modal.append(el("p", "", uiText("Scope: recorded files in this project", "対象：このプロジェクトの記録対象ファイル")));
      const counts = { added: 0, changed: 0, deleted: 0 };
      for (const file of data.plan.operations) counts[file.kind as keyof typeof counts]++;
      modal.append(el("p", "", uiText(`Replace ${counts.changed} · Recreate ${counts.added} · Delete ${counts.deleted}`, `書き換え ${counts.changed}件・再作成 ${counts.added}件・削除 ${counts.deleted}件`)));
      const changed = el("div", "history-restore-files");
      for (const file of data.plan.operations) changed.append(el("div", "", `${file.kind === "added" ? uiText("Recreate", "再作成") : file.kind === "deleted" ? uiText("Delete", "削除") : uiText("Replace", "書き換え")} · ${file.path}`));
      modal.append(changed);
      if (data.plan.rootFile !== data.plan.targetRootFile) modal.append(el("p", "", `${uiText("Build target", "ビルド対象")}：${data.plan.rootFile || "—"} → ${data.plan.targetRootFile || "—"}`));
      const excluded = el("details");
      excluded.append(el("summary", "", uiText(`${data.plan.excluded.length} excluded · unchanged`, `対象外 ${data.plan.excluded.length}件・変更しない`)));
      for (const file of data.plan.excluded) excluded.append(el("div", "history-excluded", `${file.path} · ${file.reason}`));
      modal.append(excluded);
      const actions = el("div", "history-confirm-actions");
      const cancel = button(uiText("Cancel", "キャンセル"), () => modal.close()); cancel.autofocus = true;
      actions.append(cancel, button(uiText("Restore", "戻す"), () => {
        modal.close();
        void run(async () => {
          const result = await withSaved("restore", async () => {
            const value = await call("restore", { planId: data.plan.id });
            editor.applyHistoryFiles(value.files);
            await call("ack", { buffers: editor.getHistoryBuffers() });
            return value;
          });
          selected = result.record.id; comparison.replaceChildren();
          await refresh();
        });
      }));
      modal.append(actions); modal.addEventListener("close", () => modal.remove()); document.body.append(modal); modal.showModal();
    });
  }
  bridge.onChange((message) => {
    if (message.type === "updateWorkspace") {
      const next = `${message.payload.workspaceId}:${message.payload.workspaceGeneration}`;
      if (workspace !== next) { selected = ""; versions = []; invalidateComparison(); refreshGeneration++; }
      workspace = next;
      phase = message.payload.history?.phase || phase;
      freeze(phase !== "idle");
      window.clearTimeout(poll); poll = window.setTimeout(() => void refresh(), 80);
    } else if (message.type === "history:state") {
      phase = message.payload.phase;
      if (message.payload.error) error.textContent = message.payload.error;
      freeze(phase !== "idle"); render(); if (phase !== "idle") invalidateComparison();
    }
  });
  window.addEventListener("tex64:dirty-state-changed", () => { updateCurrent(); invalidateComparison(); if (selected) comparison.append(el("p", "history-local", uiText("Files changed. Reselect a version to compare.", "ファイルが変わりました。版を選び直すと比較できます。"))); });
  render();
};
