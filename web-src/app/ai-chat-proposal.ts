import { buildLineDiff } from "./diff.js";
import type { DiffContext, FileDiff } from "./diff-modal.js";
import type { AgentProposal } from "./types.js";
import { aiText } from "./ai-i18n.js";

export type UnifiedProposalCardDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  setPendingProposalIds: (ids: string[]) => void;
  showDiffModal: (
    original: string,
    modified: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string; viewOnly?: boolean; closeLabel?: string }
  ) => void;
  showMultiFileDiff: (
    files: FileDiff[],
    options?: { title?: string; submitLabel?: string; viewOnly?: boolean; closeLabel?: string }
  ) => void;
  setDiffContext: (context: DiffContext) => void;
  /** Reverts what this run wrote; shown while the host can still undo it. */
  undoRun?: () => void;
  canUndo?: boolean;
};

/* ── Diff summary helpers ───────────────────────────────── */

const computeDiffCounts = (original: string, modified: string) => {
  const beforeText = original.trimEnd();
  const afterText = modified.trimEnd();
  const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
  const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
  const diffLines = buildLineDiff(beforeLines, afterLines);
  let adds = 0;
  let dels = 0;
  diffLines.forEach((entry) => {
    if (entry.type === "add") adds += 1;
    else if (entry.type === "del") dels += 1;
  });
  return { adds, dels };
};

const createDiffSummaryEl = (adds: number, dels: number) => {
  const row = document.createElement("div");
  row.className = "diff-summary";
  if (adds > 0) {
    const addEl = document.createElement("span");
    addEl.className = "diff-summary-item is-add";
    addEl.textContent = `+${adds}`;
    row.appendChild(addEl);
  }
  if (dels > 0) {
    const delEl = document.createElement("span");
    delEl.className = "diff-summary-item is-del";
    delEl.textContent = `-${dels}`;
    row.appendChild(delEl);
  }
  return row;
};

const fileName = (path: string) => path.split("/").pop() || path;

const getProposalType = (proposal: AgentProposal) => {
  const rawType = proposal.type || "write";
  return rawType === "write" && proposal.isNewFile ? "new" : rawType;
};

const getProposalBadgeText = (proposal: AgentProposal): string | null => {
  switch (getProposalType(proposal)) {
    case "delete": return "Delete";
    case "rename": return "move";
    case "mkdir": return "folder";
    case "new": return "New";
    default: return null; // "Edit" is obvious, no need to display
  }
};

/* ── Unified card builder ──────────────────────────────────── */

