export const createEditorSessionSplitViewOps = (runtime, coreOps) => {
    const getSplitSizing = () => {
        var _a, _b, _c, _d;
        const style = runtime.dom.editorGroupsRootEl ? getComputedStyle(runtime.dom.editorGroupsRootEl) : null;
        const min = Number.parseFloat((_a = style === null || style === void 0 ? void 0 : style.getPropertyValue("--split-min")) !== null && _a !== void 0 ? _a : "");
        const handle = Number.parseFloat((_b = style === null || style === void 0 ? void 0 : style.getPropertyValue("--split-handle")) !== null && _b !== void 0 ? _b : "");
        const width = (_d = (_c = runtime.dom.editorGroupsRootEl) === null || _c === void 0 ? void 0 : _c.getBoundingClientRect().width) !== null && _d !== void 0 ? _d : 0;
        return {
            min: Number.isFinite(min) && min > 0 ? min : 280,
            handle: Number.isFinite(handle) && handle > 0 ? handle : 8,
            width,
        };
    };
    const clampSplitRatio = (ratio) => {
        const { min, handle, width } = getSplitSizing();
        const available = Math.max(width - handle, 1);
        let minRatio = min / available;
        if (!Number.isFinite(minRatio) || minRatio < 0) {
            minRatio = 0;
        }
        if (minRatio > 0.5) {
            return 0.5;
        }
        const maxRatio = 1 - minRatio;
        if (!Number.isFinite(ratio)) {
            return 0.5;
        }
        return Math.min(Math.max(ratio, minRatio), maxRatio);
    };
    const applySplitRatio = (ratio, options = {}) => {
        if (!runtime.dom.editorGroupsRootEl) {
            return;
        }
        const normalized = clampSplitRatio(ratio);
        runtime.state.splitRatio = normalized;
        runtime.dom.editorGroupsRootEl.style.setProperty("--split-primary", `${normalized}fr`);
        runtime.dom.editorGroupsRootEl.style.setProperty("--split-secondary", `${1 - normalized}fr`);
        if (runtime.dom.editorSplitter instanceof HTMLElement) {
            runtime.dom.editorSplitter.setAttribute("aria-valuenow", String(Math.round(normalized * 100)));
        }
        if (options.persist && typeof localStorage !== "undefined") {
            localStorage.setItem(runtime.state.splitRatioKey, String(normalized));
        }
    };
    const restoreSplitRatio = () => {
        if (typeof localStorage === "undefined") {
            return 0.5;
        }
        const raw = localStorage.getItem(runtime.state.splitRatioKey);
        const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
        if (!Number.isFinite(parsed)) {
            return 0.5;
        }
        return Math.min(Math.max(parsed, 0.1), 0.9);
    };
    const setEditorGroupEmptyState = (group, isEmpty) => {
        var _a;
        if (group.root instanceof HTMLElement) {
            group.root.classList.toggle("is-empty", isEmpty);
        }
        if (!isEmpty && group.editor) {
            const editor = group.editor;
            (_a = editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
        }
    };
    const isAnyGroupComposing = () => Object.values(runtime.editorGroups).some((group) => group.isComposing);
    const updateBreadcrumbs = () => {
        runtime.deps.editorTabs.render(coreOps.getActiveGroup());
    };
    const updateMiniOutline = () => { };
    const setActiveGroup = (nextKey, options = {}) => {
        var _a;
        if (runtime.state.activeEditorGroup === nextKey) {
            return;
        }
        runtime.state.activeEditorGroup = nextKey;
        coreOps.forEachEditorGroup((group) => {
            if (group.root instanceof HTMLElement) {
                group.root.classList.toggle("is-active", group.key === nextKey);
            }
        });
        updateBreadcrumbs();
        updateMiniOutline();
        runtime.deps.outline.render();
        runtime.deps.fileTree.render();
        runtime.deps.buildOps.updateSynctexButtonState();
        if (options.focusEditor) {
            const editor = coreOps.getActiveGroup().editor;
            (_a = editor === null || editor === void 0 ? void 0 : editor.focus) === null || _a === void 0 ? void 0 : _a.call(editor);
        }
    };
    const setSplitViewEnabled = (enabled) => {
        runtime.state.splitViewEnabled = enabled;
        if (runtime.dom.editorGroupsRootEl) {
            runtime.dom.editorGroupsRootEl.dataset.split = enabled ? "true" : "false";
        }
        if (runtime.dom.editorSplitButton instanceof HTMLElement) {
            runtime.dom.editorSplitButton.classList.toggle("is-active", enabled);
            runtime.dom.editorSplitButton.setAttribute("aria-pressed", enabled ? "true" : "false");
        }
        const secondaryRoot = runtime.editorGroups.secondary.root;
        if (secondaryRoot instanceof HTMLElement) {
            secondaryRoot.setAttribute("aria-hidden", enabled ? "false" : "true");
        }
        if (runtime.dom.editorSplitter instanceof HTMLElement) {
            runtime.dom.editorSplitter.setAttribute("aria-hidden", enabled ? "false" : "true");
        }
        if (enabled) {
            applySplitRatio(runtime.state.splitRatio);
        }
        if (!enabled && runtime.state.activeEditorGroup === "secondary") {
            setActiveGroup("primary", { focusEditor: false });
        }
        coreOps.scheduleEditorLayout();
    };
    const setupSplitResizer = () => {
        if (!(runtime.dom.editorSplitter instanceof HTMLElement) || !runtime.dom.editorGroupsRootEl) {
            return;
        }
        let isResizing = false;
        const startResize = () => {
            if (isResizing) {
                return;
            }
            isResizing = true;
            runtime.dom.editorGroupsRootEl.classList.add("is-resizing");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            coreOps.forEachEditorGroup((group) => {
                if (group.editorHost instanceof HTMLElement) {
                    group.editorHost.style.pointerEvents = "none";
                }
            });
        };
        const doResize = (event) => {
            if (!isResizing || !runtime.state.splitViewEnabled) {
                return;
            }
            const rect = runtime.dom.editorGroupsRootEl.getBoundingClientRect();
            const { handle } = getSplitSizing();
            const available = Math.max(rect.width - handle, 1);
            const offset = event.clientX - rect.left - handle / 2;
            const ratio = offset / available;
            applySplitRatio(ratio);
            coreOps.scheduleEditorLayout();
        };
        const stopResize = () => {
            if (!isResizing) {
                return;
            }
            isResizing = false;
            runtime.dom.editorGroupsRootEl.classList.remove("is-resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            coreOps.forEachEditorGroup((group) => {
                if (group.editorHost instanceof HTMLElement) {
                    group.editorHost.style.pointerEvents = "";
                }
            });
            applySplitRatio(runtime.state.splitRatio, { persist: true });
            coreOps.scheduleEditorLayout();
            window.removeEventListener("pointermove", doResize);
            window.removeEventListener("pointerup", stopResize, true);
            window.removeEventListener("pointercancel", stopResize, true);
        };
        runtime.dom.editorSplitter.addEventListener("pointerdown", (event) => {
            var _a, _b;
            if (!runtime.state.splitViewEnabled || event.button !== 0) {
                return;
            }
            event.preventDefault();
            (_b = (_a = runtime.dom.editorSplitter) === null || _a === void 0 ? void 0 : _a.setPointerCapture) === null || _b === void 0 ? void 0 : _b.call(_a, event.pointerId);
            startResize();
            doResize(event);
            window.addEventListener("pointermove", doResize);
            window.addEventListener("pointerup", stopResize, true);
            window.addEventListener("pointercancel", stopResize, true);
        });
        window.addEventListener("resize", () => {
            if (!runtime.state.splitViewEnabled) {
                return;
            }
            applySplitRatio(runtime.state.splitRatio);
            coreOps.scheduleEditorLayout();
        });
    };
    const getSplitViewEnabled = () => runtime.state.splitViewEnabled;
    runtime.state.splitRatio = restoreSplitRatio();
    applySplitRatio(runtime.state.splitRatio);
    setupSplitResizer();
    return {
        updateBreadcrumbs,
        updateMiniOutline,
        setActiveGroup,
        setSplitViewEnabled,
        getSplitViewEnabled,
        setEditorGroupEmptyState,
        isAnyGroupComposing,
    };
};
