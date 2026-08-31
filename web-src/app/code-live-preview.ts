// Real-time preview for Code mode (settings > Build > Preview).
// TDOM owns incremental compilation only. Every landed PDF is handed to the
// same PDF.js surface Code already uses for an ordinary build; there is no
// live-only iframe, toolbar, window, or page interaction model. AI mode keeps
// its normal build-backed paper view and never receives TDOM snapshots.

import type { EditorGroupState } from "./editor-session/types.js";
import type { BridgeWindow } from "./types.js";
import type { LivePdfSnapshot } from "./viewer.js";
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
  openCodePreview,
}: {
  getActiveGroup: () => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getAppMode: () => string;
  getWorkspaceRoot: () => string | null;
  getRootFile: () => string | null;
  getDirtyFileSnapshots: () => DirtySnapshot[];
  openCodePreview: (snapshot: LivePdfSnapshot) => void;
}) => {
  const bridge = (window as BridgeWindow).tex64Tdom;
  let active = false;
  let starting = false;
  let engineStarted = false;
  let engineUrl: string | null = null;
  let livePdf: (LivePdfSnapshot & { mainFile: string }) | null = null;
  let snapshotDocumentEpoch = 0;
  let snapshotGeneration = 0;
  let snapshotInFlight = false;
  let lifecycleVersion = 0;
  let latestPushVersion = 0;
  let liveSessionKey: string | null = null;
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
    const offset = cursorOffset();
    if (offset == null) return;
    void bridge.focus({ offset }).catch(() => {});
  };
  const debouncedFocus = createDebouncedTask(focusCurrent, 160);

  const distributeLive = (snapshot: typeof livePdf) => {
    const groups = getEditorGroups();
    for (const group of groups) group.viewer.setLivePreview(snapshot);
    if (
      snapshot &&
      !groups.some((group) => group.openTabs.includes(snapshot.path))
    ) {
      openCodePreview(snapshot);
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
      // Code must stream the open root even before its dirty marker settles.
      // Non-root files remain dirty-only overlays.
      if (
        current &&
        (current.group.isDirty || currentRelative === rootInsideWorkspace)
      ) {
        buffers.set(current.path, current.editor.getValue?.() ?? "");
      }
      const sessionKey = `${workspaceRoot}\0${rootFile}`;
      return {
        sessionKey,
        buffers,
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
      payload: {
        source,
        path: current.path,
        fresh: `legacy\0${current.path}` !== queuedSessionKey,
        clientEditAtEpochMs: latestInputAtEpochMs || undefined,
      },
    };
  };

  const pollSnapshot = async () => {
    if (!active || !engineStarted || !liveSessionKey || snapshotInFlight || !bridge?.snapshot) return;
    const pollLifecycleVersion = lifecycleVersion;
    snapshotInFlight = true;
    try {
      const result = await bridge.snapshot({
        afterDocumentEpoch: snapshotDocumentEpoch,
        afterGeneration: snapshotGeneration,
      });
      if (!active || pollLifecycleVersion !== lifecycleVersion) return;
      if (!result?.ok) throw new Error(result?.error || "live preview snapshot failed");
      snapshotDocumentEpoch = Number(result.documentEpoch) || snapshotDocumentEpoch;
      snapshotGeneration = Number(result.generation) || snapshotGeneration;
      if (result.unchanged) return;
      if (
        typeof result.path !== "string" ||
        !result.path.toLowerCase().endsWith(".pdf") ||
        typeof result.mainFile !== "string" ||
        !result.mainFile.toLowerCase().endsWith(".tex") ||
        typeof result.data !== "string" ||
        !result.data
      ) {
        return;
      }
      livePdf = {
        path: result.path,
        mainFile: result.mainFile,
        data: result.data,
        mimeType: result.mimeType || "application/pdf",
        generation: Number(result.generation) || 0,
        documentEpoch: Number(result.documentEpoch) || 0,
      };
      distributeLive(livePdf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showLiveError(message);
    } finally {
      snapshotInFlight = false;
    }
  };

  const retireObsoleteSession = (nextSessionKey: string) => {
    const queuedSessionIsObsolete = queuedSessionKey !== null && queuedSessionKey !== nextSessionKey;
    const visibleSessionIsObsolete = liveSessionKey !== null && liveSessionKey !== nextSessionKey;
    if (!queuedSessionIsObsolete && !visibleSessionIsObsolete) return;

    // Invalidate an in-flight result immediately, before the 80ms push
    // debounce. Otherwise a completed /open for the previous project can
    // briefly replace the new project's PDF after the editor has switched.
    latestPushVersion += 1;
    pendingPush = null;
    queuedSessionKey = null;
    queuedBuffers.clear();
    if (engineUrl || livePdf || visibleSessionIsObsolete) {
      engineUrl = null;
      liveSessionKey = null;
      livePdf = null;
      snapshotDocumentEpoch = 0;
      snapshotGeneration = 0;
      distributeLive(null);
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
          engineUrl = result.url;
          liveSessionKey = snapshot.sessionKey;
          if (snapshot.payload.fresh) {
            livePdf = null;
            snapshotDocumentEpoch = 0;
            snapshotGeneration = 0;
            distributeLive(null);
          }
          void pollSnapshot();
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
    retireObsoleteSession(snapshot.sessionKey);
    // Never push mid-IME-composition: the buffer is transient and a typeset
    // per composition keystroke is wasted work. Try again after the debounce.
    if (current?.group.isComposing) {
      debouncedPush();
      return;
    }
    if (
      snapshot.sessionKey === queuedSessionKey &&
      sameBuffers(snapshot.buffers, queuedBuffers)
    ) return;
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
      // The first project push resets the engine's boot sample. Only a PDF
      // snapshot belonging to that project is ever distributed.
      bindActiveEditor();
      debouncedPush();
    } finally {
      starting = false;
    }
  };

  const suspend = () => {
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
    livePdf = null;
    snapshotDocumentEpoch = 0;
    snapshotGeneration = 0;
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

  const refresh = () => {
    const mode = getAppMode();
    applyActive(
      editorSettings.isEnabled("preview.realtime") &&
      mode === "code",
    );
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
      if (
        snapshot &&
        (snapshot.sessionKey !== queuedSessionKey ||
          !sameBuffers(snapshot.buffers, queuedBuffers))
      ) debouncedPush();
      if (livePdf) distributeLive(livePdf);
    } else {
      distributeLive(null);
    }
  };

  editorSettings.subscribe((change) => {
    if (change.kind !== "flag" || change.id !== "preview.realtime") return;
    refresh();
  });

  // Same lightweight poll as pro-live-preview: notices tab switches, editor
  // swaps and app-mode changes without threading callbacks through every
  // call site.
  const poll = window.setInterval(refresh, 200);
  const snapshotPoll = window.setInterval(() => {
    void pollSnapshot();
  }, 250);
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
        livePdf = null;
        snapshotDocumentEpoch = 0;
        snapshotGeneration = 0;
        distributeLive(null);
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
    window.clearInterval(poll);
    window.clearInterval(snapshotPoll);
    window.clearInterval(healthPoll);
  }, { once: true });
  distributeLive(null);
  refresh();
  return { isActive: () => active };
};
