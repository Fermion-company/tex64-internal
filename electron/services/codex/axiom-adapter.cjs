'use strict';

// Codex → Axiom チャット アダプタ。
//
// AgentService.run() から model === "codex" のとき呼ばれ、openprism の
// runAgentConversation と同じ renderer イベント語彙（agent:messageDelta /
// agent:message / agent:tool / agent:thought / agent:applyContent /
// agent:status / agent:error）に Codex app-server のイベントを翻訳する。
// renderer 側は一切変更せずに動くことを不変条件とする。
//
// 編集の適用モデルの違いに注意:
//   Axiom  … proposal を生成 → applyProposal がファイルを書く
//   Codex  … sandbox(workspace-write) 内で Codex 自身がファイルを書く
// そのため fileChange 完了時にディスクから読み直して agent:applyContent で
// 開いている Monaco バッファへ反映する。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getCodexService } = require('./index.cjs');
const { isExtendedTextFileName, looksBinary } = require('../text-file-types.cjs');

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const CODEX_ABORT_TERMINAL_TIMEOUT_MS = 7500;
const TEX_TEXT_FILE_PATTERN = /\.(?:tex|bib|sty|cls|clo|ltx|dtx|ins|bst|bbx|cbx|cfg|def|fd|lbx|lua|txt|aux|bbl|blg|log|out|toc|lof|lot|fdb_latexmk|fls)$/i;
const MAX_CAPTURED_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURED_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_BATCH_SIZE = 32;
const WORKSPACE_SNAPSHOT_TIMEOUT_MS = 5000;
const WORKSPACE_REFRESH_TIMEOUT_MS = 3000;
const MAX_SNAPSHOT_ENTRIES = 50_000;

const isSnapshotTextFile = (relativePath) => {
  const basename = path.basename(relativePath).toLowerCase();
  return (
    TEX_TEXT_FILE_PATTERN.test(relativePath) ||
    isExtendedTextFileName(relativePath) ||
    path.extname(basename) === '' ||
    basename === '.latexmkrc' ||
    basename === 'texmf.cnf'
  );
};

const COMPILE_FAILURE_MESSAGES = Object.freeze({
  en: 'Changes made so far were saved, but a compilation error remains.',
  ja: 'ここまでの変更は保存しましたが、組版エラーが残っています。',
  zh: '已保存目前的更改，但仍有编译错误。',
  ko: '지금까지의 변경 사항은 저장했지만 컴파일 오류가 남아 있습니다.',
  fr: 'Les modifications ont été enregistrées, mais une erreur de compilation subsiste.',
  de: 'Die bisherigen Änderungen wurden gespeichert, aber ein Kompilierungsfehler bleibt bestehen.',
  es: 'Los cambios se guardaron, pero aún queda un error de compilación.',
});

const WORKSPACE_SYNC_FAILURE_MESSAGES = Object.freeze({
  en: 'The document was built, but editor synchronization did not finish. Reload TeX64 before saving an open file.',
  ja: '文書は組版しましたが、エディタとの同期が完了しませんでした。開いているファイルを保存する前にTeX64を再読み込みしてください。',
  zh: '文档已编译，但编辑器同步未完成。请在保存已打开的文件前重新加载 TeX64。',
  ko: '문서는 컴파일했지만 편집기 동기화가 완료되지 않았습니다. 열린 파일을 저장하기 전에 TeX64를 다시 로드하세요.',
  fr: 'Le document a été compilé, mais la synchronisation de l’éditeur n’est pas terminée. Rechargez TeX64 avant d’enregistrer un fichier ouvert.',
  de: 'Das Dokument wurde kompiliert, aber die Editorsynchronisierung wurde nicht abgeschlossen. Laden Sie TeX64 neu, bevor Sie eine geöffnete Datei speichern.',
  es: 'El documento se compiló, pero la sincronización del editor no terminó. Recarga TeX64 antes de guardar un archivo abierto.',
});

const compileFailureMessage = (locale) =>
  COMPILE_FAILURE_MESSAGES[locale] || COMPILE_FAILURE_MESSAGES.en;

const workspaceSyncFailureMessage = (locale) =>
  WORKSPACE_SYNC_FAILURE_MESSAGES[locale] || WORKSPACE_SYNC_FAILURE_MESSAGES.en;

const compileResultSucceeded = (result) =>
  Boolean(
    result &&
      typeof result === 'object' &&
      result.status === 'success' &&
      typeof result.error !== 'string'
  );

const abortError = () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};

const awaitAbortable = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

const awaitWithTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });

const normalizeConversationId = (conversationId) =>
  typeof conversationId === 'string' && conversationId.trim()
    ? conversationId.trim()
    : 'default';

const extractText = (message, parts) => {
  const chunks = [];
  if (typeof message === 'string' && message.trim()) chunks.push(message);
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.trim()) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n\n').trim();
};

const extractImageDataUrls = (parts) => {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p) => p?.inlineData?.mimeType?.startsWith('image/') && p?.inlineData?.data)
    .map((p) => `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`);
};

const MAX_RESTORED_CONVERSATION_MESSAGES = 12;
const MAX_RESTORED_CONVERSATION_CHARS = 24_000;

