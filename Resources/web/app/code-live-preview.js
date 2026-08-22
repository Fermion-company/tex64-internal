// Real-time preview for Code mode (beta, settings > Build > Preview).
//
// The preview REPLACES the display inside the surfaces that already show the
// built PDF — the in-tab pdf viewer (viewer.ts → pdf-viewer.html) and the
// separate PDF window — it adds no pane of its own. While the
// `preview.realtime` flag is on and the app is in Code mode, this module
// starts the local TDOM engine, streams the active .tex buffer to it as the
// user types, and flips those viewers into live mode; each viewer swaps only
// its page canvas for the engine's embedded client, keeping its own toolbar
// and chrome. Turning the flag off restores the static PDF everywhere and
// stops the engine.
import { editorSettings } from "./editor-settings/editor-settings-store.js";
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
export const initCodeLivePreview = ({ getActiveGroup, getEditorGroups, getAppMode, getPdfViewerMode, getWorkspaceRoot, getRootFile, getDirtyFileSnapshots, setWorkspaceLivePreview, }) => {
    const bridge = window.tex64Tdom;
    let active = false;
    let starting = false;
    let engineStarted = false;
    let engineUrl = null;
    let distributedWindowKey;
    let liveGeneration = 0;
    let lifecycleVersion = 0;
    let latestPushVersion = 0;
    let liveSessionKey = null;
    let boundEditor = null;
    let boundPath = null;
    let disposable = null;
    let queuedSessionKey = null;
    let queuedBuffers = new Map();
    let pendingPush = null;
    let pushing = false;
    // Flip every PDF surface (both editor groups' viewers + the separate PDF
    // window) into or out of live mode. Idempotent; the surfaces themselves
    // re-apply the state when they (re)open.
    const distributeLive = (url, generation = liveGeneration) => {
        var _a;
        // Code's integrated source/PDF workspace owns a viewer outside the
        // editor-session groups. Keep that visible surface on the same Live
        // generation as the legacy group viewers.
        setWorkspaceLivePreview === null || setWorkspaceLivePreview === void 0 ? void 0 : setWorkspaceLivePreview(url, generation);
        // Groups can be created while the URL stays unchanged. Each viewer is
        // idempotent, so always give every current surface the active generation.
        for (const group of getEditorGroups()) {
            group.viewer.setLivePreview(url, generation);
        }
        // "Build in Separate Window" owns the destination for Live as well.
        // In tab mode, never create a detached viewer and remove Live from an
        // already-open detached PDF window while leaving the in-tab viewer live.
        const viewerMode = getPdfViewerMode();
        const windowUrl = viewerMode === "window" ? url : null;
        // Destination is part of the identity even while Live is off. Otherwise
        // `window/null` and `tab/null` collapse to the same key and a detached
        // static window can survive a later switch to tab mode.
        const windowKey = `${viewerMode}\0${windowUrl ? `${windowUrl}\0${generation}` : "static"}`;
        if (distributedWindowKey !== windowKey) {
            distributedWindowKey = windowKey;
            void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.windowLive) === null || _a === void 0 ? void 0 : _a.call(bridge, {
                url: windowUrl,
                generation,
                show: Boolean(windowUrl),
                // Turning Live off while the separate-window mode remains selected
                // restores that window's static PDF. Switching the destination to a
                // tab is different: the detached surface must disappear altogether.
                hide: viewerMode !== "window",
                error: null,
            }));
        }
    };
    const showLiveError = (message) => {
        var _a;
        if (getPdfViewerMode() !== "window")
            return;
        // The next healthy distribution must clear this transient error even
        // when the recovered engine reuses the same localhost URL/generation.
        distributedWindowKey = undefined;
        void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.windowLive) === null || _a === void 0 ? void 0 : _a.call(bridge, {
            url: engineUrl,
            generation: liveGeneration,
            show: true,
            error: `リアルタイムプレビュー: ${message}`,
        }));
    };
    const currentProjectSource = () => {
        const group = getActiveGroup();
        const path = group.currentFilePath;
        const editor = group.editor;
        if (!path || !PROJECT_SOURCE_RE.test(path) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
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
    const currentSnapshot = () => {
        var _a, _b, _c, _d, _e, _f;
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
            const workspaceNormalized = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
            const projectRelative = (value) => {
                const normalized = value === null || value === void 0 ? void 0 : value.replace(/\\/g, "/").replace(/^\.\//, "");
                return (normalized === null || normalized === void 0 ? void 0 : normalized.startsWith(`${workspaceNormalized}/`))
                    ? normalized.slice(workspaceNormalized.length + 1)
                    : normalized;
            };
            const rootInsideWorkspace = projectRelative(rootFile);
            const currentRelative = projectRelative(current === null || current === void 0 ? void 0 : current.path);
            // Keep the configured root exact even while it is clean. This also
            // notices an external reload of main.tex; all non-root files remain
            // dirty-only overlays and are never serialized just for a tab switch.
            if (current && (current.group.isDirty || currentRelative === rootInsideWorkspace)) {
                buffers.set(current.path, (_c = (_b = (_a = current.editor).getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : "");
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
                },
            };
        }
        if (!current || !current.path.toLowerCase().endsWith(".tex"))
            return null;
        const source = (_f = (_e = (_d = current.editor).getValue) === null || _e === void 0 ? void 0 : _e.call(_d)) !== null && _f !== void 0 ? _f : "";
        return {
            sessionKey: `legacy\0${current.path}`,
            buffers: new Map([[current.path, source]]),
            payload: { source, path: current.path, fresh: `legacy\0${current.path}` !== queuedSessionKey },
        };
    };
    const retireObsoleteSession = (nextSessionKey) => {
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
                const isCurrent = active &&
                    snapshot.lifecycleVersion === lifecycleVersion &&
                    snapshot.pushVersion === latestPushVersion;
                if (result.url && isCurrent) {
                    if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl)
                        liveGeneration += 1;
                    engineUrl = result.url;
                    liveSessionKey = snapshot.sessionKey;
                    distributeLive(engineUrl, liveGeneration);
                }
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
            // discard the new pending snapshot or reopen a detached error surface.
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
        retireObsoleteSession(snapshot.sessionKey);
        // Never push mid-IME-composition: the buffer is transient and a typeset
        // per composition keystroke is wasted work. Try again after the debounce.
        if (current === null || current === void 0 ? void 0 : current.group.isComposing) {
            debouncedPush();
            return;
        }
        if (snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers))
            return;
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
        var _a, _b;
        if (!active)
            return;
        const current = currentProjectSource();
        const nextEditor = (_a = current === null || current === void 0 ? void 0 : current.editor) !== null && _a !== void 0 ? _a : null;
        const nextPath = (_b = current === null || current === void 0 ? void 0 : current.path) !== null && _b !== void 0 ? _b : null;
        if (nextEditor === boundEditor && nextPath === boundPath)
            return;
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        disposable = null;
        boundEditor = nextEditor;
        boundPath = nextPath;
        if (boundEditor === null || boundEditor === void 0 ? void 0 : boundEditor.onDidChangeModelContent)
            disposable = boundEditor.onDidChangeModelContent(debouncedPush);
        debouncedPush();
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
        lifecycleVersion += 1;
        latestPushVersion += 1;
        debouncedPush.cancel();
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        disposable = null;
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
    const refresh = () => {
        applyActive(editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
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
            if (snapshot && (snapshot.sessionKey !== queuedSessionKey || !sameBuffers(snapshot.buffers, queuedBuffers)))
                debouncedPush();
            if (engineUrl)
                distributeLive(engineUrl);
        }
        else {
            // Keep the detached surface consistent with the current destination
            // even when Live itself is off.
            distributeLive(null);
        }
    };
    editorSettings.subscribe((change) => {
        if (change.kind !== "flag" || change.id !== "preview.realtime")
            return;
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
                // Force the recovered URL through even when the OS gives the new
                // process the same port as the dead one.
                distributedWindowKey = undefined;
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
        window.clearInterval(poll);
        window.clearInterval(healthPoll);
    }, { once: true });
    // Clear main-process state left by a renderer reload before restoring the
    // current setting. Without this handshake, a stale detached Live frame can
    // survive Cmd+R even when the viewer mode is now "tab".
    distributeLive(null);
    refresh();
    return { isActive: () => active };
};
