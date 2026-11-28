const COMPOSITION_RECHECK_MS = 100;
export const HOLD_PAUSE_MS = 2000;
export const HOLD_MAX_MS = 30000;
const HOLD_RECHECK_MS = 250;
export const DELETE_GRACE_MS = 5000;
export const createOutsideEdits = (deps) => {
    var _a;
    const waiting = new Map();
    const held = new Map();
    const pendingDeletions = new Map();
    const now = (_a = deps.now) !== null && _a !== void 0 ? _a : (() => Date.now());
    const composingOn = (path) => Object.values(deps.editorGroups).some((group) => group.isComposing && (group.currentFilePath === path || group.composingFilePath === path));
    // Runs `action` now, or after the composition on `path` ends (behind any
    // change already waiting for it). Returns true when it had to wait.
    const whenNotComposing = (path, action) => {
        const queue = waiting.get(path);
        if (queue) {
            queue.push(action);
            return true;
        }
        if (!composingOn(path)) {
            action();
            return false;
        }
        const pending = [action];
        waiting.set(path, pending);
        const drain = () => {
            if (waiting.get(path) !== pending)
                return;
            if (composingOn(path)) {
                window.setTimeout(drain, COMPOSITION_RECHECK_MS);
                return;
            }
            waiting.delete(path);
            for (const run of pending)
                run();
        };
        window.setTimeout(drain, COMPOSITION_RECHECK_MS);
        return true;
    };
    const applyNow = (path, content, options) => {
        const groupKey = deps.findGroupKeyByPath(path);
        if (!groupKey)
            return { handled: false, conflict: false };
        const conflict = deps.applyFormattedContent(deps.getEditorGroup(groupKey), path, content, options);
        return { handled: true, conflict };
    };
    // Applies the waiting edit of `path` now (merge, or the conflict choices).
    const release = (path) => {
        var _a, _b, _c;
        const edit = held.get(path);
        if (!edit)
            return;
        held.delete(path);
        (_a = deps.unholdSaves) === null || _a === void 0 ? void 0 : _a.call(deps, path);
        if (deps.monacoModels.get(path) !== edit.entry)
            return;
        const result = applyNow(path, edit.content, edit.options);
        if (result.conflict)
            (_c = (_b = edit.options) === null || _b === void 0 ? void 0 : _b.onDeferredConflict) === null || _c === void 0 ? void 0 : _c.call(_b);
    };
    const checkHeld = (path) => {
        var _a, _b, _c, _d, _e;
        const edit = held.get(path);
        if (!edit)
            return;
        if (deps.monacoModels.get(path) !== edit.entry) {
            held.delete(path);
            (_a = deps.unholdSaves) === null || _a === void 0 ? void 0 : _a.call(deps, path);
            return;
        }
        if (!composingOn(path)) {
            const typedAt = (_c = (_b = deps.lastTypedAt) === null || _b === void 0 ? void 0 : _b.call(deps, path)) !== null && _c !== void 0 ? _c : null;
            const paused = typedAt === null || now() - typedAt >= HOLD_PAUSE_MS;
            const overdue = now() - edit.since >= HOLD_MAX_MS && ((_e = (_d = deps.mergesCleanly) === null || _d === void 0 ? void 0 : _d.call(deps, path, edit.content)) !== null && _e !== void 0 ? _e : false);
            if (paused || overdue) {
                release(path);
                return;
            }
        }
        window.setTimeout(() => checkHeld(path), HOLD_RECHECK_MS);
    };
    const hold = (path, entry, content, options) => {
        var _a, _b;
        const previous = held.get(path);
        held.set(path, { entry, content, options: options !== null && options !== void 0 ? options : previous === null || previous === void 0 ? void 0 : previous.options, since: (_a = previous === null || previous === void 0 ? void 0 : previous.since) !== null && _a !== void 0 ? _a : now() });
        if (previous)
            return;
        (_b = deps.holdSaves) === null || _b === void 0 ? void 0 : _b.call(deps, path, () => release(path));
        window.setTimeout(() => checkHeld(path), HOLD_RECHECK_MS);
    };
    const handleExternalFileChange = (payload) => {
        const entry = deps.monacoModels.get(payload.path);
        if (!entry || !deps.findGroupKeyByPath(payload.path))
            return;
        if (payload.fileDeleted) {
            if (pendingDeletions.has(payload.path))
                return;
            const timer = window.setTimeout(() => {
                var _a;
                if (pendingDeletions.get(payload.path) !== timer)
                    return;
                pendingDeletions.delete(payload.path);
                applyExternalChange(payload, entry);
                (_a = deps.onDeletionSettled) === null || _a === void 0 ? void 0 : _a.call(deps);
            }, DELETE_GRACE_MS);
            pendingDeletions.set(payload.path, timer);
            return;
        }
        // The file is back (or was never really gone).
        const pendingDeletion = pendingDeletions.get(payload.path);
        if (pendingDeletion !== undefined) {
            window.clearTimeout(pendingDeletion);
            pendingDeletions.delete(payload.path);
        }
        applyExternalChange(payload, entry);
    };
    const applyExternalChange = (payload, entry) => {
        whenNotComposing(payload.path, () => {
            var _a, _b;
            // A buffer closed and reopened meanwhile was read fresh from disk.
            if (deps.monacoModels.get(payload.path) !== entry)
                return;
            const groupKey = deps.findGroupKeyByPath(payload.path);
            if (!groupKey)
                return;
            // The newest disk text joins an Axiom edit waiting on this file.
            const waitingEdit = held.get(payload.path);
            if (waitingEdit && !payload.fileDeleted && typeof payload.content === "string") {
                waitingEdit.content = payload.content;
                return;
            }
            if (!payload.fileDeleted && payload.content === entry.savedContent)
                return;
            const pendingSave = deps.getPendingSave();
            if (!payload.fileDeleted && (pendingSave === null || pendingSave === void 0 ? void 0 : pendingSave.path) === payload.path && pendingSave.content === payload.content)
                return;
            deps.applyFormattedContent(deps.getEditorGroup(groupKey), payload.path, (_a = payload.content) !== null && _a !== void 0 ? _a : "", {
                updateSaved: true,
                showAiDiff: false,
                expectedContent: entry.savedContent,
                fileDeleted: payload.fileDeleted,
                externalChange: true,
            });
            (_b = deps.onLivePreviewSourceChanged) === null || _b === void 0 ? void 0 : _b.call(deps);
        });
    };
    const applyContentToOpenFile = (requestedPath, content, options) => {
        const path = (options === null || options === void 0 ? void 0 : options.fileIdentity) || requestedPath;
        const entry = deps.monacoModels.get(path);
        if (!entry || !deps.findGroupKeyByPath(path))
            return applyNow(path, content, options);
        // A conflict found now is returned; one found after waiting (composition
        // or typing pause) is reported through onDeferredConflict.
        let synchronous = true;
        let result = { handled: true, conflict: false };
        whenNotComposing(path, () => {
            var _a, _b, _c;
            if (deps.monacoModels.get(path) !== entry)
                return;
            const textEdit = (options === null || options === void 0 ? void 0 : options.fileDeleted) !== true && (options === null || options === void 0 ? void 0 : options.expectedFileMissing) !== true;
            if (textEdit && (held.has(path) || ((_b = (_a = deps.disturbsTyping) === null || _a === void 0 ? void 0 : _a.call(deps, path, content, HOLD_PAUSE_MS)) !== null && _b !== void 0 ? _b : false))) {
                hold(path, entry, content, options);
                return;
            }
            if (held.has(path))
                release(path);
            const applied = applyNow(path, content, options);
            if (synchronous)
                result = applied;
            else if (applied.conflict)
                (_c = options === null || options === void 0 ? void 0 : options.onDeferredConflict) === null || _c === void 0 ? void 0 : _c.call(options);
        });
        synchronous = false;
        return result;
    };
    return {
        handleExternalFileChange,
        applyContentToOpenFile,
        /** True while a file reported missing may still come back. */
        isDeletionPending: (path) => pendingDeletions.has(path),
        clear: () => {
            var _a;
            waiting.clear();
            for (const timer of pendingDeletions.values())
                window.clearTimeout(timer);
            pendingDeletions.clear();
            for (const path of Array.from(held.keys()))
                (_a = deps.unholdSaves) === null || _a === void 0 ? void 0 : _a.call(deps, path);
            held.clear();
        },
    };
};
