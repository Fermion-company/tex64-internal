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
const path = require('path');
const { getCodexService } = require('./index.cjs');
const { TOOL_STATUS_LABELS } = require('../agent-core-utils.cjs');

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const TEX_FILE_PATTERN = /\.(tex|bib|sty|cls|ltx|dtx)$/i;

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

const buildLlmInput = (userText, context) => {
  const partsList = [];
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
  const status = await codex.getStatus();
  if (!status.installed) {
    const err = new Error(
      'Codex CLI is not installed. Install it with `npm install -g @openai/codex` and try again.'
    );
    err.code = 'CODEX_NOT_INSTALLED';
    throw err;
  }
  if (status.authenticated) return status;

  const { authUrl } = await codex.loginStart();
  if (!authUrl) {
    throw new Error('Could not start ChatGPT sign-in.');
  }
  try {
    const { shell } = require('electron');
    await shell.openExternal(authUrl);
  } catch (_) {
    // Electron 外（テスト実行時）はブラウザを開けないので URL をメッセージで渡す
    service.sendToRenderer('agent:message', {
      text: `Open this URL to sign in with ChatGPT: ${authUrl}`,
      conversationId,
    });
  }
  service.sendStatus('running', 'Waiting for ChatGPT sign-in...', conversationId);

  await new Promise((resolve, reject) => {
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
      if (event.success) finish(resolve);
      else finish(reject, new Error(event.error || 'ChatGPT sign-in failed.'));
    };
    const onAbort = () => {
      codex.loginCancel();
      finish(reject, new Error('aborted'));
    };
    const timer = setTimeout(() => {
      codex.loginCancel();
      finish(reject, new Error('ChatGPT sign-in timed out.'));
    }, LOGIN_TIMEOUT_MS);
    codex.on('event', onEvent);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

  return codex.getStatus();
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
    label: TOOL_STATUS_LABELS[name] || name,
    detail,
    summary,
    conversationId,
  });
};

