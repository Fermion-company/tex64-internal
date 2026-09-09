// Real-time preview for Code mode (beta, settings > Build > Preview).
//
// The preview replaces only the page canvas inside the ordinary in-tab PDF
// viewer. The existing PDF toolbar and split-view path stay in place; no
// separate window or second preview surface is created. While the
// `preview.realtime` flag is on and the app is in Code mode, this module
// starts the local TDOM engine, streams the active .tex buffer to it as the
// user types, and flips those viewers into live mode; each viewer swaps only
// its page canvas for the engine's embedded client, keeping its own toolbar
// and chrome. Turning the flag off restores the static PDF everywhere and
// stops the engine.

import type { EditorGroupState } from "./editor-session/types.js";
import type { BridgeWindow } from "./types.js";
import type { LivePreviewTarget } from "./viewer.js";
import { editorSettings } from "./editor-settings/editor-settings-store.js";

const createDebouncedTask = (task: () => void, delayMs: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      task();
    }, delayMs);
  };
  schedule.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return schedule;
};

type LiveEditor = {
  getValue?: () => string;
  onDidChangeModelContent?: (listener: () => void) => { dispose: () => void };
  onDidChangeCursorPosition?: (listener: () => void) => { dispose: () => void };
  getPosition?: () => { lineNumber: number; column: number } | null;
  getModel?: () => {
    getOffsetAt?: (position: { lineNumber: number; column: number }) => number;
  } | null;
};

type DirtySnapshot = { path: string; content: string; isDirty: boolean; truncated: boolean };
const PROJECT_SOURCE_RE = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|cfg|def|lbx|ltx|dtx|ins)$/i;

