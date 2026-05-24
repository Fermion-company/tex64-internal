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
const {
  hashContent,
  shortSha,
  describeChange,
  isDestructiveShrink,
  verifyExpectedSha,
  verifyPostWrite,
  checkLatexInvariants,
  formatChangeSummary,
} = require("./agent-tools-safety.cjs");

const handleReadFile = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is read-protected." };
  }
  const useBase64 = wantsBase64(args);
  if (!isTextExtension(targetPath, policy) && !useBase64) {
    return {
      error:
        "Only text files can be read. Specify encoding: base64 for binary.",
    };
  }
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "File is too large." };
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
    return { error: "file not found." };
  }
  if (stat.size > policy.maxFileBytes) {
    return { error: "File is too large." };
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
    return { error: "paths is empty." };
  }
  if (paths.length > policy.maxReadFiles) {
    return { error: `Up to ${policy.maxReadFiles} files can be read at once.` };
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
          ? "Unreadable"
          : "Only text files readable. Specify encoding: base64 for binary.",
      };
      continue;
    }
    try {
      const snapshot = service.getContextSnapshot(conversationId, targetPath);
      if (snapshot && snapshot.content) {
        if (snapshot.contentLength > policy.maxFileBytes) {
          results[p] = { error: "File is too large." };
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
        results[p] = { error: "File not found or too large" };
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
      results[p] = { error: "Read error" };
    }
  }
  return { files: results };
};

const autoApplyProposal = async (service, proposal, options = {}) => {
  service.proposals.set(proposal.id, proposal);
  const applyResult = await service.applyProposal(proposal.id, {
    discardOnFailure: true,
    ...options,
  });
  const result =
    applyResult && typeof applyResult === "object"
      ? applyResult
      : { ok: false, proposalId: proposal.id, error: "Operation failed." };
  // Send proposal to renderer so the chat shows a summary card (already in applied state)
  if (result.ok) {
    service.sendToRenderer("agent:proposal", {
      proposal: { ...proposal, autoApplied: true },
    });
  }
  return result;
};