const buildRestoredConversationContext = (conversation) => {
  if (!Array.isArray(conversation) || conversation.length === 0) return '';
  const selected = [];
  let usedChars = 0;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index];
    const role = entry?.role === 'assistant' ? 'Assistant' : entry?.role === 'user' ? 'User' : null;
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (!role || !content) continue;
    const remaining = MAX_RESTORED_CONVERSATION_CHARS - usedChars;
    if (remaining <= 0 || selected.length >= MAX_RESTORED_CONVERSATION_MESSAGES) break;
    const boundedContent = content.length > remaining ? content.slice(content.length - remaining) : content;
    selected.unshift(`${role}: ${boundedContent}`);
    usedChars += boundedContent.length;
  }
  if (selected.length === 0) return '';
  return [
    'This Codex thread was recreated after TeX64 restored the chat. Continue using this recent conversation context:',
    '<conversation_history>',
    ...selected,
    '</conversation_history>',
  ].join('\n');
};

const buildLlmInput = (userText, context, restoredConversation = []) => {
  const partsList = [];
  const restoredContext = buildRestoredConversationContext(restoredConversation);
  if (restoredContext) partsList.push(restoredContext);
  if (context?.activeFilePath) {
    partsList.push(`Active file: ${context.activeFilePath}`);
  }
  partsList.push(`User prompt: ${userText}`);
  if (
    context?.activeSelection &&
    typeof context.activeSelection.text === 'string' &&
    context.activeSelection.text.trim()
  ) {
    partsList.push(`Selection:\n${context.activeSelection.text}`);
  }
  return partsList.filter(Boolean).join('\n\n');
};

// ChatGPT ログインが必要なら開始し、完了を待つ。
const ensureCodexAuth = async (service, codex, conversationId, signal) => {
  throwIfAborted(signal);
  const status = await awaitAbortable(codex.getStatus(), signal);
  throwIfAborted(signal);
  if (!status.installed) {
    const err = new Error(
      'Codex CLI is not installed. Install it with `npm install -g @openai/codex` and try again.'
    );
    err.code = 'CODEX_NOT_INSTALLED';
    throw err;
  }
  if (status.authenticated) return status;

  const { authUrl, loginId } = await awaitAbortable(codex.loginStart(), signal);
  throwIfAborted(signal);
  if (!authUrl) {
    throw new Error('Could not start ChatGPT sign-in.');
  }
  let finishLoginFromStatus = () => {};
  let failLoginFromStatus = () => {};
  const loginCompletion = new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      codex.removeListener('event', onEvent);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const onEvent = (event) => {
      if (event.type !== 'login-completed') return;
      if (event.loginId && loginId && event.loginId !== loginId) return;
      if (event.success) finish(resolve);
      else finish(reject, new Error(event.error || 'ChatGPT sign-in failed.'));
    };
    const onAbort = () => finish(reject, abortError());
    finishLoginFromStatus = () => finish(resolve);
    failLoginFromStatus = (error) => finish(reject, error);
    const timer = setTimeout(
      () => finish(reject, new Error('ChatGPT sign-in timed out.')),
      LOGIN_TIMEOUT_MS,
    );
    codex.on('event', onEvent);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  // login/completed can arrive immediately after loginStart returns. The
  // listener above cannot observe an event that already fired, so close that
  // window with an authoritative account recheck.
  let loginStatusMessage = 'Waiting for ChatGPT sign-in...';
  try {
    const statusAfterListener = await awaitAbortable(codex.getStatus(), signal);
    if (statusAfterListener.authenticated) finishLoginFromStatus();
  } catch (error) {
    failLoginFromStatus(error);
    await loginCompletion;
  }
  try {
    const { shell } = require('electron');
    // Do not await the browser after installing the completion listener. Some
    // already-authenticated sessions finish immediately, before openExternal
    // resolves, and that event must not be lost.
    void Promise.resolve(shell.openExternal(authUrl)).catch(() => {
      service.sendStatus(
        'running',
        `Open this URL to sign in with ChatGPT: ${authUrl}`,
        conversationId,
      );
    });
  } catch (_) {
    // Electron 外（テスト実行時）はブラウザを開けないので URL をメッセージで渡す
    loginStatusMessage = `Open this URL to sign in with ChatGPT: ${authUrl}`;
  }
  service.sendStatus('running', loginStatusMessage, conversationId);
  await loginCompletion;

  const authenticatedStatus = await awaitAbortable(codex.getStatus(), signal);
  throwIfAborted(signal);
  return authenticatedStatus;
};

// Codex marks the files a turn touched with an internal directive:
//   :codex-file-citation{path="/private/tmp/…/main.pdf" purpose="output"}
// It is not markdown, so it renders verbatim — absolute sandbox path included.
// Rewrite it into a workspace-relative link the chat can open; a path outside
// the workspace degrades to its bare file name so no absolute path is shown.
const FILE_CITATION_PATTERN = /:codex-file-citation(?:\[[^\]]*\])?\{([^}]*)\}/g;

const readCitationPath = (attributes) => {
  const quoted = attributes.match(/path\s*=\s*"([^"]+)"/);
  if (quoted) return quoted[1];
  const bare = attributes.match(/path\s*=\s*([^\s,}]+)/);
  return bare ? bare[1] : null;
};

