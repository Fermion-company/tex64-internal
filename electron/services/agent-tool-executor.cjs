const path = require("path");
const fsp = require("fs/promises");
const { normalizeRelativePath } = require("./workspace.cjs");
const {
  DEFAULT_MAX_FILE_BYTES,
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
const {
  handleListFiles,
  handleProposeCreateDirectory,
  handleProposeDelete,
  handleProposePatch,
  handleReplaceLines,
  handleProposeRename,
  handleProposeWrite,
  handleReadFile,
  handleReadFiles,
  handleRunCommand,
  readFileFromDisk,
} = require("./agent-tools-file.cjs");
const { handleSearchFiles } = require("./agent-tools-search.cjs");
const { handleSearchWeb, handleReadUrl } = require("./agent-tools-web.cjs");
const {
  openTerminalSession,
  executeBashCommand,
  sendTerminalInput,
  readTerminalOutput,
  killTerminalSession,
} = require("./agent-terminal-runtime.cjs");
const { TOOL_STATUS_LABELS, clipText } = require("./agent-core-utils.cjs");

const MAX_SCRATCHPAD_CHARS = 200_000;

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
    const statusLabel = TOOL_STATUS_LABELS[name];
    if (statusLabel) {
      let detail = statusLabel;
      if (name === "read_file") {
        const targetPath = normalizePath(args.path);
        if (targetPath) detail = `${statusLabel}: ${targetPath}`;
      } else if (name === "read_files") {
        const paths = normalizeStringList(args.paths).slice(0, 3);
        if (paths.length > 0) {
          const suffix = normalizeStringList(args.paths).length > 3 ? "…" : "";
          detail = `${statusLabel}: ${paths.join(", ")}${suffix}`;
        }
      } else if (name === "search_files") {
        const query = clip(args.query, 48);
        if (query) detail = `${statusLabel}: ${query}`;
      } else if (name === "list_files") {
        const directory = normalizePath(args.directory);
        if (directory) detail = `${statusLabel}: ${directory}`;
      } else if (name === "get_index") {
        const kinds = normalizeStringList(args.kinds).slice(0, 4);
        const query = clip(args.query, 32);
        if (kinds.length > 0 || query) {
          const parts = [];
          if (kinds.length > 0) parts.push(kinds.join(", "));
          if (query) parts.push(`q=${query}`);
          detail = `${statusLabel}: ${parts.join(" ")}`;
        }
      } else if (name === "rename_latex_symbol") {
        const from = clip(args.from, 24);
        const to = clip(args.to, 24);
        if (from && to) detail = `${statusLabel}: ${from} → ${to}`;
      } else if (name === "run_build") {
        const mainFile = clip(args.mainFile, 64);
        const engine = clip(args.engine, 16);
        if (mainFile || engine) {
          detail = `${statusLabel}: ${[mainFile, engine].filter(Boolean).join(" ")}`;
        }
      } else if (name === "run_command") {
        const command = clip(args.command, 64);
        if (command) detail = `${statusLabel}: ${command}`;
      } else if (name === "execute_bash_command") {
        const command = clip(args.command, 64);
        if (command) detail = `${statusLabel}: ${command}`;
      } else if (
        name === "open_terminal_session" ||
        name === "send_terminal_input" ||
        name === "read_terminal_output" ||
        name === "kill_terminal"
      ) {
        const sessionId = clip(args.sessionId, 32);
        if (sessionId) detail = `${statusLabel}: ${sessionId}`;
      } else if (name === "search_web") {
        const query = clip(args.query, 48);
        if (query) detail = `${statusLabel}: ${query}`;
      } else if (name === "read_url") {
        const url = clip(args.url, 64);
        if (url) detail = `${statusLabel}: ${url}`;
      } else if (
        name === "write_file" ||
        name === "patch_file" ||
        name === "replace_lines" ||
        name === "delete_file" ||
        name === "rename_file" ||
        name === "create_directory" ||
        name === "propose_write" ||
        name === "propose_patch" ||
        name === "propose_delete" ||
        name === "propose_rename" ||
        name === "propose_create_directory"
      ) {
        const targetPath = clip(args.path || args.oldPath || args.newPath, 80);
        if (targetPath) detail = `${statusLabel}: ${targetPath}`;
      }
      service.sendStatus("running", service.buildProgressMessage(detail), conversationId);
    }

    if (name === "list_files") {
      return handleListFiles(service, args, policy);
    }

    if (name === "read_file") {
      return handleReadFile(service, args, policy, conversationId);
    }

    if (name === "read_files") {
      return handleReadFiles(service, args, policy, conversationId);
    }

    if (name === "search_files") {
      return handleSearchFiles(service, args, policy, conversationId);
    }

    if (name === "search_web") {
      return handleSearchWeb(service, args);
    }

    if (name === "read_url") {
      return handleReadUrl(service, args);
    }

    if (name === "replace_lines") {
      return handleReplaceLines(service, args, policy, conversationId);
    }

    if (name === "get_project_structure") {
      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;
      const rootPath = service.workspace.getRootPath();
      if (!rootPath) {
        return { error: "ワークスペースが選択されていません。" };
      }
      const buildTree = async (dir, depth) => {
        if (depth > maxDepth) return null;
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name, "ja");
        });
        const result = [];
        for (const entry of entries) {
          const absPath = path.join(dir, entry.name);
          const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
          const top = relPath.split("/")[0];
          if (policy.blockedTopLevel.has(top) && !policy.allowedTopLevel.has(top)) {
            continue;
          }
          if (entry.isDirectory()) {
            const children = await buildTree(absPath, depth + 1);
            result.push({
              name: entry.name,
              path: relPath,
              type: "dir",
              children: children || [],
            });
          } else {
            result.push({ name: entry.name, path: relPath, type: "file" });
          }
        }
        return result;
      };
      const tree = await buildTree(rootPath, 1);
      return { structure: tree };
    }

    if (name === "get_index") {
      const rootPath = service.workspace.getRootPath();
      if (!rootPath) {
        return { error: "ワークスペースが選択されていません。" };
      }
      if (!service.indexerService) {
        return { error: "インデクサが利用できません。" };
      }
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
      const query =
        typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : "";
      const kinds = Array.isArray(args.kinds)
        ? args.kinds.filter((kind) => typeof kind === "string")
        : [];
      const snapshot = await service.indexerService.buildIndex(rootPath);
      const filterSymbols = (items, keyField) => {
        let result = items;
        if (query) {
          result = result.filter((entry) =>
            String(entry[keyField] ?? "").toLowerCase().includes(query)
          );
        }
        if (Number.isFinite(limit)) {
          result = result.slice(0, Math.max(0, limit));
        }
        return result;
      };
      const includeAll = kinds.length === 0;
      const data = {};
      if (includeAll || kinds.includes("labels")) {
        data.labels = filterSymbols(snapshot.labels, "key");
      }
      if (includeAll || kinds.includes("references")) {
        data.references = filterSymbols(snapshot.references, "key");
      }
      if (includeAll || kinds.includes("citations")) {
        data.citations = filterSymbols(snapshot.citations, "key");
      }
      if (includeAll || kinds.includes("sections")) {
        data.sections = filterSymbols(snapshot.sections, "title");
      }
      if (includeAll || kinds.includes("figures")) {
        data.figures = filterSymbols(snapshot.figures, "key");
      }
      if (includeAll || kinds.includes("tables")) {
        data.tables = filterSymbols(snapshot.tables, "key");
      }
      if (includeAll || kinds.includes("todos")) {
        data.todos = filterSymbols(snapshot.todos, "key");
      }
      return { index: data };
    }

    if (name === "get_app_settings") {
      const keys = Array.isArray(args.keys)
        ? args.keys.filter((entry) => typeof entry === "string")
        : [];
      const response = await service.requestAppSettings("get", { keys });
      if (response?.error) {
        return { error: response.error };
      }
      const settings = response?.settings ?? response?.payload?.settings ?? null;
      if (!settings) {
        return { error: "設定が取得できませんでした。" };
      }
      if (keys.length === 0) {
        return { settings };
      }
      const filtered = {};
      keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
          filtered[key] = settings[key];
        }
      });
      return { settings: filtered };
    }

    if (name === "set_app_settings") {
      const patch =
        args?.settings && typeof args.settings === "object" ? args.settings : null;
      if (!patch) {
        return { error: "settings が空です。" };
      }
      const response = await service.requestAppSettings("set", { settings: patch });
      if (response?.error) {
        return { error: response.error };
      }
      const settings = response?.settings ?? response?.payload?.settings ?? null;
      if (!settings) {
        return { error: "設定が更新できませんでした。" };
      }
      return { settings };
    }

    if (name === "read_scratchpad") {
      const cid =
        typeof conversationId === "string" && conversationId.trim()
          ? conversationId.trim()
          : "default";
      const content = service.scratchpadByConversation.get(cid) ?? "";
      return { content, length: content.length };
    }

    if (name === "write_scratchpad") {
      const cid =
        typeof conversationId === "string" && conversationId.trim()
          ? conversationId.trim()
          : "default";
      const modeRaw = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
      const mode = modeRaw === "append" || modeRaw === "clear" ? modeRaw : "replace";
      const input = typeof args.content === "string" ? args.content : "";
      const current = service.scratchpadByConversation.get(cid) ?? "";
      let next = current;
      if (mode === "clear") {
        next = "";
      } else if (mode === "append") {
        const suffix = input.trim();
        if (suffix) {
          next = current ? `${current}\n${suffix}` : suffix;
        }
      } else {
        next = input;
      }
      if (next.length > MAX_SCRATCHPAD_CHARS) {
        next = next.slice(next.length - MAX_SCRATCHPAD_CHARS);
      }
      service.scratchpadByConversation.set(cid, next);
      service.markSessionDirty(cid);
      service.sendToRenderer("agent:scratchpad", {
        content: next,
        conversationId: cid,
      });
      return { status: "ok", mode, content: next, length: next.length };
    }

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
      service.sendBuildState?.("building", "Axiom がビルド中...");
      service.sendIssues?.(0, "Axiom がビルド中...", "info", []);
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

    if (name === "run_command") {
      return handleRunCommand(service, args);
    }

    if (name === "open_terminal_session") {
      return openTerminalSession(service, args, conversationId || "default");
    }

    if (name === "execute_bash_command") {
      return executeBashCommand(service, args, conversationId || "default");
    }

    if (name === "send_terminal_input") {
      return sendTerminalInput(service, args);
    }

    if (name === "read_terminal_output") {
      return readTerminalOutput(service, args);
    }

    if (name === "kill_terminal") {
      return killTerminalSession(service, args);
    }

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

    if (name === "propose_write" || name === "write_file") {
      return handleProposeWrite(service, args, policy, conversationId);
    }

    if (name === "propose_patch" || name === "patch_file") {
      return handleProposePatch(service, args, policy, conversationId);
    }

    if (name === "propose_delete" || name === "delete_file") {
      return handleProposeDelete(service, args, policy, conversationId);
    }

    if (name === "propose_rename" || name === "rename_file") {
      return handleProposeRename(service, args, policy, conversationId);
    }

    if (name === "propose_create_directory" || name === "create_directory") {
      return handleProposeCreateDirectory(service, args, policy, conversationId);
    }

    return { error: `unknown tool: ${name}` };
  } catch (error) {
    return { error: error?.message ?? "tool error" };
  }
};

module.exports = {
  executeToolCall,
};