const handleProposeWrite = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  const summary = typeof args.summary === "string" ? args.summary : "";
  const encoding = normalizeEncoding(args.encoding);
  const binaryWrite = encoding === "base64";
  // Safety flags passed through from the tool layer:
  //   args.mode           — "create" (new file only) | "overwrite" (existing only) | "any"
  //   args.allowFullRewrite — explicit acknowledgement for destructive shrinks
  const mode = typeof args.mode === "string" ? args.mode : "any";
  const allowFullRewrite = args.allowFullRewrite === true;
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is write-protected." };
  }
  if (!isTextExtension(targetPath, policy) && !binaryWrite) {
    return {
      error:
        "Only text files can be written. Specify encoding: base64 for binary.",
    };
  }
  let contentBytes = Buffer.byteLength(content, "utf8");
  if (binaryWrite) {
    const decoded = decodeBase64Strict(content);
    if (!decoded) {
      return { error: "Invalid base64 content." };
    }
    contentBytes = decoded.buffer.length;
  }
  if (contentBytes > policy.maxFileBytes) {
    return { error: "Content is too large." };
  }
  let originalContent = "";
  let isNewFile = true;
  let isBinary = binaryWrite;
  let baseContentHash = null;
  let baseSource = null;
  // Always read from disk FIRST when a file exists on disk. The context
  // snapshot was the source of several hallucination bugs: it went stale
  // after consecutive writes, and `handleProposeWrite` would then operate
  // on a phantom version of the file that no longer matched reality.
  let diskRead = false;
  try {
    const resolved = service.workspace.resolvePath(targetPath);
    const result = await readFileFromDisk(resolved, { forceBase64: binaryWrite });
    originalContent = result.content;
    isBinary = isBinary || result.binary;
    isNewFile = false;
    baseContentHash = result.contentHash;
    baseSource = "disk";
    diskRead = true;
  } catch {
    // File not on disk — may still be open in the editor via snapshot.
  }
  if (!diskRead) {
    const snapshot = service.getContextSnapshot(conversationId, targetPath);
    if (snapshot && snapshot.content) {
      if (snapshot.contentLength > policy.maxFileBytes) {
        return { error: "File is too large." };
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
      originalContent = "";
      isNewFile = true;
    }
  }

  // ---- Mode enforcement ----
  if (mode === "create" && !isNewFile) {
    return {
      error:
        "create_file requires the target not to exist. File already exists: " +
        targetPath +
        ". Use replace_lines / insert_lines / delete_lines for surgical edits, " +
        "or write_file with allowFullRewrite=true if you truly mean to replace the whole file.",
    };
  }
  if (mode === "overwrite" && isNewFile) {
    return {
      error:
        "overwrite mode requires the file to already exist, but " +
        targetPath +
        " does not. Use create_file for new files.",
    };
  }

  // ---- Destructive shrink guard ----
  // Skip for new files (nothing to shrink) and for binary writes.
  if (!isNewFile && !binaryWrite && !allowFullRewrite) {
    if (isDestructiveShrink(originalContent, content)) {
      const oldLines = originalContent.split(/\r?\n/).length;
      const newLines = content.split(/\r?\n/).length;
      return {
        error:
          "DESTRUCTIVE SHRINK REJECTED: this write would shrink " +
          targetPath +
          " from " +
          oldLines +
          " lines to " +
          newLines +
          " lines. This is almost always a bug — full-file `write_file` is the " +
          "wrong tool for targeted edits. Prefer replace_lines, insert_lines, " +
          "delete_lines, or replace_section. If you truly intend to replace the " +
          "entire file, retry with allowFullRewrite=true.",
        conflict: true,
      };
    }
    const brokenInvariants = checkLatexInvariants(targetPath, originalContent, content);
    if (brokenInvariants.length > 0) {
      return {
        error:
          "STRUCTURAL INVARIANT VIOLATION: this write would remove critical LaTeX " +
          "elements that were present in the original file: " +
          brokenInvariants.join(", ") +
          ". These elements are protected. If you truly intend to restructure the " +
          "document, pass allowFullRewrite=true. Otherwise, use targeted edit tools " +
          "(replace_lines, replace_section) so the listed elements remain intact.",
        conflict: true,
        brokenInvariants,
      };
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
  const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
  if (!apply.ok) {
    return {
      status: "apply_failed",
      proposalId: id,
      path: targetPath,
      apply,
      error: apply.error,
      conflict: apply.conflict === true,
    };
  }

  // ---- Post-write verification ----
  // Re-read from disk and compare against what we intended to write.
  // This catches silent drops / partial applies where the editor buffer
  // got out of sync with the file system.
  if (!binaryWrite) {
    const resolved = service.workspace.resolvePath(targetPath);
    const verify = await verifyPostWrite(resolved, content);
    if (!verify.ok) {
      return {
        status: "apply_failed",
        proposalId: id,
        path: targetPath,
        error: verify.error,
      };
    }
    const change = describeChange(originalContent, content);
    return {
      status: "applied",
      proposalId: id,
      path: targetPath,
      apply,
      change,
      verified: true,
      summary: formatChangeSummary(targetPath, change),
      sha: verify.actualSha,
    };
  }

  return {
    status: "applied",
    proposalId: id,
    path: targetPath,
    apply,
  };
};

const handleProposePatch = async (service, args, policy, conversationId) => {
  const summaryPrefix = typeof args.summary === "string" ? args.summary.trim() : "";
  const editsArg = Array.isArray(args.edits) ? args.edits : null;
  const normalizedEdits = [];

  if (editsArg && editsArg.length === 0) {
    return { error: "edits is empty." };
  }

  if (editsArg && editsArg.length > 0) {
    for (const edit of editsArg) {
      const targetPath = normalizePath(edit?.path);
      const search = typeof edit?.search === "string" ? edit.search : "";
      const replace = typeof edit?.replace === "string" ? edit.replace : "";
      const replaceAll = edit?.replaceAll === true;
      if (!targetPath || !search) {
        return { error: "path and search are required for each edit." };
      }
      normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
    }
  } else {
    const targetPath = normalizePath(args.path);
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const replaceAll = args.replaceAll === true;
    if (!targetPath || !search) {
      return { error: "path and search are required." };
    }
    normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
  }

  const editsByPath = new Map();
  for (const edit of normalizedEdits) {
    if (isBlockedPath(edit.path, policy)) {
      return { error: "Target path is edit-protected." };
    }
    if (!isTextExtension(edit.path, policy)) {
      return { error: "Only text files can be edited." };
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
      base = `"${searchPreview}..." → "${replacePreview}..." (${appliedCount}places)`;
    } else {
      base = `${edits.length} replacements (${appliedCount} places)`;
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
    // Always read from disk first so that sequential write_file calls within the
    // same run each operate on the current file content rather than a stale snapshot.
    let diskRead = false;
    try {
      const resolved = service.workspace.resolvePath(targetPath);
      const result = await readFileFromDisk(resolved);
      if (result.binary) {
        return { error: "Cannot partially edit binary file." };
      }
      if (result.size > policy.maxFileBytes) {
        return { error: "File is too large." };
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
          return { error: "File is too large." };
        }
        originalContent = snapshot.content;
        if (!snapshot.isDirty && !snapshot.truncated) {
          baseContentHash = hashUtf8Text(snapshot.content);
          baseSource = "snapshot";
        }
      } else {
        return { error: "file not found." };
      }
    }
    let updatedContent = originalContent;
    let appliedCount = 0;
    for (const edit of edits) {
      const result = edit.replaceAll
        ? replaceAllWithCount(updatedContent, edit.search, edit.replace)
        : replaceOnceWithCount(updatedContent, edit.search, edit.replace);
      if (result.count === 0) {
        return { error: `${targetPath}  search string not found.` };
      }
      updatedContent = result.text;
      appliedCount += result.count;
    }
    if (appliedCount === 0 || updatedContent === originalContent) {
      return { error: "No changes." };
    }
    if (updatedContent.length > policy.maxFileBytes) {
      return { error: "Content is too large." };
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
    const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
    proposals.push({
      proposalId: id,
      path: prepared.path,
      appliedCount: prepared.appliedCount,
      ok: Boolean(apply?.ok),
      error: apply?.ok ? undefined : apply?.error ?? "Apply failed.",
    });
  }

  const successCount = proposals.filter((entry) => entry.ok).length;
  const hasFailure = proposals.length > successCount;
  return {
    status: hasFailure ? (successCount > 0 ? "partially_applied" : "apply_failed") : "applied",
    proposalIds: proposals.map((proposal) => proposal.proposalId),
    files: proposals,
  };
};

/**
 * Shared helper: read the current text content for an existing file,
 * preferring disk so we never operate on a stale snapshot. Returns
 * { ok, content, baseContentHash, baseSource, error? }.
 */
const readCurrentTextContent = async (service, policy, conversationId, targetPath) => {
  try {
    const resolved = service.workspace.resolvePath(targetPath);
    const result = await readFileFromDisk(resolved);
    if (result.binary) {
      return { ok: false, error: "Cannot edit a binary file." };
    }
    if (result.size > policy.maxFileBytes) {
      return { ok: false, error: "File is too large." };
    }
    return {
      ok: true,
      content: result.content,
      baseContentHash: result.contentHash,
      baseSource: "disk",
    };
  } catch {
    // Fall through to snapshot
  }
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { ok: false, error: "File is too large." };
    }
    return {
      ok: true,
      content: snapshot.content,
      baseContentHash:
        !snapshot.isDirty && !snapshot.truncated
          ? hashUtf8Text(snapshot.content)
          : null,
      baseSource: "snapshot",
    };
  }
  return { ok: false, error: "file not found." };
};

/**
 * Shared helper: submit an edited file content through the proposal system
 * with full safety (destructive-shrink guard, structural invariants, post-write verify).
 */
const submitEditedContent = async ({
  service,
  policy,
  conversationId,
  targetPath,
  originalContent,
  updatedContent,
  baseContentHash,
  baseSource,
  summary,
  allowFullRewrite,
  proposalType = "patch",
}) => {
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is edit-protected." };
  }
  if (!isTextExtension(targetPath, policy)) {
    return { error: "Only text files can be edited." };
  }
  if (Buffer.byteLength(updatedContent, "utf8") > policy.maxFileBytes) {
    return { error: "Content is too large." };
  }
  if (updatedContent === originalContent) {
    return { error: "No changes: the edit produced identical content." };
  }
  if (!allowFullRewrite && isDestructiveShrink(originalContent, updatedContent)) {
    const oldLines = originalContent.split(/\r?\n/).length;
    const newLines = updatedContent.split(/\r?\n/).length;
    return {
      error:
        "DESTRUCTIVE SHRINK REJECTED: this edit would shrink " +
        targetPath +
        " from " +
        oldLines +
        " lines to " +
        newLines +
        " lines. Use a narrower edit range, or pass allowFullRewrite=true " +
        "if this is truly intended.",
      conflict: true,
    };
  }
  if (!allowFullRewrite) {
    const brokenInvariants = checkLatexInvariants(
      targetPath,
      originalContent,
      updatedContent,
    );
    if (brokenInvariants.length > 0) {
      return {
        error:
          "STRUCTURAL INVARIANT VIOLATION: this edit would remove critical LaTeX " +
          "elements that were present in the original file: " +
          brokenInvariants.join(", ") +
          ". These elements are protected. If you truly intend to restructure the " +
          "document (e.g. convert to a different class or remove \\maketitle), pass " +
          "allowFullRewrite=true. Otherwise, narrow your edit so the listed " +
          "elements remain intact.",
        conflict: true,
        brokenInvariants,
      };
    }
  }

  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: proposalType,
    path: targetPath,
    content: updatedContent,
    originalContent,
    summary,
    isNewFile: false,
    conversationId,
    workspaceRootPath: service.workspace.getRootPath() || undefined,
    baseContentHash: typeof baseContentHash === "string" ? baseContentHash : undefined,
    baseExists: true,
    baseSource: baseSource || undefined,
    createdAt: Date.now(),
  };
  const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
  if (!apply.ok) {
    return {
      status: "apply_failed",
      proposalId: id,
      path: targetPath,
      error: apply.error,
      conflict: apply.conflict === true,
    };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const verify = await verifyPostWrite(resolved, updatedContent);
  if (!verify.ok) {
    return {
      status: "apply_failed",
      proposalId: id,
      path: targetPath,
      error: verify.error,
    };
  }
  const change = describeChange(originalContent, updatedContent);
  return {
    status: "applied",
    proposalId: id,
    path: targetPath,
    change,
    verified: true,
    summary: formatChangeSummary(targetPath, change),
    sha: verify.actualSha,
  };
};