const rewriteFileCitations = (text, rootPath) => {
  if (typeof text !== 'string' || !text.includes(':codex-file-citation')) return text;
  return text.replace(FILE_CITATION_PATTERN, (_match, attributes) => {
    const cited = readCitationPath(attributes || '');
    if (!cited) return '';
    const absPath = path.isAbsolute(cited) ? cited : path.join(rootPath, cited);
    const relPath = path.relative(rootPath, absPath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return path.basename(absPath);
    }
    // Brackets would end the markdown label early; parentheses would end the
    // target early. Both are legal in file names, so neutralise them.
    const label = relPath.replace(/[[\]]/g, '\\$&');
    const target = encodeURI(relPath).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `[${label}](tex64-file:${target})`;
  });
};

const toolEvent = (service, conversationId, name, detail, summary) => {
  service.sendToRenderer('agent:tool', {
    name,
    detail,
    summary,
    conversationId,
  });
};

const enumerateWorkspaceFiles = async (rootPath, signal) => {
  const root = path.resolve(rootPath);
  const directories = [root];
  const files = [];
  let visitedEntries = 0;
  while (directories.length > 0) {
    throwIfAborted(signal);
    const directory = directories.shift();
    const entries = await awaitAbortable(
      fsp.readdir(directory, { withFileTypes: true }),
      signal,
    );
    for (const entry of entries) {
      throwIfAborted(signal);
      visitedEntries += 1;
      if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
        return { files, complete: false };
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(relativePath.split(path.sep).join('/'));
      }
      // Symlinks are deliberately not followed: their targets may escape the
      // workspace and every writable app path already rejects that traversal.
    }
  }
  return { files, complete: true };
};

const captureWorkspaceInputsWithSignal = async (
  service,
  rootPath,
  signal,
  knownRelativePaths = null,
) => {
  const enumeration = Array.isArray(knownRelativePaths)
    ? { files: knownRelativePaths, complete: false }
    : await (typeof service.codexWorkspaceEnumerator === 'function'
        ? awaitAbortable(service.codexWorkspaceEnumerator(rootPath, signal), signal)
        : enumerateWorkspaceFiles(rootPath, signal));
  if (!enumeration || !Array.isArray(enumeration.files)) {
    throw new Error('Workspace enumeration returned an invalid result.');
  }
  const files = enumeration.files;
  const candidates = [];
  const seen = new Set();
  for (const relativePath of files) {
    // Any workspace file can affect a LaTeX build: extensionless \input files,
    // .latexmkrc, texmf.cnf, generated data and custom packages are all valid.
    if (typeof relativePath !== 'string') continue;
    const absolutePath = path.resolve(rootPath, relativePath);
    const relative = path.relative(rootPath, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join('/');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({ relativePath: normalized, absolutePath });
  }

  const sources = new Map();
  const buildInputs = new Map();
  let capturedSourceBytes = 0;
  for (let offset = 0; offset < candidates.length; offset += SNAPSHOT_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = candidates.slice(offset, offset + SNAPSHOT_BATCH_SIZE);
    const stats = await awaitAbortable(
      Promise.all(
        batch.map(async (entry) => {
          try {
            const stat = await fsp.stat(entry.absolutePath, { bigint: true });
            return stat.isFile() ? { ...entry, stat } : null;
          } catch {
            return { ...entry, stat: null };
          }
        }),
      ),
      signal,
    );
    for (const entry of stats) {
      if (!entry) continue;
      if (!entry.stat) {
        buildInputs.set(entry.relativePath, 'unreadable');
        if (isSnapshotTextFile(entry.relativePath)) {
          sources.set(entry.relativePath, {
            signature: 'unreadable',
            content: null,
            captureFailed: true,
          });
        }
        continue;
      }
      const signature = `${entry.stat.size}:${entry.stat.mtimeNs}`;
      buildInputs.set(entry.relativePath, signature);
      if (!isSnapshotTextFile(entry.relativePath)) continue;
      const size = Number(entry.stat.size);
      let content = null;
      let captureFailed = false;
      if (
        Number.isSafeInteger(size) &&
        size <= MAX_CAPTURED_SOURCE_BYTES &&
        capturedSourceBytes + size <= MAX_CAPTURED_SOURCE_TOTAL_BYTES
      ) {
        try {
          const buffer = await awaitAbortable(fsp.readFile(entry.absolutePath), signal);
          capturedSourceBytes += size;
          if (!looksBinary(buffer)) content = buffer.toString('utf8');
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          captureFailed = true;
        }
      }
      sources.set(entry.relativePath, { signature, content, captureFailed });
    }
  }
  return { sources, buildInputs, complete: enumeration.complete };
};

const captureWorkspaceInputs = async (
  service,
  rootPath,
  signal,
  knownRelativePaths = null,
) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs =
    Number.isFinite(service.codexWorkspaceSnapshotTimeoutMs) &&
    service.codexWorkspaceSnapshotTimeoutMs > 0
      ? service.codexWorkspaceSnapshotTimeoutMs
      : WORKSPACE_SNAPSHOT_TIMEOUT_MS;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await captureWorkspaceInputsWithSignal(
      service,
      rootPath,
      controller.signal,
      knownRelativePaths,
    );
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      const timeoutError = new Error('Workspace snapshot timed out.');
      timeoutError.code = 'CODEX_WORKSPACE_SNAPSHOT_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const buildInputsChanged = (before, after) => {
  if (!(before instanceof Map) || !(after instanceof Map)) return false;
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relativePath of paths) {
    if (before.get(relativePath) !== after.get(relativePath)) return true;
  }
  return false;
};

