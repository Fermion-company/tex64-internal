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
const createDebouncedTask = (task, delayMs) => {
    let timer = null;
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            task();
        }, delayMs);
    };
    schedule.cancel = () => {
        if (timer)
            clearTimeout(timer);
        timer = null;
    };
    return schedule;
};
const PROJECT_SOURCE_RE = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|cfg|def|lbx|ltx|dtx|ins)$/i;
export const initCodeLivePreview = ({ getActiveGroup, getEditorGroups, getAppMode, getWorkspaceRoot, getRootFile, getDirtyFileSnapshots, }) => {
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
    let queuedBuffers = new Map();
    let pendingPush = null;
    let pushing = false;
    let latestInputAtEpochMs = 0;
    let lastContentChangeAtEpochMs = 0;
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
        // A character insertion moves the Monaco caret too. Let its 80ms source
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
        const configuredRoot = getRootFile();
        const rootFile = configuredRoot || (path.toLowerCase().endsWith(".tex") ? path : null);
        const sessionKey = workspaceRoot && rootFile
            ? `${workspaceRoot}\0${rootFile}`
            : path.toLowerCase().endsWith(".tex") ? `legacy\0${path}` : null;
        if (!sessionKey)
            return;
        pendingExactInputs.set(path, {
            id: ++nextExactInputId,
            sessionKey,
            path,
            text: editor.getValue(),
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        // Keep event-time captures queued until the editor group's path catches up
        // with its newly installed model. The capture itself is already bound to
        // the model URI, so no keystroke is lost while dispatch is held.
        if (activeEditorPathMismatch())
            return null;
        const current = currentProjectSource();
        const workspaceRoot = getWorkspaceRoot();
        const configuredRoot = getRootFile();
        const rootFile = configuredRoot || ((current === null || current === void 0 ? void 0 : current.path.toLowerCase().endsWith(".tex")) ? current.path : null);
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
                buffers.set(current.path, (_c = (_b = (_a = current.editor).getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : "");
            }
            const sessionKey = `${workspaceRoot}\0${rootFile}`;
            const exactInputs = [...pendingExactInputs.values()].filter((input) => input.sessionKey === sessionKey);
            // A save can make the active buffer clean before the 80ms task runs.
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
                    fresh: sessionKey !== queuedSessionKey,
                    clientEditAtEpochMs: exactInputs.length === 1
                        ? exactInputs[0].editAtEpochMs : latestInputAtEpochMs || undefined,
                },
            };
        }
        if (!current || !current.path.toLowerCase().endsWith(".tex"))
            return null;
        const source = (_f = (_e = (_d = current.editor).getValue) === null || _e === void 0 ? void 0 : _e.call(_d)) !== null && _f !== void 0 ? _f : "";
        const sessionKey = `legacy\0${current.path}`;
        const exactInput = ((_g = pendingExactInputs.get(current.path)) === null || _g === void 0 ? void 0 : _g.sessionKey) === sessionKey
            ? pendingExactInputs.get(current.path) : null;
        return {
            sessionKey,
            buffers: new Map([[current.path, (_h = exactInput === null || exactInput === void 0 ? void 0 : exactInput.text) !== null && _h !== void 0 ? _h : source]]),
            exactInputIds: new Map(exactInput ? [[current.path, exactInput.id]] : []),
            target: { workspaceRoot: null, pdfPath: current.path.replace(/\.tex$/i, ".pdf") },
            payload: {
                source: (_j = exactInput === null || exactInput === void 0 ? void 0 : exactInput.text) !== null && _j !== void 0 ? _j : source,
                path: current.path,
                fresh: sessionKey !== queuedSessionKey,
                clientEditAtEpochMs: (_k = exactInput === null || exactInput === void 0 ? void 0 : exactInput.editAtEpochMs) !== null && _k !== void 0 ? _k : (latestInputAtEpochMs || undefined),
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
        if (!active || !(bridge === null || bridge === void 0 ? void 0 : bridge.push))
            return;
        const current = currentProjectSource();
        const snapshot = currentSnapshot();
        if (!snapshot)
            return;
        // A Build keeps the paper until the engine accepts a source that differs
        // from the one it typeset; that push carries the release.
        const changedSinceBuild = Boolean(builtSnapshot) && (sourceRefreshPending ||
            snapshot.sessionKey !== (builtSnapshot === null || builtSnapshot === void 0 ? void 0 : builtSnapshot.sessionKey) || sourceEditVersion !== (builtSnapshot === null || builtSnapshot === void 0 ? void 0 : builtSnapshot.editVersion));
        retireObsoleteSession(snapshot.sessionKey);
        // Never push mid-IME-composition: the buffer is transient and a typeset
        // per composition keystroke is wasted work. Try again after the debounce.
        if (current === null || current === void 0 ? void 0 : current.group.isComposing) {
            debouncedPush();
            return;
        }
        if (!sourceRefreshPending &&
            snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers)) {
            // With no queued or in-flight request, queuedBuffers is the last source
            // the bridge accepted. A new capture of those same bytes is already live.
            if (!pushing && !pendingPush)
                clearAcceptedExactInputs(snapshot, true);
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
    // The first keystroke after a pause (a jump to another place, say) goes
    // out within a frame: 16ms still takes in the companion edit the editor
    // makes in the same task (the \end{…} after a \begin{…}, a closing \]).
    const firstPush = createDebouncedTask(pushCurrent, 16);
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
            disposable = eventEditor.onDidChangeModelContent(() => {
                var _a, _b;
                sourceEditVersion += 1;
                const editedAtEpochMs = Date.now();
                const sincePreviousEdit = editedAtEpochMs - lastContentChangeAtEpochMs;
                lastContentChangeAtEpochMs = editedAtEpochMs;
                latestInputAtEpochMs = editedAtEpochMs;
                const currentModel = (_b = (_a = eventEditor.getModel) === null || _a === void 0 ? void 0 : _a.call(eventEditor)) !== null && _b !== void 0 ? _b : null;
                const modelPath = editorModelPath(eventEditor);
                // The listener belongs to the editor, not to the model. A tab/search
                // navigation can replace its model before the 200ms binding poll.
                // Prefer the model URI; only use the bound path when the original
                // URI-less model is still installed.
                const exactPath = modelPath !== null && modelPath !== void 0 ? modelPath : (currentModel === eventModel ? eventPath : null);
                captureExactInput(exactPath, eventEditor, editedAtEpochMs);
                // a burst is still coalesced by the 80ms debounce
                if (sincePreviousEdit > 400 && !pushing && !pendingPush)
                    firstPush();
                else
                    debouncedPush();
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
        firstPush.cancel();
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
            if (snapshot && (sourceRefreshPending || snapshot.sessionKey !== queuedSessionKey || !sameBuffers(snapshot.buffers, queuedBuffers)))
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
    window.addEventListener("tex64:build-state", (event) => {
        var _a, _b;
        if (!active || !liveTarget)
            return;
        const detail = event.detail;
        const normalize = (value) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
        const root = liveTarget.workspaceRoot;
        if (detail.workspaceRoot && normalize(detail.workspaceRoot) !== normalize(root !== null && root !== void 0 ? root : ""))
            return;
        const absolute = (value) => /^(?:\/|[A-Za-z]:\/)/.test(value)
            ? normalize(value) : `${normalize(root !== null && root !== void 0 ? root : "")}/${normalize(value)}`;
        const pdfPath = (_a = detail.pdfPath) !== null && _a !== void 0 ? _a : (_b = detail.targetFile) === null || _b === void 0 ? void 0 : _b.replace(/\.tex$/i, ".pdf");
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
            if (active && healthLifecycleVersion === lifecycleVersion &&
                (!(status === null || status === void 0 ? void 0 : status.running) || status.state !== "ready")) {
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