// Reject edits that make an inserted/replaced line byte-identical to an
// immediately adjacent line - the signature of an accidental duplication
// (e.g. "fixing" a stray line by overwriting it with a copy of its neighbor).
// Only substantive lines (>= 24 trimmed chars) are flagged, so short tokens
// like "}", "\\", or "\end{...}" never trip it.
const ADJACENT_DUP_MIN_LEN = 24;
const findIntroducedAdjacentDuplicate = (lines, blockStartIndex, blockLength) => {
  if (!Array.isArray(lines) || blockLength <= 0) return null;
  const substantive = (s) => typeof s === "string" && s.trim().length >= ADJACENT_DUP_MIN_LEN;
  const firstNew = lines[blockStartIndex];
  const before = lines[blockStartIndex - 1];
  if (substantive(firstNew) && firstNew === before) {
    return { side: "above", line: firstNew };
  }
  const lastNew = lines[blockStartIndex + blockLength - 1];
  const after = lines[blockStartIndex + blockLength];
  if (substantive(lastNew) && lastNew === after) {
    return { side: "below", line: lastNew };
  }
  return null;
};
const adjacentDuplicateError = (dup) =>
  "DUPLICATE LINE REJECTED: this edit would make a line identical to the line immediately " +
  dup.side +
  " it:\n  \"" +
  (dup.line.length > 80 ? dup.line.slice(0, 80) + "..." : dup.line) +
  "\"\nThis is almost always an accidental duplication (for example, replacing a stray " +
  "line with a copy of its neighbor). To DELETE a stray or undefined line, use delete_lines. " +
  "To change content, write distinct correct text - never copy an adjacent line.";

