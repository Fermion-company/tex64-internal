export const initBlockEditSession = (deps) => {
    let mode = "insert";
    let lastDetectedKey = null;
    const buildDetectedKey = (detected) => { var _a; return `${detected.type}:${detected.start}:${detected.end}:${(_a = detected.fullMatch) !== null && _a !== void 0 ? _a : ""}`; };
    const canEdit = () => {
        var _a;
        const group = deps.getActiveGroup();
        const editor = group.editor;
        if (!editor || !((_a = group.currentFilePath) === null || _a === void 0 ? void 0 : _a.endsWith(".tex"))) {
            return false;
        }
        return true;
    };
    const clearDetected = (clearActive) => {
        deps.autoDetect.clearDetectedBlockState({ force: true, clearActive });
        lastDetectedKey = null;
    };
    const syncDetectedAtPosition = (position, options) => {
        var _a, _b;
        if (!canEdit()) {
            return;
        }
        const detected = deps.autoDetect.syncDetectedBlockAtPosition(position, {
            force: (_a = options === null || options === void 0 ? void 0 : options.force) !== null && _a !== void 0 ? _a : false,
            allowTabSwitch: (_b = options === null || options === void 0 ? void 0 : options.allowTabSwitch) !== null && _b !== void 0 ? _b : false,
            ignoreSelection: true,
        });
        if (!detected) {
            clearDetected(true);
            deps.clearMathInput();
            return;
        }
        const nextKey = buildDetectedKey(detected);
        if (nextKey !== lastDetectedKey) {
            deps.autoDetect.activateDetectedBlock();
            lastDetectedKey = nextKey;
        }
    };
    const enterEditMode = () => {
        var _a, _b;
        if (!canEdit()) {
            mode = "insert";
            deps.setBlockModeUi(mode);
            return;
        }
        lastDetectedKey = null;
        const editor = deps.getActiveGroup().editor;
        (_a = editor === null || editor === void 0 ? void 0 : editor.focus) === null || _a === void 0 ? void 0 : _a.call(editor);
        const position = (_b = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (position) {
            syncDetectedAtPosition(position, { force: true, allowTabSwitch: true });
        }
    };
    const leaveEditMode = () => {
        clearDetected(true);
    };
    const setMode = (nextMode) => {
        if (nextMode === "edit" && !canEdit()) {
            mode = "insert";
            deps.setBlockModeUi(mode);
            return;
        }
        if (mode === nextMode) {
            deps.setBlockModeUi(mode);
            return;
        }
        mode = nextMode;
        deps.setBlockModeUi(mode);
        if (mode === "edit") {
            enterEditMode();
        }
        else {
            leaveEditMode();
        }
    };
    const handleCursorPositionChange = (position) => {
        if (mode !== "edit") {
            return;
        }
        syncDetectedAtPosition(position, { force: false, allowTabSwitch: false });
    };
    const refreshDetectedBlock = (allowTabSwitch = false) => {
        var _a;
        if (mode !== "edit") {
            return;
        }
        const editor = deps.getActiveGroup().editor;
        const position = (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor);
        if (!position) {
            return;
        }
        syncDetectedAtPosition(position, { force: true, allowTabSwitch });
    };
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        if (mode !== "edit") {
            return;
        }
        setMode("insert");
    });
    deps.setBlockModeUi(mode);
    return {
        setMode,
        getMode: () => mode,
        exitEditMode: () => setMode("insert"),
        handleCursorPositionChange,
        refreshDetectedBlock,
    };
};