const fileChangeMayAffectBuild = (item) => {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (changes.length === 0) return true;
  return changes.some((change) => typeof change?.path === 'string');
};

const reconcileTexSources = async (service, conversationId, rootPath, before, after) => {
  if (!(before instanceof Map) || !(after instanceof Map)) {
    return { changed: false, incomplete: true };
  }
  let changed = false;
  let incomplete = false;
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relativePath of paths) {
    const existedBefore = before.has(relativePath);
    const previous = before.get(relativePath);
    const current = after.get(relativePath);
    if (
      previous?.signature === current?.signature &&
      previous?.content === current?.content
    ) continue;
    changed = true;
    if (
      typeof current?.content === 'string' &&
      typeof previous?.content === 'string'
    ) {
      service.sendToRenderer('agent:applyContent', {
        path: relativePath,
        content: current.content,
        ...(typeof previous?.content === 'string'
          ? { expectedContent: previous.content }
          : {}),
        updateSaved: true,
        conversationId,
      });
    } else if (!existedBefore && typeof current?.content === 'string') {
      service.sendToRenderer('agent:applyContent', {
        path: relativePath,
        content: current.content,
        expectedFileMissing: true,
        updateSaved: true,
        conversationId,
      });
    } else if (!current && existedBefore && typeof previous?.content === 'string') {
      service.sendToRenderer('agent:applyContent', {
        path: relativePath,
        content: '',
        expectedContent: previous.content,
        fileDeleted: true,
        updateSaved: false,
        conversationId,
      });
    } else if (existedBefore && current) {
      // This existing text file changed but its pre-turn bytes were not safely
      // captured (large, binary-looking or transient read failure). Never send
      // a non-CAS replacement that could erase concurrent Monaco input.
      incomplete = true;
    }
    if (current) before.set(relativePath, current);
    else before.delete(relativePath);
  }
  return { changed, incomplete };
};