const handleReplaceLines = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "";
  const startLineRaw = Number(args.startLine);
  const endLineRaw = args.endLine === undefined ? startLineRaw : Number(args.endLine);
  const allowFullRewrite = args.allowFullRewrite === true;
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is edit-protected." };
  }
  if (!isTextExtension(targetPath, policy)) {
    return { error: "Only text files can be edited." };
  }
  if (!Number.isFinite(startLineRaw) || startLineRaw < 1) {
    return { error: "startLine must be a number >= 1." };
  }
  if (!Number.isFinite(endLineRaw) || endLineRaw < startLineRaw) {
    return { error: "endLine must be >= startLine." };
  }
  const startLine = Math.round(startLineRaw);
  const endLine = Math.round(endLineRaw);
  const replacementText = typeof args.content === "string" ? args.content : "";

  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) {
    return { error: read.error };
  }
  const originalContent = read.content;

  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
  const originalLines = normalizedOriginal.split("\n");
  const startIndex = startLine - 1;
  const endIndex = endLine - 1;
  if (startIndex < 0 || startIndex >= originalLines.length) {
    return { error: "startLine is out of range (file has " + originalLines.length + " lines)." };
  }
  if (endIndex < 0 || endIndex >= originalLines.length) {
    return { error: "endLine is out of range (file has " + originalLines.length + " lines)." };
  }

  const normalizedReplacement = replacementText.replace(/\r\n/g, "\n");
  const replacementLines = normalizedReplacement.split("\n");
  const updatedLines = [
    ...originalLines.slice(0, startIndex),
    ...replacementLines,
    ...originalLines.slice(endIndex + 1),
  ];
  const replaceDup = findIntroducedAdjacentDuplicate(updatedLines, startIndex, replacementLines.length);
  if (replaceDup) {
    return { error: adjacentDuplicateError(replaceDup) };
  }
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  const lineRangeLabel = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent,
    updatedContent,
    baseContentHash: read.baseContentHash,
    baseSource: read.baseSource,
    summary: summary.trim() ? summary : `Replace lines ${lineRangeLabel} in ${targetPath}`,
    allowFullRewrite,
    proposalType: "patch",
  });
};