const runCodexConversation = async (
  service,
  { message, parts, context, conversationId = 'default' }
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

  service.sendStatus('running', 'Preparing...', targetConversationId);
  const settings = await service.ensureUserSettings().getAgentSettings();
  service.resolveAgentOptions(settings);
  service.contextByConversation.set(targetConversationId, context ?? {});
  service.workspaceRootByConversation.set(targetConversationId, rootPath);

  const conversation = service.buildConversation(targetConversationId);
  const run = service.startConversationRun(targetConversationId);
  const isCurrentRun = () => service.isRunCurrent(targetConversationId, run.token);
  const codex = getCodexService();

  // 会話履歴（永続セッション用）にはクリーンなユーザーテキストのみ保存
  conversation.push({ role: 'user', content: userText });
  service.markSessionDirty(targetConversationId);

  let listener = null;
  try {
    // ---- 認証（未ログインならブラウザで ChatGPT ログイン） ----
    await ensureCodexAuth(service, codex, targetConversationId, run.controller.signal);
    if (!isCurrentRun()) return;

    service.sendStatus('running', 'Thinking...', targetConversationId);

    // ---- イベント購読を張ってからターン開始（取りこぼし防止） ----
    const finalTexts = [];
    const changedTexFiles = new Set();
    let turnThreadId = null;

    const turnDone = new Promise((resolve) => {
      listener = (event) => {
        if (!isCurrentRun()) return;
        if (event.type === 'backend-stopped') {
          resolve({ ok: false, error: event.error || 'Codex backend stopped.' });
          return;
        }
        if (turnThreadId && event.threadId && event.threadId !== turnThreadId) return;
        switch (event.type) {
          case 'assistant-delta':
            service.sendToRenderer('agent:messageDelta', {
              text: event.text,
              conversationId: targetConversationId,
            });
            return;
          case 'item-started': {
            const item = event.item;
            if (item.kind === 'commandExecution') {
              toolEvent(service, targetConversationId, 'run_command', item.command, 'running');
            } else if (item.kind === 'fileChange') {
              const paths = (item.changes || []).map((c) => c.path).join(', ');
              toolEvent(service, targetConversationId, 'write_file', paths, 'running');
            } else if (item.kind === 'mcpToolCall') {
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
            if (item.kind === 'agentMessage' && item.text) {
              finalTexts.push(item.text);
            } else if (item.kind === 'reasoning' && item.text) {
              service.sendToRenderer('agent:thought', {
                text: item.text,
                conversationId: targetConversationId,
              });
            } else if (item.kind === 'commandExecution') {
              toolEvent(
                service,
                targetConversationId,
                'run_command',
                item.command,
                item.exitCode === 0 ? 'ok' : `exit ${item.exitCode}`
              );
            } else if (item.kind === 'fileChange') {
              handleFileChangeCompleted(service, targetConversationId, rootPath, item, changedTexFiles);
            } else if (item.kind === 'mcpToolCall') {
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
      codex.on('event', listener);
    });

    // ---- 中断: 既存の AbortController 経路をそのまま利用 ----
    const onAbort = () => {
      codex.interrupt(targetConversationId);
    };
    run.controller.signal.addEventListener('abort', onAbort, { once: true });

    // ---- ターン開始 ----
    const { threadId } = await codex.sendMessage({
      key: targetConversationId,
      projectDir: rootPath,
      text: buildLlmInput(userText, context),
      images,
      // 任意設定: agent settings に codexModel があれば Codex 側モデルを固定できる
      model: typeof settings?.codexModel === 'string' ? settings.codexModel : undefined,
    });
    turnThreadId = threadId;

    const result = await turnDone;
    if (!isCurrentRun()) return;

    if (!result.ok) {
      service.sendToRenderer('agent:error', {
        message: result.error || 'Codex run failed.',
        conversationId: targetConversationId,
      });
      service.sendStatus('error', 'Codex error', targetConversationId);
      return;
    }

    // ---- 最終メッセージ ----
    const finalText = rewriteFileCitations(finalTexts.join('\n\n').trim(), rootPath);
    if (finalText) {
      conversation.push({ role: 'assistant', content: finalText });
      service.sendToRenderer('agent:message', {
        text: finalText,
        conversationId: targetConversationId,
      });
    }

    // ---- TeX ファイルが変わっていれば自動ビルド（Axiom と同じ体験） ----
    if (changedTexFiles.size > 0 && service.agentOptions?.autoBuild) {
      try {
        await service.executeToolCall({ name: 'run_build', args: {} }, targetConversationId);
      } catch (_) { /* build failures surface through build events */ }
    }

    service.sendStatus('idle', 'Waiting', targetConversationId);
  } catch (error) {
    if (!isCurrentRun()) return;
    if (error && error.message === 'aborted') {
      service.sendStatus('idle', 'Aborted.', targetConversationId);
      return;
    }
    service.sendToRenderer('agent:error', {
      message: error?.message || 'Codex run failed.',
      conversationId: targetConversationId,
    });
    service.sendStatus('error', 'Codex error', targetConversationId);
  } finally {
    if (listener) codex.removeListener('event', listener);
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);
  }
};

// Codex がディスクに書いた変更を開いているエディタバッファへ反映する。
const handleFileChangeCompleted = (service, conversationId, rootPath, item, changedTexFiles) => {
  const changes = item.changes || [];
  const relPaths = [];
  for (const change of changes) {
    if (!change.path) continue;
    const absPath = path.isAbsolute(change.path)
      ? change.path
      : path.join(rootPath, change.path);
    const relPath = path.relative(rootPath, absPath);
    if (relPath.startsWith('..')) continue;
    relPaths.push(relPath);
    if (TEX_FILE_PATTERN.test(relPath)) changedTexFiles.add(relPath);
    if (change.kind === 'delete') continue;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      service.sendToRenderer('agent:applyContent', {
        path: relPath,
        content,
        updateSaved: true,
      });
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
