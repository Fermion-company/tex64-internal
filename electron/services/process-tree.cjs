'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WINDOWS_JOB_METADATA = Symbol('tex64.windowsJobMetadata');
const WINDOWS_JOB_CLEANUP_TIMEOUT_MS = 8000;
const WINDOWS_JOB_CANCEL_TIMEOUT_MS = 10000;

const quoteWindowsArgument = (value) => {
  const text = String(value ?? '');
  if (text.length > 0 && !/[\s"]/u.test(text)) return text;
  let quoted = '"';
  let backslashes = 0;
  for (const char of text) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2) + '"';
  return quoted;
};

const quoteCmdToken = (value) => {
  // Delayed expansion is disabled by /V:OFF. Keep the conventional cmd.exe
  // quoting used for .cmd/.bat launchers without changing literal arguments.
  const escaped = String(value ?? '')
    .replace(/"/gu, '""');
  return `"${escaped}"`;
};

const resolveWindowsExecutable = (command, env) => {
  const raw = String(command || '');
  if (!raw || path.win32.isAbsolute(raw) || /[\\/]/u.test(raw)) return raw;
  const pathValue = Object.entries(env || {}).find(
    ([key]) => key.toUpperCase() === 'PATH',
  )?.[1];
  if (typeof pathValue !== 'string' || !pathValue) return raw;
  const hasExtension = path.win32.extname(raw).length > 0;
  const pathExtValue = Object.entries(env || {}).find(
    ([key]) => key.toUpperCase() === 'PATHEXT',
  )?.[1];
  const extensions = hasExtension
    ? ['']
    : String(pathExtValue || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (const directoryValue of pathValue.split(path.win32.delimiter)) {
    const directory = directoryValue.trim().replace(/^"|"$/gu, '');
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${raw}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return raw;
};

const windowsInvocation = (command, args, options) => {
  const env = options.env || process.env;
  const needsCmd = options.shell === true || /\.(?:bat|cmd)$/iu.test(String(command || ''));
  if (needsCmd) {
    const executable = resolveWindowsExecutable(
      env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe',
      env,
    );
    const shellLine = [command, ...(Array.isArray(args) ? args : [])]
      .map(quoteCmdToken)
      .join(' ');
    return {
      executable,
      // cmd.exe expects the /C payload to have one outer quote pair. The
      // individual tokens remain quoted inside that pair.
      commandLine: `${quoteWindowsArgument(executable)} /D /V:OFF /S /C "${shellLine}"`,
    };
  }
  const executable = resolveWindowsExecutable(command, env);
  const argv = [executable, ...(Array.isArray(args) ? args : [])];
  return {
    executable,
    commandLine: argv.map(quoteWindowsArgument).join(' '),
  };
};

const windowsJobScriptPath = () => {
  const sourcePath = path.join(__dirname, 'windows-job.ps1');
  const packedSegment = `${path.sep}app.asar${path.sep}`;
  if (sourcePath.includes(packedSegment)) {
    return sourcePath.replace(
      packedSegment,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
  }
  return sourcePath;
};

const readCompletion = (statusPath) => {
  try {
    const raw = fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/u, '');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    return {
      cleanupOk: value.cleanupOk === true,
      cancelled: value.cancelled === true,
      targetExitCode: Number.isInteger(value.targetExitCode)
        ? value.targetExitCode
        : null,
      error: typeof value.error === 'string' ? value.error : '',
    };
  } catch {
    return null;
  }
};

/**
 * Spawn a subprocess whose entire Windows descendant tree is owned from the
 * first instruction by a private Job Object. Closing the helper, a natural
 * root exit, or an explicit cancel all terminate remaining descendants.
 *
 * POSIX keeps the existing direct-spawn/process-group behaviour.
 */
const spawnOwnedProcess = (command, args = [], options = {}) => {
  if (process.platform !== 'win32') {
    return spawn(command, args, options);
  }

  const invocation = windowsInvocation(command, args, options);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex64-job-'));
  const configPath = path.join(stateDir, 'launch.json');
  const cancelPath = path.join(stateDir, 'cancel');
  const statusPath = path.join(stateDir, 'status.json');
  const config = {
    executable: invocation.executable,
    commandLine: invocation.commandLine,
    workingDirectory: options.cwd || process.cwd(),
    cancelPath,
    statusPath,
    cleanupTimeoutMs: WINDOWS_JOB_CLEANUP_TIMEOUT_MS,
    parentPid: process.pid,
  };
  fs.writeFileSync(configPath, JSON.stringify(config), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const helperOptions = { ...options };
  delete helperOptions.shell;
  delete helperOptions.detached;
  delete helperOptions.windowsVerbatimArguments;
  helperOptions.windowsHide = true;
  helperOptions.detached = false;

  let child;
  try {
    const systemRoot = options.env?.SystemRoot ||
      options.env?.SYSTEMROOT ||
      process.env.SystemRoot ||
      process.env.SYSTEMROOT;
    const powershellPath = systemRoot
      ? path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
      : 'powershell.exe';
    child = spawn(
      powershellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowsJobScriptPath(),
        '-ConfigPath',
        configPath,
      ],
      helperOptions,
    );
  } catch (error) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }

  const metadata = {
    cancelPath,
    statusPath,
    stateDir,
    closed: false,
    completion: null,
  };
  Object.defineProperty(child, WINDOWS_JOB_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
  child.once('close', () => {
    metadata.closed = true;
    metadata.completion = readCompletion(statusPath);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return child;
};

const waitForOwnedClose = (child, metadata, timeoutMs) =>
  new Promise((resolve) => {
    if (metadata.closed) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('close', onClose);
  });

const getOwnedProcessCompletion = (child) => {
  const metadata = child?.[WINDOWS_JOB_METADATA] || null;
  if (!metadata?.closed) return null;
  return metadata.completion;
};

const waitForExit = (child, timeoutMs = 4000) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      finish({ ok: false, code: null });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', () => finish({ ok: false, code: null }));
    child.once('close', (code) => finish({ ok: code === 0, code }));
  });

const runWindowsCommand = async (command, args) => {
  try {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    return await waitForExit(child);
  } catch {
    return { ok: false, code: null };
  }
};

/**
 * Ask the Job Object owner to terminate and verify every descendant. A raw PID
 * is still force-killed for backward compatibility, but can never be reported
 * as verified: once an intermediate parent is dead, PID ancestry is incomplete.
 */
const terminateWindowsProcessTree = async (childOrPid) => {
  if (process.platform !== 'win32') return false;

  const child = childOrPid && typeof childOrPid === 'object' ? childOrPid : null;
  const metadata = child?.[WINDOWS_JOB_METADATA] || null;
  if (child && metadata) {
    if (metadata.closed) return metadata.completion?.cleanupOk === true;
    try {
      fs.writeFileSync(metadata.cancelPath, 'cancel\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== 'EEXIST' && !metadata.closed) {
        // Fall through to the emergency helper kill below. Without a status
        // record this path is deliberately not considered verified cleanup.
      }
    }
    if (await waitForOwnedClose(child, metadata, WINDOWS_JOB_CANCEL_TIMEOUT_MS)) {
      return metadata.completion?.cleanupOk === true;
    }
  }

  const pid = child?.pid ?? childOrPid;
  if (Number.isInteger(pid) && pid > 0) {
    await runWindowsCommand('taskkill.exe', [
      '/pid',
      String(pid),
      '/T',
      '/F',
    ]);
    if (child && metadata) {
      await waitForOwnedClose(child, metadata, 2000);
    }
  }
  // taskkill only follows the currently visible ancestry. It cannot prove that
  // a descendant of an already-dead intermediate process was removed.
  return false;
};

module.exports = {
  spawnOwnedProcess,
  terminateWindowsProcessTree,
  getOwnedProcessCompletion,
  // Pure helpers are exported for deterministic Windows command-line tests on
  // non-Windows CI. They do not launch a process.
  _quoteWindowsArgument: quoteWindowsArgument,
  _windowsInvocation: windowsInvocation,
};
