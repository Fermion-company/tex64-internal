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
    bridgeWindow.tex64UpdateGit = (payload) => {
        deps.git.handleUpdate(payload);
    };
    bridgeWindow.tex64UpdateGitDiff = (payload) => {
        deps.git.handleDiff(payload);
    };
    bridgeWindow.tex64UpdateGitActionResult = (payload) => {
        deps.git.handleActionResult(payload);
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1;
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
            case "updateGit":
                (_f = bridgeWindow.tex64UpdateGit) === null || _f === void 0 ? void 0 : _f.call(bridgeWindow, message.payload);
                break;
            case "updateGitDiff":
                (_g = bridgeWindow.tex64UpdateGitDiff) === null || _g === void 0 ? void 0 : _g.call(bridgeWindow, message.payload);
                break;
            case "gitActionResult":
                (_h = bridgeWindow.tex64UpdateGitActionResult) === null || _h === void 0 ? void 0 : _h.call(bridgeWindow, message.payload);
                break;
            case "openFileResult":
                (_j = bridgeWindow.tex64OpenFileResult) === null || _j === void 0 ? void 0 : _j.call(bridgeWindow, message.payload);
                break;
            case "saveResult":
                (_k = bridgeWindow.tex64SaveResult) === null || _k === void 0 ? void 0 : _k.call(bridgeWindow, message.payload);
                break;
            case "formatResult":
                (_l = bridgeWindow.tex64FormatResult) === null || _l === void 0 ? void 0 : _l.call(bridgeWindow, message.payload);
                break;
            case "buildLog":
                deps.build.handleBuildLog((_o = (_m = message.payload) === null || _m === void 0 ? void 0 : _m.log) !== null && _o !== void 0 ? _o : null);
                break;
            case "synctex:forwardResult":
                deps.build.handleSynctexForwardResult(message.payload);
                break;
            case "renameResult":
                (_p = bridgeWindow.tex64RenameResult) === null || _p === void 0 ? void 0 : _p.call(bridgeWindow, message.payload);
                break;
            case "env:checkResult":
                (_q = deps.settings) === null || _q === void 0 ? void 0 : _q.updateEnvStatus((_r = message.payload.command) !== null && _r !== void 0 ? _r : "", Boolean(message.payload.available));
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "alchemy:settings":
                (_s = deps.alchemy) === null || _s === void 0 ? void 0 : _s.handleSettings(message.payload);
                break;
            case "agent:settings":
                (_t = deps.agent) === null || _t === void 0 ? void 0 : _t.handleSettings(message.payload.settings);
                break;
            case "agent:status":
                (_u = deps.agent) === null || _u === void 0 ? void 0 : _u.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:message":
                (_v = deps.agent) === null || _v === void 0 ? void 0 : _v.handleMessage((_w = message.payload.text) !== null && _w !== void 0 ? _w : "", message.payload.conversationId);
                break;
            case "agent:tool":
                (_x = deps.agent) === null || _x === void 0 ? void 0 : _x.handleTool(message.payload);
                break;
            case "agent:proposal":
                (_y = deps.agent) === null || _y === void 0 ? void 0 : _y.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_z = deps.agent) === null || _z === void 0 ? void 0 : _z.handleApplyResult(message.payload);
                break;
            case "agent:error":
                (_0 = deps.agent) === null || _0 === void 0 ? void 0 : _0.handleError((_1 = message.payload.message) !== null && _1 !== void 0 ? _1 : "AIエラー", message.payload.conversationId);
                break;
            default:
                break;
        }
    };
    if ((_a = bridgeWindow.tex64Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) {
        bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
    }
};
