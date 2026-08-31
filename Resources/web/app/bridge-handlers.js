import { uiText } from "./i18n.js";
const AI_MODE_CONVERSATION_PREFIX = "tex64-ai-mode:";
const isAiModeAgentPayload = (payload) => {
    if (!payload || typeof payload !== "object")
        return false;
    const body = payload;
    const directId = body.conversationId;
    if (typeof directId === "string" &&
        directId.startsWith(AI_MODE_CONVERSATION_PREFIX)) {
        return true;
    }
    const proposal = body.proposal;
    return Boolean(proposal &&
        typeof proposal === "object" &&
        typeof proposal.conversationId === "string" &&
        proposal.conversationId.startsWith(AI_MODE_CONVERSATION_PREFIX));
};
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
        var _a, _b;
        (_a = deps.filePreview) === null || _a === void 0 ? void 0 : _a.setWorkspaceScope(payload);
        (_b = deps.fileExcerpt) === null || _b === void 0 ? void 0 : _b.setWorkspaceScope(payload);
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
        if (isAiModeAgentPayload(payload))
            return;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleStatus(payload.state, payload.message, payload.conversationId);
    };
    bridgeWindow.tex64AgentMessage = (payload) => {
        var _a;
        if (isAiModeAgentPayload(payload))
            return;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleMessage(payload.text, payload.conversationId);
    };
    bridgeWindow.tex64AgentMessageDelta = (payload) => {
        var _a, _b;
        if (isAiModeAgentPayload(payload))
            return;
        (_b = (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleMessageDelta) === null || _b === void 0 ? void 0 : _b.call(_a, payload.text, payload.conversationId);
    };
    bridgeWindow.tex64AgentTool = (payload) => {
        var _a;
        if (isAiModeAgentPayload(payload))
            return;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleTool(payload);
    };
    bridgeWindow.tex64AgentProposal = (payload) => {
        var _a;
        if (isAiModeAgentPayload(payload))
            return;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleProposal(payload.proposal);
    };
    bridgeWindow.tex64AgentApplyResult = (payload) => {
        var _a;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleApplyResult(payload);
    };
    bridgeWindow.tex64AgentError = (payload) => {
        var _a;
        if (isAiModeAgentPayload(payload))
            return;
        (_a = deps.agent) === null || _a === void 0 ? void 0 : _a.handleError(payload.message, payload.conversationId);
    };
    const handleBridgeMessage = (message) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46;
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
            case "env:detectResult":
                (_s = (_r = deps.settings) === null || _r === void 0 ? void 0 : _r.handleEnvDetectResult) === null || _s === void 0 ? void 0 : _s.call(_r, message.payload);
                break;
            case "env:installStart":
                (_u = (_t = deps.settings) === null || _t === void 0 ? void 0 : _t.handleEnvInstallStart) === null || _u === void 0 ? void 0 : _u.call(_t, message.payload);
                break;
            case "env:installResult":
                (_w = (_v = deps.settings) === null || _v === void 0 ? void 0 : _v.handleEnvInstallResult) === null || _w === void 0 ? void 0 : _w.call(_v, message.payload);
                break;
            case "env:installProgress":
                (_y = (_x = deps.settings) === null || _x === void 0 ? void 0 : _x.handleEnvInstallProgress) === null || _y === void 0 ? void 0 : _y.call(_x, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "recentProjects":
                deps.handleRecentProjects((_z = message.payload.projects) !== null && _z !== void 0 ? _z : []);
                break;
            case "agent:settings":
                (_0 = deps.agent) === null || _0 === void 0 ? void 0 : _0.handleSettings(message.payload.settings);
                break;
            case "agent:state":
                // AI mode shares the renderer-wide host bus, but its request-correlated
                // state belongs only to the embedded document workspace. Passing it to
                // Code would replace Code's chat list with the AI document thread.
                if (!isAiModeAgentPayload(message.payload)) {
                    (_2 = (_1 = deps.agent) === null || _1 === void 0 ? void 0 : _1.handleState) === null || _2 === void 0 ? void 0 : _2.call(_1, message.payload);
                }
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
                    snapshot = (_6 = (_4 = (_3 = deps.settings) === null || _3 === void 0 ? void 0 : _3.applySettingsPatch) === null || _4 === void 0 ? void 0 : _4.call(_3, (_5 = payload.settings) !== null && _5 !== void 0 ? _5 : {})) !== null && _6 !== void 0 ? _6 : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_9 = (_8 = (_7 = deps.settings) === null || _7 === void 0 ? void 0 : _7.getSettingsSnapshot) === null || _8 === void 0 ? void 0 : _8.call(_7)) !== null && _9 !== void 0 ? _9 : null;
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
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_10 = deps.agent) === null || _10 === void 0 ? void 0 : _10.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:requestRejected":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_12 = (_11 = deps.agent) === null || _11 === void 0 ? void 0 : _11.handleRequestRejected) === null || _12 === void 0 ? void 0 : _12.call(_11, message.payload);
                break;
            case "agent:message":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_13 = deps.agent) === null || _13 === void 0 ? void 0 : _13.handleMessage((_14 = message.payload.text) !== null && _14 !== void 0 ? _14 : "", message.payload.conversationId);
                break;
            case "agent:messageDelta":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_16 = (_15 = deps.agent) === null || _15 === void 0 ? void 0 : _15.handleMessageDelta) === null || _16 === void 0 ? void 0 : _16.call(_15, (_17 = message.payload.text) !== null && _17 !== void 0 ? _17 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_18 = deps.agent) === null || _18 === void 0 ? void 0 : _18.handleTool(message.payload);
                break;
            case "agent:proposal":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_19 = deps.agent) === null || _19 === void 0 ? void 0 : _19.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_20 = deps.agent) === null || _20 === void 0 ? void 0 : _20.handleApplyResult(message.payload);
                break;
            case "agent:undoResult":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_21 = deps.agent) === null || _21 === void 0 ? void 0 : _21.handleUndoResult(message.payload);
                break;
            case "agent:undoAvailability":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_23 = (_22 = deps.agent) === null || _22 === void 0 ? void 0 : _22.handleUndoAvailability) === null || _23 === void 0 ? void 0 : _23.call(_22, message.payload);
                break;
            case "agent:scratchpad":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_25 = (_24 = deps.agent) === null || _24 === void 0 ? void 0 : _24.handleScratchpad) === null || _25 === void 0 ? void 0 : _25.call(_24, message.payload);
                break;
            case "agent:thought":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_27 = (_26 = deps.agent) === null || _26 === void 0 ? void 0 : _26.handleThought) === null || _27 === void 0 ? void 0 : _27.call(_26, message.payload);
                break;
            case "agent:error":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_28 = deps.agent) === null || _28 === void 0 ? void 0 : _28.handleError((_29 = message.payload.message) !== null && _29 !== void 0 ? _29 : uiText("Axiom error", "Axiom エラー"), message.payload.conversationId);
                break;
            case "api:usage":
                (_30 = deps.api) === null || _30 === void 0 ? void 0 : _30.handleUsage(message.payload);
                break;
            case "platform:auth":
                (_31 = deps.platform) === null || _31 === void 0 ? void 0 : _31.handleAuth(message.payload);
                break;
            case "platform:aiAccess":
                (_32 = deps.platform) === null || _32 === void 0 ? void 0 : _32.handleAiAccess(message.payload);
                break;
            case "platform:usage":
                (_33 = deps.platform) === null || _33 === void 0 ? void 0 : _33.handleUsage(message.payload);
                break;
            case "platform:update":
                (_34 = deps.platform) === null || _34 === void 0 ? void 0 : _34.handleUpdate(message.payload);
                break;
            case "platform:updateStatus":
                (_35 = deps.platform) === null || _35 === void 0 ? void 0 : _35.handleUpdateStatus(message.payload);
                break;
            case "platform:feedback":
                (_36 = deps.platform) === null || _36 === void 0 ? void 0 : _36.handleFeedback(message.payload);
                break;
            case "platform:announcements":
                (_38 = (_37 = deps.platform) === null || _37 === void 0 ? void 0 : _37.handleAnnouncements) === null || _38 === void 0 ? void 0 : _38.call(_37, message.payload);
                break;
            case "billing:checkoutClosed":
                (_39 = deps.billing) === null || _39 === void 0 ? void 0 : _39.handleCheckoutClosed(message.payload);
                break;
            case "app:command":
                (_40 = deps.app) === null || _40 === void 0 ? void 0 : _40.handleCommand((_41 = message.payload.command) !== null && _41 !== void 0 ? _41 : "");
                break;
            case "file:previewResult":
                (_42 = deps.filePreview) === null || _42 === void 0 ? void 0 : _42.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_43 = deps.fileExcerpt) === null || _43 === void 0 ? void 0 : _43.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                {
                    const applyPayload = message.payload;
                    const applyResult = deps.editorSession.applyContentToOpenFile((_44 = applyPayload.path) !== null && _44 !== void 0 ? _44 : "", (_45 = applyPayload.content) !== null && _45 !== void 0 ? _45 : "", {
                        updateSaved: applyPayload.updateSaved === true,
                        ...(typeof applyPayload.expectedContent === "string"
                            ? { expectedContent: applyPayload.expectedContent }
                            : {}),
                        expectedFileMissing: applyPayload.expectedFileMissing === true,
                        fileDeleted: applyPayload.fileDeleted === true,
                        ...(typeof applyPayload.conversationId === "string"
                            ? { conversationId: applyPayload.conversationId }
                            : {}),
                        showAiDiff: applyPayload.showAiDiff === true ||
                            (applyPayload.showAiDiff !== false && applyPayload.source !== "ai-direct-edit"),
                    });
                    if (applyResult.conflict &&
                        typeof applyPayload.conversationId === "string" &&
                        applyPayload.conversationId.trim()) {
                        deps.postToNative({
                            type: "agent:contentConflict",
                            conversationId: applyPayload.conversationId,
                            path: (_46 = applyPayload.path) !== null && _46 !== void 0 ? _46 : "",
                        });
                    }
                }
                break;
            default:
                break;
        }
    };
    if ((_a = bridgeWindow.tex64Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) {
        bridgeWindow.tex64Bridge.onMessage(handleBridgeMessage);
    }
};
