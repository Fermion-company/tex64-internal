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
import { editorSettings } from "./editor-settings/editor-settings-store.js";
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
const COMPOSITION_RETRY_MS = 80;
// Trailing debounce with an upper bound: a burst of keystrokes closer than
// delayMs would otherwise keep pushing the task back and the paper would not
// move until the hands stop. With maxWaitMs the task also fires once that much
// time has passed since the first deferred call, so a long run of typing still
// updates every maxWaitMs.
const createDebouncedTask = (task, delayMs, maxWaitMs = 0) => {
    let timer = null;
    let firstDeferredAt = 0;
    const fire = () => {
        timer = null;
        firstDeferredAt = 0;
        task();
    };
    const schedule = () => {
        const now = Date.now();
        if (timer)
            clearTimeout(timer);
        if (!firstDeferredAt)
            firstDeferredAt = now;
        const wait = maxWaitMs > 0 ? Math.min(delayMs, Math.max(0, firstDeferredAt + maxWaitMs - now)) : delayMs;
        timer = setTimeout(fire, wait);
    };
    schedule.cancel = () => {
        if (timer)
            clearTimeout(timer);
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
const createMicrotaskTask = (task) => {
    let queued = false;
    let generation = 0;
    const schedule = () => {
        if (queued)
            return;
        queued = true;
        const scheduled = generation;
        queueMicrotask(() => {
            if (scheduled !== generation)
                return;
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
// One change of ordinary characters (or a deletion): nothing the editor
// answers with an edit of its own, as it does for a brace, a backslash
// command or a new line.
const PLAIN_TYPED_TEXT_RE = /^[^\\{}[\]$%&#^_~\r\n]*$/;
const isPlainTypedChange = (event) => {
    var _a;
    return !!event && event.isFlush !== true && Array.isArray(event.changes) && event.changes.length === 1 &&
        typeof ((_a = event.changes[0]) === null || _a === void 0 ? void 0 : _a.text) === "string" && PLAIN_TYPED_TEXT_RE.test(event.changes[0].text);
};
const PROJECT_SOURCE_RE = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|cfg|def|lbx|ltx|dtx|ins)$/i;
export const initCodeLivePreview = ({ getActiveGroup, getEditorGroups, getAppMode, getWorkspaceRoot, getRootFile, getRootSource, getLastBuildTarget, getDocumentFor, getDocumentsIncluding, getDirtyFileSnapshots, }) => {
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
    const isStandaloneSource = (text) => {
        const source = text.slice(0, 262144)
            .replace(/(^|[^\\])%[^\n]*/g, "$1")
            .replace(VERBATIM_RE, " ")
            .replace(/\\KKcodeS[\s\S]*?\\KKcodeE/g, " ")
            .replace(/\\KKverb\|[^|\n]*\|/g, " ")
            .replace(/\\(?:verb|lstinline)\*?([^A-Za-z\s{])[^\n]*?\1/g, " ");
        const documentClass = /\\document(?:class|style)\s*(?:\[[^\]]*\])?\s*\{/.exec(source);
        if (!documentClass)
            return false;
        const body = /\\begin\s*\{document\}/.exec(source);
        if (!body || body.index < documentClass.index)
            return false;
        return !/\\(?:begin\s*\{|part\b|chapter\b|(?:sub)*section\b|input\b|include\b)/.test(source.slice(0, documentClass.index));
    };
    const currentLiveRoot = () => {
        // the document Live was last asked for: a long boot leaves liveSessionKey
        // on the document before it for minutes, and answering with that one
        // sent Live back to it in the middle of the boot
        const key = queuedSessionKey !== null && queuedSessionKey !== void 0 ? queuedSessionKey : liveSessionKey;
        if (!key || key.startsWith("legacy\0"))
            return null;
        const at = key.indexOf("\0");
        return at >= 0 ? key.slice(at + 1) : null;
    };
    const liveRootFor = (path, text) => {
        var _a, _b;
        const configuredRoot = getRootFile();
        const isTex = Boolean(path && path.toLowerCase().endsWith(".tex"));
        // Main decides ownership as a Build does, and knows which book reads a
        // chapter. Until its answer is in, the text itself is the best evidence.
        const owner = isTex && path ? getDocumentFor === null || getDocumentFor === void 0 ? void 0 : getDocumentFor(path) : null;
        if (owner && /\.tex$/i.test(owner)) {
            // A chapter that is a document of its own and that several books read,
            // none of them built in this session, comes back as its own owner.
            // While one of those books is the paper on screen, the chapter stays
            // in it: reopening a project and opening such a chapter switched Live
            // from the 389-page book to the chapter alone (two pages).
            if (owner === path && (getLastBuildTarget === null || getLastBuildTarget === void 0 ? void 0 : getLastBuildTarget()) !== path) {
                const running = currentLiveRoot();
                if (running && running !== path && ((_a = getDocumentsIncluding === null || getDocumentsIncluding === void 0 ? void 0 : getDocumentsIncluding(path)) === null || _a === void 0 ? void 0 : _a.includes(running)))
                    return running;
            }
            return owner;
        }
        if (isTex && typeof text === "string" && isStandaloneSource(text)) {
            // Main has not answered yet (undefined). A chapter of a book reads as
            // a document of its own (subfiles), and taking its text at its word
            // restarted the engine for the chapter and again for the book a moment
            // later: opening a chapter of a 389-page book cost two full boots.
            // The running document stays until the answer is in.
            const running = currentLiveRoot();
            if (owner === undefined && running && running !== path)
                return running;
            return path;
        }
        if (configuredRoot && (getRootSource === null || getRootSource === void 0 ? void 0 : getRootSource()) === "manual")
            return configuredRoot;
        const lastBuilt = (_b = getLastBuildTarget === null || getLastBuildTarget === void 0 ? void 0 : getLastBuildTarget()) !== null && _b !== void 0 ? _b : null;
        return configuredRoot || (lastBuilt && /\.tex$/i.test(lastBuilt) ? lastBuilt : null) || (isTex ? path : null);
    };
    const bridge = window.tex64Tdom;
    let active = false;
    let starting = false;
    let engineStarted = false;
    let engineUrl = null;
    let liveGeneration = 0;
    let lifecycleVersion = 0;
    let latestPushVersion = 0;
    let liveSessionKey = null;
    let liveTarget = null;
    let boundEditor = null;
    let boundPath = null;
    let disposable = null;
    let cursorDisposable = null;
    let queuedSessionKey = null;
    let queuedActivePath;
    let queuedBuffers = new Map();
    let pendingPush = null;
    let pushing = false;
    let latestInputAtEpochMs = 0;
    let nextExactInputId = 0;
    const pendingExactInputs = new Map();
    // Session and edit version a completed Build typeset. Dirty-only buffers
    // cannot tell a saved edit from the Build's source, so edits are counted.
    let builtSnapshot = null;
    let sourceEditVersion = 0;
    let buildStartEditVersion = null;
    let sourceRefreshPending = false;
    let buildOwnsView = false;
    let buildViewVersion = 0;
    // Revision accepted for the first change after a Build; the viewer keeps the
    // Build PDF until Live presents at least this revision.
    let liveExpectedSrcRev = null;
    let lastWindowPreviewKey = null;
    // Document main keeps on its Build paper because it is past the length
    // Live is offered for (live-preview-page-limit.cjs). Nothing is pushed for
    // it until another document is in front or a Build has made a new paper.
    let limitedSessionKey = null;
    const cursorOffset = (editor) => {
        var _a, _b, _c, _d, _e, _f;
        if (editor === void 0) { editor = (_b = (_a = currentProjectSource()) === null || _a === void 0 ? void 0 : _a.editor) !== null && _b !== void 0 ? _b : null; }
        const position = (_c = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor);
        const offset = position ? (_f = (_e = (_d = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _d === void 0 ? void 0 : _d.call(editor)) === null || _e === void 0 ? void 0 : _e.getOffsetAt) === null || _f === void 0 ? void 0 : _f.call(_e, position) : null;
        return Number.isFinite(Number(offset)) ? Number(offset) : null;
    };
    const focusCurrent = () => {
        if (!active || !engineStarted || !(bridge === null || bridge === void 0 ? void 0 : bridge.focus))
            return;
        // A character insertion moves the Monaco caret too. Let its source
        // push finish first; otherwise a speculative warm against the old source
        // can grab the resident chain just before the real edit arrives.
        if (pushing || pendingPush || latestInputAtEpochMs) {
            debouncedFocus();
            return;
        }
        const source = currentProjectSource();
        const offset = cursorOffset(source === null || source === void 0 ? void 0 : source.editor);
        if (offset == null)
            return;
        void bridge.focus({ offset, filePath: source === null || source === void 0 ? void 0 : source.path }).catch(() => { });
    };
    const debouncedFocus = createDebouncedTask(focusCurrent, 160);
    // Flip the existing PDF surfaces into or out of live mode. The PDF
    // frame keeps its ordinary toolbar and swaps only the page canvas for the
    // embedded incremental renderer. While a completed Build owns the paper,
    // the same frame is kept below that PDF instead of being recreated.
    const distributeLive = (url, generation = liveGeneration) => {
        const payload = url && (liveTarget === null || liveTarget === void 0 ? void 0 : liveTarget.workspaceRoot) ? {
            url,
            generation,
            target: liveTarget,
            hold: buildOwnsView,
            expectedSrcRev: buildOwnsView ? null : liveExpectedSrcRev,
        } : null;
        for (const group of getEditorGroups()) {
            group.viewer.setLivePreview(url, generation, liveTarget, buildOwnsView, buildOwnsView ? null : liveExpectedSrcRev);
        }
        if (bridge === null || bridge === void 0 ? void 0 : bridge.setWindowPreview) {
            const key = JSON.stringify(payload);
            if (key !== lastWindowPreviewKey) {
                lastWindowPreviewKey = key;
                void bridge.setWindowPreview(payload).then((result) => {
                    if (!(result === null || result === void 0 ? void 0 : result.ok) && lastWindowPreviewKey === key)
                        lastWindowPreviewKey = null;
                }, () => {
                    if (lastWindowPreviewKey === key)
                        lastWindowPreviewKey = null;
                });
            }
        }
    };
    const showLiveError = (message) => console.warn("[live-preview]", message);
    const editorModelPath = (editor) => {
        var _a, _b;
        return getEditorModelPath((_b = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== null && _b !== void 0 ? _b : null);
    };
    const sameFilePath = (left, right) => {
        const comparable = (value) => {
            const normalized = value.replace(/\\/g, "/");
            return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
        };
        return comparable(left) === comparable(right);
    };
    const activeEditorPathMismatch = () => {
        const group = getActiveGroup();
        const path = group.currentFilePath;
        const editor = group.editor;
        if (!path || !PROJECT_SOURCE_RE.test(path) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
            return false;
        const modelPath = editorModelPath(editor);
        return Boolean(modelPath && !sameFilePath(modelPath, path));
    };
    const currentProjectSource = () => {
        const group = getActiveGroup();
        const path = group.currentFilePath;
        const editor = group.editor;
        if (!path || !PROJECT_SOURCE_RE.test(path) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
            return null;
        const modelPath = editorModelPath(editor);
        // One Monaco editor is reused while setModel switches files. During that
        // handoff currentFilePath and the actual model can briefly name different
        // files; never attach one model's bytes to the other's path.
        if (modelPath && !sameFilePath(modelPath, path))
            return null;
        return { group, path, editor };
    };
    const sameBuffers = (left, right) => {
        if (left.size !== right.size)
            return false;
        for (const [path, text] of left)
            if (right.get(path) !== text)
                return false;
        return true;
    };
    const captureExactInput = (path, editor, editedAtEpochMs) => {
        if (!path || !PROJECT_SOURCE_RE.test(path) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
            return;
        const workspaceRoot = getWorkspaceRoot();
        const text = editor.getValue();
        const rootFile = liveRootFor(path, text);
        const sessionKey = workspaceRoot && rootFile
            ? `${workspaceRoot}\0${rootFile}`
            : path.toLowerCase().endsWith(".tex") ? `legacy\0${path}` : null;
        if (!sessionKey)
            return;
        pendingExactInputs.set(path, {
            id: ++nextExactInputId,
            sessionKey,
            path,
            text,
            editAtEpochMs: editedAtEpochMs,
        });
    };
    const clearAcceptedExactInputs = (snapshot, allowEquivalentBytes = false) => {
        for (const [path, exactInput] of pendingExactInputs) {
            if (exactInput.sessionKey !== snapshot.sessionKey)
                continue;
            const sameCapture = snapshot.exactInputIds.get(path) === exactInput.id;
            const sameAcceptedBytes = snapshot.buffers.get(path) === exactInput.text;
            if (sameCapture || (allowEquivalentBytes && sameAcceptedBytes))
                pendingExactInputs.delete(path);
        }
    };
    const currentSnapshot = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        // Keep event-time captures queued until the editor group's path catches up
        // with its newly installed model. The capture itself is already bound to
        // the model URI, so no keystroke is lost while dispatch is held.
        if (activeEditorPathMismatch())
            return null;
        const current = currentProjectSource();
        const workspaceRoot = getWorkspaceRoot();
        const rootFile = liveRootFor((_a = current === null || current === void 0 ? void 0 : current.path) !== null && _a !== void 0 ? _a : null, (_d = (_c = current === null || current === void 0 ? void 0 : (_b = current.editor).getValue) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : null);
        if (workspaceRoot && rootFile) {
            const buffers = new Map();
            for (const snapshot of getDirtyFileSnapshots()) {
                if (snapshot.isDirty && !snapshot.truncated && PROJECT_SOURCE_RE.test(snapshot.path)) {
                    buffers.set(snapshot.path, snapshot.content);
                }
            }
            // Clean files come from the project snapshot on disk. Serializing the
            // clean root only while its tab is active would turn a root/child tab
            // switch into a source edit. External reloads explicitly call
            // refreshSource below, which forces a same-session disk refresh.
            if (current === null || current === void 0 ? void 0 : current.group.isDirty) {
                buffers.set(current.path, (_g = (_f = (_e = current.editor).getValue) === null || _f === void 0 ? void 0 : _f.call(_e)) !== null && _g !== void 0 ? _g : "");
            }
            const sessionKey = `${workspaceRoot}\0${rootFile}`;
            const exactInputs = [...pendingExactInputs.values()].filter((input) => input.sessionKey === sessionKey);
            // A save can make the active buffer clean before the deferred task runs.
            // Keep the exact bytes observed by the editor notification until the
            // engine accepts them; a later clean snapshot removes the overlay.
            for (const exactInput of exactInputs)
                buffers.set(exactInput.path, exactInput.text);
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
                    activePath: current === null || current === void 0 ? void 0 : current.path,
                    fresh: sessionKey !== queuedSessionKey,
                    clientEditAtEpochMs: exactInputs.length === 1
                        ? exactInputs[0].editAtEpochMs : latestInputAtEpochMs || undefined,
                },
            };
        }
        if (!current || !current.path.toLowerCase().endsWith(".tex"))
            return null;
        const source = (_k = (_j = (_h = current.editor).getValue) === null || _j === void 0 ? void 0 : _j.call(_h)) !== null && _k !== void 0 ? _k : "";
        const sessionKey = `legacy\0${current.path}`;
        const exactInput = ((_l = pendingExactInputs.get(current.path)) === null || _l === void 0 ? void 0 : _l.sessionKey) === sessionKey
            ? pendingExactInputs.get(current.path) : null;
        return {
            sessionKey,
            buffers: new Map([[current.path, (_m = exactInput === null || exactInput === void 0 ? void 0 : exactInput.text) !== null && _m !== void 0 ? _m : source]]),
            exactInputIds: new Map(exactInput ? [[current.path, exactInput.id]] : []),
            target: { workspaceRoot: null, pdfPath: current.path.replace(/\.tex$/i, ".pdf") },
            payload: {
                source: (_o = exactInput === null || exactInput === void 0 ? void 0 : exactInput.text) !== null && _o !== void 0 ? _o : source,
                path: current.path,
                fresh: sessionKey !== queuedSessionKey,
                clientEditAtEpochMs: (_p = exactInput === null || exactInput === void 0 ? void 0 : exactInput.editAtEpochMs) !== null && _p !== void 0 ? _p : (latestInputAtEpochMs || undefined),
            },
        };
    };
    const retireObsoleteSession = (nextSessionKey) => {
        for (const [path, exactInput] of pendingExactInputs) {
            if (exactInput.sessionKey !== nextSessionKey)
                pendingExactInputs.delete(path);
        }
        const queuedSessionIsObsolete = queuedSessionKey !== null && queuedSessionKey !== nextSessionKey;
        const visibleSessionIsObsolete = liveSessionKey !== null && liveSessionKey !== nextSessionKey;
        if (!queuedSessionIsObsolete && !visibleSessionIsObsolete)
            return;
        // Invalidate an in-flight result immediately, before the push
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
    const matchesQueuedSource = (snapshot) => snapshot.sessionKey === queuedSessionKey &&
        snapshot.payload.activePath === queuedActivePath &&
        sameBuffers(snapshot.buffers, queuedBuffers);
    let limitedRetryTimer = null;
    const retryLimited = (sessionKey) => {
        if (limitedRetryTimer !== null)
            clearTimeout(limitedRetryTimer);
        limitedRetryTimer = setTimeout(() => {
            limitedRetryTimer = null;
            if (!active || limitedSessionKey !== sessionKey)
                return;
            limitedSessionKey = null;
            sourceRefreshPending = true;
            pushCurrent();
        }, 5000);
    };
    const enterPageLimit = (sessionKey) => {
        limitedSessionKey = sessionKey;
        lifecycleVersion += 1;
        latestPushVersion += 1;
        debouncedPush.cancel();
        typedPush.cancel();
        compositionRetry.cancel();
        debouncedFocus.cancel();
        pendingExactInputs.clear();
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
    };
    const drainPushes = async () => {
        if (pushing || !(bridge === null || bridge === void 0 ? void 0 : bridge.push))
            return;
        pushing = true;
        const drainLifecycleVersion = lifecycleVersion;
        let attemptedSnapshot = null;
        try {
            // Single-flight latest-wins queue: while LuaLaTeX is working, new
            // keystrokes replace the one pending snapshot instead of building an
            // unbounded FIFO of already-obsolete document states.
            while (active && pendingPush) {
                const snapshot = pendingPush;
                pendingPush = null;
                attemptedSnapshot = snapshot;
                const result = await bridge.push(snapshot.payload);
                if (!(result === null || result === void 0 ? void 0 : result.ok))
                    throw new Error((result === null || result === void 0 ? void 0 : result.error) || "live preview push failed");
                if (result.limited) {
                    if (active && snapshot.lifecycleVersion === lifecycleVersion) {
                        enterPageLimit(snapshot.sessionKey);
                        // Main is still reading what the chapter starts from: ask again.
                        if (result.pending)
                            retryLimited(snapshot.sessionKey);
                    }
                    attemptedSnapshot = null;
                    continue;
                }
                // Only the capture ids carried by this accepted request are retired.
                // An older acknowledgement must never clear a newer edit of same bytes.
                clearAcceptedExactInputs(snapshot);
                const isCurrent = active &&
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
                    // a push that follows a length limit starts the engine itself
                    engineStarted = true;
                    if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl)
                        liveGeneration += 1;
                    engineUrl = result.url;
                    liveSessionKey = snapshot.sessionKey;
                    liveTarget = snapshot.target;
                    distributeLive(engineUrl, liveGeneration);
                }
                else if (releasesBuild && engineUrl) {
                    distributeLive(engineUrl, liveGeneration);
                }
                if (snapshot.payload.clientEditAtEpochMs === latestInputAtEpochMs)
                    latestInputAtEpochMs = 0;
                attemptedSnapshot = null;
            }
        }
        catch (error) {
            const failureIsCurrent = Boolean(attemptedSnapshot &&
                active &&
                drainLifecycleVersion === lifecycleVersion &&
                attemptedSnapshot.lifecycleVersion === lifecycleVersion &&
                attemptedSnapshot.pushVersion === latestPushVersion);
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
            if (failureIsCurrent)
                showLiveError(message);
            console.warn("[live-preview]", message);
        }
        finally {
            pushing = false;
            if (active && pendingPush)
                void drainPushes();
        }
    };
    const pushCurrent = () => {
        compositionRetry.cancel();
        if (!active || !(bridge === null || bridge === void 0 ? void 0 : bridge.push))
            return;
        const current = currentProjectSource();
        const snapshot = currentSnapshot();
        if (!snapshot)
            return;
        if (limitedSessionKey === snapshot.sessionKey) {
            pendingExactInputs.clear();
            latestInputAtEpochMs = 0;
            return;
        }
        // A Build keeps the paper until the engine accepts a source that differs
        // from the one it typeset; that push carries the release.
        const changedSinceBuild = Boolean(builtSnapshot) && (sourceRefreshPending ||
            snapshot.sessionKey !== (builtSnapshot === null || builtSnapshot === void 0 ? void 0 : builtSnapshot.sessionKey) || sourceEditVersion !== (builtSnapshot === null || builtSnapshot === void 0 ? void 0 : builtSnapshot.editVersion));
        retireObsoleteSession(snapshot.sessionKey);
        // Never push mid-IME-composition: the buffer is transient and a typeset
        // per composition keystroke is wasted work. Retry on a separate, slower
        // cadence so a long composition cannot turn into a 16ms retry loop.
        if (current === null || current === void 0 ? void 0 : current.group.isComposing) {
            compositionRetry();
            return;
        }
        if (!sourceRefreshPending && matchesQueuedSource(snapshot)) {
            // With no queued or in-flight request, queuedBuffers is the last source
            // the bridge accepted. A new capture of those same bytes is already live.
            if (!pushing && !pendingPush)
                clearAcceptedExactInputs(snapshot, true);
            return;
        }
        queuedSessionKey = snapshot.sessionKey;
        // For long books, main selects the chapter by the active path even when
        // both tabs are clean and the root and dirty buffers are identical.
        queuedActivePath = snapshot.payload.activePath;
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
    // Coalesce same-task paste, multi-cursor and programmatic companion edits.
    // The single-flight latest-wins queue above is the only engine back-pressure.
    const debouncedPush = createDebouncedTask(pushCurrent, TYPING_PUSH_DELAY_MS, TYPING_PUSH_MAX_WAIT_MS);
    // A keystroke in the editor: out as soon as the editor's own call returns.
    const typedPush = createMicrotaskTask(pushCurrent);
    const compositionRetry = createDebouncedTask(pushCurrent, COMPOSITION_RETRY_MS);
    const bindActiveEditor = () => {
        var _a, _b, _c, _d;
        if (!active)
            return;
        const current = currentProjectSource();
        const nextEditor = (_a = current === null || current === void 0 ? void 0 : current.editor) !== null && _a !== void 0 ? _a : null;
        const nextPath = (_b = current === null || current === void 0 ? void 0 : current.path) !== null && _b !== void 0 ? _b : null;
        if (nextEditor === boundEditor && nextPath === boundPath)
            return;
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        cursorDisposable === null || cursorDisposable === void 0 ? void 0 : cursorDisposable.dispose();
        disposable = null;
        cursorDisposable = null;
        boundEditor = nextEditor;
        boundPath = nextPath;
        if (boundEditor === null || boundEditor === void 0 ? void 0 : boundEditor.onDidChangeModelContent) {
            const eventEditor = boundEditor;
            const eventPath = boundPath;
            const eventModel = (_d = (_c = eventEditor.getModel) === null || _c === void 0 ? void 0 : _c.call(eventEditor)) !== null && _d !== void 0 ? _d : null;
            disposable = eventEditor.onDidChangeModelContent((event) => {
                var _a, _b;
                sourceEditVersion += 1;
                const editedAtEpochMs = Date.now();
                latestInputAtEpochMs = editedAtEpochMs;
                const currentModel = (_b = (_a = eventEditor.getModel) === null || _a === void 0 ? void 0 : _a.call(eventEditor)) !== null && _b !== void 0 ? _b : null;
                const modelPath = editorModelPath(eventEditor);
                // The listener belongs to the editor, not to the model. A tab/search
                // navigation can replace its model before the 200ms binding poll.
                // Prefer the model URI; only use the bound path when the original
                // URI-less model is still installed.
                const exactPath = modelPath !== null && modelPath !== void 0 ? modelPath : (currentModel === eventModel ? eventPath : null);
                captureExactInput(exactPath, eventEditor, editedAtEpochMs);
                // The editor lays out and paints the keystroke before its call
                // returns (6 ms measured). Plain typing does not wait for that; any
                // other change goes out when the call returns, with whatever the
                // editor adds to it.
                if (isPlainTypedChange(event)) {
                    typedPush.cancel();
                    pushCurrent();
                }
                else
                    typedPush();
            });
        }
        if (boundEditor === null || boundEditor === void 0 ? void 0 : boundEditor.onDidChangeCursorPosition) {
            cursorDisposable = boundEditor.onDidChangeCursorPosition(debouncedFocus);
        }
        debouncedPush();
        debouncedFocus();
    };
    const start = async () => {
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.start) || starting || !currentSnapshot())
            return;
        const startLifecycleVersion = lifecycleVersion;
        starting = true;
        try {
            const result = await bridge.start();
            if (!active || startLifecycleVersion !== lifecycleVersion)
                return;
            if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.url) {
                showLiveError((result === null || result === void 0 ? void 0 : result.error) || "エンジンを起動できませんでした。");
                console.warn("[live-preview] engine failed to start:", result === null || result === void 0 ? void 0 : result.error);
                return;
            }
            engineStarted = true;
            // Do not expose the engine's tiny boot sample. The first successful
            // project push below returns the same URL and reveals the viewer only
            // after the configured root document is actually open.
            bindActiveEditor();
            debouncedPush();
        }
        finally {
            starting = false;
        }
    };
    const suspend = () => {
        builtSnapshot = null;
        buildStartEditVersion = null;
        lifecycleVersion += 1;
        latestPushVersion += 1;
        debouncedPush.cancel();
        typedPush.cancel();
        compositionRetry.cancel();
        debouncedFocus.cancel();
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        cursorDisposable === null || cursorDisposable === void 0 ? void 0 : cursorDisposable.dispose();
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
        buildOwnsView = false;
        liveExpectedSrcRev = null;
        liveGeneration += 1;
        distributeLive(null);
    };
    const applyActive = (next) => {
        var _a;
        if (active === next)
            return;
        active = next;
        if (active)
            void start();
        else {
            suspend();
            void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.stop) === null || _a === void 0 ? void 0 : _a.call(bridge));
        }
    };
    let historyBlocked = false;
    const refresh = () => {
        applyActive(!historyBlocked && editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
        if (active && limitedSessionKey) {
            // Still the limited document (or a tab that is no source at all): its
            // Build paper stays, as with the setting off. Another document starts over.
            const snapshot = currentSnapshot();
            if (!snapshot || snapshot.sessionKey === limitedSessionKey)
                return;
            limitedSessionKey = null;
        }
        if (active) {
            if (!engineStarted && !starting)
                void start();
            bindActiveEditor();
            // A workspace switch can reuse the same Monaco editor instance while
            // swapping its model after currentFilePath changes. The editor binding
            // alone then observes neither transition and the old project remains
            // visible until the first typed character. Poll the actual path+buffer
            // pair as the source of truth; pushCurrent is still a no-op when both
            // match the last successful enqueue.
            const snapshot = currentSnapshot();
            if (snapshot)
                retireObsoleteSession(snapshot.sessionKey);
            if (snapshot && (sourceRefreshPending || !matchesQueuedSource(snapshot)))
                debouncedPush();
            if (engineUrl)
                distributeLive(engineUrl);
        }
        else
            distributeLive(null);
    };
    const refreshSource = () => {
        if (!active)
            return;
        sourceEditVersion += 1;
        sourceRefreshPending = true;
        latestInputAtEpochMs = Date.now();
        debouncedPush();
    };
    editorSettings.subscribe((change) => {
        if (change.kind !== "flag" || change.id !== "preview.realtime")
            return;
        refresh();
    });
    // A Build is the one thing that can bring a limited document back under
    // the limit. Ask main again with the new paper; the answer either starts
    // Live or keeps the limit, and no engine is started just to ask.
    window.addEventListener("tex64:build-state", (event) => {
        var _a, _b, _c;
        if (active && limitedSessionKey) {
            if (((_a = event.detail) === null || _a === void 0 ? void 0 : _a.state) !== "success")
                return;
            limitedSessionKey = null;
            sourceRefreshPending = true;
            pushCurrent();
            return;
        }
        if (!active || !liveTarget)
            return;
        const detail = event.detail;
        const normalize = (value) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
        const root = liveTarget.workspaceRoot;
        if (detail.workspaceRoot && normalize(detail.workspaceRoot) !== normalize(root !== null && root !== void 0 ? root : ""))
            return;
        const absolute = (value) => /^(?:\/|[A-Za-z]:\/)/.test(value)
            ? normalize(value) : `${normalize(root !== null && root !== void 0 ? root : "")}/${normalize(value)}`;
        const pdfPath = (_b = detail.pdfPath) !== null && _b !== void 0 ? _b : (_c = detail.targetFile) === null || _c === void 0 ? void 0 : _c.replace(/\.tex$/i, ".pdf");
        if (!pdfPath || absolute(pdfPath) !== absolute(liveTarget.pdfPath))
            return;
        if (detail.state === "building") {
            buildStartEditVersion !== null && buildStartEditVersion !== void 0 ? buildStartEditVersion : (buildStartEditVersion = sourceEditVersion);
            const targetPdf = absolute(pdfPath);
            const targetIsVisible = getEditorGroups().some((group) => group.viewer.getViewerMode() === "pdf" &&
                typeof group.currentFilePath === "string" &&
                absolute(group.currentFilePath) === targetPdf);
            if (detail.previousPdf === true && !targetIsVisible && !buildOwnsView) {
                const snapshot = currentSnapshot();
                builtSnapshot = snapshot
                    ? { sessionKey: snapshot.sessionKey, editVersion: sourceEditVersion }
                    : null;
                buildOwnsView = Boolean(builtSnapshot);
                if (buildOwnsView) {
                    buildViewVersion += 1;
                    liveExpectedSrcRev = null;
                    if (engineUrl)
                        distributeLive(engineUrl);
                }
            }
            return;
        }
        const sourceChanged = buildStartEditVersion !== null && buildStartEditVersion !== sourceEditVersion ||
            getDirtyFileSnapshots().some((snapshot) => snapshot.isDirty && PROJECT_SOURCE_RE.test(snapshot.path));
        buildStartEditVersion = null;
        if (detail.state !== "success")
            return;
        detail.sourceChanged = sourceChanged;
        // A completed Build owns the paper only while this exact source remains
        // current. The engine keeps its accepted source, document generation and
        // warm checkpoints, so the next edit stays on /edit. Ownership travels
        // with the Live state: a PDF tab this Build has just opened applies it
        // once its viewer is ready, and late responses redistribute it unchanged.
        const built = sourceChanged ? null : currentSnapshot();
        builtSnapshot = built ? { sessionKey: built.sessionKey, editVersion: sourceEditVersion } : null;
        buildOwnsView = Boolean(builtSnapshot);
        if (buildOwnsView)
            buildViewVersion += 1;
        liveExpectedSrcRev = null;
        if (engineUrl)
            distributeLive(engineUrl);
        if (!buildOwnsView)
            debouncedPush();
    });
    // History owns the writer barrier and main-process shutdown. Retire the
    // renderer generation immediately so a late push cannot expose pre-restore
    // pages while files and editor models are being synchronized.
    const history = window.tex64History;
    const unsubscribeHistory = history === null || history === void 0 ? void 0 : history.onChange((message) => {
        var _a, _b, _c;
        const phase = message.type === "workspace:operation" ? (_a = message.payload) === null || _a === void 0 ? void 0 : _a.phase
            : message.type === "updateWorkspace" ? (_c = (_b = message.payload) === null || _b === void 0 ? void 0 : _b.workspaceOperation) === null || _c === void 0 ? void 0 : _c.phase : undefined;
        if (typeof phase !== "string")
            return;
        historyBlocked = phase !== "idle";
        refresh();
    });
    // Same lightweight poll as pro-live-preview: notices tab switches, editor
    // swaps and app-mode changes without threading callbacks through every
    // call site.
    const poll = window.setInterval(refresh, 200);
    let checkingHealth = false;
    const healthPoll = window.setInterval(async () => {
        if (!active || !engineStarted || checkingHealth || !(bridge === null || bridge === void 0 ? void 0 : bridge.status))
            return;
        const healthLifecycleVersion = lifecycleVersion;
        checkingHealth = true;
        try {
            const status = await bridge.status();
            const current = active && healthLifecycleVersion === lifecycleVersion;
            const limitedKey = queuedSessionKey !== null && queuedSessionKey !== void 0 ? queuedSessionKey : liveSessionKey;
            if (current && (status === null || status === void 0 ? void 0 : status.pageLimited) && limitedKey) {
                // main stopped the engine: the document grew past the length limit
                enterPageLimit(limitedKey);
            }
            else if (current && (!(status === null || status === void 0 ? void 0 : status.running) || status.state !== "ready")) {
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
        }
        catch {
            // A transient IPC failure is retried by the next low-frequency poll.
        }
        finally {
            checkingHealth = false;
        }
    }, 2000);
    window.addEventListener("beforeunload", () => {
        unsubscribeHistory === null || unsubscribeHistory === void 0 ? void 0 : unsubscribeHistory();
        window.clearInterval(poll);
        window.clearInterval(healthPoll);
    }, { once: true });
    // Clear renderer state left by a reload before restoring the current
    // setting.
    distributeLive(null);
    refresh();
    return { isActive: () => active, refreshSource };
};