const runCodexConversation = async (
  service,
  { message, parts, context, conversationId = 'default' },
  prestartedRun = null,
) => {
  const targetConversationId = normalizeConversationId(conversationId);

  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    service.sendToRenderer('agent:error', {
      message: 'No workspace is selected.',
      conversationId: targetConversationId,
    });
    service.sendStatus('error', 'No workspace is selected.', targetConversationId);
    return;
  }

  const userText = extractText(message, parts);
  const images = extractImageDataUrls(parts);
  if (!userText && images.length === 0) {
    service.sendToRenderer('agent:error', {
      message: 'Input is empty.',
      conversationId: targetConversationId,
    });
    service.sendStatus('error', 'Input is empty.', targetConversationId);
    return;
  }

  const run = prestartedRun ?? service.startConversationRun(targetConversationId);
  const isCurrentRun = () => service.isRunCurrent(targetConversationId, run.token);
  const codex = service.codexService ?? getCodexService();

  let listener = null;
  let onAbort = null;
  let abortDeadlineTimer = null;
  let resolveAbortDeadline = null;
  let forcedStopPromise = null;
  const finalTexts = [];
  const changedTexFiles = new Set();
  let workspaceMayNeedBuild = false;
  let sawWorkspaceMutationPotential = false;
  let sourceSnapshot = null;
  let buildInputSnapshot = null;
  let initialSnapshotComplete = false;
  let sourcesReconciled = false;
  let reconciliationFailed = false;
  let workspaceRefreshPromise = null;
  let buildAttempted = false;
  let buildFailed = false;
  let turnStartAttempted = false;
  const compileFailure = compileFailureMessage(context?.uiLocale);
  const assertWorkspaceCurrent = () => {
    if (service.workspace.getRootPath() !== rootPath) {
      const error = new Error(
        'The workspace changed during this Codex turn. Retry in the current workspace.'
      );
      error.code = 'AGENT_WORKSPACE_CHANGED';
      throw error;
    }
  };
  const settleChangedFiles = async () => {
    if (buildAttempted) return buildFailed ? 'failed' : 'ok';
    if (!workspaceMayNeedBuild && changedTexFiles.size === 0) return 'unchanged';
    buildAttempted = true;
    try {
      assertWorkspaceCurrent();
      const result = await service.executeToolCall(
        { name: 'run_build', args: {} },
        targetConversationId
      );
      assertWorkspaceCurrent();
      buildFailed = !compileResultSucceeded(result);
    } catch (_) {
      buildFailed = true;
    }
    return buildFailed ? 'failed' : 'ok';
  };
  const refreshWorkspaceAfterChange = async () => {
    if (typeof service.updateWorkspaceIfNeeded !== 'function') return true;
    if (!workspaceRefreshPromise) {
      workspaceRefreshPromise = awaitWithTimeout(
        Promise.resolve(service.updateWorkspaceIfNeeded(rootPath, true)),
        WORKSPACE_REFRESH_TIMEOUT_MS,
        'Workspace refresh timed out.',
      )
        .then((result) => result !== false)
        .catch(() => false);
    }
    return workspaceRefreshPromise;
  };
  const reconcileWorkspaceSources = async (force = false) => {
    if (sourcesReconciled) return;
    sourcesReconciled = true;
    if (!force && !sawWorkspaceMutationPotential) return;
    try {
      assertWorkspaceCurrent();
      // Terminal reconciliation must still run after Stop because a command may
      // have completed a write before the abort was observed.
      const currentInputs = await captureWorkspaceInputs(service, rootPath, null);
      const sourceSync = await reconcileTexSources(
        service,
        targetConversationId,
        rootPath,
        sourceSnapshot,
        currentInputs.sources,
      );
      const inputsChanged = buildInputsChanged(
        buildInputSnapshot,
        currentInputs.buildInputs,
      );
      if (sourceSync.changed || inputsChanged) {
        workspaceMayNeedBuild = true;
      }
      if (!initialSnapshotComplete || currentInputs.complete !== true) {
        reconciliationFailed = true;
        workspaceMayNeedBuild = true;
      }
      if (sourceSync.incomplete) reconciliationFailed = true;
      if (
        (sourceSync.changed || inputsChanged || changedTexFiles.size > 0) &&
        !(await refreshWorkspaceAfterChange())
      ) {
        reconciliationFailed = true;
      }
      assertWorkspaceCurrent();
    } catch (_) {
      // Workspace identity is checked again by the build tool. Never refresh a
      // buffer from a different project merely to improve change detection.
      // If the bounded scan itself failed in the original workspace after a
      // possible writer ran, compile conservatively instead of claiming that
      // no build input changed.
      if (
        service.workspace.getRootPath() === rootPath &&
        (force || sawWorkspaceMutationPotential)
      ) {
        reconciliationFailed = true;
        // Directory enumeration may be the only stalled operation. Re-read
        // every file from the bounded pre-turn snapshot directly so existing
        // open Monaco buffers still receive CAS-protected disk content.
        try {
          const knownPaths = [
            ...new Set([
              ...(sourceSnapshot instanceof Map ? sourceSnapshot.keys() : []),
              ...(buildInputSnapshot instanceof Map ? buildInputSnapshot.keys() : []),
            ]),
          ];
          const knownInputs = await captureWorkspaceInputs(
            service,
            rootPath,
            null,
            knownPaths,
          );
          const sourceSync = await reconcileTexSources(
            service,
            targetConversationId,
            rootPath,
            sourceSnapshot,
            knownInputs.sources,
          );
          const inputsChanged = buildInputsChanged(
            buildInputSnapshot,
            knownInputs.buildInputs,
          );
          if (sourceSync.changed || inputsChanged) {
            workspaceMayNeedBuild = true;
          }
          if (sourceSync.incomplete) reconciliationFailed = true;
          if (!(await refreshWorkspaceAfterChange())) {
            reconciliationFailed = true;
          }
        } catch {
          // The terminal result below stays resumable and explicitly requires
          // a reload; never guess at file contents after both scans fail.
        }
        workspaceMayNeedBuild = true;
      }
    }
  };
  const sendCompileFailure = () => {
    service.sendToRenderer('agent:error', {
      message: compileFailure,
      conversationId: targetConversationId,
    });
  };
  const sendReconciliationFailure = () => {
    service.sendToRenderer('agent:error', {
      message: workspaceSyncFailureMessage(context?.uiLocale),
      conversationId: targetConversationId,
    });
  };
  const stopBackendAndWait = () => {
    if (!forcedStopPromise) {
      forcedStopPromise = Promise.resolve(codex.stop?.()).then(
        () => true,
        () => {
          // A failed Windows Job Object drain means a workspace writer may
          // still exist. Keep the terminal state resumable instead of treating
          // the failed stop as quiescence.
          reconciliationFailed = true;
          return false;
        },
      );
    }
    return forcedStopPromise;
  };
  try {
    if (!prestartedRun) {
      service.sendStatus('running', 'Preparing...', targetConversationId);
    }
    if (run.controller.signal.aborted) throw new Error('aborted');
    const settings = await awaitAbortable(
      service.ensureUserSettings().getAgentSettings(),
      run.controller.signal,
    );
    if (!isCurrentRun()) return;
    if (run.controller.signal.aborted) throw new Error('aborted');
    service.resolveAgentOptions(settings);
    service.contextByConversation.set(targetConversationId, context ?? {});
    service.workspaceRootByConversation.set(targetConversationId, rootPath);

    const conversation = service.buildConversation(targetConversationId);
    const conversationBeforeTurn = conversation.slice();
    // 会話履歴（永続セッション用）にはクリーンなユーザーテキストのみ保存
    conversation.push({ role: 'user', content: userText });
    service.markSessionDirty(targetConversationId);

    // ---- 認証（未ログインならブラウザで ChatGPT ログイン） ----
    await ensureCodexAuth(service, codex, targetConversationId, run.controller.signal);
    if (!isCurrentRun()) return;
    throwIfAborted(run.controller.signal);

    // Bind event handling to this exact thread before turn/start. Codex is a
    // singleton and different Code chats may run concurrently; accepting
    // events while the thread id is unknown cross-wires transcripts and files.
    const previousThreadId =
      typeof codex.threadIdFor === 'function'
        ? codex.threadIdFor(targetConversationId)
        : null;
    const turnThreadId = await awaitAbortable(
      codex.ensureThread(targetConversationId, rootPath),
      run.controller.signal,
    );
    const restoredConversation =
      !previousThreadId || previousThreadId !== turnThreadId
        ? conversationBeforeTurn
        : [];
    if (!isCurrentRun()) return;
    throwIfAborted(run.controller.signal);
    assertWorkspaceCurrent();
    const initialInputs = await captureWorkspaceInputs(
      service,
      rootPath,
      run.controller.signal,
    );
    sourceSnapshot = initialInputs.sources;
    buildInputSnapshot = initialInputs.buildInputs;
    initialSnapshotComplete = initialInputs.complete === true;
    if (!isCurrentRun()) return;
    throwIfAborted(run.controller.signal);
    assertWorkspaceCurrent();

    service.sendStatus('running', 'Thinking...', targetConversationId);

    // ---- イベント購読を張ってからターン開始（取りこぼし防止） ----
    let expectedTurnId = null;
    const pendingThreadEvents = [];
    const turnDone = new Promise((resolve) => {
      const handleBoundEvent = (event) => {
        switch (event.type) {
          case 'assistant-delta':
            service.sendToRenderer('agent:messageDelta', {
              text: event.text,
              conversationId: targetConversationId,
            });
            return;
          case 'item-started': {
            const item = event.item;
            if (
              !['agentMessage', 'reasoning', 'webSearch', 'error'].includes(item.kind)
            ) {
              // New Codex protocol items (for example collabAgentToolCall or a
              // dynamic tool) may delegate to a same-workspace writer. Unknown
              // tool kinds are therefore reconciled conservatively.
              sawWorkspaceMutationPotential = true;
            }
            if (item.kind === 'commandExecution') {
              // A shell command cannot be classified safely from its name
              // (`find -delete` and `sed -n ...w` both write). Always compare
              // the bounded before/after snapshots; unchanged inputs still
              // avoid an unnecessary build.
              sawWorkspaceMutationPotential = true;
              toolEvent(service, targetConversationId, 'run_command', item.command, 'running');
            } else if (item.kind === 'fileChange') {
              sawWorkspaceMutationPotential = true;
              if (fileChangeMayAffectBuild(item)) workspaceMayNeedBuild = true;
              const paths = (item.changes || []).map((c) => c.path).join(', ');
              toolEvent(service, targetConversationId, 'write_file', paths, 'running');
            } else if (item.kind === 'mcpToolCall') {
              // MCP tool names are not a security boundary. A read-looking
              // custom tool may write, so terminal reconciliation is required.
              sawWorkspaceMutationPotential = true;
              toolEvent(
                service,
                targetConversationId,
                item.tool || 'tool',
                item.server ? `MCP: ${item.server}` : undefined,
                'running'
              );
            } else if (item.kind === 'webSearch') {
              toolEvent(service, targetConversationId, 'web_search', item.query, 'running');
            }
            return;
          }
          case 'item-completed': {
            const item = event.item;
            if (
              !['agentMessage', 'reasoning', 'webSearch', 'error'].includes(item.kind)
            ) {
              sawWorkspaceMutationPotential = true;
            }
            if (item.kind === 'agentMessage' && item.text) {
              finalTexts.push(item.text);
            } else if (item.kind === 'reasoning' && item.text) {
              service.sendToRenderer('agent:thought', {
                text: item.text,
                conversationId: targetConversationId,
              });
            } else if (item.kind === 'commandExecution') {
              sawWorkspaceMutationPotential = true;
              toolEvent(
                service,
                targetConversationId,
                'run_command',
                item.command,
                item.exitCode === 0 ? 'ok' : `exit ${item.exitCode}`
              );
            } else if (item.kind === 'fileChange') {
              sawWorkspaceMutationPotential = true;
              if (fileChangeMayAffectBuild(item)) workspaceMayNeedBuild = true;
              handleFileChangeCompleted(
                service,
                targetConversationId,
                rootPath,
                item,
                changedTexFiles,
                sourceSnapshot,
              );
            } else if (item.kind === 'mcpToolCall') {
              sawWorkspaceMutationPotential = true;
              toolEvent(
                service,
                targetConversationId,
                item.tool || 'tool',
                item.server ? `MCP: ${item.server}` : undefined,
                item.status === 'failed' ? 'error' : 'ok'
              );
            } else if (item.kind === 'error' && item.text) {
              service.sendToRenderer('agent:error', {
                message: item.text,
                conversationId: targetConversationId,
              });
            }
            return;
          }
          case 'error':
            resolve({ ok: false, error: event.message });
            return;
          case 'turn-failed':
            resolve({ ok: false, error: event.error });
            return;
          case 'turn-completed':
            resolve({ ok: true });
            return;
          default:
            return;
        }
      };
      listener = (event) => {
        if (!isCurrentRun()) return;
        if (event.type === 'backend-stopped') {
          const settleStopped = () =>
            resolve({ ok: false, error: event.error || 'Codex backend stopped.' });
          if (forcedStopPromise) void forcedStopPromise.finally(settleStopped);
          else settleStopped();
          return;
        }
        if (event.threadId !== turnThreadId) return;
        if (!expectedTurnId) {
          pendingThreadEvents.push(event);
          return;
        }
        if (event.turnId !== expectedTurnId) return;
        handleBoundEvent(event);
      };
      codex.on('event', listener);
    });

    // ---- 中断: 既存の AbortController 経路をそのまま利用 ----
    const abortDeadline = new Promise((resolve) => {
      resolveAbortDeadline = resolve;
    });
    const startAbortDeadline = () => {
      if (abortDeadlineTimer !== null) return;
      abortDeadlineTimer = setTimeout(() => {
        // A lost interrupt/terminal event must not leave an untracked writer.
        // Stopping the singleton also makes concurrent Codex turns receive a
        // backend-stopped terminal and settle their own completed changes.
        void stopBackendAndWait().finally(() => {
          resolveAbortDeadline?.({ abortDeadline: true });
        });
      }, CODEX_ABORT_TERMINAL_TIMEOUT_MS);
    };
    onAbort = () => {
      startAbortDeadline();
      void Promise.resolve(codex.interrupt(targetConversationId)).catch(() => {});
    };
    run.controller.signal.addEventListener('abort', onAbort, { once: true });
    if (run.controller.signal.aborted) onAbort();

    // ---- ターン開始 ----
    turnStartAttempted = true;
    const sendPromise = codex.sendMessage({
      key: targetConversationId,
      projectDir: rootPath,
      text: buildLlmInput(userText, context, restoredConversation),
      images,
      // 任意設定: agent settings に codexModel があれば Codex 側モデルを固定できる
      model: typeof settings?.codexModel === 'string' ? settings.codexModel : undefined,
    });
    const started = await Promise.race([sendPromise, abortDeadline]);
    if (started?.abortDeadline) throw abortError();
    if (!isCurrentRun()) return;
    if (started?.threadId !== turnThreadId) {
      await stopBackendAndWait();
      throw new Error('Codex started the turn in an unexpected thread.');
    }
    expectedTurnId = started?.turnId;
    if (!expectedTurnId) {
      await stopBackendAndWait();
      throw new Error('Codex did not return a turn identity.');
    }
    pendingThreadEvents.splice(0).forEach((event) => {
      if (event.turnId === expectedTurnId) {
        // Re-enter the installed listener now that strict turn identity is
        // known; events from an older turn in the same thread stay discarded.
        listener?.(event);
      }
    });
    // Stop can land while thread/start or turn/start is in flight, before the
    // first interrupt has a turn id. Retry now that sendMessage has installed
    // it, then wait for the terminal event so completed writes are observed.
    if (run.controller.signal.aborted) {
      void Promise.resolve(codex.interrupt(targetConversationId)).catch(() => {});
    }

    let result = await Promise.race([turnDone, abortDeadline]);
    if (result?.abortDeadline) throw abortError();
    if (!isCurrentRun()) return;
    if (sawWorkspaceMutationPotential && typeof codex.quiesceThread === 'function') {
      try {
        await codex.quiesceThread(targetConversationId, turnThreadId);
      } catch (error) {
        // quiesceThread fail-closes by stopping the backend tree. Reconcile and
        // build the bytes left behind, but do not report an unsafe success.
        result = {
          ok: false,
          error: error?.message || 'Codex background process cleanup failed.',
        };
      }
    }
    // The Codex writer and its background terminals are quiescent now. Stop during host reconciliation/build
    // must cancel only that build; it must not kill the singleton backend and
    // unrelated conversations seven seconds later.
    if (onAbort) {
      run.controller.signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
    if (abortDeadlineTimer !== null) {
      clearTimeout(abortDeadlineTimer);
      abortDeadlineTimer = null;
    }

    await reconcileWorkspaceSources(result.ok !== true);
    const compileState = await settleChangedFiles();
    if (!isCurrentRun()) return;

    if (run.controller.signal.aborted) {
      if (compileState === 'failed') sendCompileFailure();
      if (reconciliationFailed) sendReconciliationFailure();
      service.sendStatus(
        compileState === 'failed' || reconciliationFailed ? 'resumable' : 'idle',
        compileState === 'failed'
          ? 'Compilation failed'
          : reconciliationFailed
            ? 'Editor sync incomplete'
            : 'Aborted.',
        targetConversationId
      );
      return;
    }

    if (!result.ok) {
      service.sendToRenderer('agent:error', {
        message: [
          result.error || 'Codex run failed.',
          compileState === 'failed' ? compileFailure : '',
          reconciliationFailed ? workspaceSyncFailureMessage(context?.uiLocale) : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        conversationId: targetConversationId,
      });
      service.sendStatus('error', 'Codex error', targetConversationId);
      return;
    }

    // ---- 最終メッセージ ----
    const rawFinalText = rewriteFileCitations(finalTexts.join('\n\n').trim(), rootPath);
    const finalText =
      compileState === 'failed'
        ? [rawFinalText, compileFailure].filter(Boolean).join('\n\n')
        : rawFinalText;
    if (finalText) {
      conversation.push({ role: 'assistant', content: finalText });
      service.sendToRenderer('agent:message', {
        text: finalText,
        conversationId: targetConversationId,
      });
    }

    if (compileState === 'failed') sendCompileFailure();
    if (reconciliationFailed) sendReconciliationFailure();
    service.sendStatus(
      compileState === 'failed' || reconciliationFailed ? 'resumable' : 'idle',
      compileState === 'failed'
        ? 'Compilation failed'
        : reconciliationFailed
          ? 'Editor sync incomplete'
          : 'Waiting',
      targetConversationId
    );
  } catch (error) {
    if (!isCurrentRun()) return;
    // Before turn/start, Codex has no writer that could have touched this
    // workspace. Avoid an unnecessary, potentially slow terminal scan when
    // Stop lands during settings/auth/thread preparation.
    if (turnStartAttempted) await reconcileWorkspaceSources(true);
    const compileState = await settleChangedFiles();
    if (!isCurrentRun()) return;
    if (error?.name === 'AbortError' || run.controller.signal.aborted) {
      if (compileState === 'failed') sendCompileFailure();
      if (reconciliationFailed) sendReconciliationFailure();
      service.sendStatus(
        compileState === 'failed' || reconciliationFailed ? 'resumable' : 'idle',
        compileState === 'failed'
          ? 'Compilation failed'
          : reconciliationFailed
            ? 'Editor sync incomplete'
            : 'Aborted.',
        targetConversationId
      );
      return;
    }
    service.sendToRenderer('agent:error', {
      message: [
        error?.message || 'Codex run failed.',
        compileState === 'failed' ? compileFailure : '',
        reconciliationFailed ? workspaceSyncFailureMessage(context?.uiLocale) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      conversationId: targetConversationId,
    });
    service.sendStatus('error', 'Codex error', targetConversationId);
  } finally {
    if (listener) codex.removeListener('event', listener);
    if (onAbort) run.controller.signal.removeEventListener('abort', onAbort);
    if (abortDeadlineTimer !== null) clearTimeout(abortDeadlineTimer);
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);
  }
};

// Codex がディスクに書いた変更を開いているエディタバッファへ反映する。
const handleFileChangeCompleted = (
  service,
  conversationId,
  rootPath,
  item,
  changedTexFiles,
  sourceSnapshot,
) => {
  const changes = item.changes || [];
  const relPaths = [];
  for (const change of changes) {
    if (!change.path) continue;
    const absPath = path.isAbsolute(change.path)
      ? change.path
      : path.join(rootPath, change.path);
    const relPath = path.relative(rootPath, absPath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue;
    const normalizedRelPath = relPath.split(path.sep).join('/');
    relPaths.push(normalizedRelPath);
    const isTextSource = isSnapshotTextFile(normalizedRelPath);
    changedTexFiles.add(normalizedRelPath);
    const previousSource = sourceSnapshot?.get?.(normalizedRelPath);
    if (change.kind === 'delete') {
      // Keep the pre-turn entry until the terminal snapshot confirms deletion.
      // That comparison plus the awaited workspace refresh closes any open tab
      // instead of letting a later Save recreate the deleted file.
      continue;
    }
    if (!isTextSource) continue;
    try {
      const stat = fs.statSync(absPath, { bigint: true });
      const signature = `${stat.size}:${stat.mtimeNs}`;
      // Only buffers whose bounded pre-turn content was captured can be
      // refreshed without risking an overwrite of concurrent user typing.
      if (
        typeof previousSource?.content === 'string' &&
        stat.size <= BigInt(MAX_CAPTURED_SOURCE_BYTES)
      ) {
        const buffer = fs.readFileSync(absPath);
        if (!looksBinary(buffer)) {
          const content = buffer.toString('utf8');
          service.sendToRenderer('agent:applyContent', {
            path: normalizedRelPath,
            content,
            expectedContent: previousSource.content,
            updateSaved: true,
            conversationId,
          });
          sourceSnapshot?.set?.(normalizedRelPath, { signature, content });
        }
      }
    } catch (_) { /* file may have been moved; skip buffer refresh */ }
  }
  toolEvent(
    service,
    conversationId,
    'write_file',
    relPaths.join(', '),
    item.status === 'failed' ? 'error' : 'ok'
  );
  // Codex creates, moves and deletes files on disk directly. Buffers of files
  // that are already open were refreshed above, but the file tree only learns
  // about the change when the workspace snapshot is resent — without this a
  // freshly created main.tex stays invisible until the folder is reopened.
  if (relPaths.length > 0) {
    Promise.resolve(service.updateWorkspaceIfNeeded(rootPath, true)).catch(() => {
      /* tree refresh is best-effort; the edits themselves already landed */
    });
  }
};

module.exports = { runCodexConversation, rewriteFileCitations };
