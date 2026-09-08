import { updatePdfSourceState } from "./viewer.js";
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
    let externalWorkspaceRoot = null;
    let externalWorkspaceGeneration;
    bridgeWindow.tex64SetBuildState = (payload) => {
        var _a, _b;
        updatePdfSourceState(payload.pdfSourceState);
        if (payload.targetFile && !payload.requestId)
            (_b = (_a = deps.build).setBuildTarget) === null || _b === void 0 ? void 0 : _b.call(_a, payload.targetFile);
        deps.build.setBuildState(payload.state, payload.message);
    };
    bridgeWindow.tex64UpdateIssues = (payload) => {
        var _a, _b;
        const status = (_a = payload.status) !== null && _a !== void 0 ? _a : (payload.count > 0 ? "error" : "success");
        deps.updateIssues(payload.count, payload.summary, status, (_b = payload.issues) !== null && _b !== void 0 ? _b : []);
    };
    bridgeWindow.tex64UpdateWorkspace = (payload) => {
        var _a, _b;
        updatePdfSourceState(payload.pdfSourceState, true);
        externalWorkspaceRoot = payload.rootPath;
        externalWorkspaceGeneration = payload.workspaceGeneration;
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56, _57, _58, _59, _60, _61, _62, _63, _64;
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
            case "file:externalChange": {
                const change = message.payload;
                if (change.root === externalWorkspaceRoot && change.workspaceGeneration === externalWorkspaceGeneration) {
                    deps.editorSession.handleExternalFileChange(change);
                }
                break;
            }
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
            case "synctex:reverseResult": {
                const reverse = message.payload;
                if (typeof (reverse === null || reverse === void 0 ? void 0 : reverse.requestId) === "string" && reverse.requestId.startsWith("ask-axiom:")) {
                    (_p = (_o = deps.agent) === null || _o === void 0 ? void 0 : _o.handlePdfReverseResult) === null || _p === void 0 ? void 0 : _p.call(_o, message.payload);
                    break;
                }
                deps.build.handleSynctexReverseResult(message.payload);
                break;
            }
            case "pdf:askAxiom":
                (_r = (_q = deps.agent) === null || _q === void 0 ? void 0 : _q.askFromPdf) === null || _r === void 0 ? void 0 : _r.call(_q, message.payload);
                break;
            case "renameResult":
                (_s = bridgeWindow.tex64RenameResult) === null || _s === void 0 ? void 0 : _s.call(bridgeWindow, message.payload);
                break;
            case "env:checkResult":
                (_t = deps.settings) === null || _t === void 0 ? void 0 : _t.updateEnvStatus((_u = message.payload.command) !== null && _u !== void 0 ? _u : "", Boolean(message.payload.available));
                break;
            case "env:detectResult":
                (_w = (_v = deps.settings) === null || _v === void 0 ? void 0 : _v.handleEnvDetectResult) === null || _w === void 0 ? void 0 : _w.call(_v, message.payload);
                break;
            case "env:installStart":
                (_y = (_x = deps.settings) === null || _x === void 0 ? void 0 : _x.handleEnvInstallStart) === null || _y === void 0 ? void 0 : _y.call(_x, message.payload);
                break;
            case "env:installResult":
                (_0 = (_z = deps.settings) === null || _z === void 0 ? void 0 : _z.handleEnvInstallResult) === null || _0 === void 0 ? void 0 : _0.call(_z, message.payload);
                break;
            case "env:installProgress":
                (_2 = (_1 = deps.settings) === null || _1 === void 0 ? void 0 : _1.handleEnvInstallProgress) === null || _2 === void 0 ? void 0 : _2.call(_1, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "recentProjects":
                deps.handleRecentProjects((_3 = message.payload.projects) !== null && _3 !== void 0 ? _3 : []);
                break;
            case "agent:settings":
                (_4 = deps.agent) === null || _4 === void 0 ? void 0 : _4.handleSettings(message.payload.settings);
                break;
            case "agent:state":
                // AI mode shares the renderer-wide host bus, but its request-correlated
                // state belongs only to the embedded document workspace. Passing it to
                // Code would replace Code's chat list with the AI document thread.
                if (!isAiModeAgentPayload(message.payload)) {
                    (_6 = (_5 = deps.agent) === null || _5 === void 0 ? void 0 : _5.handleState) === null || _6 === void 0 ? void 0 : _6.call(_5, message.payload);
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
                    snapshot = (_10 = (_8 = (_7 = deps.settings) === null || _7 === void 0 ? void 0 : _7.applySettingsPatch) === null || _8 === void 0 ? void 0 : _8.call(_7, (_9 = payload.settings) !== null && _9 !== void 0 ? _9 : {})) !== null && _10 !== void 0 ? _10 : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_13 = (_12 = (_11 = deps.settings) === null || _11 === void 0 ? void 0 : _11.getSettingsSnapshot) === null || _12 === void 0 ? void 0 : _12.call(_11)) !== null && _13 !== void 0 ? _13 : null;
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
                (_14 = deps.agent) === null || _14 === void 0 ? void 0 : _14.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:requestRejected":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_16 = (_15 = deps.agent) === null || _15 === void 0 ? void 0 : _15.handleRequestRejected) === null || _16 === void 0 ? void 0 : _16.call(_15, message.payload);
                break;
            case "agent:message": {
                if (isAiModeAgentPayload(message.payload))
                    break;
                const reply = message.payload;
                (_17 = deps.agent) === null || _17 === void 0 ? void 0 : _17.handleMessage((_18 = reply.text) !== null && _18 !== void 0 ? _18 : "", reply.conversationId, {
                    proposals: Array.isArray(reply.proposals) ? reply.proposals : undefined,
                    question: reply.question && typeof reply.question === "object" ? reply.question : undefined,
                    plan: reply.plan && typeof reply.plan === "object" ? reply.plan : undefined,
                });
                break;
            }
            case "agent:messageReset":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_20 = (_19 = deps.agent) === null || _19 === void 0 ? void 0 : _19.handleMessageReset) === null || _20 === void 0 ? void 0 : _20.call(_19, message.payload);
                break;
            case "agent:title":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_22 = (_21 = deps.agent) === null || _21 === void 0 ? void 0 : _21.handleTitle) === null || _22 === void 0 ? void 0 : _22.call(_21, message.payload);
                break;
            case "agent:feedbackResult":
                (_24 = (_23 = deps.agent) === null || _23 === void 0 ? void 0 : _23.handleFeedbackResult) === null || _24 === void 0 ? void 0 : _24.call(_23, message.payload);
                break;
            case "agent:branchResult":
                (_26 = (_25 = deps.agent) === null || _25 === void 0 ? void 0 : _25.handleBranchResult) === null || _26 === void 0 ? void 0 : _26.call(_25, message.payload);
                break;
            case "agent:proposalScope":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_28 = (_27 = deps.agent) === null || _27 === void 0 ? void 0 : _27.handleProposalScope) === null || _28 === void 0 ? void 0 : _28.call(_27, message.payload);
                break;
            case "agent:transcribeResult":
                (_30 = (_29 = deps.agent) === null || _29 === void 0 ? void 0 : _29.handleTranscribeResult) === null || _30 === void 0 ? void 0 : _30.call(_29, message.payload);
                break;
            case "agent:documentMap":
                (_32 = (_31 = deps.agent) === null || _31 === void 0 ? void 0 : _31.handleDocumentMap) === null || _32 === void 0 ? void 0 : _32.call(_31, message.payload);
                break;
            case "agent:messageDelta":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_34 = (_33 = deps.agent) === null || _33 === void 0 ? void 0 : _33.handleMessageDelta) === null || _34 === void 0 ? void 0 : _34.call(_33, (_35 = message.payload.text) !== null && _35 !== void 0 ? _35 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_36 = deps.agent) === null || _36 === void 0 ? void 0 : _36.handleTool(message.payload);
                break;
            case "agent:proposal":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_37 = deps.agent) === null || _37 === void 0 ? void 0 : _37.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_38 = deps.agent) === null || _38 === void 0 ? void 0 : _38.handleApplyResult(message.payload);
                break;
            case "agent:undoResult":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_39 = deps.agent) === null || _39 === void 0 ? void 0 : _39.handleUndoResult(message.payload);
                break;
            case "agent:undoAvailability":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_41 = (_40 = deps.agent) === null || _40 === void 0 ? void 0 : _40.handleUndoAvailability) === null || _41 === void 0 ? void 0 : _41.call(_40, message.payload);
                break;
            case "agent:scratchpad":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_43 = (_42 = deps.agent) === null || _42 === void 0 ? void 0 : _42.handleScratchpad) === null || _43 === void 0 ? void 0 : _43.call(_42, message.payload);
                break;
            case "agent:thought":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_45 = (_44 = deps.agent) === null || _44 === void 0 ? void 0 : _44.handleThought) === null || _45 === void 0 ? void 0 : _45.call(_44, message.payload);
                break;
            case "agent:error":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_46 = deps.agent) === null || _46 === void 0 ? void 0 : _46.handleError((_47 = message.payload.message) !== null && _47 !== void 0 ? _47 : uiText("Axiom error", "Axiom エラー"), message.payload.conversationId);
                break;
            case "api:usage":
                (_48 = deps.api) === null || _48 === void 0 ? void 0 : _48.handleUsage(message.payload);
                break;
            case "platform:auth":
                (_49 = deps.platform) === null || _49 === void 0 ? void 0 : _49.handleAuth(message.payload);
                break;
            case "platform:aiAccess":
                (_50 = deps.platform) === null || _50 === void 0 ? void 0 : _50.handleAiAccess(message.payload);
                break;
            case "platform:usage":
                (_51 = deps.platform) === null || _51 === void 0 ? void 0 : _51.handleUsage(message.payload);
                break;
            case "platform:update":
                (_52 = deps.platform) === null || _52 === void 0 ? void 0 : _52.handleUpdate(message.payload);
                break;
            case "platform:updateStatus":
                (_53 = deps.platform) === null || _53 === void 0 ? void 0 : _53.handleUpdateStatus(message.payload);
                break;
            case "platform:feedback":
                (_54 = deps.platform) === null || _54 === void 0 ? void 0 : _54.handleFeedback(message.payload);
                break;
            case "platform:announcements":
                (_56 = (_55 = deps.platform) === null || _55 === void 0 ? void 0 : _55.handleAnnouncements) === null || _56 === void 0 ? void 0 : _56.call(_55, message.payload);
                break;
            case "billing:checkoutClosed":
                (_57 = deps.billing) === null || _57 === void 0 ? void 0 : _57.handleCheckoutClosed(message.payload);
                break;
            case "app:command":
                (_58 = deps.app) === null || _58 === void 0 ? void 0 : _58.handleCommand((_59 = message.payload.command) !== null && _59 !== void 0 ? _59 : "");
                break;
            case "file:previewResult":
                (_60 = deps.filePreview) === null || _60 === void 0 ? void 0 : _60.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_61 = deps.fileExcerpt) === null || _61 === void 0 ? void 0 : _61.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                {
                    const applyPayload = message.payload;
                    const applyResult = deps.editorSession.applyContentToOpenFile((_62 = applyPayload.path) !== null && _62 !== void 0 ? _62 : "", (_63 = applyPayload.content) !== null && _63 !== void 0 ? _63 : "", {
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
                            path: (_64 = applyPayload.path) !== null && _64 !== void 0 ? _64 : "",
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
