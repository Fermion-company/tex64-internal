export const initBridgeHandlers = (deps) => {
    var _a;
    const { bridgeWindow } = deps;
    bridgeWindow.tex64SetBuildState = (payload) => {
        deps.build.setBuildState(payload.state, payload.message);
    };
    bridgeWindow.tex64UpdateIssues = (payload) => {
        var _a, _b;
        const status = (_a = payload.status) !== null && _a !== void 0 ? _a : (payload.count > 0 ? "error" : "success");
        deps.updateIssues(payload.count, payload.summary, status, (_b = payload.issues) !== null && _b !== void 0 ? _b : []);
    };
    bridgeWindow.tex64UpdateWorkspace = (payload) => {
        deps.handleWorkspaceUpdate(payload);
    };
    bridgeWindow.tex64UpdateIndex = (payload) => {
        deps.handleIndexUpdate(payload);
    };
    bridgeWindow.tex64UpdateSearch = (payload) => {
        deps.search.handleSearchUpdate(payload);
    };
    bridgeWindow.tex64OpenFileResult = (payload) => {
        deps.editorSession.handleOpenFileResult(payload);
    };
    bridgeWindow.tex64SaveResult = (payload) => {
        deps.editorSession.handleSaveResult(payload);
    };
    bridgeWindow.tex64FormatResult = (payload) => {
        deps.build.handleFormatResult(payload);
    };
    bridgeWindow.tex64SynctexForwardResult = (payload) => {
        deps.build.handleSynctexForwardResult(payload);
    };
    bridgeWindow.tex64SynctexReverseResult = (payload) => {
        deps.build.handleSynctexReverseResult(payload);
    };
    bridgeWindow.tex64RenameResult = (payload) => {
        deps.editorSession.handleRenameResult(payload);
    };
    bridgeWindow.tex64AgentSettings = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleSettings(payload.settings);
    };
    bridgeWindow.tex64AgentStatus = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleStatus(payload.state, payload.message, payload.conversationId);
    };
    bridgeWindow.tex64AgentMessage = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleMessage(payload.text, payload.conversationId);
    };
    bridgeWindow.tex64AgentMessageDelta = (payload) => {
        var _a, _b;
        (_b = (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleMessageDelta) === null || _b === void 0 ? void 0 : _b.call(_a, payload.text, payload.conversationId);
    };
    bridgeWindow.tex64AgentTool = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleTool(payload);
    };
    bridgeWindow.tex64AgentProposal = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleProposal(payload.proposal);
    };
    bridgeWindow.tex64AgentApplyResult = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleApplyResult(payload);
    };
    bridgeWindow.tex64AgentError = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleError(payload.message, payload.conversationId);
    };
    const handleBridgeMessage = (message) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15;
        if (!(message === null || message === void 0 ? void 0 : message.type)) {
            return;
        }
        switch (message.type) {
            case "setBuildState":
                (_a = bridgeWindow.tex64SetBuildState) === null || _a === void 0 ? void 0 : _a.call(bridgeWindow, message.payload);
                break;
            case "updateIssues":
                (_b = bridgeWindow.tex64UpdateIssues) === null || _b === void 0 ? void 0 : _b.call(bridgeWindow, message.payload);
                break;
            case "updateWorkspace":
                (_c = bridgeWindow.tex64UpdateWorkspace) === null || _c === void 0 ? void 0 : _c.call(bridgeWindow, message.payload);
                break;
            case "updateIndex":
                (_d = bridgeWindow.tex64UpdateIndex) === null || _d === void 0 ? void 0 : _d.call(bridgeWindow, message.payload);
                break;
            case "updateSearch":
                (_e = bridgeWindow.tex64UpdateSearch) === null || _e === void 0 ? void 0 : _e.call(bridgeWindow, message.payload);
                break;
            case "search:renameResult":
                (_g = (_f = deps.search).handleRenameResult) === null || _g === void 0 ? void 0 : _g.call(_f, message.payload);
                break;
            case "openFileResult":
                (_h = bridgeWindow.tex64OpenFileResult) === null || _h === void 0 ? void 0 : _h.call(bridgeWindow, message.payload);
                break;
            case "saveResult":
                (_j = bridgeWindow.tex64SaveResult) === null || _j === void 0 ? void 0 : _j.call(bridgeWindow, message.payload);
                break;
            case "formatResult":
                (_k = bridgeWindow.tex64FormatResult) === null || _k === void 0 ? void 0 : _k.call(bridgeWindow, message.payload);
                break;
            case "buildLog":
                deps.build.handleBuildLog((_m = (_l = message.payload) === null || _l === void 0 ? void 0 : _l.log) !== null && _m !== void 0 ? _m : null);
                break;
            case "synctex:forwardResult":
                deps.build.handleSynctexForwardResult(message.payload);
                break;
            case "synctex:reverseResult":
                deps.build.handleSynctexReverseResult(message.payload);
                break;
            case "renameResult":
                (_o = bridgeWindow.tex64RenameResult) === null || _o === void 0 ? void 0 : _o.call(bridgeWindow, message.payload);
                break;
            case "env:checkResult":
                (_p = deps.settings) === null || _p === void 0 ? void 0 : _p.updateEnvStatus((_q = message.payload.command) !== null && _q !== void 0 ? _q : "", Boolean(message.payload.available));
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "agent:settings":
                (_r = deps.agent) === null || _r === void 0 ? void 0 : _r.handleSettings(message.payload.settings);
                break;
            case "settings:request": {
                const payload = message.payload;
                const requestId = payload === null || payload === void 0 ? void 0 : payload.requestId;
                if (!requestId) {
                    break;
                }
                let snapshot = null;
                let ok = false;
                if ((payload === null || payload === void 0 ? void 0 : payload.action) === "set") {
                    snapshot = (_v = (_t = (_s = deps.settings) === null || _s === void 0 ? void 0 : _s.applySettingsPatch) === null || _t === void 0 ? void 0 : _t.call(_s, (_u = payload.settings) !== null && _u !== void 0 ? _u : {})) !== null && _v !== void 0 ? _v : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_y = (_x = (_w = deps.settings) === null || _w === void 0 ? void 0 : _w.getSettingsSnapshot) === null || _x === void 0 ? void 0 : _x.call(_w)) !== null && _y !== void 0 ? _y : null;
                    ok = Boolean(snapshot);
                }
                const keys = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.keys) ? payload.keys : [];
                let settings = snapshot;
                if (snapshot && keys.length > 0) {
                    const filtered = {};
                    const snapshotRecord = snapshot;
                    keys.forEach((key) => {
                        if (key in snapshotRecord) {
                            filtered[key] = snapshotRecord[key];
                        }
                    });
                    settings = filtered;
                }
                deps.postToNative({
                    type: "settings:response",
                    requestId,
                    ok,
                    settings,
                    error: ok ? undefined : "設定が取得できませんでした。",
                }, true);
                break;
            }
            case "agent:status":
                (_z = deps.agent) === null || _z === void 0 ? void 0 : _z.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:message":
                (_0 = deps.agent) === null || _0 === void 0 ? void 0 : _0.handleMessage((_1 = message.payload.text) !== null && _1 !== void 0 ? _1 : "", message.payload.conversationId);
                break;
            case "agent:messageDelta":
                (_3 = (_2 = deps.agent) === null || _2 === void 0 ? void 0 : _2.handleMessageDelta) === null || _3 === void 0 ? void 0 : _3.call(_2, (_4 = message.payload.text) !== null && _4 !== void 0 ? _4 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                (_5 = deps.agent) === null || _5 === void 0 ? void 0 : _5.handleTool(message.payload);
                break;
            case "agent:proposal":
                (_6 = deps.agent) === null || _6 === void 0 ? void 0 : _6.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_7 = deps.agent) === null || _7 === void 0 ? void 0 : _7.handleApplyResult(message.payload);
                break;
            case "agent:error":
                (_8 = deps.agent) === null || _8 === void 0 ? void 0 : _8.handleError((_9 = message.payload.message) !== null && _9 !== void 0 ? _9 : "AIエラー", message.payload.conversationId);
                break;
            case "api:completionResult":
                (_10 = deps.api) === null || _10 === void 0 ? void 0 : _10.handleCompletionResult(message.payload);
                break;
            case "api:usage":
                (_11 = deps.api) === null || _11 === void 0 ? void 0 : _11.handleUsage(message.payload);
                break;
            case "file:previewResult":
                (_12 = deps.filePreview) === null || _12 === void 0 ? void 0 : _12.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_13 = deps.fileExcerpt) === null || _13 === void 0 ? void 0 : _13.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                deps.editorSession.applyContentToOpenFile((_14 = message.payload.path) !== null && _14 !== void 0 ? _14 : "", (_15 = message.payload.content) !== null && _15 !== void 0 ? _15 : "", message.payload.updateSaved !== false
                    ? { updateSaved: true }
                    : undefined);
                break;
            default:
                break;
        }
    };
    if ((_a = bridgeWindow.tex64Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) {
        bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
    }
};
