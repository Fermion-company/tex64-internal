const fsp = require("fs/promises");
const crypto = require("crypto");
const {
  isBlockedPath,
  isTextExtension,
  normalizeEncoding,
  normalizePath,
  wantsBase64,
} = require("./agent-policy.cjs");
const {
  ALLOWED_RUN_COMMANDS,
  MAX_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  readFileFromDisk,
  hashUtf8Text,
  decodeBase64Strict,
  parseCommandLine,
  runShellCommand,
  replaceOnceWithCount,
  replaceAllWithCount,
  handleListFiles,
  handleRunCommand,
} = require("./agent-tools-file-utils.cjs");

const handleReadFile = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは読み取り禁止です。" };
  }
  const useBase64 = wantsBase64(args);
  if (!isTextExtension(targetPath, policy) && !useBase64) {
    return {
      error:
        "テキストファイルのみ読み取れます。バイナリは encoding: base64 を指定してください。",
    };
  }
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    if (useBase64) {
      return {
        content: Buffer.from(snapshot.content, "utf8").toString("base64"),
        encoding: "base64",
        binary: true,
        partial: snapshot.truncated,
        source: "buffer",
      };
    }
    return {
      content: snapshot.content,
      partial: snapshot.truncated,
      source: "buffer",
    };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  if (stat.size > policy.maxFileBytes) {
    return { error: "ファイルが大きすぎます。" };
  }
  const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
  const response = { content: result.content };
  if (result.binary) {
    response.encoding = "base64";
    response.binary = true;
    response.size = result.size;
  }
  return response;
};

const handleReadFiles = async (service, args, policy, conversationId) => {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) {
    return { error: "paths が空です。" };
  }
  if (paths.length > policy.maxReadFiles) {
    return { error: `一度に読み取れるファイルは${policy.maxReadFiles}個までです。` };
  }
  const useBase64 = wantsBase64(args);
  const results = {};
  for (const p of paths) {
    const targetPath = normalizePath(p);
    if (
      !targetPath ||
      isBlockedPath(targetPath, policy) ||
      (!isTextExtension(targetPath, policy) && !useBase64)
    ) {
      results[p] = {
        error: useBase64
          ? "読み取り不可"
          : "テキストのみ読み取り可能です。バイナリは encoding: base64 を指定してください。",
      };
      continue;
    }
    try {
      const snapshot = service.getContextSnapshot(conversationId, targetPath);
      if (snapshot && snapshot.content) {
        if (snapshot.contentLength > policy.maxFileBytes) {
          results[p] = { error: "ファイルが大きすぎます。" };
        } else {
          if (useBase64) {
            results[p] = {
              content: Buffer.from(snapshot.content, "utf8").toString("base64"),
              encoding: "base64",
              binary: true,
              partial: snapshot.truncated,
              source: "buffer",
            };
          } else {
            results[p] = {
              content: snapshot.content,
              partial: snapshot.truncated,
              source: "buffer",
            };
          }
        }
        continue;
      }
      const resolved = service.workspace.resolvePath(targetPath);
      const stat = await fsp.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > policy.maxFileBytes) {
        results[p] = { error: "ファイルが見つからないか大きすぎます" };
        continue;
      }
      const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
      results[p] = { content: result.content };
      if (result.binary) {
        results[p].encoding = "base64";
        results[p].binary = true;
        results[p].size = result.size;
      }
    } catch {
      results[p] = { error: "読み取りエラー" };
    }
  }
  return { files: results };
};

const AUTO_APPLY_MAX_CHANGED_LINES = 80;