const handleInsertLines = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "";
  const afterLineRaw = Number(args.afterLine);
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (!Number.isFinite(afterLineRaw) || afterLineRaw < 0) {
    return {
      error: "afterLine must be a number >= 0 (use 0 to insert at the top of the file).",
    };
  }
  const afterLine = Math.round(afterLineRaw);
  const insertion = typeof args.content === "string" ? args.content : "";
  if (!insertion) {
    return { error: "content is empty — nothing to insert." };
  }

  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) {
    return { error: read.error };
  }
  const originalContent = read.content;

  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
  const originalLines = normalizedOriginal.split("\n");
  if (afterLine > originalLines.length) {
    return {
      error:
        "afterLine " +
        afterLine +
        " is out of range (file has " +
        originalLines.length +
        " lines).",
    };
  }
  const normalizedInsertion = insertion.replace(/\r\n/g, "\n");
  const insertionLines = normalizedInsertion.split("\n");
  // Drop the spurious empty line that split creates when insertion ends with \n
  if (
    insertionLines.length > 0 &&
    insertionLines[insertionLines.length - 1] === "" &&
    normalizedInsertion.endsWith("\n")
  ) {
    insertionLines.pop();
  }
  const updatedLines = [
    ...originalLines.slice(0, afterLine),
    ...insertionLines,
    ...originalLines.slice(afterLine),
  ];
  const insertDup = findIntroducedAdjacentDuplicate(updatedLines, afterLine, insertionLines.length);
  if (insertDup) {
    return { error: adjacentDuplicateError(insertDup) };
  }
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent,
    updatedContent,
    baseContentHash: read.baseContentHash,
    baseSource: read.baseSource,
    summary:
      summary.trim() ||
      `Insert ${insertionLines.length} lines after line ${afterLine} in ${targetPath}`,
    // Inserting always grows the file, so destructive shrink does not apply.
    allowFullRewrite: true,
    proposalType: "patch",
  });
};

