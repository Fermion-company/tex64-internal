import { uiText } from "./i18n.js";
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30;
        var _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42;
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
                deps.build.handleBuildLog((_31 = (_l = message.payload) === null || _l === void 0 ? void 0 : _l.log) !== null && _31 !== void 0 ? _31 : null);
                break;
            case "synctex:forwardResult":
                deps.build.handleSynctexForwardResult(message.payload);
                break;
            case "synctex:reverseResult":
                deps.build.handleSynctexReverseResult(message.payload);
                break;
            case "renameResult":
                (_m = bridgeWindow.tex64RenameResult) === null || _m === void 0 ? void 0 : _m.call(bridgeWindow, message.payload);
                break;
            case "env:checkResult":
                (_o = deps.settings) === null || _o === void 0 ? void 0 : _o.updateEnvStatus((_32 = message.payload.command) !== null && _32 !== void 0 ? _32 : "", Boolean(message.payload.available));
                break;
            case "env:detectResult":
                (_q = (_p = deps.settings) === null || _p === void 0 ? void 0 : _p.handleEnvDetectResult) === null || _q === void 0 ? void 0 : _q.call(_p, message.payload);
                break;
            case "env:installStart":
                (_s = (_r = deps.settings) === null || _r === void 0 ? void 0 : _r.handleEnvInstallStart) === null || _s === void 0 ? void 0 : _s.call(_r, message.payload);
                break;
            case "env:installResult":
                (_u = (_t = deps.settings) === null || _t === void 0 ? void 0 : _t.handleEnvInstallResult) === null || _u === void 0 ? void 0 : _u.call(_t, message.payload);
                break;
            case "env:installProgress":
                (_w = (_v = deps.settings) === null || _v === void 0 ? void 0 : _v.handleEnvInstallProgress) === null || _w === void 0 ? void 0 : _w.call(_v, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "recentProjects":
                deps.handleRecentProjects((_33 = message.payload.projects) !== null && _33 !== void 0 ? _33 : []);
                break;
            case "agent:settings":
                (_x = deps.agent) === null || _x === void 0 ? void 0 : _x.handleSettings(message.payload.settings);
                break;
            case "agent:state":
                (_z = (_y = deps.agent) === null || _y === void 0 ? void 0 : _y.handleState) === null || _z === void 0 ? void 0 : _z.call(_y, message.payload);
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
                    snapshot = (_35 = (_1 = (_0 = deps.settings) === null || _0 === void 0 ? void 0 : _0.applySettingsPatch) === null || _1 === void 0 ? void 0 : _1.call(_0, (_34 = payload.settings) !== null && _34 !== void 0 ? _34 : {})) !== null && _35 !== void 0 ? _35 : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_36 = (_3 = (_2 = deps.settings) === null || _2 === void 0 ? void 0 : _2.getSettingsSnapshot) === null || _3 === void 0 ? void 0 : _3.call(_2)) !== null && _36 !== void 0 ? _36 : null;
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
                    error: ok ? undefined : uiText("Settings could not be retrieved.", "設定が取得できませんでした。"),
                }, true);
                break;
            }
            case "agent:status":
                (_4 = deps.agent) === null || _4 === void 0 ? void 0 : _4.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:message":
                (_5 = deps.agent) === null || _5 === void 0 ? void 0 : _5.handleMessage((_37 = message.payload.text) !== null && _37 !== void 0 ? _37 : "", message.payload.conversationId);
                break;
            case "agent:messageDelta":
                (_7 = (_6 = deps.agent) === null || _6 === void 0 ? void 0 : _6.handleMessageDelta) === null || _7 === void 0 ? void 0 : _7.call(_6, (_38 = message.payload.text) !== null && _38 !== void 0 ? _38 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                (_8 = deps.agent) === null || _8 === void 0 ? void 0 : _8.handleTool(message.payload);
                break;
            case "agent:proposal":
                (_9 = deps.agent) === null || _9 === void 0 ? void 0 : _9.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_10 = deps.agent) === null || _10 === void 0 ? void 0 : _10.handleApplyResult(message.payload);
                break;
            case "agent:undoResult":
                (_11 = deps.agent) === null || _11 === void 0 ? void 0 : _11.handleUndoResult(message.payload);
                break;
            case "agent:undoAvailability":
                (_13 = (_12 = deps.agent) === null || _12 === void 0 ? void 0 : _12.handleUndoAvailability) === null || _13 === void 0 ? void 0 : _13.call(_12, message.payload);
                break;
            case "agent:scratchpad":
                (_15 = (_14 = deps.agent) === null || _14 === void 0 ? void 0 : _14.handleScratchpad) === null || _15 === void 0 ? void 0 : _15.call(_14, message.payload);
                break;
            case "agent:thought":
                (_17 = (_16 = deps.agent) === null || _16 === void 0 ? void 0 : _16.handleThought) === null || _17 === void 0 ? void 0 : _17.call(_16, message.payload);
                break;
            case "agent:error":
                (_18 = deps.agent) === null || _18 === void 0 ? void 0 : _18.handleError((_39 = message.payload.message) !== null && _39 !== void 0 ? _39 : uiText("Axiom error", "Axiom エラー"), message.payload.conversationId);
                break;
            case "api:usage":
                (_19 = deps.api) === null || _19 === void 0 ? void 0 : _19.handleUsage(message.payload);
                break;
            case "platform:auth":
                (_20 = deps.platform) === null || _20 === void 0 ? void 0 : _20.handleAuth(message.payload);
                break;
            case "platform:aiAccess":
                (_21 = deps.platform) === null || _21 === void 0 ? void 0 : _21.handleAiAccess(message.payload);
                break;
            case "platform:usage":
                (_22 = deps.platform) === null || _22 === void 0 ? void 0 : _22.handleUsage(message.payload);
                break;
            case "platform:update":
                (_23 = deps.platform) === null || _23 === void 0 ? void 0 : _23.handleUpdate(message.payload);
                break;
            case "platform:updateStatus":
                (_24 = deps.platform) === null || _24 === void 0 ? void 0 : _24.handleUpdateStatus(message.payload);
                break;
            case "platform:feedback":
                (_25 = deps.platform) === null || _25 === void 0 ? void 0 : _25.handleFeedback(message.payload);
                break;
            case "platform:announcements":
                (_27 = (_26 = deps.platform) === null || _26 === void 0 ? void 0 : _26.handleAnnouncements) === null || _27 === void 0 ? void 0 : _27.call(_26, message.payload);
                break;
            case "app:command":
                (_28 = deps.app) === null || _28 === void 0 ? void 0 : _28.handleCommand((_40 = message.payload.command) !== null && _40 !== void 0 ? _40 : "");
                break;
            case "file:previewResult":
                (_29 = deps.filePreview) === null || _29 === void 0 ? void 0 : _29.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_30 = deps.fileExcerpt) === null || _30 === void 0 ? void 0 : _30.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                deps.editorSession.applyContentToOpenFile((_41 = message.payload.path) !== null && _41 !== void 0 ? _41 : "", (_42 = message.payload.content) !== null && _42 !== void 0 ? _42 : "", {
                    updateSaved: message.payload.updateSaved === true,
                    showAiDiff: true,
                });
                break;
            default:
                break;
        }
    };
    if ((_a = bridgeWindow.tex64Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) {
        bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
    }
};