export const createUnifiedProposalCard = (
  proposals: AgentProposal[],
  appliedIds: Set<string>,
  deps: UnifiedProposalCardDeps
) => {
  const card = document.createElement("div");
  card.className = "ai-proposal";
  const proposalIds = proposals.map((p) => p.id);

  const isAutoApplied = proposals.some(
    (p) => (p as AgentProposal & { autoApplied?: boolean }).autoApplied === true
  );
  const allApplied = isAutoApplied || proposals.every((p) => appliedIds.has(p.id));

  if (allApplied) card.classList.add("is-applied");

  /* ── Header ──────────────────────────────── */

  const header = document.createElement("div");
  header.className = "ai-proposal-header";

  const icon = document.createElement("div");
  icon.className = "ai-proposal-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';

  // Several edits to one file are one change to the reader: group by path,
  // and show each file's net difference (first original -> last content).
  const byPath = new Map<string, AgentProposal[]>();
  for (const proposal of proposals) {
    const list = byPath.get(proposal.path);
    if (list) list.push(proposal);
    else byPath.set(proposal.path, [proposal]);
  }
  const fileGroups = [...byPath.entries()].map(([filePath, edits]) => ({
    path: filePath,
    first: edits[0],
    last: edits[edits.length - 1],
    ids: edits.map((edit) => edit.id),
  }));

  const titleEl = document.createElement("div");
  titleEl.className = "ai-proposal-path";
  titleEl.textContent =
    fileGroups.length === 1
      ? fileGroups[0].path
      : `${fileGroups.length} file changes`;

  header.append(icon, titleEl);

  const badge = document.createElement("span");
  badge.className = "ai-proposal-badge";
  if (allApplied) {
    // Written already: the card itself says so, no badge needed.
  } else {
    const badgeText = proposals.length === 1
      ? getProposalBadgeText(proposals[0])
      : null; // No aggregate badge needed for multiple files
    if (badgeText) {
      badge.textContent = badgeText;
      header.appendChild(badge);
    }
  }

  /* ── File list (multi-file only) ───────────────── */

  if (fileGroups.length > 1) {
    const fileList = document.createElement("div");
    fileList.className = "ai-proposal-file-list";

    for (const group of fileGroups) {
      const proposal = group.last;
      const fileItem = document.createElement("div");
      fileItem.className = "ai-proposal-file-item";
      if (group.ids.every((id) => appliedIds.has(id)) || isAutoApplied) fileItem.classList.add("is-applied");

      const fileName = document.createElement("span");
      fileName.className = "ai-proposal-file-name";
      fileName.textContent = proposal.path.split("/").pop() || proposal.path;
      fileName.title = proposal.path;
      fileItem.appendChild(fileName);

      const badgeText = getProposalBadgeText(proposal);
      if (badgeText) {
        const fileBadge = document.createElement("span");
        fileBadge.className = "ai-proposal-file-badge";
        fileBadge.textContent = badgeText;
        fileItem.appendChild(fileBadge);
      }

      // Flat diff counts (no wrapper) for grid alignment
      const isBinary = proposal.isBinary === true;
      const proposalType = getProposalType(proposal);
      if (!isBinary && proposalType !== "mkdir" && proposalType !== "rename") {
        const original = group.first.originalContent ?? "";
        const modified = proposal.content ?? "";
        const { adds, dels } = computeDiffCounts(original, modified);
        if (adds > 0) {
          const addEl = document.createElement("span");
          addEl.className = "diff-summary-item is-add";
          addEl.textContent = `+${adds}`;
          fileItem.appendChild(addEl);
        }
        if (dels > 0) {
          const delEl = document.createElement("span");
          delEl.className = "diff-summary-item is-del";
          delEl.textContent = `-${dels}`;
          fileItem.appendChild(delEl);
        }
      }

      fileList.appendChild(fileItem);
    }
    card.append(header, fileList);
  } else {
    // Single file: the net counts sit on the header line, after the name.
    const p = fileGroups[0].last;
    const isBinary = p.isBinary === true;
    const proposalType = getProposalType(p);
    if (!isBinary && proposalType !== "mkdir" && proposalType !== "rename") {
      const original = fileGroups[0].first.originalContent ?? "";
      const modified = p.content ?? "";
      const { adds, dels } = computeDiffCounts(original, modified);
      if (adds > 0 || dels > 0) {
        const counts = createDiffSummaryEl(adds, dels);
        counts.classList.add("ai-proposal-counts");
        header.appendChild(counts);
      }
      card.append(header);
    } else {
      const summary = document.createElement("div");
      summary.className = "ai-proposal-summary";
      summary.textContent = p.summary || "Proposed file changes";
      card.append(header, summary);
    }
  }

  /* ── Where it landed: section and page ───────── */

  const scopeParts: string[] = [];
  const seenScopes = new Set<string>();
  for (const group of fileGroups) {
    const scoped = group.last.scope ?? group.first.scope;
    if (!scoped) continue;
    const place = scoped.section
      ? `§ ${scoped.section}`
      : aiText("scope_line").replace("{n}", String(scoped.line));
    const page = Number.isFinite(scoped.page) ? aiText("scope_page").replace("{n}", String(scoped.page)) : "";
    const text = [fileGroups.length > 1 ? fileName(group.path) : "", place, page].filter(Boolean).join(" · ");
    if (!seenScopes.has(text)) {
      seenScopes.add(text);
      scopeParts.push(text);
    }
  }
  if (scopeParts.length > 0) {
    const scopeEl = document.createElement("div");
    scopeEl.className = "ai-proposal-scope";
    scopeEl.textContent = scopeParts.slice(0, 3).join("　");
    card.appendChild(scopeEl);
  }

  /* ── Actions ─────────────────────────────── */

  const actions = document.createElement("div");
  actions.className = "ai-proposal-actions";

  // Review button
  const hasDiffableFiles = proposals.some(
    (p) => !p.isBinary && getProposalType(p) !== "mkdir" && getProposalType(p) !== "rename"
  );
  if (hasDiffableFiles) {
    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    reviewButton.className = "panel-button ghost";
    reviewButton.textContent = aiText("view_diff");
    reviewButton.addEventListener("click", (event) => {
      event.stopPropagation();
      // The edit is already on disk: the diff is a view, not an approval.
      deps.setPendingProposalIds([]);
      deps.setDiffContext({ type: "aiApply", proposalIds: [] });

      const diffable = proposals.filter(
        (p) => !p.isBinary && getProposalType(p) !== "mkdir" && getProposalType(p) !== "rename"
      );
      // Group edits by file: each file's net diff (first edit's original ->
      // last edit's result). One file -> single Monaco diff; multiple files ->
      // one Monaco diff per file, stacked (same engine, just repeated).
      const byPath = new Map<string, FileDiff>();
      for (const p of diffable) {
        const existing = byPath.get(p.path);
        if (existing) {
          existing.modified = p.content ?? "";
        } else {
          byPath.set(p.path, {
            fileName: p.path,
            original: p.originalContent ?? "",
            modified: p.content ?? "",
          });
        }
      }
      const files = [...byPath.values()];
      if (files.length === 1) {
        deps.showDiffModal(files[0].original, files[0].modified, 0, {
          title: aiText("changes_title"),
          fileName: files[0].fileName,
          viewOnly: true,
          closeLabel: aiText("close"),
        });
      } else {
        deps.showMultiFileDiff(files, {
          title: aiText("changes_title"),
          viewOnly: true,
          closeLabel: aiText("close"),
        });
      }
    });
    actions.appendChild(reviewButton);
  }

  // A change the reader does not want goes back from here, not from the editor.
  if (allApplied && deps.canUndo && deps.undoRun) {
    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.className = "panel-button ghost";
    undoButton.textContent = aiText("undo_run");
    undoButton.addEventListener("click", (event) => {
      event.stopPropagation();
      undoButton.disabled = true;
      deps.undoRun?.();
    });
    actions.appendChild(undoButton);
  }

  if (!allApplied) {
    // Edits the host could not write straight away (an unsaved buffer was in
    // the way) are applied from here.
    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "panel-button";
    applyButton.textContent =
      proposals.length === 1
        ? getProposalType(proposals[0]) === "delete"
          ? "Delete"
          : getProposalType(proposals[0]) === "mkdir"
          ? "Create"
          : getProposalType(proposals[0]) === "rename"
          ? "move"
          : "Apply"
        : "Apply all";
    applyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const unapplied = proposals.filter((p) => !appliedIds.has(p.id));
      deps.postToNative({
        type: "agent:applyBatch",
        proposalIds: unapplied.map((proposal) => proposal.id),
      });
    });
    actions.appendChild(applyButton);
  }

  card.appendChild(actions);
  return card;
};