const shouldAutoApply = (service, proposal) => {
  if (service?.agentOptions?.autoApply !== true) return false;
  if (!proposal) return true;
  // For large changes, fall back to proposal mode so the user can review
  const original = typeof proposal.originalContent === "string" ? proposal.originalContent : "";
  const content = typeof proposal.content === "string" ? proposal.content : "";
  const originalLines = original.split("\n").length;
  const contentLines = content.split("\n").length;
  const changedLines = Math.abs(contentLines - originalLines) + Math.min(originalLines, contentLines);
  // Estimate: if the diff is very large, require review
  if (original.length === 0 && content.length === 0) return true;
  if (original === content) return true;
  // Simple heuristic: if total line count change is large, require approval
  const diffSize = Math.abs(contentLines - originalLines);
  const totalLines = Math.max(originalLines, contentLines);
  if (totalLines > AUTO_APPLY_MAX_CHANGED_LINES && diffSize > AUTO_APPLY_MAX_CHANGED_LINES / 2) {
    return false;
  }
  // If the content change is very large (>80% of file rewritten), require approval
  if (original.length > 0 && Math.abs(content.length - original.length) > original.length * 0.8) {
    if (totalLines > AUTO_APPLY_MAX_CHANGED_LINES) return false;
  }
  return true;
};

const autoApplyProposal = async (service, proposal, options = {}) => {
  service.proposals.set(proposal.id, proposal);
  const applyResult = await service.applyProposal(proposal.id, {
    discardOnFailure: true,
    ...options,
  });
  if (applyResult && typeof applyResult === "object") {
    return applyResult;
  }
  return { ok: false, proposalId: proposal.id, error: "操作に失敗しました。" };
};

