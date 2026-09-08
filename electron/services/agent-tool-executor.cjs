const { historyBoundary } = require("./agent-history-boundary.cjs");
/**
 * Tool executor — stripped down to only the tools used outside the
 * OpenPrism AgentExecutor run-loop:
 *
 *   1. run_build   — called by maybeAutoBuild and compile_document
 *   2. rename_latex_symbol — called by handleSearchRename (handlers/agent.cjs)
 *
 * All other tools (30+) have been removed.  The 7-tool OpenPrism agent
 * (read_file, list_files, write_file, apply_patch, get_compile_log,
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
  normalizeStringList,
} = require("./agent-policy.cjs");
const {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
} = require("./agent-latex.cjs");
const { readFileFromDisk } = require("./agent-tools-file.cjs");
const { clipText } = require("./agent-core-utils.cjs");

const WORKSPACE_CHANGED_ERROR =
  "The workspace changed during this Axiom turn. The compile result was discarded; retry in the current workspace.";
const POST_BUILD_REFRESH_TIMEOUT_MS = 5000;

const normalizeBuildTarget = (rootPath, value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(rootPath, raw.replace(/\\/g, path.sep));
  const resolvedRoot = path.resolve(rootPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("The document to compile must be inside the current workspace.");
  }
  if (path.extname(resolved).toLowerCase() !== ".tex") {
    throw new Error("compile_document requires a .tex document.");
  }
  return path.relative(resolvedRoot, resolved).split(path.sep).join("/");
};

const compileLogExcerpt = (value, maxChars = 12_000) => {
  const log = typeof value === "string" ? value.trim() : "";
  if (!log) {
    return null;
  }
  if (log.length <= maxChars) {
    return log;
  }
  return `[earlier output omitted]\n${log.slice(log.length - maxChars)}`;
};

const refreshWorkspaceAfterBuild = async (service, rootPath, signal) => {
  if (typeof service.updateWorkspaceIfNeeded !== "function") {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), POST_BUILD_REFRESH_TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => service.updateWorkspaceIfNeeded(rootPath, true))
      .then(
        (value) => finish(value !== false),
        () => finish(false),
      );
  });
};

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
    const turnSignal = service.runningControllers?.get?.(conversationId)?.controller?.signal;
    const buildWasAlreadyAbortedAtToolStart = turnSignal?.aborted === true;
    const policy = service.agentPolicy ?? buildAgentPolicy();
    const clip = (value, max = 60) => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) return "";
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };

    // ---- Status for IPC ----
    // The tool event (name + target) carries the specifics; the status line
    // only says that work is going on, in words each UI localizes.
    if (name === "run_build" || name === "rename_latex_symbol") {
      service.sendStatus("running", "Working...", conversationId);
    }

    // ---- run_build ----
    if (name === "run_build") {
      if (!service.buildService) {
        return { error: "Build feature is not available." };
      }
      const currentRootPath = service.workspace.getRootPath();
      if (!currentRootPath) {
        return { error: "No workspace is selected." };
      }
      const storedRootPath = service.workspaceRootByConversation?.get?.(conversationId);
      const capturedRootPath =
        typeof storedRootPath === "string" && storedRootPath.trim()
          ? storedRootPath.trim()
          : currentRootPath;
      const assertCapturedWorkspace = () => {
        if (service.workspace.getRootPath() !== capturedRootPath) {
          const error = new Error(WORKSPACE_CHANGED_ERROR);
          error.code = "AGENT_WORKSPACE_CHANGED";
          throw error;
        }
      };
      assertCapturedWorkspace();

      const context = service.contextByConversation?.get?.(conversationId) ?? {};
      const explicitMain =
        typeof args.mainFile === "string" && args.mainFile.trim()
          ? args.mainFile.trim()
          : "";
      const implicitTexCandidate = [context.activeFilePath, context.documentMainFile]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .find((value) => path.extname(value).toLowerCase() === ".tex") ?? "";
      const requestedEngine = typeof args.engine === "string" ? args.engine.trim() : "";
      // An explicit tool argument is user/model intent and must fail closed when
      // it is not a TeX document. The renderer's active file is only a hint:
      // editing a .bib/.sty/config file must still compile the current document.
      const requestedFile = normalizeBuildTarget(
        capturedRootPath,
        explicitMain || implicitTexCandidate,
      );
      let targetFile = requestedFile;
      if (requestedFile) {
        const magicRoot = await service.workspace
          .resolveTexRootFromMagic(requestedFile)
          .catch(() => null);
        assertCapturedWorkspace();
        // A per-file % !TEX root directive is explicit user intent and wins.
        // Otherwise the requested/active nested document is the exact target;
        // the workspace-wide root file must not override it.
        targetFile = normalizeBuildTarget(capturedRootPath, magicRoot || requestedFile);
      } else {
        const rootInfo = await service.workspace.rootInfo().catch(() => null);
        assertCapturedWorkspace();
        targetFile = normalizeBuildTarget(capturedRootPath, rootInfo?.path || "main.tex");
      }
      if (!targetFile) {
        return { error: "No LaTeX document is available to compile." };
      }
      try {
        // A lexical `root/…` target may still traverse a symlink to a TeX file
        // outside the workspace. Compile through the same canonical boundary
        // used by every file edit before handing the target to BuildService.
        const resolvedTarget = service.workspace.resolvePath(targetFile);
        targetFile = normalizeBuildTarget(capturedRootPath, resolvedTarget);
      } catch {
        return {
          error: "The document to compile must stay inside the current workspace.",
        };
      }
      const buildEventContext = {
        workspaceRoot: capturedRootPath,
        targetFile,
        documentMainFile: targetFile,
        ...(typeof context.workspaceId === "string" && context.workspaceId.trim()
          ? { workspaceId: context.workspaceId.trim() }
          : {}),
        ...(Number.isSafeInteger(context.workspaceGeneration)
          ? { workspaceGeneration: context.workspaceGeneration }
          : {}),
      };
      service.sendBuildState?.("building", "Building...", buildEventContext);
      service.sendIssues?.(0, "Building...", "info", []);
      const settings = await service.workspace.loadSettings().catch(() => null);
      assertCapturedWorkspace();
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
      const markBuildStarted = () => {
        service.activeAgentBuildConversationId = conversationId;
      };
      const markBuildFinished = () => {
        if (service.activeAgentBuildConversationId === conversationId) {
          service.activeAgentBuildConversationId = null;
        }
      };
      const runBuild = async (...buildArgs) => {
        if (typeof service.buildService.buildQueued === "function") {
          return service.buildService.buildQueued(...buildArgs, {
            onStart: markBuildStarted,
            onFinish: markBuildFinished,
            signal: turnSignal,
            allowInitiallyAborted: buildWasAlreadyAbortedAtToolStart,
          });
        }
        markBuildStarted();
        try {
          return await service.buildService.build(...buildArgs);
        } finally {
          markBuildFinished();
        }
      };
      let result = await runBuild(
        capturedRootPath,
        targetFile,
        requestedEngine || "lualatex",
        buildProfile
      );
      assertCapturedWorkspace();

      // Match the normal Build button: managed TeX installs missing packages
      // from the real compiler log, then retries the same exact document.
      const installedPackages = new Set();
      const recoveryNotes = [];
      for (let attempt = 0; attempt < 4 && result.kind === "failure"; attempt += 1) {
        if (!service.envService || typeof service.envService.installMissingPackagesFromLog !== "function") {
          break;
        }
        let recovery;
        try {
          recovery = await service.envService.installMissingPackagesFromLog(result.log, {
            excludePackages: [...installedPackages],
            signal: turnSignal,
            onPackagesResolved: () => {
              if (service.workspace.getRootPath() !== capturedRootPath) {
                return;
              }
              service.sendBuildState?.(
                "building",
                "Installing missing TeX packages...",
                buildEventContext
              );
              service.sendIssues?.(0, "Installing missing TeX packages...", "info", []);
            },
          });
        } catch (error) {
          // The real build above already happened. Preserve that failure as the
          // compile_document result so terminal settlement does not build the
          // exact same edit a second time after Stop or package-recovery errors.
          recoveryNotes.push(
            error?.name === "AbortError"
              ? "Missing-package recovery was stopped."
              : `Missing-package recovery failed: ${error?.message ?? "unknown error"}`,
          );
          break;
        }
        assertCapturedWorkspace();
        if (!recovery?.success || !Array.isArray(recovery.packages) || recovery.packages.length === 0) {
          break;
        }
        recovery.packages.forEach((packageName) => installedPackages.add(packageName));
        recoveryNotes.push(recovery.message || `Installed ${recovery.packages.join(", ")}.`);
        result = await runBuild(
          capturedRootPath,
          targetFile,
          requestedEngine || "lualatex",
          buildProfile
        );
        assertCapturedWorkspace();
      }
      if (recoveryNotes.length > 0 && typeof result.log === "string") {
        result.log = [
          ...recoveryNotes.map((note) => `[tex64] ${note}`),
          "",
          result.log,
        ].join("\n");
      }
      if (result.kind === "busy") {
        service.sendBuildState?.("building", "Build is already running.", buildEventContext);
        service.sendIssues?.(0, "Build is already running.", "info", []);
        return { status: "busy", targetFile, summary: "Build is already running." };
      }
      if (result.log) {
        service.sendBuildLog?.(result.log);
      }
      // Workspace refresh is presentation-side bookkeeping. A stuck renderer
      // snapshot must never hold the completed compiler result or Stop forever.
      await refreshWorkspaceAfterBuild(service, capturedRootPath, turnSignal);
      assertCapturedWorkspace();
      if (result.kind === "cancelled") {
        service.sendBuildState?.(
          "idle",
          result.summary ?? "Build cancelled.",
          buildEventContext
        );
        service.sendIssues?.(0, result.summary ?? "Build cancelled.", "info", []);
        return {
          status: "cancelled",
          targetFile,
          summary: result.summary ?? "Build cancelled.",
          logExcerpt: compileLogExcerpt(result.log),
        };
      }
      if (result.kind === "success") {
        // A PDF that came out with error-level issues (missing glyphs: the
        // text is simply absent from the page) is not a success for the
        // agent. Report it as a failure with the fix in the message, so the
        // repair round changes the setup instead of moving on.
        const errorIssues = result.issues.filter((issue) => issue.severity === "error");
        if (errorIssues.length > 0) {
          const summaryText = errorIssues[0]?.message ?? result.summary;
          service.sendBuildState?.("failed", summaryText, buildEventContext);
          service.sendIssues?.(errorIssues.length, summaryText, "error", errorIssues);
          return {
            status: "failure",
            targetFile,
            summary: `The PDF was produced but has ${errorIssues.length} error(s): ${summaryText}`,
            issues: errorIssues,
            pdfPath: result.pdfPath ?? null,
            logExcerpt: compileLogExcerpt(result.log),
          };
        }
        const warningIssues = result.issues.filter(
          (issue) => issue.severity === "warning"
        );
        if (warningIssues.length > 0) {
          const summaryText = warningIssues[0]?.message ?? result.summary;
          service.sendIssues?.(warningIssues.length, summaryText, "info", warningIssues);
        } else {
          service.sendIssues?.(0, result.summary, "success", []);
        }
        let relativePdfPath = null;
        if (typeof result.pdfPath === "string" && result.pdfPath.trim()) {
          const resolvedPdfPath = path.resolve(result.pdfPath);
          const resolvedRoot = path.resolve(capturedRootPath);
          if (
            resolvedPdfPath !== resolvedRoot &&
            resolvedPdfPath.startsWith(`${resolvedRoot}${path.sep}`)
          ) {
            relativePdfPath = path
              .relative(resolvedRoot, resolvedPdfPath)
              .split(path.sep)
              .join("/");
          }
        }
        service.sendBuildState?.("success", result.summary, {
          ...buildEventContext,
          pdfPath: relativePdfPath,
        });
        return {
          status: "success",
          targetFile,
          summary: result.summary,
          issues: result.issues,
          pdfPath: result.pdfPath ?? null,
          ...(result.issues.length > 0
            ? { logExcerpt: compileLogExcerpt(result.log) }
            : {}),
        };
      }
      if (result.kind === "failure") {
        const count = Math.max(result.issues.length, 1);
        const summaryText = result.issues[0]?.message ?? result.summary;
        service.sendBuildState?.("failed", result.summary, buildEventContext);
        service.sendIssues?.(count, summaryText, "error", result.issues);
        return {
          status: "failure",
          targetFile,
          summary: result.summary,
          issues: result.issues,
          logExcerpt: compileLogExcerpt(result.log),
        };
      }
      return { status: "unknown", summary: "Build result unknown." };
    }

    // ---- rename_latex_symbol ----
    if (name === "rename_latex_symbol") {
      const from = typeof args.from === "string" ? args.from.trim() : "";
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!from || !to) {
        return { error: "from and to are required." };
      }
      if (from === to) {
        return { error: "from and to are the same." };
      }
      const invalidPattern = /[\s,{}]/;
      if (invalidPattern.test(from) || invalidPattern.test(to)) {
        return { error: "from/to must not contain spaces or delimiters." };
      }
      const kinds = normalizeStringList(args.kinds).map((entry) => entry.toLowerCase());
      const renameLabels =
        kinds.length === 0 || kinds.includes("label") || kinds.includes("ref");
      const renameCites =
        kinds.length === 0 || kinds.includes("cite") || kinds.includes("citation");
      if (!renameLabels && !renameCites) {
        return { error: "kinds is invalid." };
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
        return { error: "Failed to get file list." };
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
                `${targetPath} has unsaved changes and snapshot is omitted.` +
                "Please save and try again.",
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
        return { error: "No matching symbol found." };
      }

      const proposals = [];
      const summaryBase =
        renameLabels && renameCites
          ? "Symbol rename"
          : renameLabels
          ? "Label rename"
          : "Citation key rename";

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
          // The workspace-wide scan and a later manual Apply can be separated
          // by arbitrary user edits. CAS the exact bytes that were scanned.
          baseContentHash: service.hashUtf8(prepared.originalContent),
          summary: `${summaryBase}: ${from} → ${to} (${prepared.appliedCount}places)`,
          isNewFile: false,
          conversationId,
          workspaceRootPath: service.workspace.getRootPath() || undefined,
        };
        if (autoApply) {
          proposal.historyBoundary = historyBoundary(service);
          service.proposals.set(id, proposal);
          const apply = await service.applyProposal(id, {
            discardOnFailure: true,
            skipAutoBuild: true,
            _workspaceRunToken: service.runningControllers?.get?.(conversationId)?.token,
          });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
            ok: Boolean(apply?.ok),
            error: apply?.ok ? undefined : apply?.error ?? "Apply failed.",
          });
        } else {
          proposal.historyBoundary = historyBoundary(service);
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
