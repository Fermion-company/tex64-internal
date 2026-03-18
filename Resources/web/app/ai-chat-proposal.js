import { buildLineDiff } from "./diff.js";
/* ── Diff summary helpers ───────────────────────────────── */
const computeDiffCounts = (original, modified) => {
    const beforeText = original.trimEnd();
    const afterText = modified.trimEnd();
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    let adds = 0;
    let dels = 0;
    diffLines.forEach((entry) => {
        if (entry.type === "add")
            adds += 1;
        else if (entry.type === "del")
            dels += 1;
    });
    return { adds, dels };
};
const createDiffSummaryEl = (adds, dels) => {
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
const getProposalType = (proposal) => {
    const rawType = proposal.type || "write";
    return rawType === "write" && proposal.isNewFile ? "new" : rawType;
};
const getProposalBadgeText = (proposal) => {
    switch (getProposalType(proposal)) {
        case "delete": return "削除";
        case "rename": return "移動";
        case "mkdir": return "フォルダ";
        case "new": return "新規";
        default: return null; // 「編集」は自明なので表示しない
    }
};
/* ── Unified card builder ──────────────────────────────────── */
export const createUnifiedProposalCard = (proposals, appliedIds, deps) => {
    var _a, _b, _c, _d;
    const card = document.createElement("div");
    card.className = "ai-proposal";
    const proposalIds = proposals.map((p) => p.id);
    const isAutoApplied = proposals.some((p) => p.autoApplied === true);
    const allApplied = isAutoApplied || proposals.every((p) => appliedIds.has(p.id));
    if (allApplied)
        card.classList.add("is-applied");
    /* ── Header ──────────────────────────────── */
    const header = document.createElement("div");
    header.className = "ai-proposal-header";
    const icon = document.createElement("div");
    icon.className = "ai-proposal-icon";
    icon.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
    const titleEl = document.createElement("div");
    titleEl.className = "ai-proposal-path";
    titleEl.textContent =
        proposals.length === 1
            ? proposals[0].path
            : `${proposals.length}件のファイル変更`;
    header.append(icon, titleEl);
    const badge = document.createElement("span");
    badge.className = "ai-proposal-badge";
    if (allApplied) {
        badge.textContent = "適用済み";
        badge.style.background = "rgba(99, 102, 241, 0.1)";
        badge.style.color = "#818cf8";
        badge.style.borderColor = "rgba(99, 102, 241, 0.2)";
        header.appendChild(badge);
    }
    else {
        const badgeText = proposals.length === 1
            ? getProposalBadgeText(proposals[0])
            : null; // 複数ファイルの集約バッジは不要
        if (badgeText) {
            badge.textContent = badgeText;
            header.appendChild(badge);
        }
    }
    /* ── File list (multi-file only) ───────────────── */
    if (proposals.length > 1) {
        const fileList = document.createElement("div");
        fileList.className = "ai-proposal-file-list";
        for (const proposal of proposals) {
            const fileItem = document.createElement("div");
            fileItem.className = "ai-proposal-file-item";
            if (appliedIds.has(proposal.id))
                fileItem.classList.add("is-applied");
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
                const original = (_a = proposal.originalContent) !== null && _a !== void 0 ? _a : "";
                const modified = (_b = proposal.content) !== null && _b !== void 0 ? _b : "";
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
    }
    else {
        // Single file: summary row with diff counts
        const summary = document.createElement("div");
        summary.className = "ai-proposal-summary";
        const p = proposals[0];
        const isBinary = p.isBinary === true;
        const proposalType = getProposalType(p);
        if (!isBinary && proposalType !== "mkdir" && proposalType !== "rename") {
            const original = (_c = p.originalContent) !== null && _c !== void 0 ? _c : "";
            const modified = (_d = p.content) !== null && _d !== void 0 ? _d : "";
            const { adds, dels } = computeDiffCounts(original, modified);
            if (adds > 0 || dels > 0) {
                summary.appendChild(createDiffSummaryEl(adds, dels));
            }
            else {
                summary.textContent = "変更なし";
            }
        }
        else {
            summary.textContent = p.summary || "ファイルの変更案";
        }
        card.append(header, summary);
    }
    /* ── Actions ─────────────────────────────── */
    const actions = document.createElement("div");
    actions.className = "ai-proposal-actions";
    // Review button
    const hasDiffableFiles = proposals.some((p) => !p.isBinary && getProposalType(p) !== "mkdir" && getProposalType(p) !== "rename");
    if (hasDiffableFiles) {
        const reviewButton = document.createElement("button");
        reviewButton.type = "button";
        reviewButton.className = "panel-button ghost";
        reviewButton.textContent = "差分を見る";
        reviewButton.addEventListener("click", (event) => {
            var _a, _b;
            event.stopPropagation();
            deps.setPendingProposalIds(proposalIds);
            deps.setDiffContext({ type: "aiApply", proposalIds });
            const diffable = proposals.filter((p) => !p.isBinary && getProposalType(p) !== "mkdir" && getProposalType(p) !== "rename");
            if (diffable.length === 1) {
                const p = diffable[0];
                deps.showDiffModal((_a = p.originalContent) !== null && _a !== void 0 ? _a : "", (_b = p.content) !== null && _b !== void 0 ? _b : "", 0, {
                    title: "変更内容の確認",
                    fileName: p.path,
                    submitLabel: allApplied ? "確定" : "適用",
                });
            }
            else {
                const files = diffable.map((p) => {
                    var _a, _b;
                    return ({
                        fileName: p.path,
                        original: (_a = p.originalContent) !== null && _a !== void 0 ? _a : "",
                        modified: (_b = p.content) !== null && _b !== void 0 ? _b : "",
                    });
                });
                deps.showMultiFileDiff(files, {
                    title: "変更内容の確認",
                    submitLabel: allApplied ? "確定" : "すべて適用",
                });
            }
        });
        actions.appendChild(reviewButton);
    }
    if (allApplied) {
        const undoButton = document.createElement("button");
        undoButton.type = "button";
        undoButton.className = "panel-button ghost";
        undoButton.textContent = "元に戻す";
        undoButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if (proposals.length > 0) {
                deps.postToNative({
                    type: "agent:undoLastApply",
                    conversationId: proposals[0].conversationId,
                });
            }
        });
        actions.appendChild(undoButton);
    }
    else {
        const applyButton = document.createElement("button");
        applyButton.type = "button";
        applyButton.className = "panel-button";
        applyButton.textContent =
            proposals.length === 1
                ? getProposalType(proposals[0]) === "delete"
                    ? "削除"
                    : getProposalType(proposals[0]) === "mkdir"
                        ? "作成"
                        : getProposalType(proposals[0]) === "rename"
                            ? "移動"
                            : "適用"
                : "すべて適用";
        applyButton.addEventListener("click", (event) => {
            event.stopPropagation();
            const unapplied = proposals.filter((p) => !appliedIds.has(p.id));
            for (const p of unapplied) {
                deps.postToNative({ type: "agent:apply", proposalId: p.id });
            }
        });
        actions.appendChild(applyButton);
    }
    card.appendChild(actions);
    return card;
};
