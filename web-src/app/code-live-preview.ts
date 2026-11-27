// Real-time preview for Code mode (beta, settings > Build > Preview).
//
// The preview replaces only the page canvas inside the ordinary PDF viewer,
// whether it is an in-tab surface or the configured Build window. The existing
// PDF toolbar stays in place; no live-only preview surface is created. While the
// `preview.realtime` flag is on and the app is in Code mode, this module
// starts the local TDOM engine, streams the active .tex buffer to it as the
// user types, and flips those viewers into live mode; each viewer swaps only
// its page canvas for the engine's embedded client, keeping its own toolbar
// and chrome. Turning the flag off restores the static PDF everywhere and
// stops the engine.

import type { EditorGroupState, MonacoModel } from "./editor-session/types.js";
import type { BridgeWindow } from "./types.js";
import type { LivePreviewTarget } from "./viewer.js";
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { uiText } from "./i18n.js";
import { getEditorModelPath } from "./editor-session/model-path.js";

// Real-app typing → paper (25 tokens, 320ms apart, solo 2-page document):
// 80/120ms gave p50 103ms / p90 144ms; 16/32ms gave p50 45ms / p90 52ms.
// The wait only has to outlast the task that made the edit, so that the
// companion edit the editor makes in that same task (the \end{…} after a
// \begin{…}, a closing \]) goes out with it: a timer does that at any
// length. A frame's worth of waiting was a sixth of a keystroke's whole way
// to the paper.
const TYPING_PUSH_DELAY_MS = 1;
const TYPING_PUSH_MAX_WAIT_MS = 4;

// Trailing debounce with an upper bound: a burst of keystrokes closer than
// delayMs would otherwise keep pushing the task back and the paper would not
// move until the hands stop. With maxWaitMs the task also fires once that much
// time has passed since the first deferred call, so a long run of typing still
// updates every maxWaitMs.
const createDebouncedTask = (task: () => void, delayMs: number, maxWaitMs = 0) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstDeferredAt = 0;
  const fire = () => {
    timer = null;
    firstDeferredAt = 0;
    task();
  };
  const schedule = () => {
    const now = Date.now();
    if (timer) clearTimeout(timer);
    if (!firstDeferredAt) firstDeferredAt = now;
    const wait = maxWaitMs > 0 ? Math.min(delayMs, Math.max(0, firstDeferredAt + maxWaitMs - now)) : delayMs;
    timer = setTimeout(fire, wait);
  };
  schedule.isScheduled = () => timer !== null;
  schedule.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstDeferredAt = 0;
  };
  return schedule;
};

// Runs the task when the code that asked for it has finished, before the
// browser does anything else. A timer, even of one millisecond, waits until
// the editor has laid out and painted the keystroke: 10 ms and more on the
// way to the engine. Everything the editor changes in the same call (a
// paste, several cursors, the \end{…} it adds after a \begin{…}) is still
// taken together.
const createMicrotaskTask = (task: () => void) => {
  let queued = false;
  let generation = 0;
  const schedule = () => {
    if (queued) return;
    queued = true;
    const scheduled = generation;
    queueMicrotask(() => {
      if (scheduled !== generation) return;
      queued = false;
      task();
    });
  };
  schedule.cancel = () => {
    generation += 1;
    queued = false;
  };
  return schedule;
};

type LiveContentChange = { changes?: Array<{ text?: string }>; isFlush?: boolean };

// One change of ordinary characters (or a deletion): nothing the editor
// answers with an edit of its own, as it does for a brace, a backslash
// command or a new line.
const PLAIN_TYPED_TEXT_RE = /^[^\\{}[\]$%&#^_~\r\n]*$/;
const isPlainTypedChange = (event?: LiveContentChange) =>
  !!event && event.isFlush !== true && Array.isArray(event.changes) && event.changes.length === 1 &&
  typeof event.changes[0]?.text === "string" && PLAIN_TYPED_TEXT_RE.test(event.changes[0].text);

type LiveTextModel = Pick<MonacoModel, "getValue" | "getVersionId">;

type LiveEditor = {
  getValue?: () => string;
  onDidChangeModelContent?: (listener: (event?: LiveContentChange) => void) => { dispose: () => void };
  onDidCompositionEnd?: (listener: () => void) => { dispose: () => void };
  onDidChangeCursorPosition?: (listener: () => void) => { dispose: () => void };
  getPosition?: () => { lineNumber: number; column: number } | null;
  getModel?: () => (Partial<LiveTextModel> & {
    getOffsetAt?: (position: { lineNumber: number; column: number }) => number;
  }) | null;
};

type DirtySnapshot = { path: string; content: string; isDirty: boolean; truncated: boolean };
const PROJECT_SOURCE_RE = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|cfg|clo|def|fd|ldf|lbx|ltx|dtx|ins)$/i;

