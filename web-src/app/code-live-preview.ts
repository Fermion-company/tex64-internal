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
import { getEditorModelPath } from "./editor-session/model-path.js";

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
    // Build whose paper this push may return to Live once the engine accepts it.
    releaseBuildView: number | null;
  }) | null = null;
  let pushing = false;
  let latestInputAtEpochMs = 0;
  let nextExactInputId = 0;
  type ExactInput = {
    id: number;
    sessionKey: string;
    path: string;
    text: string;
    editAtEpochMs: number;
  };
  const pendingExactInputs = new Map<string, ExactInput>();
  // Session and edit version a completed Build typeset. Dirty-only buffers
  // cannot tell a saved edit from the Build's source, so edits are counted.
  let builtSnapshot: { sessionKey: string; editVersion: number } | null = null;
  let sourceEditVersion = 0;
  let buildStartEditVersion: number | null = null;
  let sourceRefreshPending = false;
  let buildOwnsView = false;
  let buildViewVersion = 0;
  // Revision accepted for the first change after a Build; the viewer keeps the
  // Build PDF until Live presents at least this revision.
  let liveExpectedSrcRev: number | null = null;

  const cursorOffset = (editor: LiveEditor | null = currentProjectSource()?.editor ?? null) => {
    const position = editor?.getPosition?.();
    const offset = position ? editor?.getModel?.()?.getOffsetAt?.(position) : null;
    return Number.isFinite(Number(offset)) ? Number(offset) : null;
  };

  const focusCurrent = () => {
    if (!active || !engineStarted || !bridge?.focus) return;
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
  // embedded incremental renderer. While a completed Build owns the paper,
  // the same frame is kept below that PDF instead of being recreated.
  const distributeLive = (url: string | null, generation = liveGeneration) => {
    for (const group of getEditorGroups()) {
      group.viewer.setLivePreview(url, generation, liveTarget, buildOwnsView, buildOwnsView ? null : liveExpectedSrcRev);
    }
  };

  const showLiveError = (message: string) => console.warn("[live-preview]", message);

  const editorModelPath = (editor: LiveEditor | null) => {
    return getEditorModelPath(editor?.getModel?.() ?? null);
  };

  const sameFilePath = (left: string, right: string) => {
    const comparable = (value: string) => {
      const normalized = value.replace(/\\/g, "/");
      return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    return comparable(left) === comparable(right);
  };

  const activeEditorPathMismatch = () => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const editor = group.editor as LiveEditor | null;
    if (!path || !PROJECT_SOURCE_RE.test(path) || !editor?.getValue) return false;
    const modelPath = editorModelPath(editor);
    return Boolean(modelPath && !sameFilePath(modelPath, path));
  };

  const currentProjectSource = () => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const editor = group.editor as LiveEditor | null;
    if (!path || !PROJECT_SOURCE_RE.test(path) || !editor?.getValue) return null;
    const modelPath = editorModelPath(editor);
    // One Monaco editor is reused while setModel switches files. During that
    // handoff currentFilePath and the actual model can briefly name different
    // files; never attach one model's bytes to the other's path.
    if (modelPath && !sameFilePath(modelPath, path)) return null;
    return { group, path, editor };
  };

  const sameBuffers = (left: Map<string, string>, right: Map<string, string>) => {
    if (left.size !== right.size) return false;
    for (const [path, text] of left) if (right.get(path) !== text) return false;
    return true;
  };

  const captureExactInput = (path: string | null, editor: LiveEditor | null, editedAtEpochMs: number) => {
    if (!path || !PROJECT_SOURCE_RE.test(path) || !editor?.getValue) return;
    const workspaceRoot = getWorkspaceRoot();
    const configuredRoot = getRootFile();
    const rootFile = configuredRoot || (path.toLowerCase().endsWith(".tex") ? path : null);
    const sessionKey = workspaceRoot && rootFile
      ? `${workspaceRoot}\0${rootFile}`
      : path.toLowerCase().endsWith(".tex") ? `legacy\0${path}` : null;
    if (!sessionKey) return;
    pendingExactInputs.set(path, {
      id: ++nextExactInputId,
      sessionKey,
      path,
      text: editor.getValue(),
      editAtEpochMs: editedAtEpochMs,
    });
  };

  const clearAcceptedExactInputs = (
    snapshot: NonNullable<ReturnType<typeof currentSnapshot>>,
    allowEquivalentBytes = false
  ) => {
    for (const [path, exactInput] of pendingExactInputs) {
      if (exactInput.sessionKey !== snapshot.sessionKey) continue;
      const sameCapture = snapshot.exactInputIds.get(path) === exactInput.id;
      const sameAcceptedBytes = snapshot.buffers.get(path) === exactInput.text;
      if (sameCapture || (allowEquivalentBytes && sameAcceptedBytes)) pendingExactInputs.delete(path);
    }
  };

  const currentSnapshot = () => {
    // Keep event-time captures queued until the editor group's path catches up
    // with its newly installed model. The capture itself is already bound to
    // the model URI, so no keystroke is lost while dispatch is held.
    if (activeEditorPathMismatch()) return null;
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
      // Clean files come from the project snapshot on disk. Serializing the
      // clean root only while its tab is active would turn a root/child tab
      // switch into a source edit. External reloads explicitly call
      // refreshSource below, which forces a same-session disk refresh.
      if (current?.group.isDirty) {
        buffers.set(current.path, current.editor.getValue?.() ?? "");
      }
      const sessionKey = `${workspaceRoot}\0${rootFile}`;
      const exactInputs = [...pendingExactInputs.values()].filter((input) => input.sessionKey === sessionKey);
      // A save can make the active buffer clean before the 80ms task runs.
      // Keep the exact bytes observed by the editor notification until the
      // engine accepts them; a later clean snapshot removes the overlay.
      for (const exactInput of exactInputs) buffers.set(exactInput.path, exactInput.text);
      return {
        sessionKey,
        buffers,
        exactInputIds: new Map(exactInputs.map((input) => [input.path, input.id])),
        target: /\.tex$/i.test(rootFile)
          ? { workspaceRoot, pdfPath: rootFile.replace(/\.tex$/i, ".pdf") } : null,
        payload: {
          workspaceRoot,
          rootFile,
          buffers: [...buffers].map(([path, text]) => ({ path, text })),
          fresh: sessionKey !== queuedSessionKey,
          clientEditAtEpochMs: exactInputs.length === 1
            ? exactInputs[0].editAtEpochMs : latestInputAtEpochMs || undefined,
        },
      };
    }
    if (!current || !current.path.toLowerCase().endsWith(".tex")) return null;
    const source = current.editor.getValue?.() ?? "";
    const sessionKey = `legacy\0${current.path}`;
    const exactInput = pendingExactInputs.get(current.path)?.sessionKey === sessionKey
      ? pendingExactInputs.get(current.path)! : null;
    return {
      sessionKey,
      buffers: new Map([[current.path, exactInput?.text ?? source]]),
      exactInputIds: new Map(exactInput ? [[current.path, exactInput.id]] : []),
      target: { workspaceRoot: null, pdfPath: current.path.replace(/\.tex$/i, ".pdf") },
      payload: {
        source: exactInput?.text ?? source,
        path: current.path,
        fresh: sessionKey !== queuedSessionKey,
        clientEditAtEpochMs: exactInput?.editAtEpochMs ?? (latestInputAtEpochMs || undefined),
      },
    };
  };

  const retireObsoleteSession = (nextSessionKey: string) => {
    for (const [path, exactInput] of pendingExactInputs) {
      if (exactInput.sessionKey !== nextSessionKey) pendingExactInputs.delete(path);
    }
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
    builtSnapshot = null;
    buildOwnsView = false;
    liveExpectedSrcRev = null;
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
        // Only the capture ids carried by this accepted request are retired.
        // An older acknowledgement must never clear a newer edit of same bytes.
        clearAcceptedExactInputs(snapshot);
        const isCurrent =
          active &&
          snapshot.lifecycleVersion === lifecycleVersion &&
          snapshot.pushVersion === latestPushVersion;
        // The engine accepted a source that differs from the Build's. A newer
        // queued push (such as the overlay removal after autosave) only moves
        // it further, so an accepted release need not be the latest push.
        const releasesBuild = active && snapshot.lifecycleVersion === lifecycleVersion &&
          buildOwnsView && snapshot.releaseBuildView === buildViewVersion;
        if (releasesBuild) {
          builtSnapshot = null;
          buildOwnsView = false;
          liveExpectedSrcRev = Number.isInteger(result.srcRev) ? Number(result.srcRev) : null;
        }
        if (result.url && isCurrent) {
          if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl) liveGeneration += 1;
          engineUrl = result.url;
          liveSessionKey = snapshot.sessionKey;
          liveTarget = snapshot.target;
          distributeLive(engineUrl, liveGeneration);
        } else if (releasesBuild && engineUrl) {
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
    // A Build keeps the paper until the engine accepts a source that differs
    // from the one it typeset; that push carries the release.
    const changedSinceBuild = Boolean(builtSnapshot) && (sourceRefreshPending ||
      snapshot.sessionKey !== builtSnapshot?.sessionKey || sourceEditVersion !== builtSnapshot?.editVersion);
    retireObsoleteSession(snapshot.sessionKey);
    // Never push mid-IME-composition: the buffer is transient and a typeset
    // per composition keystroke is wasted work. Try again after the debounce.
    if (current?.group.isComposing) {
      debouncedPush();
      return;
    }
    if (!sourceRefreshPending &&
        snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers)) {
      // With no queued or in-flight request, queuedBuffers is the last source
      // the bridge accepted. A new capture of those same bytes is already live.
      if (!pushing && !pendingPush) clearAcceptedExactInputs(snapshot, true);
      return;
    }
    queuedSessionKey = snapshot.sessionKey;
    queuedBuffers = new Map(snapshot.buffers);
    sourceRefreshPending = false;
    pendingPush = {
      ...snapshot,
      pushVersion: ++latestPushVersion,
      lifecycleVersion,
      releaseBuildView: changedSinceBuild ? buildViewVersion : null,
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
      const eventEditor = boundEditor;
      const eventPath = boundPath;
      const eventModel = eventEditor.getModel?.() ?? null;
      disposable = eventEditor.onDidChangeModelContent(() => {
        sourceEditVersion += 1;
        const editedAtEpochMs = Date.now();
        latestInputAtEpochMs = editedAtEpochMs;
        const currentModel = eventEditor.getModel?.() ?? null;
        const modelPath = editorModelPath(eventEditor);
        // The listener belongs to the editor, not to the model. A tab/search
        // navigation can replace its model before the 200ms binding poll.
        // Prefer the model URI; only use the bound path when the original
        // URI-less model is still installed.
        const exactPath = modelPath ?? (currentModel === eventModel ? eventPath : null);
        captureExactInput(exactPath, eventEditor, editedAtEpochMs);
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
    pendingExactInputs.clear();
    sourceRefreshPending = false;
    pendingPush = null;
    engineStarted = false;
    engineUrl = null;
    liveSessionKey = null;
    buildOwnsView = false;
    liveExpectedSrcRev = null;
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
      if (snapshot && (sourceRefreshPending || snapshot.sessionKey !== queuedSessionKey || !sameBuffers(snapshot.buffers, queuedBuffers))) debouncedPush();
      if (engineUrl) distributeLive(engineUrl);
    } else distributeLive(null);
  };

  const refreshSource = () => {
    if (!active) return;
    sourceEditVersion += 1;
    sourceRefreshPending = true;
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
      state: string; pdfPath?: string; targetFile?: string; workspaceRoot?: string;
      previousPdf?: boolean; sourceChanged?: boolean;
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
      const targetPdf = absolute(pdfPath);
      const targetIsVisible = getEditorGroups().some((group) =>
        group.viewer.getViewerMode() === "pdf" &&
        typeof group.currentFilePath === "string" &&
        absolute(group.currentFilePath) === targetPdf
      );
      if (detail.previousPdf === true && !targetIsVisible && !buildOwnsView) {
        const snapshot = currentSnapshot();
        builtSnapshot = snapshot
          ? { sessionKey: snapshot.sessionKey, editVersion: sourceEditVersion }
          : null;
        buildOwnsView = Boolean(builtSnapshot);
        if (buildOwnsView) {
          buildViewVersion += 1;
          liveExpectedSrcRev = null;
          if (engineUrl) distributeLive(engineUrl);
        }
      }
      return;
    }
    const sourceChanged = buildStartEditVersion !== null && buildStartEditVersion !== sourceEditVersion ||
      getDirtyFileSnapshots().some((snapshot) => snapshot.isDirty && PROJECT_SOURCE_RE.test(snapshot.path));
    buildStartEditVersion = null;
    if (detail.state !== "success") return;
    detail.sourceChanged = sourceChanged;
    // A completed Build owns the paper only while this exact source remains
    // current. The engine keeps its accepted source, document generation and
    // warm checkpoints, so the next edit stays on /edit. Ownership travels
    // with the Live state: a PDF tab this Build has just opened applies it
    // once its viewer is ready, and late responses redistribute it unchanged.
    const built = sourceChanged ? null : currentSnapshot();
    builtSnapshot = built ? { sessionKey: built.sessionKey, editVersion: sourceEditVersion } : null;
    buildOwnsView = Boolean(builtSnapshot);
    if (buildOwnsView) buildViewVersion += 1;
    liveExpectedSrcRev = null;
    if (engineUrl) distributeLive(engineUrl);
    if (!buildOwnsView) debouncedPush();
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
        // A restart is not a source change: a Build that still matches the
        // source keeps the paper, and the recovered frame arrives held. An
        // edit made meanwhile releases it through the accepted push as usual.
        liveExpectedSrcRev = null;
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