export const initCodeLivePreview = ({
  getActiveGroup,
  getEditorGroups,
  getAppMode,
  getWorkspaceRoot,
  getRootFile,
  getDirtyFileSnapshots,
}: {
  getActiveGroup: () => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getAppMode: () => string;
  getWorkspaceRoot: () => string | null;
  getRootFile: () => string | null;
  getDirtyFileSnapshots: () => DirtySnapshot[];
}) => {
  const bridge = (window as BridgeWindow).tex64Tdom;
  let active = false;
  let starting = false;
  let engineStarted = false;
  let engineUrl: string | null = null;
  let liveGeneration = 0;
  let lifecycleVersion = 0;
  let latestPushVersion = 0;
  let liveSessionKey: string | null = null;
  let liveTarget: LivePreviewTarget | null = null;
  let boundEditor: LiveEditor | null = null;
  let boundPath: string | null = null;
  let disposable: { dispose: () => void } | null = null;
  let cursorDisposable: { dispose: () => void } | null = null;
  let queuedSessionKey: string | null = null;
  let queuedBuffers = new Map<string, string>();
  let pendingPush: (NonNullable<ReturnType<typeof currentSnapshot>> & {
    pushVersion: number;
    lifecycleVersion: number;
  }) | null = null;
  let pushing = false;
  let latestInputAtEpochMs = 0;
  let builtSnapshot: { sessionKey: string; buffers: Map<string, string> } | null = null;
  let sourceEditVersion = 0;
  let buildStartEditVersion: number | null = null;

  const cursorOffset = (editor: LiveEditor | null = currentProjectSource()?.editor ?? null) => {
    const position = editor?.getPosition?.();
    const offset = position ? editor?.getModel?.()?.getOffsetAt?.(position) : null;
    return Number.isFinite(Number(offset)) ? Number(offset) : null;
  };

  const focusCurrent = () => {
    if (!active || builtSnapshot || !engineStarted || !bridge?.focus) return;
    // A character insertion moves the Monaco caret too. Let its 80ms source
    // push finish first; otherwise a speculative warm against the old source
    // can grab the resident chain just before the real edit arrives.
    if (pushing || pendingPush || latestInputAtEpochMs) {
      debouncedFocus();
      return;
    }
    const source = currentProjectSource();
    const offset = cursorOffset(source?.editor);
    if (offset == null) return;
    void bridge.focus({ offset, filePath: source?.path }).catch(() => {});
  };
  const debouncedFocus = createDebouncedTask(focusCurrent, 160);

  // Flip the existing in-tab PDF surfaces into or out of live mode. The PDF
  // frame keeps its ordinary toolbar and swaps only the page canvas for the
  // embedded incremental renderer.
  const distributeLive = (url: string | null, generation = liveGeneration) => {
    for (const group of getEditorGroups()) {
      group.viewer.setLivePreview(url, generation, liveTarget);
    }
  };

  const showLiveError = (message: string) => console.warn("[live-preview]", message);

  const currentProjectSource = () => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const editor = group.editor as LiveEditor | null;
    if (!path || !PROJECT_SOURCE_RE.test(path) || !editor?.getValue) return null;
    return { group, path, editor };
  };

  const sameBuffers = (left: Map<string, string>, right: Map<string, string>) => {
    if (left.size !== right.size) return false;
    for (const [path, text] of left) if (right.get(path) !== text) return false;
    return true;
  };

  const currentSnapshot = () => {
    const current = currentProjectSource();
    const workspaceRoot = getWorkspaceRoot();
    const configuredRoot = getRootFile();
    const rootFile = configuredRoot || (current?.path.toLowerCase().endsWith(".tex") ? current.path : null);
    if (workspaceRoot && rootFile) {
      const buffers = new Map<string, string>();
      for (const snapshot of getDirtyFileSnapshots()) {
        if (snapshot.isDirty && !snapshot.truncated && PROJECT_SOURCE_RE.test(snapshot.path)) {
          buffers.set(snapshot.path, snapshot.content);
        }
      }
      const workspaceNormalized = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
      const projectRelative = (value?: string) => {
        const normalized = value?.replace(/\\/g, "/").replace(/^\.\//, "");
        return normalized?.startsWith(`${workspaceNormalized}/`)
          ? normalized.slice(workspaceNormalized.length + 1)
          : normalized;
      };
      const rootInsideWorkspace = projectRelative(rootFile);
      const currentRelative = projectRelative(current?.path);
      // Keep the configured root exact even while it is clean. This also
      // notices an external reload of main.tex; all non-root files remain
      // dirty-only overlays and are never serialized just for a tab switch.
      if (current && (current.group.isDirty || currentRelative === rootInsideWorkspace)) {
        buffers.set(current.path, current.editor.getValue?.() ?? "");
      }
      const sessionKey = `${workspaceRoot}\0${rootFile}`;
      return {
        sessionKey,
        buffers,
        target: /\.tex$/i.test(rootFile)
          ? { workspaceRoot, pdfPath: rootFile.replace(/\.tex$/i, ".pdf") } : null,
        payload: {
          workspaceRoot,
          rootFile,
          buffers: [...buffers].map(([path, text]) => ({ path, text })),
          fresh: sessionKey !== queuedSessionKey,
          clientEditAtEpochMs: latestInputAtEpochMs || undefined,
        },
      };
    }
    if (!current || !current.path.toLowerCase().endsWith(".tex")) return null;
    const source = current.editor.getValue?.() ?? "";
    return {
      sessionKey: `legacy\0${current.path}`,
      buffers: new Map([[current.path, source]]),
      target: { workspaceRoot: null, pdfPath: current.path.replace(/\.tex$/i, ".pdf") },
      payload: {
        source,
        path: current.path,
        fresh: `legacy\0${current.path}` !== queuedSessionKey,
        clientEditAtEpochMs: latestInputAtEpochMs || undefined,
      },
    };
  };

  const retireObsoleteSession = (nextSessionKey: string) => {
    const queuedSessionIsObsolete = queuedSessionKey !== null && queuedSessionKey !== nextSessionKey;
    const visibleSessionIsObsolete = liveSessionKey !== null && liveSessionKey !== nextSessionKey;
    if (!queuedSessionIsObsolete && !visibleSessionIsObsolete) return;

    // Invalidate an in-flight result immediately, before the 80ms push
    // debounce. Otherwise a completed /open for the previous project can
    // briefly reactivate its iframe after the editor has already switched.
    latestPushVersion += 1;
    pendingPush = null;
    queuedSessionKey = null;
    queuedBuffers.clear();
    if (engineUrl || visibleSessionIsObsolete) {
      engineUrl = null;
      liveSessionKey = null;
      liveGeneration += 1;
      distributeLive(null, liveGeneration);
    }
  };

  const drainPushes = async () => {
    if (pushing || !bridge?.push) return;
    pushing = true;
    const drainLifecycleVersion = lifecycleVersion;
    let attemptedSnapshot: typeof pendingPush = null;
    try {
      // Single-flight latest-wins queue: while LuaLaTeX is working, new
      // keystrokes replace the one pending snapshot instead of building an
      // unbounded FIFO of already-obsolete document states.
      while (active && pendingPush) {
        const snapshot = pendingPush;
        pendingPush = null;
        attemptedSnapshot = snapshot;
        const result = await bridge.push(snapshot.payload);
        if (!result?.ok) throw new Error(result?.error || "live preview push failed");
        const isCurrent =
          active &&
          snapshot.lifecycleVersion === lifecycleVersion &&
          snapshot.pushVersion === latestPushVersion;
        if (result.url && isCurrent) {
          if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl) liveGeneration += 1;
          engineUrl = result.url;
          liveSessionKey = snapshot.sessionKey;
          liveTarget = snapshot.target;
          distributeLive(engineUrl, liveGeneration);
        }
        if (snapshot.payload.clientEditAtEpochMs === latestInputAtEpochMs) latestInputAtEpochMs = 0;
        attemptedSnapshot = null;
      }
    } catch (error) {
      const failureIsCurrent = Boolean(
        attemptedSnapshot &&
        active &&
        drainLifecycleVersion === lifecycleVersion &&
        attemptedSnapshot.lifecycleVersion === lifecycleVersion &&
        attemptedSnapshot.pushVersion === latestPushVersion
      );
      if (failureIsCurrent) {
        pendingPush = null;
        // Let the 200ms truth poll retry a fresh open instead of diffing
        // against a source the engine may not have accepted.
        queuedSessionKey = null;
        queuedBuffers.clear();
      }
      const message = error instanceof Error ? error.message : String(error);
      // A push can reject after Live was switched off, after a newer edit, or
      // after the editor changed projects. Never let that obsolete failure
      // discard the new pending snapshot.
      if (failureIsCurrent) showLiveError(message);
      console.warn("[live-preview]", message);
    } finally {
      pushing = false;
      if (active && pendingPush) void drainPushes();
    }
  };

  const pushCurrent = () => {
    if (!active || !bridge?.push) return;
    const current = currentProjectSource();
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    if (builtSnapshot) {
      if (snapshot.sessionKey === builtSnapshot.sessionKey && sameBuffers(snapshot.buffers, builtSnapshot.buffers)) return;
      builtSnapshot = null;
      snapshot.payload.fresh = true;
    }
    retireObsoleteSession(snapshot.sessionKey);
    // Never push mid-IME-composition: the buffer is transient and a typeset
    // per composition keystroke is wasted work. Try again after the debounce.
    if (current?.group.isComposing) {
      debouncedPush();
      return;
    }
    if (snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers)) return;
    queuedSessionKey = snapshot.sessionKey;
    queuedBuffers = new Map(snapshot.buffers);
    pendingPush = {
      ...snapshot,
      pushVersion: ++latestPushVersion,
      lifecycleVersion,
    };
    void drainPushes();
  };
  // 80ms, matching the engine's own client: the engine typesets a keystroke
  // in 20-60ms, so the debounce dominates end-to-end latency — 300ms (the
  // Pro live preview's value) made a ~50ms pipeline feel like half a second.
  const debouncedPush = createDebouncedTask(pushCurrent, 80);

  const bindActiveEditor = () => {
    if (!active) return;
    const current = currentProjectSource();
    const nextEditor = current?.editor ?? null;
    const nextPath = current?.path ?? null;
    if (nextEditor === boundEditor && nextPath === boundPath) return;
    disposable?.dispose();
    cursorDisposable?.dispose();
    disposable = null;
    cursorDisposable = null;
    boundEditor = nextEditor;
    boundPath = nextPath;
    if (boundEditor?.onDidChangeModelContent) {
      disposable = boundEditor.onDidChangeModelContent(() => {
        sourceEditVersion += 1;
        latestInputAtEpochMs = Date.now();
        debouncedPush();
      });
    }
    if (boundEditor?.onDidChangeCursorPosition) {
      cursorDisposable = boundEditor.onDidChangeCursorPosition(debouncedFocus);
    }
    debouncedPush();
    debouncedFocus();
  };

  const start = async () => {
    if (!bridge?.start || starting || !currentSnapshot()) return;
    const startLifecycleVersion = lifecycleVersion;
    starting = true;
    try {
      const result = await bridge.start();
      if (!active || startLifecycleVersion !== lifecycleVersion) return;
      if (!result?.ok || !result.url) {
        showLiveError(result?.error || "エンジンを起動できませんでした。");
        console.warn("[live-preview] engine failed to start:", result?.error);
        return;
      }
      engineStarted = true;
      // Do not expose the engine's tiny boot sample. The first successful
      // project push below returns the same URL and reveals the viewer only
      // after the configured root document is actually open.
      bindActiveEditor();
      debouncedPush();
    } finally {
      starting = false;
    }
  };

  const suspend = () => {
    builtSnapshot = null;
    buildStartEditVersion = null;
    lifecycleVersion += 1;
    latestPushVersion += 1;
    debouncedPush.cancel();
    debouncedFocus.cancel();
    disposable?.dispose();
    cursorDisposable?.dispose();
    disposable = null;
    cursorDisposable = null;
    boundEditor = null;
    boundPath = null;
    queuedSessionKey = null;
    queuedBuffers.clear();
    pendingPush = null;
    engineStarted = false;
    engineUrl = null;
    liveSessionKey = null;
    liveGeneration += 1;
    distributeLive(null);
  };

  const applyActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    if (active) void start();
    else {
      suspend();
      void bridge?.stop?.();
    }
  };

  let historyBlocked = false;
  const refresh = () => {
    applyActive(!historyBlocked && editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
    if (active) {
      if (!engineStarted && !starting) void start();
      bindActiveEditor();
      // A workspace switch can reuse the same Monaco editor instance while
      // swapping its model after currentFilePath changes. The editor binding
      // alone then observes neither transition and the old project remains
      // visible until the first typed character. Poll the actual path+buffer
      // pair as the source of truth; pushCurrent is still a no-op when both
      // match the last successful enqueue.
      const snapshot = currentSnapshot();
      if (snapshot) retireObsoleteSession(snapshot.sessionKey);
      if (snapshot && (snapshot.sessionKey !== queuedSessionKey || !sameBuffers(snapshot.buffers, queuedBuffers))) debouncedPush();
      if (engineUrl) distributeLive(engineUrl);
    } else distributeLive(null);
  };

  const refreshSource = () => {
    if (!active) return;
    sourceEditVersion += 1;
    builtSnapshot = null;
    latestInputAtEpochMs = Date.now();
    debouncedPush();
  };

  editorSettings.subscribe((change) => {
    if (change.kind !== "flag" || change.id !== "preview.realtime") return;
    refresh();
  });

  window.addEventListener("tex64:build-state", (event) => {
    if (!active || !liveTarget) return;
    const detail = (event as CustomEvent<{
      state: string; pdfPath?: string; targetFile?: string; workspaceRoot?: string; sourceChanged?: boolean;
    }>).detail;
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const root = liveTarget.workspaceRoot;
    if (detail.workspaceRoot && normalize(detail.workspaceRoot) !== normalize(root ?? "")) return;
    const absolute = (value: string) => /^(?:\/|[A-Za-z]:\/)/.test(value)
      ? normalize(value) : `${normalize(root ?? "")}/${normalize(value)}`;
    const pdfPath = detail.pdfPath ?? detail.targetFile?.replace(/\.tex$/i, ".pdf");
    if (!pdfPath || absolute(pdfPath) !== absolute(liveTarget.pdfPath)) return;
    if (detail.state === "building") {
      buildStartEditVersion ??= sourceEditVersion;
      return;
    }
    const sourceChanged = buildStartEditVersion !== null && buildStartEditVersion !== sourceEditVersion ||
      getDirtyFileSnapshots().some((snapshot) => snapshot.isDirty && PROJECT_SOURCE_RE.test(snapshot.path));
    buildStartEditVersion = null;
    if (detail.state !== "success") return;
    detail.sourceChanged = sourceChanged;
    // A completed Build owns the paper. Retire late live responses and let
    // the PDF frame load its deferred build output. The next source change
    // opens a fresh engine generation, so old canonical ink cannot win back.
    builtSnapshot = sourceChanged ? null : currentSnapshot();
    latestPushVersion += 1;
    pendingPush = null;
    debouncedPush.cancel();
    debouncedFocus.cancel();
    queuedSessionKey = null;
    queuedBuffers.clear();
    engineUrl = null;
    liveSessionKey = null;
    liveGeneration += 1;
    distributeLive(null);
    if (sourceChanged) debouncedPush();
  });

  // History owns the writer barrier and main-process shutdown. Retire the
  // renderer generation immediately so a late push cannot expose pre-restore
  // pages while files and editor models are being synchronized.
  const history = (window as unknown as { tex64History?: { onChange: (listener: (message: any) => void) => () => void } }).tex64History;
  const unsubscribeHistory = history?.onChange((message) => {
    const phase = message.type === "workspace:operation" ? message.payload?.phase
      : message.type === "updateWorkspace" ? message.payload?.workspaceOperation?.phase : undefined;
    if (typeof phase !== "string") return;
    historyBlocked = phase !== "idle";
    refresh();
  });

  // Same lightweight poll as pro-live-preview: notices tab switches, editor
  // swaps and app-mode changes without threading callbacks through every
  // call site.
  const poll = window.setInterval(refresh, 200);
  let checkingHealth = false;
  const healthPoll = window.setInterval(async () => {
    if (!active || !engineStarted || checkingHealth || !bridge?.status) return;
    const healthLifecycleVersion = lifecycleVersion;
    checkingHealth = true;
    try {
      const status = await bridge.status() as { running?: boolean; state?: string } | null;
      if (active && healthLifecycleVersion === lifecycleVersion &&
          (!status?.running || status.state !== "ready")) {
        lifecycleVersion += 1;
        latestPushVersion += 1;
        engineStarted = false;
        engineUrl = null;
        liveSessionKey = null;
        // Force the recovered URL through even when the OS gives the new
        // process the same port as the dead one.
        liveGeneration += 1;
        distributeLive(null, liveGeneration);
        queuedSessionKey = null;
        queuedBuffers.clear();
        pendingPush = null;
        void start();
      }
    } catch {
      // A transient IPC failure is retried by the next low-frequency poll.
    } finally {
      checkingHealth = false;
    }
  }, 2_000);
  window.addEventListener("beforeunload", () => {
    unsubscribeHistory?.();
    window.clearInterval(poll);
    window.clearInterval(healthPoll);
  }, { once: true });
  // Clear renderer state left by a reload before restoring the current
  // setting.
  distributeLive(null);
  refresh();
  return { isActive: () => active, refreshSource };
};
