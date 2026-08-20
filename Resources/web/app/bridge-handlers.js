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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56;
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
            case "packages:catalogResult":
                (_s = (_r = deps.packages) === null || _r === void 0 ? void 0 : _r.handleCatalog) === null || _s === void 0 ? void 0 : _s.call(_r, message.payload);
                break;
            case "packages:filesResult":
                (_u = (_t = deps.packages) === null || _t === void 0 ? void 0 : _t.handleFiles) === null || _u === void 0 ? void 0 : _u.call(_t, message.payload);
                break;
            case "packages:ctanResult":
                (_w = (_v = deps.packages) === null || _v === void 0 ? void 0 : _v.handleCtan) === null || _w === void 0 ? void 0 : _w.call(_v, message.payload);
                break;
            case "packages:detailResult":
                (_y = (_x = deps.packages) === null || _x === void 0 ? void 0 : _x.handleDetail) === null || _y === void 0 ? void 0 : _y.call(_x, message.payload);
                break;
            case "packages:opStart":
                (_0 = (_z = deps.packages) === null || _z === void 0 ? void 0 : _z.handleOpStart) === null || _0 === void 0 ? void 0 : _0.call(_z, message.payload);
                break;
            case "packages:opProgress":
                (_2 = (_1 = deps.packages) === null || _1 === void 0 ? void 0 : _1.handleOpProgress) === null || _2 === void 0 ? void 0 : _2.call(_1, message.payload);
                break;
            case "packages:opResult":
                (_4 = (_3 = deps.packages) === null || _3 === void 0 ? void 0 : _3.handleOpResult) === null || _4 === void 0 ? void 0 : _4.call(_3, message.payload);
                break;
            case "env:detectResult":
                (_6 = (_5 = deps.settings) === null || _5 === void 0 ? void 0 : _5.handleEnvDetectResult) === null || _6 === void 0 ? void 0 : _6.call(_5, message.payload);
                break;
            case "env:installStart":
                (_8 = (_7 = deps.settings) === null || _7 === void 0 ? void 0 : _7.handleEnvInstallStart) === null || _8 === void 0 ? void 0 : _8.call(_7, message.payload);
                break;
            case "env:installResult":
                (_10 = (_9 = deps.settings) === null || _9 === void 0 ? void 0 : _9.handleEnvInstallResult) === null || _10 === void 0 ? void 0 : _10.call(_9, message.payload);
                break;
            case "env:installProgress":
                (_12 = (_11 = deps.settings) === null || _11 === void 0 ? void 0 : _11.handleEnvInstallProgress) === null || _12 === void 0 ? void 0 : _12.call(_11, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "recentProjects":
                deps.handleRecentProjects((_13 = message.payload.projects) !== null && _13 !== void 0 ? _13 : []);
                break;
            case "agent:settings":
                (_14 = deps.agent) === null || _14 === void 0 ? void 0 : _14.handleSettings(message.payload.settings);
                break;
            case "agent:state":
                (_16 = (_15 = deps.agent) === null || _15 === void 0 ? void 0 : _15.handleState) === null || _16 === void 0 ? void 0 : _16.call(_15, message.payload);
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
                    snapshot = (_20 = (_18 = (_17 = deps.settings) === null || _17 === void 0 ? void 0 : _17.applySettingsPatch) === null || _18 === void 0 ? void 0 : _18.call(_17, (_19 = payload.settings) !== null && _19 !== void 0 ? _19 : {})) !== null && _20 !== void 0 ? _20 : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_23 = (_22 = (_21 = deps.settings) === null || _21 === void 0 ? void 0 : _21.getSettingsSnapshot) === null || _22 === void 0 ? void 0 : _22.call(_21)) !== null && _23 !== void 0 ? _23 : null;
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
                (_24 = deps.agent) === null || _24 === void 0 ? void 0 : _24.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:message":
                (_25 = deps.agent) === null || _25 === void 0 ? void 0 : _25.handleMessage((_26 = message.payload.text) !== null && _26 !== void 0 ? _26 : "", message.payload.conversationId);
                break;
            case "agent:messageDelta":
                (_28 = (_27 = deps.agent) === null || _27 === void 0 ? void 0 : _27.handleMessageDelta) === null || _28 === void 0 ? void 0 : _28.call(_27, (_29 = message.payload.text) !== null && _29 !== void 0 ? _29 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                (_30 = deps.agent) === null || _30 === void 0 ? void 0 : _30.handleTool(message.payload);
                break;
            case "agent:proposal":
                (_31 = deps.agent) === null || _31 === void 0 ? void 0 : _31.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_32 = deps.agent) === null || _32 === void 0 ? void 0 : _32.handleApplyResult(message.payload);
                break;
            case "agent:undoResult":
                (_33 = deps.agent) === null || _33 === void 0 ? void 0 : _33.handleUndoResult(message.payload);
                break;
            case "agent:undoAvailability":
                (_35 = (_34 = deps.agent) === null || _34 === void 0 ? void 0 : _34.handleUndoAvailability) === null || _35 === void 0 ? void 0 : _35.call(_34, message.payload);
                break;
            case "agent:scratchpad":
                (_37 = (_36 = deps.agent) === null || _36 === void 0 ? void 0 : _36.handleScratchpad) === null || _37 === void 0 ? void 0 : _37.call(_36, message.payload);
                break;
            case "agent:thought":
                (_39 = (_38 = deps.agent) === null || _38 === void 0 ? void 0 : _38.handleThought) === null || _39 === void 0 ? void 0 : _39.call(_38, message.payload);
                break;
            case "agent:error":
                (_40 = deps.agent) === null || _40 === void 0 ? void 0 : _40.handleError((_41 = message.payload.message) !== null && _41 !== void 0 ? _41 : uiText("Axiom error", "Axiom エラー"), message.payload.conversationId);
                break;
            case "api:usage":
                (_42 = deps.api) === null || _42 === void 0 ? void 0 : _42.handleUsage(message.payload);
                break;
            case "platform:auth":
                (_43 = deps.platform) === null || _43 === void 0 ? void 0 : _43.handleAuth(message.payload);
                break;
            case "platform:aiAccess":
                (_44 = deps.platform) === null || _44 === void 0 ? void 0 : _44.handleAiAccess(message.payload);
                break;
            case "platform:usage":
                (_45 = deps.platform) === null || _45 === void 0 ? void 0 : _45.handleUsage(message.payload);
                break;
            case "platform:update":
                (_46 = deps.platform) === null || _46 === void 0 ? void 0 : _46.handleUpdate(message.payload);
                break;
            case "platform:updateStatus":
                (_47 = deps.platform) === null || _47 === void 0 ? void 0 : _47.handleUpdateStatus(message.payload);
                break;
            case "platform:feedback":
                (_48 = deps.platform) === null || _48 === void 0 ? void 0 : _48.handleFeedback(message.payload);
                break;
            case "platform:announcements":
                (_50 = (_49 = deps.platform) === null || _49 === void 0 ? void 0 : _49.handleAnnouncements) === null || _50 === void 0 ? void 0 : _50.call(_49, message.payload);
                break;
            case "app:command":
                (_51 = deps.app) === null || _51 === void 0 ? void 0 : _51.handleCommand((_52 = message.payload.command) !== null && _52 !== void 0 ? _52 : "");
                break;
            case "file:previewResult":
                (_53 = deps.filePreview) === null || _53 === void 0 ? void 0 : _53.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_54 = deps.fileExcerpt) === null || _54 === void 0 ? void 0 : _54.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                deps.editorSession.applyContentToOpenFile((_55 = message.payload.path) !== null && _55 !== void 0 ? _55 : "", (_56 = message.payload.content) !== null && _56 !== void 0 ? _56 : "", {
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
