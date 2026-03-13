import { buildLineDiff } from "./diff.js";
import type { DiffContext } from "./diff-modal.js";
import type { AgentProposal } from "./types.js";

export type ProposalCardDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  dismissProposal: (proposalId: string) => void;
  setPendingProposalId: (value: string | null) => void;
  showDiffModal?: (
    before: string,
    after: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => void;
  setDiffContext?: (context: DiffContext) => void;
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
  return { adds, dels, diffLines };
};

const createDiffSummaryEl = (adds: number, dels: number) => {
  const row = document.createElement("div");
  row.className = "diff-summary ai-proposal-diff-summary";
  if (adds === 0 && dels === 0) {
    const text = document.createElement("span");
    text.textContent = "変更なし";
    row.appendChild(text);
    return row;
  }
  const addEl = document.createElement("span");
  addEl.className = "diff-summary-item is-add";
  addEl.textContent = `+${adds}`;
  const delEl = document.createElement("span");
  delEl.className = "diff-summary-item is-del";
  delEl.textContent = `-${dels}`;
  row.append(addEl, delEl);
  return row;
};

/* ── Main card builder ──────────────────────────────────── */

export const createProposalCard = (proposal: AgentProposal, deps: ProposalCardDeps) => {
  const card = document.createElement("div");
  card.className = "ai-proposal";
  card.dataset.proposalId = proposal.id;

  const isAutoApplied = (proposal as AgentProposal & { autoApplied?: boolean }).autoApplied === true;

  if (isAutoApplied) {
    card.classList.add("is-applied");
  }

  const header = document.createElement("div");
  header.className = "ai-proposal-header";

  const icon = document.createElement("div");
  icon.className = "ai-proposal-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';

  const path = document.createElement("div");
  path.className = "ai-proposal-path";
  path.textContent = proposal.path;

  header.append(icon, path);

  const originalContent = proposal.originalContent ?? "";
  const modifiedContent = proposal.content ?? "";
  const isBinary = proposal.isBinary === true;

  const rawType = proposal.type || "write";
  const proposalType = rawType === "write" && proposal.isNewFile ? "new" : rawType;
  const badge = document.createElement("span");
  badge.className = "ai-proposal-badge";

  if (isAutoApplied) {
    badge.textContent = "auto-applied";
    badge.style.background = "rgba(34, 197, 94, 0.1)";
    badge.style.color = "#4ade80";
    badge.style.borderColor = "rgba(34, 197, 94, 0.2)";
  } else {
    switch (proposalType) {
      case "delete":
        badge.textContent = "削除";
        badge.style.background = "var(--danger, #dc3545)";
        break;
      case "rename":
        badge.textContent = "移動";
        badge.style.background = "var(--warning, #ffc107)";
        badge.style.color = "#000";
        break;
      case "mkdir":
        badge.textContent = "フォルダ";
        badge.style.background = "var(--info, #17a2b8)";
        break;
      case "new":
        badge.textContent = "新規";
        break;
      default:
        badge.textContent = "編集";
        break;
    }
  }
  header.appendChild(badge);

  /* ── Summary row with diff counts ──────────────── */

  const summary = document.createElement("div");
  summary.className = "ai-proposal-summary";

  if (isAutoApplied && !isBinary && !(proposalType === "mkdir" || proposalType === "rename")) {
    const { adds, dels } = computeDiffCounts(originalContent, modifiedContent);
    const fileLabel = document.createElement("span");
    fileLabel.className = "ai-proposal-file-label";
    fileLabel.textContent = proposal.path.split("/").pop() || proposal.path;
    summary.appendChild(fileLabel);
    summary.appendChild(createDiffSummaryEl(adds, dels));
  } else {
    summary.textContent = proposal.summary || "ファイルの変更案";
  }

  /* ── Actions ───────────────────────────────────── */

  const actions = document.createElement("div");
  actions.className = "ai-proposal-actions";

  const diffContainer = document.createElement("div");
  diffContainer.className = "ai-proposal-diff";

  if (isAutoApplied) {
    // Auto-applied: show review button + undo button
    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    reviewButton.className = "panel-button ghost";
    reviewButton.textContent = "レビュー";
    reviewButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (deps.showDiffModal && deps.setDiffContext && !isBinary) {
        deps.setDiffContext?.({ type: "aiApply", proposalId: proposal.id } as DiffContext);
        deps.setPendingProposalId(proposal.id);
        deps.showDiffModal?.(originalContent, modifiedContent, 0, {
          title: "変更の差分",
          fileName: proposal.path,
        });
        return;
      }
      // Fallback: inline toggle
      const isOpen = diffContainer.classList.toggle("is-open");
      reviewButton.textContent = isOpen ? "閉じる" : "レビュー";
      if (isOpen && !diffContainer.dataset.ready) {
        renderDiff();
        diffContainer.dataset.ready = "true";
      }
    });

    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.className = "panel-button ghost";
    undoButton.textContent = "元に戻す";
    undoButton.addEventListener("click", (e) => {
      e.stopPropagation();
      deps.postToNative({ type: "agent:undoLastApply", conversationId: proposal.conversationId });
    });

    actions.append(reviewButton, undoButton);
  } else {
    // Manual apply: show preview + apply buttons
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "panel-button ghost";
    previewButton.textContent =
      proposalType === "mkdir" || proposalType === "rename"
        ? "詳細を見る"
        : "差分を見る";

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "panel-button";
    applyButton.textContent =
      proposalType === "delete"
        ? "削除"
        : proposalType === "mkdir"
        ? "作成"
        : proposalType === "rename"
        ? "移動"
        : "適用";
    applyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deps.postToNative({ type: "agent:apply", proposalId: proposal.id });
    });

    previewButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldUseModal =
        Boolean(deps.showDiffModal) &&
        Boolean(deps.setDiffContext) &&
        !(proposalType === "mkdir" || proposalType === "rename" || isBinary);
      if (shouldUseModal) {
        deps.setDiffContext?.({ type: "aiApply", proposalId: proposal.id } as DiffContext);
        deps.setPendingProposalId(proposal.id);
        deps.showDiffModal?.(originalContent, modifiedContent, 0, {
          title: "Axiom 提案の差分",
          fileName: proposal.path,
          submitLabel: applyButton.textContent ?? "適用",
        });
        return;
      }
      const isOpen = diffContainer.classList.toggle("is-open");
      previewButton.textContent =
        proposalType === "mkdir" || proposalType === "rename"
          ? isOpen ? "詳細を閉じる" : "詳細を見る"
          : isOpen ? "差分を閉じる" : "差分を見る";
      if (isOpen && !diffContainer.dataset.ready) {
        renderDiff();
        diffContainer.dataset.ready = "true";
      }
    });

    actions.append(previewButton, applyButton);
  }

  /* ── Diff container (shared) ───────────────────── */

  const buildDiffLines = () => {
    const beforeText = originalContent.trimEnd();
    const afterText = modifiedContent.trimEnd();
    if (beforeText === afterText) {
      const empty = document.createElement("div");
      empty.className = "ai-proposal-diff-empty";
      empty.textContent = "変更なし";
      return empty;
    }
    const { diffLines } = computeDiffCounts(originalContent, modifiedContent);
    const diffBody = document.createElement("div");
    diffBody.className = "ai-diff";
    diffLines.forEach((entry) => {
      const line = document.createElement("div");
      line.className = `ai-diff-line is-${entry.type}`;
      const prefix = entry.type === "add" ? "+" : entry.type === "del" ? "-" : " ";
      line.textContent = `${prefix} ${entry.line}`;
      diffBody.appendChild(line);
    });
    return diffBody;
  };

  const renderDiff = () => {
    diffContainer.replaceChildren();
    const headerRow = document.createElement("div");
    headerRow.className = "ai-proposal-diff-header";
    if (proposalType === "rename") {
      const renameText = document.createElement("div");
      renameText.className = "ai-proposal-diff-note";
      const oldPath = proposal.oldPath ? proposal.oldPath : "";
      renameText.textContent = oldPath ? `${oldPath} → ${proposal.path}` : proposal.path;
      headerRow.appendChild(renameText);
    } else if (proposalType === "mkdir") {
      const note = document.createElement("div");
      note.className = "ai-proposal-diff-note";
      note.textContent = "新しいフォルダを作成します。";
      headerRow.appendChild(note);
    } else if (isBinary) {
      const note = document.createElement("div");
      note.className = "ai-proposal-diff-note";
      note.textContent = "バイナリファイルのため差分プレビューは省略しています。";
      headerRow.appendChild(note);
    } else {
      const { adds, dels } = computeDiffCounts(originalContent, modifiedContent);
      headerRow.appendChild(createDiffSummaryEl(adds, dels));
    }
    diffContainer.appendChild(headerRow);
    if (!(proposalType === "rename" || proposalType === "mkdir" || isBinary)) {
      diffContainer.appendChild(buildDiffLines());
    }
  };

  card.append(header, summary, actions, diffContainer);
  return card;
};
