/**
 * Tool executor — stripped down to only the tools used outside the
 * OpenPrism AgentExecutor run-loop:
 *
 *   1. run_build   — called by maybeAutoBuild (agent-proposal-runtime.cjs)
 *   2. rename_latex_symbol — called by handleSearchRename (handlers/agent.cjs)
 *
 * All other tools (30+) have been removed.  The 7-tool OpenPrism agent
 * (read_file, list_files, propose_patch, apply_patch, get_compile_log,
 * arxiv_search, arxiv_bibtex) is handled by openprism/tools.cjs.
 */

"use strict";

const path = require("path");
const fsp = require("fs/promises");
const {
  buildAgentPolicy,
  isBlockedPath,
  isTextExtension,
  normalizeExtensionList,
  normalizePath,
  normalizeStringList,
} = require("./agent-policy.cjs");
const {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
} = require("./agent-latex.cjs");
const { readFileFromDisk } = require("./agent-tools-file.cjs");
const { TOOL_STATUS_LABELS, clipText } = require("./agent-core-utils.cjs");

const executeToolCall = async (service, toolCall, conversationId) => {
  try {
    await service.ensureSessionsRestored();
    const name = toolCall?.name ?? "";
    let args = toolCall?.args ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") {
      args = {};
    }
    const policy = service.agentPolicy ?? buildAgentPolicy();
    const clip = (value, max = 60) => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) return "";
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };

    // ---- Status label for IPC ----
    const statusLabel = TOOL_STATUS_LABELS[name];
    if (statusLabel) {
      let detail = statusLabel;
      if (name === "rename_latex_symbol") {
        const from = clip(args.from, 24);
        const to = clip(args.to, 24);
        if (from && to) detail = `${statusLabel}: ${from} → ${to}`;
      } else if (name === "run_build") {
        const mainFile = clip(args.mainFile, 64);
        const engine = clip(args.engine, 16);
        if (mainFile || engine) {
          detail = `${statusLabel}: ${[mainFile, engine].filter(Boolean).join(" ")}`;
        }
      }
      service.sendStatus("running", detail, conversationId);
    }

    // ---- run_build ----
    if (name === "run_build") {
      if (!service.buildService) {
        return { error: "ビルド機能が利用できません。" };
      }
      const rootPath = service.workspace.getRootPath();
      if (!rootPath) {
        return { error: "ワークスペースが選択されていません。" };
      }
      const requestedMain = typeof args.mainFile === "string" ? args.mainFile.trim() : "";
      const requestedEngine = typeof args.engine === "string" ? args.engine.trim() : "";
      const rootInfo = await service.workspace.rootInfo().catch(() => null);
      const requestedFile = requestedMain && requestedMain.trim() ? requestedMain.trim() : null;
      let targetFile = rootInfo?.path || "main.tex";
      if (requestedFile && requestedFile.endsWith(".tex")) {
        const magicRoot = await service.workspace
          .resolveTexRootFromMagic(requestedFile)
          .catch(() => null);
        if (magicRoot) {
          targetFile = magicRoot;
        } else if (!rootInfo?.path) {
          targetFile = requestedFile;
        }
      } else if (requestedFile && !rootInfo?.path) {
        targetFile = requestedFile;
      }
      service.sendBuildState?.("building", "ビルドしています...");
      service.sendIssues?.(0, "ビルドしています...", "info", []);
      const settings = await service.workspace.loadSettings().catch(() => null);
      const activeId =
        typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
      const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
      const selected = activeId
        ? profiles.find(
            (profile) => profile && typeof profile === "object" && profile.id === activeId
          )
        : null;
      const buildProfile = selected
        ? {
            outDir:
              typeof selected.outDir === "string" && selected.outDir.trim()
                ? selected.outDir.trim()
                : null,
            extraArgs:
              typeof selected.extraArgs === "string" && selected.extraArgs.trim()
                ? selected.extraArgs.trim()
                : null,
          }
        : null;
      const result = await service.buildService.build(
        rootPath,
        targetFile,
        requestedEngine || "lualatex",
        buildProfile
      );
      if (result.kind === "busy") {
        service.sendBuildState?.("building", "すでにビルド中です。");
        service.sendIssues?.(0, "すでにビルド中です。", "info", []);
        return { status: "busy", summary: "すでにビルド中です。" };
      }
      if (result.log) {
        service.sendBuildLog?.(result.log);
      }
      if (result.kind === "cancelled") {
        service.sendBuildState?.("idle", result.summary ?? "ビルドをキャンセルしました。");
        service.sendIssues?.(0, result.summary ?? "ビルドをキャンセルしました。", "info", []);
        return { status: "cancelled", summary: result.summary ?? "ビルドをキャンセルしました。" };
      }
      if (result.kind === "success") {
        const warningIssues = result.issues.filter(
          (issue) => issue.severity === "warning"
        );
        if (warningIssues.length > 0) {
          const summaryText = warningIssues[0]?.message ?? result.summary;
          service.sendIssues?.(warningIssues.length, summaryText, "info", warningIssues);
        } else {
          service.sendIssues?.(0, result.summary, "success", []);
        }
        service.sendBuildState?.("success", result.summary);
        return {
          status: "success",
          summary: result.summary,
          issues: result.issues,
          pdfPath: result.pdfPath ?? null,
        };
      }
      if (result.kind === "failure") {
        const count = Math.max(result.issues.length, 1);
        const summaryText = result.issues[0]?.message ?? result.summary;
        service.sendBuildState?.("failed", result.summary);
        service.sendIssues?.(count, summaryText, "error", result.issues);
        return { status: "failure", summary: result.summary, issues: result.issues };
      }
      return { status: "unknown", summary: "ビルド結果が不明です。" };
    }

    // ---- rename_latex_symbol ----
    if (name === "rename_latex_symbol") {
      const from = typeof args.from === "string" ? args.from.trim() : "";
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!from || !to) {
        return { error: "from と to は必須です。" };
      }
      if (from === to) {
        return { error: "from と to が同じです。" };
      }
      const invalidPattern = /[\s,{}]/;
      if (invalidPattern.test(from) || invalidPattern.test(to)) {
        return { error: "from/to に空白や区切り文字は使えません。" };
      }
      const kinds = normalizeStringList(args.kinds).map((entry) => entry.toLowerCase());
      const renameLabels =
        kinds.length === 0 || kinds.includes("label") || kinds.includes("ref");
      const renameCites =
        kinds.length === 0 || kinds.includes("cite") || kinds.includes("citation");
      if (!renameLabels && !renameCites) {
        return { error: "kinds が不正です。" };
      }
      const extOverride = normalizeExtensionList(args.extensions);
      const targetExtensions =
        extOverride.size > 0
          ? extOverride
          : new Set(DEFAULT_LATEX_SYMBOL_EXTENSIONS);
      if (!renameCites && extOverride.size === 0) {
        targetExtensions.delete("bib");
      }
      let fileList = [];
      try {
        fileList = await service.workspace.listFiles();
      } catch {
        return { error: "ファイル一覧の取得に失敗しました。" };
      }

      const preparedProposals = [];
      const skipped = [];

      for (const targetPath of fileList) {
        if (!targetPath) {
          continue;
        }
        if (isBlockedPath(targetPath, policy)) {
          skipped.push({ path: targetPath, reason: "blocked" });
          continue;
        }
        const ext = path.extname(targetPath).toLowerCase().replace(/^\./, "");
        if (!targetExtensions.has(ext)) {
          continue;
        }
        if (!isTextExtension(targetPath, policy)) {
          skipped.push({ path: targetPath, reason: "non_text" });
          continue;
        }

        let originalContent = "";
        const snapshot = service.getContextSnapshot(conversationId, targetPath);
        if (snapshot && typeof snapshot.content === "string") {
          if (snapshot.truncated && snapshot.isDirty) {
            return {
              error:
                `${targetPath} は未保存の変更があり、スナップショットが省略されています。` +
                "保存してから再実行してください。",
            };
          }
          if (!snapshot.truncated) {
            originalContent = snapshot.content;
          }
        }

        if (!originalContent) {
          let resolved = "";
          try {
            resolved = service.workspace.resolvePath(targetPath);
          } catch {
            continue;
          }
          const stat = await fsp.stat(resolved).catch(() => null);
          if (!stat || !stat.isFile()) {
            continue;
          }
          if (stat.size > policy.maxFileBytes) {
            skipped.push({ path: targetPath, reason: "too_large" });
            continue;
          }
          const result = await readFileFromDisk(resolved);
          if (result.binary) {
            skipped.push({ path: targetPath, reason: "binary" });
            continue;
          }
          originalContent = result.content;
        }

        let updatedContent = originalContent;
        let appliedCount = 0;

        if (ext === "bib") {
          if (renameCites) {
            const result = renameBibEntryKey(updatedContent, from, to);
            updatedContent = result.text;
            appliedCount += result.count;
          }
        } else {
          const result = renameLatexInText(updatedContent, {
            from,
            to,
            renameLabels,
            renameCites,
          });
          updatedContent = result.text;
          appliedCount += result.count;
        }

        if (appliedCount === 0 || updatedContent === originalContent) {
          continue;
        }
        if (updatedContent.length > policy.maxFileBytes) {
          skipped.push({ path: targetPath, reason: "too_large" });
          continue;
        }
        preparedProposals.push({
          path: targetPath,
          originalContent,
          updatedContent,
          appliedCount,
        });
      }

      if (preparedProposals.length === 0) {
        return { error: "一致するシンボルが見つかりません。" };
      }

      const proposals = [];
      const summaryBase =
        renameLabels && renameCites
          ? "シンボルリネーム"
          : renameLabels
          ? "ラベルリネーム"
          : "引用キーリネーム";

      const autoApply = service?.agentOptions?.autoApply === true;
      for (const prepared of preparedProposals) {
        const id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const proposal = {
          id,
          type: "patch",
          path: prepared.path,
          content: prepared.updatedContent,
          originalContent: prepared.originalContent,
          summary: `${summaryBase}: ${from} → ${to} (${prepared.appliedCount}箇所)`,
          isNewFile: false,
          conversationId,
          workspaceRootPath: service.workspace.getRootPath() || undefined,
        };
        if (autoApply) {
          service.proposals.set(id, proposal);
          const apply = await service.applyProposal(id, {
            discardOnFailure: true,
            skipAutoBuild: true,
          });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
            ok: Boolean(apply?.ok),
            error: apply?.ok ? undefined : apply?.error ?? "適用に失敗しました。",
          });
        } else {
          service.proposals.set(id, proposal);
          service.sendToRenderer("agent:proposal", { proposal });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
          });
        }
      }

      if (autoApply) {
        const successCount = proposals.filter((entry) => entry.ok).length;
        const hasFailure = proposals.length > successCount;
        const autoBuild =
          successCount > 0 && service?.agentOptions?.autoBuild === true
            ? await service.executeToolCall(
                { name: "run_build", args: {} },
                conversationId || "default"
              )
            : null;
        return {
          status: hasFailure ? (successCount > 0 ? "partially_applied" : "apply_failed") : "applied",
          proposalIds: proposals.map((proposal) => proposal.proposalId),
          files: proposals,
          skipped,
          autoBuild,
        };
      }

      return {
        status: "proposed",
        proposalIds: proposals.map((proposal) => proposal.proposalId),
        files: proposals,
        skipped,
      };
    }

    return { error: `unknown tool: ${name}` };
  } catch (error) {
    return { error: error?.message ?? "tool error" };
  }
};

module.exports = {
  executeToolCall,
};