export const initCodeLivePreview = ({
  getCompileEngine = () => "lualatex",
  getActiveGroup,
  getEditorGroups,
  getAppMode,
  getWorkspaceRoot,
  getWorkspaceFiles,
  getRootFile,
  getRootSource,
  getLastBuildTarget,
  getDocumentFor,
  getDocumentsIncluding,
  getDirtyFileSnapshots,
  onRuntimeError,
  hasSavedPaper,
  showFirstPaper,
  closeFirstPaper,
}: {
  getCompileEngine?: () => string;
  getActiveGroup: () => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getAppMode: () => string;
  getWorkspaceRoot: () => string | null;
  getWorkspaceFiles?: () => string[];
  getRootFile: () => string | null;
  getRootSource?: () => string;
  getLastBuildTarget?: () => string | null;
  // The document Build would make of a fragment, once known (undefined while
  // it is being resolved).
  getDocumentFor?: (path: string) => string | null | undefined;
  /** The documents that read `path` (a chapter), as far as known; null before the answer is in. */
  getDocumentsIncluding?: (path: string) => string[] | null;
  getDirtyFileSnapshots: (readText: (model: LiveTextModel) => string) => DirtySnapshot[];
  onRuntimeError: (message: string | null) => void;
  hasSavedPaper?: (target: LivePreviewTarget) => boolean;
  showFirstPaper: (target: LivePreviewTarget) => "window" | void;
  closeFirstPaper: (switchingDocument: boolean) => void;
}) => {
  // The document the live paper follows, decided like a Build: a file that is
  // a document itself (\documentclass … \begin{document}) is its own root even
  // when Settings names another; a fragment follows the document that reads
  // it (main resolves it as Build does), else the root the user set, else the
  // detected root, else the last document built.
  // Same reading as main's isStandaloneDocument (tex-build-target.cjs): text
  // shown as an example is not the file's structure, and a class line after
  // body material is quoted text. A chapter that prints a complete document
  // in a listing used to become its own live root, and its paper never came.
  const VERBATIM_ENV = "(?:[A-Za-z@]*[Vv]erbatim[A-Za-z@*]*|lstlisting\\*?|minted\\*?|[A-Za-z@]*[Ll]isting[A-Za-z@*]*|filecontents\\*?|comment|luacode\\*?)";
  const VERBATIM_RE = new RegExp(`\\\\begin\\s*\\{(${VERBATIM_ENV})\\}[\\s\\S]*?\\\\end\\s*\\{\\1\\}`, "g");
  const isStandaloneSource = (text: string) => {
    const source = text.slice(0, 262144)
      .replace(/(^|[^\\])%[^\n]*/g, "$1")
      .replace(VERBATIM_RE, " ")
      .replace(/\\KKcodeS[\s\S]*?\\KKcodeE/g, " ")
      .replace(/\\KKverb\|[^|\n]*\|/g, " ")
      .replace(/\\(?:verb|lstinline)\*?([^A-Za-z\s{])[^\n]*?\1/g, " ");
    const documentClass = /\\document(?:class|style)\s*(?:\[[^\]]*\])?\s*\{/.exec(source);
    if (!documentClass) return false;
    const body = /\\begin\s*\{document\}/.exec(source);
    if (!body || body.index < documentClass.index) return false;
    return !/\\(?:begin\s*\{|part\b|chapter\b|(?:sub)*section\b|input\b|include\b)/.test(source.slice(0, documentClass.index));
  };
  let queuedDefault: string | null = null;
  let queuedLastBuild: string | null = null;
  const currentLiveRoot = () => {
    // the document Live was last asked for: a long boot leaves liveSessionKey
    // on the document before it for minutes, and answering with that one
    // sent Live back to it in the middle of the boot
    const key = queuedSessionKey ?? liveSessionKey;
    const root = getWorkspaceRoot();
    const prefix = root && `${root}\0`;
    return prefix && key?.startsWith(prefix) ? key.slice(prefix.length) : null;
  };
  // The edit notification, dirty tabs and the background poll can all request
  // the same revision. Flatten Monaco's piece tree once for that revision.
  let modelTexts = new WeakMap<LiveTextModel, { version: number; text: string }>();
  const readModelText = (model: LiveTextModel) => {
    const version = model.getVersionId?.();
    if (version === undefined) return model.getValue();
    const cached = modelTexts.get(model);
    if (cached?.version === version) return cached.text;
    const text = model.getValue();
    modelTexts.set(model, { version, text });
    return text;
  };
  const readEditorText = (editor: LiveEditor) => {
    const model = editor.getModel?.();
    return model && typeof model.getValue === "function"
      ? readModelText(model as LiveTextModel)
      : editor.getValue?.() ?? "";
  };

  const liveRootFor = (path: string | null, readText: () => string) => {
    const configuredRoot = getRootFile();
    const isTex = Boolean(path && path.toLowerCase().endsWith(".tex"));
    if (!isTex) {
      // Clicking the paper, a reference PDF or a style file adds no new
      // manuscript selection. Keep the document the user was editing.
      const running = currentLiveRoot();
      const files = getWorkspaceFiles?.();
      if (running && (!files || files.includes(running))) {
        const built = getLastBuildTarget?.();
        if (configuredRoot && configuredRoot !== queuedDefault && getRootSource?.() === "manual") return configuredRoot;
        if (built && built !== queuedLastBuild && (!files || files.includes(built))) return built;
        return running;
      }
    }
    // Main decides ownership as a Build does, and knows which book reads a
    // chapter. Until its answer is in, the text itself is the best evidence.
    const owner = isTex && path && getDocumentFor ? getDocumentFor(path) : null;
    if (isTex && path) {
      const running = currentLiveRoot();
      // Opening a shared chapter doesn't select a new manuscript. Wait for
      // ownership before switching, including when its source is a fragment.
      if (running && running !== path) {
        if (owner === undefined) return running;
        if (getLastBuildTarget?.() !== path && path !== configuredRoot &&
            getDocumentsIncluding?.(path)?.includes(running)) return running;
      }
      if (owner && /\.tex$/i.test(owner)) return owner;
      if (isStandaloneSource(readText())) return path;
    }
    if (configuredRoot && getRootSource?.() === "manual") return configuredRoot;
    const lastBuilt = getLastBuildTarget?.() ?? null;
    return configuredRoot || (lastBuilt && /\.tex$/i.test(lastBuilt) ? lastBuilt : null) || (isTex ? path : null);
  };
  const bridge = (window as BridgeWindow).tex64Tdom;
  let active = false;
  let starting: object | null = null;
  let engineStarted = false;
  let compileEngine = "lualatex";
  let fallback = false;
  let publishedFallback = false;
  let missingCommand: { name: string; checkAfter: number } | null = null;
  let pdfRetry: { editVersion: number; at: number | null } | null = null;
  let fallbackBuildInProgress = false;
  let runningPdf: { id: string; version: number; superseded: boolean } | null = null;
  let retryStartAfter = 0;
  let engineUrl: string | null = null;
  let liveGeneration = 0;
  let lifecycleVersion = 0;
  let latestPushVersion = 0;
  let liveSessionKey: string | null = null;
  let liveTarget: LivePreviewTarget | null = null;
  let boundEditor: LiveEditor | null = null;
  let boundPath: string | null = null;
  let disposable: { dispose: () => void } | null = null;
  let compositionDisposable: { dispose: () => void } | null = null;
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
  let lastWindowPreviewKey: string | null = null;
  // The resident engine has a page budget. A document without a usable
  // chapter window still updates through the single-flight PDF compiler.
  let limitedSessionKey: string | null = null;

  let waitingForChapter = false;
  let recoveringEmptyPaper = false;
  let tryingRetainedPaper = false;
  let cleanPaper: { pushVersion: number; editVersion: number } | null = null;
  let editEpoch = -1;
  let editingPaper = false;
  const resumeCleanPaper = () => {
    if (!active || !recoveringEmptyPaper || editingPaper || !cleanPaper ||
        cleanPaper.pushVersion !== latestPushVersion || cleanPaper.editVersion !== sourceEditVersion ||
        buildOwnsView || fallbackBuildInProgress) return;
    cleanPaper = null;
    recoveringEmptyPaper = false;
    sourceRefreshPending = true;
    pushCurrent();
  };
  let nativeSourceRev: number | null = null;
  let emptyPaperErrorRev: number | null = null;
  const usingPdf = () => fallback || recoveringEmptyPaper || (limitedSessionKey !== null && !waitingForChapter && Boolean(bridge?.compilePdf));

  // A close is the user's choice. Only offer the first paper once for
  // this document until Live is switched off or another document opens.
  let firstPaperSession: string | null = null;
  let firstPaperInWindow = false;
  const retireFirstPaper = (switchingDocument: boolean) => {
    closeFirstPaper(switchingDocument);
    if (firstPaperInWindow) void bridge?.setUnbuiltWindow?.(null).catch(() => {});
    firstPaperSession = null;
    firstPaperInWindow = false;
  };
  const offerFirstPaper = (key: string, target: LivePreviewTarget | null) => {
    if (!target?.workspaceRoot || firstPaperSession === key) return;
    firstPaperSession = key;
    firstPaperInWindow = showFirstPaper(target) === "window";
    if (firstPaperInWindow) void bridge?.setUnbuiltWindow?.(target).catch(() => {});
  };

  const cursorOffset = (editor: LiveEditor | null = currentProjectSource()?.editor ?? null) => {
    const position = editor?.getPosition?.();
    const offset = position ? editor?.getModel?.()?.getOffsetAt?.(position) : null;
    return Number.isFinite(Number(offset)) ? Number(offset) : null;
  };

  const focusCurrent = () => {
    if (!active || !engineStarted || fallback || !bridge?.focus) return;
    // A character insertion moves the Monaco caret too. Let its source
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

  // Flip the existing PDF surfaces into or out of live mode. The PDF
  // frame keeps its ordinary toolbar and swaps only the page canvas for the
  // embedded incremental renderer. While a completed Build owns the paper,
  // the same frame is kept below that PDF instead of being recreated.
  const distributeLive = (url: string | null, generation = liveGeneration) => {
    const payload = url && liveTarget?.workspaceRoot ? {
      url,
      generation,
      target: liveTarget,
      hold: buildOwnsView,
      expectedSrcRev: buildOwnsView ? null : liveExpectedSrcRev,
    } : null;
    for (const group of getEditorGroups()) {
      group.viewer.setLivePreview(url, generation, liveTarget, buildOwnsView, buildOwnsView ? null : liveExpectedSrcRev);
    }
    if (bridge?.setWindowPreview) {
      const key = JSON.stringify(payload);
      if (key !== lastWindowPreviewKey) {
        lastWindowPreviewKey = key;
        void bridge.setWindowPreview(payload).then((result) => {
          if (!result?.ok && lastWindowPreviewKey === key) lastWindowPreviewKey = null;
        }, () => {
          if (lastWindowPreviewKey === key) lastWindowPreviewKey = null;
        });
      }
    }
  };

  const showLiveError = (message: string) => {
    console.warn("[live-preview]", message);
    onRuntimeError(uiText("Real-time preview could not start.", "リアルタイムプレビューを起動できませんでした。") + ` ${message}`);
  };
  const clearFallbackPaper = () => {
    publishedFallback = false;
    for (const group of getEditorGroups()) group.viewer.showFallbackPreview(null, null);
    void bridge?.showWindowPdf?.(null);
  };

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
    const text = readEditorText(editor);
    const rootFile = liveRootFor(path, () => text);
    const sessionKey = workspaceRoot && rootFile
      ? `${workspaceRoot}\0${rootFile}`
      : path.toLowerCase().endsWith(".tex") ? `legacy\0${path}` : null;
    if (!sessionKey) return;
    pendingExactInputs.set(path, {
      id: ++nextExactInputId,
      sessionKey,
      path,
      text,
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
    let composing: Map<object, { path: string; baseline: NonNullable<EditorGroupState["compositionBaseline"]> }> | undefined;
    for (const group of getEditorGroups()) {
      const path = group.currentFilePath;
      if (!group.isComposing || !path || !PROJECT_SOURCE_RE.test(path)) continue;
      const baseline = group.compositionBaseline;
      const editor = group.editor as LiveEditor | null;
      if (!baseline || path !== group.composingFilePath || editor?.getModel?.() !== baseline.model) return null;
      (composing ??= new Map()).set(baseline.model, { path, baseline });
    }
    const current = currentProjectSource();
    const model = current?.editor.getModel?.();
    const committedText = () => (model && composing?.get(model)?.baseline.text) ?? (current ? readEditorText(current.editor) : "");
    const workspaceRoot = getWorkspaceRoot();
    const rootFile = liveRootFor(current?.path ?? null, committedText);
    if (workspaceRoot && rootFile) {
      const buffers = new Map<string, string>();
      const readCommitted = composing
        ? (model: LiveTextModel) => composing.get(model)?.baseline.text ?? readModelText(model)
        : readModelText;
      for (const snapshot of getDirtyFileSnapshots(readCommitted)) {
        if (snapshot.isDirty && !snapshot.truncated && PROJECT_SOURCE_RE.test(snapshot.path)) {
          buffers.set(snapshot.path, snapshot.content);
        }
      }
      // Clean files come from the project snapshot on disk. Serializing the
      // clean root only while its tab is active would turn a root/child tab
      // switch into a source edit. External reloads explicitly call
      // refreshSource below, which forces a same-session disk refresh.
      if (current?.group.isDirty && !buffers.has(current.path)) {
        buffers.set(current.path, committedText());
      }
      const sessionKey = `${workspaceRoot}\0${rootFile}`;
      const exactInputs = [...pendingExactInputs.values()].filter((input) => input.sessionKey === sessionKey);
      // A save can make the active buffer clean before the deferred task runs.
      // Keep the exact bytes observed by the editor notification until the
      // engine accepts them; a later clean snapshot removes the overlay.
      for (const exactInput of exactInputs) buffers.set(exactInput.path, exactInput.text);
      // The candidate may make a clean file dirty, or temporarily make
      // a dirty file equal to disk. Keep the pre-composition overlay.
      if (composing) for (const { path, baseline } of composing.values()) {
        if (baseline.dirty) buffers.set(path, baseline.text);
        else buffers.delete(path);
      }
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
          // the file in front: of a document past the Live length, its chapter is the one kept live
          activePath: current?.path,
          fresh: sessionKey !== queuedSessionKey,
          clientEditAtEpochMs: exactInputs.length === 1
            ? exactInputs[0].editAtEpochMs : latestInputAtEpochMs || undefined,
        },
      };
    }
    if (!current || !current.path.toLowerCase().endsWith(".tex")) return null;
    const source = committedText();
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

    // Invalidate an in-flight result immediately, before the push
    // debounce. Otherwise a completed /open for the previous project can
    // briefly reactivate its iframe after the editor has already switched.
    retireFirstPaper(true);
    recoveringEmptyPaper = false;
    emptyPaperErrorRev = null;
    nativeSourceRev = null;
    pdfRetry = null;
    missingCommand = null;
    if (runningPdf) void bridge?.supersedePdf?.(runningPdf.id, true);
    lifecycleVersion += 1;
    latestPushVersion += 1;
    pendingPush = null;
    queuedSessionKey = null;
    queuedBuffers.clear();
    builtSnapshot = null;
    buildOwnsView = false;
    liveExpectedSrcRev = null;
    if (usingPdf() || publishedFallback) {
      buildViewVersion += 1;
      fallbackBuildInProgress = false;
      fallbackDrain.cancel();
      clearFallbackPaper();
    }
    if (engineUrl || visibleSessionIsObsolete) {
      engineUrl = null;
      liveSessionKey = null;
      liveGeneration += 1;
      distributeLive(null, liveGeneration);
    }
  };

  let limitedRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const retryLimited = (sessionKey: string) => {
    if (limitedRetryTimer !== null) clearTimeout(limitedRetryTimer);
    limitedRetryTimer = setTimeout(() => {
      limitedRetryTimer = null;
      if (!active || limitedSessionKey !== sessionKey) return;
      limitedSessionKey = null;
      sourceRefreshPending = true;
      pushCurrent();
    }, 5_000);
  };

  const enterPageLimit = (sessionKey: string, pending = false) => {
    waitingForChapter = pending;
    limitedSessionKey = sessionKey;
    lifecycleVersion += 1;
    latestPushVersion += 1;
    debouncedPush.cancel();
    typedPush.cancel();
    debouncedFocus.cancel();
    pendingPush = null;
    latestInputAtEpochMs = 0;
    builtSnapshot = null;
    buildOwnsView = false;
    liveExpectedSrcRev = null;
    engineStarted = false;
    engineUrl = null;
    liveSessionKey = null;
    liveGeneration += 1;
    distributeLive(null, liveGeneration);
    if (usingPdf()) {
      sourceRefreshPending = true;
      debouncedPush();
    }
  };

  const drainPushes = async () => {
    if (pushing || !bridge?.push || fallbackBuildInProgress) return;
    pushing = true;
    let attemptedSnapshot: typeof pendingPush = null;
    try {
      // Single-flight latest-wins queue: while LuaLaTeX is working, new
      // keystrokes replace the one pending snapshot instead of building an
      // unbounded FIFO of already-obsolete document states.
      while (active && pendingPush && !fallbackBuildInProgress) {
        const snapshot = pendingPush;
        pendingPush = null;
        attemptedSnapshot = snapshot;
        if (usingPdf()) {
          const buildAtStart = buildViewVersion;
          const id = crypto.randomUUID();
          const editVersion = sourceEditVersion;
          runningPdf = { id, version: editVersion, superseded: false };
          let result;
          try {
            result = await bridge.compilePdf?.({ ...snapshot.payload, engine: compileEngine, requestId: id,
              ...(tryingRetainedPaper && recoveringEmptyPaper && { recoverIncompleteMath: true }) });
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          } finally {
            runningPdf = null;
          }
          if (!active || snapshot.lifecycleVersion !== lifecycleVersion) continue;
          const busy = result?.code === "TDOM_BUILD_IN_PROGRESS" || result?.code === "TDOM_PREVIEW_BUSY";
          const ioFailure = !result?.ok && (result?.code === "TDOM_PREVIEW_IO_ERROR" || (!result?.code && Boolean(result?.error)));
          if (!busy && !ioFailure) {
            clearAcceptedExactInputs(snapshot);
            if (snapshot.pushVersion === latestPushVersion) pdfRetry = null;
          }
          // Display a finished revision of this paper even while its next
          // edit is queued. Waiting for typing to stop can hide every frame.
          if (snapshot.sessionKey === queuedSessionKey && buildAtStart === buildViewVersion && !fallbackBuildInProgress) {
            if (result?.ok && (result.data || result.url) && typeof result.generation === "number" && snapshot.target) {
              missingCommand = result.command ? { name: result.command, checkAfter: Date.now() + 5000 } : null;
              if (result.pendingBibliography && snapshot.pushVersion === latestPushVersion) sourceRefreshPending = true;
              tryingRetainedPaper = false;
              publishedFallback = true;
              liveSessionKey = snapshot.sessionKey;
              for (const group of getEditorGroups()) group.viewer.showFallbackPreview(snapshot.target, result.data ?? null, result.generation, result.url);
              void bridge.showWindowPdf?.(result.generation);
              if (engineUrl) {
                engineUrl = null;
                distributeLive(null, ++liveGeneration);
              }
              offerFirstPaper(snapshot.sessionKey, snapshot.target);
              onRuntimeError(result.command
                ? uiText(`Install ${result.command} to update the bibliography.`, `参考文献の更新には ${result.command} が必要です。`)
                : result.warning || (result.pendingMathCloser
                  ? (result.pendingMathFile
                    ? uiText(`Close the formula in ${result.pendingMathFile} with ${result.pendingMathCloser}.`,
                      `${result.pendingMathFile} の数式を ${result.pendingMathCloser} で閉じてください。`)
                    : uiText(`Close the formula with ${result.pendingMathCloser}.`, `数式の末尾に ${result.pendingMathCloser} を追加してください。`))
                  : result.missingDocumentEnd
                  ? uiText("Add \\end{document} to finish the manuscript.", "原稿の末尾に \\end{document} を追加してください。")
                  : null));
              if (recoveringEmptyPaper && !result.warning && !result.pendingMathCloser && !result.missingDocumentEnd && !result.emptyDocument && snapshot.pushVersion === latestPushVersion) {
                // Keep updating the PDF while a paper field owns keyboard focus.
                // The compile reply and the final keystroke can cross in IPC.
                if ((result.editEpoch ?? -1) >= editEpoch) {
                  editEpoch = result.editEpoch ?? -1;
                  editingPaper = Boolean(result.editingPaper);
                }
                cleanPaper = { pushVersion: snapshot.pushVersion, editVersion };
                resumeCleanPaper();
              }
            } else if (snapshot.pushVersion === latestPushVersion && busy) {
              sourceRefreshPending = true;
            } else if (snapshot.pushVersion === latestPushVersion && result?.code === "TDOM_TEX_COMMAND_MISSING") {
              const tool = result.command || compileEngine;
              missingCommand = { name: tool, checkAfter: Date.now() + 5000 };
              onRuntimeError(uiText(`Install ${tool} to update the real-time preview.`, `プレビューの更新には ${tool} が必要です。`));
            } else if (snapshot.pushVersion === latestPushVersion && result?.code === "TDOM_PREVIEW_NO_PAGES") {
              onRuntimeError(uiText("TeX produced no pages. Add document content to see the preview.", "本文を入力するとプレビューにページが表示されます。"));
            } else if (snapshot.pushVersion === latestPushVersion && result?.code === "TDOM_TEX_ERROR") {
              // A failed trial on an already visible document must keep native
              // edits flowing. This revision has already been tried once.
              if (tryingRetainedPaper) {
                tryingRetainedPaper = false;
                recoveringEmptyPaper = false;
              }
              missingCommand = null;
              onRuntimeError(result.error || uiText("Correct the TeX error to update the preview.", "原稿の組版エラーを修正するとプレビューが更新されます。"));
            } else if (snapshot.pushVersion === latestPushVersion && result?.code === "TDOM_PREVIEW_SOURCE_LIMIT") {
              onRuntimeError(uiText("The preview can stage up to 500 files per update, including the root manuscript.", "ルート原稿と未保存のファイルを合わせて500件までプレビューに反映できます。"));
            } else if (snapshot.pushVersion === latestPushVersion && ioFailure) {
              missingCommand = null;
              if (pdfRetry?.editVersion !== editVersion) pdfRetry = { editVersion, at: Date.now() + 2000 };
              onRuntimeError(result?.error || uiText("The preview could not finish typesetting.", "プレビューの組版を完了できませんでした。"));
            } else if (snapshot.pushVersion === latestPushVersion && result?.code === "TDOM_PREVIEW_TIMEOUT") {
              onRuntimeError(uiText("Typesetting the preview timed out.", "プレビューの組版が制限時間を超えました。"));
            }
          }
          if (snapshot.payload.clientEditAtEpochMs === latestInputAtEpochMs) latestInputAtEpochMs = 0;
          // If the trailing timer fired while the compiler was occupied,
          // the pending edit already waited its turn.
          if (pendingPush && !fallbackDrain.isScheduled()) continue;
          break;
        }
        const result = await bridge.push(snapshot.payload);
        if (!result?.ok) throw new Error(result?.error || "live preview push failed");
        if (result.limited) {
          if (active && snapshot.lifecycleVersion === lifecycleVersion && snapshot.sessionKey === queuedSessionKey) {
            enterPageLimit(snapshot.sessionKey, result.pending === true);
            // Main is still reading what the chapter starts from: ask again.
            if (result.pending) retryLimited(snapshot.sessionKey);
          }
          attemptedSnapshot = null;
          continue;
        }
        // Only the capture ids carried by this accepted request are retired.
        // An older acknowledgement must never clear a newer edit of same bytes.
        clearAcceptedExactInputs(snapshot);
        // The URL opens the live document stream, including subsequent edits.
        // Mount it on the first accepted revision even if typing has queued another.
        const acceptedCurrentDocument =
          active &&
          snapshot.lifecycleVersion === lifecycleVersion &&
          snapshot.sessionKey === queuedSessionKey;
        // The engine accepted a source that differs from the Build's. A newer
        // queued push (such as the overlay removal after autosave) only moves
        // it further, so an accepted release need not be the latest push.
        const releasesBuild = acceptedCurrentDocument &&
          buildOwnsView && snapshot.releaseBuildView === buildViewVersion;
        if (releasesBuild) {
          builtSnapshot = null;
          buildOwnsView = false;
          liveExpectedSrcRev = Number.isInteger(result.srcRev) ? Number(result.srcRev) : null;
        }
        if (result.url && acceptedCurrentDocument) {
          onRuntimeError(null);
          // a push that follows a length limit starts the engine itself
          engineStarted = true;
          if (Number.isInteger(result.srcRev)) {
            nativeSourceRev = Number(result.srcRev);
            if (publishedFallback && !engineUrl) liveExpectedSrcRev = nativeSourceRev;
          }
          if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl) liveGeneration += 1;
          engineUrl = result.url;
          liveSessionKey = snapshot.sessionKey;
          liveTarget = snapshot.target;
          distributeLive(engineUrl, liveGeneration);
          offerFirstPaper(snapshot.sessionKey, snapshot.target);
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
      if (active && pendingPush && !usingPdf()) void drainPushes();
    }
  };
  const fallbackDrain = createDebouncedTask(() => { void drainPushes(); }, 850, 2500);

  const pushCurrent = (settledDiskChange = false) => {
    if (!active || !bridge?.push || (!engineStarted && (starting || Date.now() < retryStartAfter))) return;
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    if (limitedSessionKey === snapshot.sessionKey && !usingPdf()) {
      pendingExactInputs.clear();
      latestInputAtEpochMs = 0;
      return;
    }
    // A Build keeps the paper until the engine accepts a source that differs
    // from the one it typeset; that push carries the release.
    const changedSinceBuild = Boolean(builtSnapshot) && (sourceRefreshPending ||
      snapshot.sessionKey !== builtSnapshot?.sessionKey || sourceEditVersion !== builtSnapshot?.editVersion);
    retireObsoleteSession(snapshot.sessionKey);
    if (!sourceRefreshPending &&
        snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers)) {
      // With no queued or in-flight request, queuedBuffers is the last source
      // the bridge accepted. A new capture of those same bytes is already live.
      if (!pushing && !pendingPush && !pdfRetry) clearAcceptedExactInputs(snapshot, true);
      return;
    }
    if (snapshot.target && firstPaperSession !== snapshot.sessionKey && hasSavedPaper?.(snapshot.target)) {
      offerFirstPaper(snapshot.sessionKey, snapshot.target);
    }
    queuedSessionKey = snapshot.sessionKey;
    queuedDefault = getRootFile();
    queuedLastBuild = getLastBuildTarget?.() ?? null;
    queuedBuffers = new Map(snapshot.buffers);
    sourceRefreshPending = false;
    pendingPush = {
      ...snapshot,
      pushVersion: ++latestPushVersion,
      lifecycleVersion,
      releaseBuildView: changedSinceBuild ? buildViewVersion : null,
    };
    if (usingPdf()) {
      if (runningPdf && !runningPdf.superseded && runningPdf.version !== sourceEditVersion) {
        runningPdf.superseded = true;
        void bridge?.supersedePdf?.(runningPdf.id, false);
      }
      // Opening a document and a settled filesystem notification have no
      // typing burst to wait for. Keep the trailing debounce for keystrokes.
      if (!pushing && !fallbackBuildInProgress && (snapshot.payload.fresh || settledDiskChange)) {
        fallbackDrain.cancel();
        void drainPushes();
      } else fallbackDrain();
    }
    else void drainPushes();
  };
  // Coalesce same-task paste, multi-cursor and programmatic companion edits.
  // The single-flight latest-wins queue above is the only engine back-pressure.
  const debouncedPush = createDebouncedTask(pushCurrent, TYPING_PUSH_DELAY_MS, TYPING_PUSH_MAX_WAIT_MS);
  // A keystroke in the editor: out as soon as the editor's own call returns.
  const typedPush = createMicrotaskTask(pushCurrent);

  const bindActiveEditor = () => {
    if (!active) return;
    const current = currentProjectSource();
    const nextEditor = current?.editor ?? null;
    const nextPath = current?.path ?? null;
    if (nextEditor === boundEditor && nextPath === boundPath) return;
    disposable?.dispose();
    compositionDisposable?.dispose();
    compositionDisposable = null;
    cursorDisposable?.dispose();
    disposable = null;
    cursorDisposable = null;
    boundEditor = nextEditor;
    boundPath = nextPath;
    if (boundEditor?.onDidChangeModelContent) {
      const eventEditor = boundEditor;
      const eventPath = boundPath;
      const eventModel = eventEditor.getModel?.() ?? null;
      let compositionChanged = false;
      const recordChange = (event?: LiveContentChange) => {
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
        // The editor lays out and paints the keystroke before its call
        // returns (6 ms measured). Plain typing does not wait for that; any
        // other change goes out when the call returns, with whatever the
        // editor adds to it.
        if (isPlainTypedChange(event)) {
          typedPush.cancel();
          pushCurrent();
        } else typedPush();
      };
      disposable = eventEditor.onDidChangeModelContent((event) => {
        const model = eventEditor.getModel?.();
        if (current?.group.isComposing || (model && getEditorGroups().some(group =>
          group.isComposing && group.compositionBaseline?.model === model))) {
          compositionChanged = true;
          return;
        }
        recordChange(event);
      });
      compositionDisposable = eventEditor.onDidCompositionEnd?.(() => {
        if (compositionChanged) {
          compositionChanged = false;
          recordChange();
        } else typedPush();
      }) ?? null;
    }
    if (boundEditor?.onDidChangeCursorPosition) {
      cursorDisposable = boundEditor.onDidChangeCursorPosition(debouncedFocus);
    }
    debouncedPush();
    debouncedFocus();
  };

  const start = async () => {
    if (!bridge?.start || starting || Date.now() < retryStartAfter || !currentSnapshot()) return;
    const startLifecycleVersion = lifecycleVersion;
    const request = {};
    starting = request;
    try {
      const result = await bridge.start(compileEngine);
      if (!active || startLifecycleVersion !== lifecycleVersion) return;
      if (!result?.ok || (!result.url && !result.fallback)) {
        retryStartAfter = Date.now() + 5_000;
        showLiveError(result?.error || "");
        return;
      }
      fallback = result.fallback === true;
      engineStarted = true;
      onRuntimeError(null);
      // Do not expose the engine's tiny boot sample. The first successful
      // project push below returns the same URL and reveals the viewer only
      // after the configured root document is actually open.
      bindActiveEditor();
      debouncedPush();
    } catch (error) {
      if (active && startLifecycleVersion === lifecycleVersion) {
        retryStartAfter = Date.now() + 5_000;
        showLiveError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (starting === request) starting = null;
    }
  };

  const suspend = () => {
    retireFirstPaper(false);
    modelTexts = new WeakMap();
    if (usingPdf() || publishedFallback) clearFallbackPaper();
    fallback = false;
    pdfRetry = null;
    missingCommand = null;
    fallbackBuildInProgress = false;
    retryStartAfter = 0;
    starting = null;
    fallbackDrain.cancel();
    onRuntimeError(null);
    builtSnapshot = null;
    buildStartEditVersion = null;
    lifecycleVersion += 1;
    latestPushVersion += 1;
    debouncedPush.cancel();
    typedPush.cancel();
    debouncedFocus.cancel();
    disposable?.dispose();
    compositionDisposable?.dispose();
    compositionDisposable = null;
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
    limitedSessionKey = null;
    recoveringEmptyPaper = false;
    nativeSourceRev = null;
    emptyPaperErrorRev = null;
    buildOwnsView = false;
    liveExpectedSrcRev = null;
    liveGeneration += 1;
    distributeLive(null);
  };

  const applyActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    if (active) {
      poll = window.setInterval(refresh, 200);
      healthPoll = window.setInterval(checkHealth, 2_000);
      void start();
    } else {
      stopPolling();
      suspend();
      void bridge?.stop?.();
    }
  };

  let historyBlocked = false;
  const refresh = () => {
    const setting = getCompileEngine();
    const nextEngine = ["xelatex", "pdflatex", "uplatex"].includes(setting) ? setting : "lualatex";
    if (compileEngine !== nextEngine) {
      compileEngine = nextEngine;
      missingCommand = null;
      // Keep the current paper and any unsaved model until the replacement
      // is ready, but invalidate results from a different typesetter.
      lifecycleVersion += 1;
      latestPushVersion += 1;
      if (runningPdf) void bridge?.supersedePdf?.(runningPdf.id, true);
      pendingPush = null;
      queuedSessionKey = null;
      limitedSessionKey = null;
      sourceRefreshPending = true;
      engineStarted = false;
      starting = null;
      retryStartAfter = 0;
    }
    applyActive(!historyBlocked && editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
    if (active && limitedSessionKey) {
      const snapshot = currentSnapshot();
      if (!snapshot) return;
      if (snapshot.sessionKey !== limitedSessionKey) {
        retireObsoleteSession(snapshot.sessionKey);
        limitedSessionKey = null;
      } else if (!usingPdf()) return;
    }
    if (active) {
      if (!engineStarted && !starting && !limitedSessionKey) void start();
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

  const refreshSource = (settledDiskChange = false) => {
    if (!active) return;
    sourceEditVersion += 1;
    sourceRefreshPending = true;
    latestInputAtEpochMs = Date.now();
    if (settledDiskChange) pushCurrent(true);
    else debouncedPush();
  };

  // A Build is the one thing that can bring a limited document back under
  // the limit. Ask main again with the new paper; the answer either starts
  // Live or keeps the limit, and no engine is started just to ask.
  window.addEventListener("tex64:build-state", (event) => {
    if (active && usingPdf()) {
      const detail = (event as CustomEvent<{ state: string; workspaceRoot?: string }>).detail;
      if (!detail || (detail.workspaceRoot && detail.workspaceRoot !== getWorkspaceRoot())) return;
      if (detail.state === "building") {
        fallbackBuildInProgress = true;
        buildViewVersion += 1;
        latestPushVersion += 1;
        fallbackDrain.cancel();
        pendingPush = null;
      } else if (detail.state === "success") {
        fallbackBuildInProgress = false;
        clearFallbackPaper();
        if (!limitedSessionKey && pendingPush) fallbackDrain();
      } else if (fallbackBuildInProgress) {
        fallbackBuildInProgress = false;
        sourceRefreshPending = true;
        pushCurrent();
      }
      if (!(limitedSessionKey && detail.state === "success")) return;
    }
    if (active && limitedSessionKey) {
      if ((event as CustomEvent<{ state: string }>).detail?.state !== "success") return;
      limitedSessionKey = null;
      sourceRefreshPending = true;
      pushCurrent();
      return;
    }
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
      getDirtyFileSnapshots(readModelText).some((snapshot) => snapshot.isDirty && PROJECT_SOURCE_RE.test(snapshot.path));
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
  // Only the visible live preview needs to watch editor swaps and engine health.
  let poll: number | undefined;
  let healthPoll: number | undefined;
  const stopPolling = () => {
    window.clearInterval(poll);
    window.clearInterval(healthPoll);
    poll = undefined;
    healthPoll = undefined;
  };
  let checkingHealth = false;
  const checkHealth = async () => {
    if (!active || !engineStarted || checkingHealth) return;
    if (usingPdf() && pdfRetry?.at != null && pdfRetry.editVersion === sourceEditVersion &&
        Date.now() >= pdfRetry.at && !pushing && !pendingPush && !fallbackBuildInProgress) {
      // Retry a transient file/launcher failure once. An unchanged permanent
      // failure must not keep starting TeX in the background.
      pdfRetry.at = null;
      sourceRefreshPending = true;
      pushCurrent(true);
      return;
    }
    const missing = missingCommand;
    if (missing && usingPdf()) {
      if (Date.now() < missing.checkAfter || !bridge?.commandAvailable || fallbackBuildInProgress || pushing) return;
      missing.checkAfter = Date.now() + 5000;
      checkingHealth = true;
      try {
        if (await bridge.commandAvailable(missing.name) && active && missingCommand === missing) {
          missingCommand = null;
          sourceRefreshPending = true;
          pushCurrent(true);
        }
      } catch {
        // A transient IPC failure leaves the missing-tool check scheduled.
      } finally {
        checkingHealth = false;
      }
      return;
    }
    if (fallback || !bridge?.status) return;
    const healthLifecycleVersion = lifecycleVersion;
    checkingHealth = true;
    try {
      const status = await bridge.status() as { running?: boolean; state?: string; pageLimited?: boolean } | null;
      const current = active && healthLifecycleVersion === lifecycleVersion;
      const limitedKey = queuedSessionKey ?? liveSessionKey;
      if (current && status?.pageLimited && limitedKey) {
        // main stopped the engine: the document grew past the length limit
        enterPageLimit(limitedKey);
      } else if (current && (!status?.running || status.state !== "ready")) {
        lifecycleVersion += 1;
        latestPushVersion += 1;
        engineStarted = false;
        nativeSourceRev = null;
        emptyPaperErrorRev = null;
        // A restart is not a source change: a Build that still matches the
        // source keeps the paper, and the recovered frame arrives held. An
        // edit made meanwhile releases it through the accepted push as usual.
        liveExpectedSrcRev = null;
        // Keep the last painted paper through restart. The fresh push
        // below advances its generation, even if the port is reused.
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
  };
  const unsubscribeSettings = editorSettings.subscribe((change) => {
    if (change.kind !== "flag" || change.id !== "preview.realtime") return;
    refresh();
  });

  const unsubscribePaperEditing = bridge?.onPaperEditing?.(state => {
    if (!active || queuedSessionKey !== `${state.workspaceRoot}\0${state.rootFile}` || state.editEpoch < editEpoch) return;
    editEpoch = state.editEpoch;
    editingPaper = state.editingPaper;
    resumeCleanPaper();
  });

  const unsubscribeInputs = bridge?.onInputsChanged?.(({ workspaceRoot, rootFile }) => {
    if (!active || !usingPdf() || workspaceRoot !== getWorkspaceRoot() ||
        queuedSessionKey !== `${workspaceRoot}\0${rootFile}`) return;
    refreshSource(true);
  });

  const unsubscribeHistory = history?.onChange((message) => {
    const phase = message.type === "workspace:operation" ? message.payload?.phase
      : message.type === "updateWorkspace" ? message.payload?.workspaceOperation?.phase : undefined;
    if (typeof phase !== "string") return;
    historyBlocked = phase !== "idle";
    refresh();
  });

  window.addEventListener("pagehide", () => {
    unsubscribeSettings?.();
    unsubscribeHistory?.();
    unsubscribeInputs?.();
    unsubscribePaperEditing?.();
    stopPolling();
  }, { once: true });
  // Clear renderer state left by a reload before restoring the current
  // setting.
  distributeLive(null);
  refresh();
  const isLivePaper = (pdfPath: string) => {
    const root = currentLiveRoot();
    return active && root !== null && root.replace(/\.tex$/i, ".pdf") === pdfPath;
  };
  const environmentInstalled = () => {
    if (missingCommand) {
      missingCommand.checkAfter = 0;
      void checkHealth();
    }
  };
  const recoverEmptyPaper = (detail: unknown) => {
    const error = detail as { generation?: number; url?: string; srcRev?: number; retainedPaper?: boolean } | null;
    if (!active || !bridge?.compilePdf || usingPdf() || buildOwnsView || fallbackBuildInProgress ||
        !engineUrl || !error || error.generation !== liveGeneration || error.url !== engineUrl ||
        !Number.isInteger(error.srcRev) || error.srcRev !== nativeSourceRev || error.srcRev === emptyPaperErrorRev ||
        !liveSessionKey || currentSnapshot()?.sessionKey !== liveSessionKey) return;
    emptyPaperErrorRev = nativeSourceRev;
    cleanPaper = null;
    tryingRetainedPaper = error.retainedPaper === true;
    recoveringEmptyPaper = true;
    sourceRefreshPending = true;
    pushCurrent(true);
  };
  return { isActive: () => active, isLivePaper, recoverEmptyPaper, refreshMode: refresh, refreshSource, environmentInstalled };
};