const handleProposeWrite = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  const summary = typeof args.summary === "string" ? args.summary : "";
  const encoding = normalizeEncoding(args.encoding);
  const binaryWrite = encoding === "base64";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは書き込み禁止です。" };
  }
  if (!isTextExtension(targetPath, policy) && !binaryWrite) {
    return {
      error:
        "テキストファイルのみ書き込み可能です。バイナリは encoding: base64 を指定してください。",
    };
  }
  let contentBytes = Buffer.byteLength(content, "utf8");
  if (binaryWrite) {
    const decoded = decodeBase64Strict(content);
    if (!decoded) {
      return { error: "base64 の内容が不正です。" };
    }
    contentBytes = decoded.buffer.length;
  }
  if (contentBytes > policy.maxFileBytes) {
    return { error: "内容が大きすぎます。" };
  }
  let originalContent = "";
  let isNewFile = true;
  let isBinary = binaryWrite;
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = binaryWrite
      ? Buffer.from(snapshot.content, "utf8").toString("base64")
      : snapshot.content;
    isNewFile = false;
    if (!snapshot.isDirty && !snapshot.truncated) {
      baseContentHash = hashUtf8Text(snapshot.content);
      baseSource = "snapshot";
    }
  } else {
    try {
      const resolved = service.workspace.resolvePath(targetPath);
      const result = await readFileFromDisk(resolved, { forceBase64: binaryWrite });
      originalContent = result.content;
      isBinary = isBinary || result.binary;
      isNewFile = false;
      baseContentHash = result.contentHash;
      baseSource = "disk";
    } catch {
      originalContent = "";
      isNewFile = true;
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "write",
    path: targetPath,
    content,
    originalContent,
    encoding: binaryWrite ? "base64" : undefined,
    isBinary,
    summary,
    isNewFile,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseContentHash: typeof baseContentHash === "string" ? baseContentHash : undefined,
    baseExists: !isNewFile,
    baseSource: baseSource || undefined,
    createdAt: Date.now(),
  };
  if (shouldAutoApply(service, proposal)) {
    const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
    return {
      status: apply.ok ? "applied" : "apply_failed",
      proposalId: id,
      path: targetPath,
      apply,
      ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
    };
  }
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposePatch = async (service, args, policy, conversationId) => {
  const summaryPrefix = typeof args.summary === "string" ? args.summary.trim() : "";
  const editsArg = Array.isArray(args.edits) ? args.edits : null;
  const normalizedEdits = [];

  if (editsArg && editsArg.length === 0) {
    return { error: "edits が空です。" };
  }

  if (editsArg && editsArg.length > 0) {
    for (const edit of editsArg) {
      const targetPath = normalizePath(edit?.path);
      const search = typeof edit?.search === "string" ? edit.search : "";
      const replace = typeof edit?.replace === "string" ? edit.replace : "";
      const replaceAll = edit?.replaceAll === true;
      if (!targetPath || !search) {
        return { error: "edits の各項目に path と search は必須です。" };
      }
      normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
    }
  } else {
    const targetPath = normalizePath(args.path);
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const replaceAll = args.replaceAll === true;
    if (!targetPath || !search) {
      return { error: "path と search は必須です。" };
    }
    normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
  }

  const editsByPath = new Map();
  for (const edit of normalizedEdits) {
    if (isBlockedPath(edit.path, policy)) {
      return { error: "対象パスは編集禁止です。" };
    }
    if (!isTextExtension(edit.path, policy)) {
      return { error: "テキストファイルのみ編集可能です。" };
    }
    if (!editsByPath.has(edit.path)) {
      editsByPath.set(edit.path, []);
    }
    editsByPath.get(edit.path).push(edit);
  }

  const fileCount = editsByPath.size;
  const preparedProposals = [];

  const buildSummary = (path, edits, appliedCount) => {
    if (summaryPrefix && fileCount === 1) {
      return summaryPrefix;
    }
    let base = "";
    if (edits.length === 1) {
      const searchPreview = edits[0].search.slice(0, 20);
      const replacePreview = edits[0].replace.slice(0, 20);
      base = `"${searchPreview}..." → "${replacePreview}..." (${appliedCount}箇所)`;
    } else {
      base = `${edits.length}件の置換（${appliedCount}箇所）`;
    }
    if (!summaryPrefix) {
      return base;
    }
    return `${summaryPrefix} (${path}: ${base})`;
  };

  for (const [targetPath, edits] of editsByPath.entries()) {
    let originalContent = "";
    let baseContentHash = null;
    let baseSource = null;
    // Always read from disk first so that sequential propose_patch calls within the
    // same run each operate on the current file content rather than a stale snapshot.
    let diskRead = false;
    try {
      const resolved = service.workspace.resolvePath(targetPath);
      const result = await readFileFromDisk(resolved);
      if (result.binary) {
        return { error: "バイナリファイルのため部分編集できません。" };
      }
      if (result.size > policy.maxFileBytes) {
        return { error: "ファイルが大きすぎます。" };
      }
      originalContent = result.content;
      baseContentHash = result.contentHash;
      baseSource = "disk";
      diskRead = true;
    } catch {
      // File not on disk – fall back to snapshot.
    }
    if (!diskRead) {
      const snapshot = service.getContextSnapshot(conversationId, targetPath);
      if (snapshot && snapshot.content) {
        if (snapshot.contentLength > policy.maxFileBytes) {
          return { error: "ファイルが大きすぎます。" };
        }
        originalContent = snapshot.content;
        if (!snapshot.isDirty && !snapshot.truncated) {
          baseContentHash = hashUtf8Text(snapshot.content);
          baseSource = "snapshot";
        }
      } else {
        return { error: "ファイルが見つかりません。" };
      }
    }
    let updatedContent = originalContent;
    let appliedCount = 0;
    for (const edit of edits) {
      const result = edit.replaceAll
        ? replaceAllWithCount(updatedContent, edit.search, edit.replace)
        : replaceOnceWithCount(updatedContent, edit.search, edit.replace);
      if (result.count === 0) {
        return { error: `${targetPath} に検索文字列が見つかりません。` };
      }
      updatedContent = result.text;
      appliedCount += result.count;
    }
    if (appliedCount === 0 || updatedContent === originalContent) {
      return { error: "変更がありません。" };
    }
    if (updatedContent.length > policy.maxFileBytes) {
      return { error: "内容が大きすぎます。" };
    }
    preparedProposals.push({
      path: targetPath,
      edits,
      originalContent,
      updatedContent,
      appliedCount,
      baseContentHash,
      baseSource,
    });
  }

  const proposals = [];
  const baseAutoApply = shouldAutoApply(service);
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
      summary: buildSummary(prepared.path, prepared.edits, prepared.appliedCount),
      isNewFile: false,
      conversationId,
      workspaceRootPath: service.workspace.getRootPath() || undefined,
      baseContentHash:
        typeof prepared.baseContentHash === "string" ? prepared.baseContentHash : undefined,
      baseExists: true,
      baseSource: prepared.baseSource || undefined,
      createdAt: Date.now(),
    };
    const autoApply = baseAutoApply && shouldAutoApply(service, proposal);
    if (autoApply) {
      const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
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

  if (baseAutoApply) {
    const successCount = proposals.filter((entry) => entry.ok).length;
    const hasFailure = proposals.length > successCount;
    return {
      status: hasFailure ? (successCount > 0 ? "partially_applied" : "apply_failed") : "applied",
      proposalIds: proposals.map((proposal) => proposal.proposalId),
      files: proposals,
    };
  }

  return {
    status: "proposed",
    proposalIds: proposals.map((proposal) => proposal.proposalId),
    files: proposals,
  };
};

const handleReplaceLines = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "";
  const startLineRaw = Number(args.startLine);
  const endLineRaw = args.endLine === undefined ? startLineRaw : Number(args.endLine);
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは編集禁止です。" };
  }
  if (!isTextExtension(targetPath, policy)) {
    return { error: "テキストファイルのみ編集可能です。" };
  }
  if (!Number.isFinite(startLineRaw) || startLineRaw < 1) {
    return { error: "startLine は 1 以上の数値が必要です。" };
  }
  if (!Number.isFinite(endLineRaw) || endLineRaw < startLineRaw) {
    return { error: "endLine は startLine 以上の数値が必要です。" };
  }
  const startLine = Math.round(startLineRaw);
  const endLine = Math.round(endLineRaw);
  const replacementText = typeof args.content === "string" ? args.content : "";

  let originalContent = "";
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = snapshot.content;
    if (!snapshot.isDirty && !snapshot.truncated) {
      baseContentHash = hashUtf8Text(snapshot.content);
      baseSource = "snapshot";
    }
  } else {
    try {
      const resolved = service.workspace.resolvePath(targetPath);
      const result = await readFileFromDisk(resolved);
      if (result.binary) {
        return { error: "バイナリファイルのため行置換できません。" };
      }
      originalContent = result.content;
      baseContentHash = result.contentHash;
      baseSource = "disk";
    } catch {
      return { error: "ファイルが見つかりません。" };
    }
  }

  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
  const originalLines = normalizedOriginal.split("\n");
  const startIndex = startLine - 1;
  const endIndex = endLine - 1;
  if (startIndex < 0 || startIndex >= originalLines.length) {
    return { error: "startLine が範囲外です。" };
  }
  if (endIndex < 0 || endIndex >= originalLines.length) {
    return { error: "endLine が範囲外です。" };
  }

  const normalizedReplacement = replacementText.replace(/\r\n/g, "\n");
  const replacementLines = normalizedReplacement.split("\n");
  const updatedLines = [
    ...originalLines.slice(0, startIndex),
    ...replacementLines,
    ...originalLines.slice(endIndex + 1),
  ];
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  if (updatedContent === originalContent) {
    return { error: "変更がありません。" };
  }
  if (Buffer.byteLength(updatedContent, "utf8") > policy.maxFileBytes) {
    return { error: "内容が大きすぎます。" };
  }

  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const lineRangeLabel = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  const proposal = {
    id,
    type: "patch",
    path: targetPath,
    content: updatedContent,
    originalContent,
    summary: summary.trim() ? summary : `行置換: ${targetPath}:${lineRangeLabel}`,
    isNewFile: false,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseContentHash: typeof baseContentHash === "string" ? baseContentHash : undefined,
    baseExists: true,
    baseSource: baseSource || undefined,
    createdAt: Date.now(),
  };

  if (shouldAutoApply(service, proposal)) {
    const apply = await autoApplyProposal(service, proposal);
    return {
      status: apply.ok ? "applied" : "apply_failed",
      proposalId: id,
      path: targetPath,
      apply,
      autoBuild: apply.autoBuild ?? null,
      ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
    };
  }
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposeDelete = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "ファイル削除";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは削除禁止です。" };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  let originalContent = "";
  let isBinary = false;
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = snapshot.content;
    if (!snapshot.isDirty && !snapshot.truncated) {
      baseContentHash = hashUtf8Text(snapshot.content);
      baseSource = "snapshot";
    }
  } else {
    try {
      const result = await readFileFromDisk(resolved);
      originalContent = result.content;
      isBinary = result.binary;
      baseContentHash = result.contentHash;
      baseSource = "disk";
    } catch {
      originalContent = "";
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "delete",
    path: targetPath,
    content: "",
    originalContent,
    isBinary,
    summary,
    isNewFile: false,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseContentHash: typeof baseContentHash === "string" ? baseContentHash : undefined,
    baseExists: true,
    baseSource: baseSource || undefined,
    createdAt: Date.now(),
  };
  if (shouldAutoApply(service)) {
    const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
    return {
      status: apply.ok ? "applied" : "apply_failed",
      proposalId: id,
      path: targetPath,
      apply,
      ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
    };
  }
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposeRename = async (service, args, policy, conversationId) => {
  const oldPath = normalizePath(args.oldPath);
  const newPath = normalizePath(args.newPath);
  const summary = typeof args.summary === "string" ? args.summary : `${oldPath} → ${newPath}`;
  if (!oldPath || !newPath) {
    return { error: "oldPath と newPath は必須です。" };
  }
  if (isBlockedPath(oldPath, policy) || isBlockedPath(newPath, policy)) {
    return { error: "対象パスは操作禁止です。" };
  }
  const resolved = service.workspace.resolvePath(oldPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  let originalContent = "";
  let isBinary = false;
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, oldPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = snapshot.content;
    if (!snapshot.isDirty && !snapshot.truncated) {
      baseContentHash = hashUtf8Text(snapshot.content);
      baseSource = "snapshot";
    }
  } else {
    try {
      const result = await readFileFromDisk(resolved);
      originalContent = result.content;
      isBinary = result.binary;
      baseContentHash = result.contentHash;
      baseSource = "disk";
    } catch {
      originalContent = "";
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "rename",
    path: newPath,
    oldPath,
    content: originalContent,
    originalContent,
    isBinary,
    summary,
    isNewFile: false,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseContentHash: typeof baseContentHash === "string" ? baseContentHash : undefined,
    baseExists: true,
    baseSource: baseSource || undefined,
    createdAt: Date.now(),
  };
  if (shouldAutoApply(service)) {
    const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
    return {
      status: apply.ok ? "applied" : "apply_failed",
      proposalId: id,
      path: newPath,
      apply,
      ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
    };
  }
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposeCreateDirectory = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "ディレクトリ作成";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは作成禁止です。" };
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "mkdir",
    path: targetPath,
    content: "",
    originalContent: "",
    summary,
    isNewFile: true,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseExists: false,
    createdAt: Date.now(),
  };
  if (shouldAutoApply(service)) {
    const apply = await autoApplyProposal(service, proposal);
    return {
      status: apply.ok ? "applied" : "apply_failed",
      proposalId: id,
      path: targetPath,
      apply,
      autoBuild: apply.autoBuild ?? null,
      ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
    };
  }
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

module.exports = {
  ALLOWED_RUN_COMMANDS,
  MAX_COMMAND_TIMEOUT_MS,
  decodeBase64Strict,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  handleListFiles,
  handleProposeCreateDirectory,
  handleProposeDelete,
  handleProposePatch,
  handleProposeRename,
  handleProposeWrite,
  handleReplaceLines,
  handleReadFile,
  handleReadFiles,
  handleRunCommand,
  readFileFromDisk,
  replaceAllWithCount,
  replaceOnceWithCount,
  runShellCommand,
  parseCommandLine,
};