const handleDeleteLines = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "";
  const startLineRaw = Number(args.startLine);
  const endLineRaw = args.endLine === undefined ? startLineRaw : Number(args.endLine);
  const allowFullRewrite = args.allowFullRewrite === true;
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (!Number.isFinite(startLineRaw) || startLineRaw < 1) {
    return { error: "startLine must be a number >= 1." };
  }
  if (!Number.isFinite(endLineRaw) || endLineRaw < startLineRaw) {
    return { error: "endLine must be >= startLine." };
  }
  const startLine = Math.round(startLineRaw);
  const endLine = Math.round(endLineRaw);

  const read = await readCurrentTextContent(service, policy, conversationId, targetPath);
  if (!read.ok) {
    return { error: read.error };
  }
  const originalContent = read.content;
  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
  const originalLines = normalizedOriginal.split("\n");
  if (startLine < 1 || startLine > originalLines.length) {
    return { error: "startLine is out of range (file has " + originalLines.length + " lines)." };
  }
  if (endLine < 1 || endLine > originalLines.length) {
    return { error: "endLine is out of range (file has " + originalLines.length + " lines)." };
  }
  const updatedLines = [
    ...originalLines.slice(0, startLine - 1),
    ...originalLines.slice(endLine),
  ];
  let updatedContent = updatedLines.join("\n");
  if (newline === "\r\n") {
    updatedContent = updatedContent.replace(/\n/g, "\r\n");
  }
  const lineRangeLabel = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return submitEditedContent({
    service,
    policy,
    conversationId,
    targetPath,
    originalContent,
    updatedContent,
    baseContentHash: read.baseContentHash,
    baseSource: read.baseSource,
    summary: summary.trim() || `Delete lines ${lineRangeLabel} from ${targetPath}`,
    allowFullRewrite,
    proposalType: "patch",
  });
};

const handleCreateFile = async (service, args, policy, conversationId) => {
  // Delegates to handleProposeWrite with mode: "create".
  return handleProposeWrite(
    service,
    {
      path: args.path,
      content: args.content,
      summary: args.summary || `Create file ${args.path}`,
      mode: "create",
    },
    policy,
    conversationId,
  );
};

const handleProposeDelete = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "fileDelete";
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is protected from deletion." };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "file not found." };
  }
  let originalContent = "";
  let isBinary = false;
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "File is too large." };
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
  const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
  return {
    status: apply.ok ? "applied" : "apply_failed",
    proposalId: id,
    path: targetPath,
    apply,
    ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
  };
};

const handleProposeRename = async (service, args, policy, conversationId) => {
  const oldPath = normalizePath(args.oldPath);
  const newPath = normalizePath(args.newPath);
  const summary = typeof args.summary === "string" ? args.summary : `${oldPath} → ${newPath}`;
  if (!oldPath || !newPath) {
    return { error: "oldPath and newPath are required." };
  }
  if (isBlockedPath(oldPath, policy) || isBlockedPath(newPath, policy)) {
    return { error: "Target path is protected from this operation." };
  }
  const resolved = service.workspace.resolvePath(oldPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "file not found." };
  }
  let originalContent = "";
  let isBinary = false;
  let baseContentHash = null;
  let baseSource = null;
  const snapshot = service.getContextSnapshot(conversationId, oldPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "File is too large." };
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
  const apply = await autoApplyProposal(service, proposal, { skipAutoBuild: true });
  return {
    status: apply.ok ? "applied" : "apply_failed",
    proposalId: id,
    path: newPath,
    apply,
    ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
  };
};

const handleProposeCreateDirectory = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "Create directory";
  if (!targetPath) {
    return { error: "path is empty." };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "Target path is protected from creation." };
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
  const apply = await autoApplyProposal(service, proposal);
  return {
    status: apply.ok ? "applied" : "apply_failed",
    proposalId: id,
    path: targetPath,
    apply,
    autoBuild: apply.autoBuild ?? null,
    ...(apply.ok ? {} : { error: apply.error, conflict: apply.conflict === true }),
  };
};

module.exports = {
  ALLOWED_RUN_COMMANDS,
  MAX_COMMAND_TIMEOUT_MS,
  decodeBase64Strict,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  handleCreateFile,
  handleDeleteLines,
  handleInsertLines,
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
  readCurrentTextContent,
  submitEditedContent,
  readFileFromDisk,
  replaceAllWithCount,
  replaceOnceWithCount,
  runShellCommand,
  parseCommandLine,
};
