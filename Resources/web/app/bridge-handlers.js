import { updatePdfSourceState } from "./viewer.js";
import { uiText } from "./i18n.js";
import { parseLiveAnchorRequest, parseLiveEditRequest, parseLiveSourceRequest } from "./viewer.js";
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
    let buildSourceWarning = null;
    bridgeWindow.tex64SetBuildState = (payload) => {
        var _a, _b, _c, _d, _e, _f;
        updatePdfSourceState(payload.pdfSourceState);
        if (payload.state === "building")
            buildSourceWarning = null;
        const detail = {
            state: payload.state,
            message: payload.message,
            pdfPath: payload.pdfPath,
            targetFile: payload.targetFile,
            workspaceRoot: (_a = payload.workspaceRoot) !== null && _a !== void 0 ? _a : (_b = payload.pdfSourceState) === null || _b === void 0 ? void 0 : _b.rootPath,
            previousPdf: payload.previousPdf === true,
            sourceChanged: false,
        };
        (_d = (_c = deps.build).handleBuildPreviewState) === null || _d === void 0 ? void 0 : _d.call(_c, detail);
        window.dispatchEvent(new CustomEvent("tex64:build-state", { detail }));
        if (detail.sourceChanged)
            buildSourceWarning =
                "Sources changed during the build. The saved PDF is from an earlier version; build again to update it.";
        if (payload.state === "success" && payload.targetFile && !payload.requestId)
            (_f = (_e = deps.build).setBuildTarget) === null || _f === void 0 ? void 0 : _f.call(_e, payload.targetFile);
        deps.build.setBuildState(payload.state, payload.message);
    };
    bridgeWindow.tex64UpdateIssues = (payload) => {
        var _a, _b, _c;
        const status = (_a = payload.status) !== null && _a !== void 0 ? _a : (payload.count > 0 ? "error" : "success");
        if (buildSourceWarning && status !== "error") {
            const issues = [...((_b = payload.issues) !== null && _b !== void 0 ? _b : []), { severity: "warning", message: buildSourceWarning, line: null }];
            deps.updateIssues(Math.max(payload.count, issues.length), buildSourceWarning, "info", issues);
            return;
        }
        deps.updateIssues(payload.count, payload.summary, status, (_c = payload.issues) !== null && _c !== void 0 ? _c : []);
    };
    bridgeWindow.tex64UpdateWorkspace = (payload) => {
        var _a, _b;
        if (payload.rootPath !== externalWorkspaceRoot || payload.workspaceGeneration !== externalWorkspaceGeneration) {
            buildSourceWarning = null;
        }
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56, _57, _58, _59, _60, _61, _62, _63, _64, _65, _66, _67, _68, _69, _70, _71, _72;
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
            case "build:chooseTarget":
                (_p = (_o = deps.build).chooseBuildTarget) === null || _p === void 0 ? void 0 : _p.call(_o, message.payload);
                break;
            case "synctex:forwardResult":
                deps.build.handleSynctexForwardResult(message.payload);
                break;
            case "synctex:reverseResult": {
                const reverse = message.payload;
                if (typeof (reverse === null || reverse === void 0 ? void 0 : reverse.requestId) === "string" && reverse.requestId.startsWith("ask-axiom:")) {
                    (_r = (_q = deps.agent) === null || _q === void 0 ? void 0 : _q.handlePdfReverseResult) === null || _r === void 0 ? void 0 : _r.call(_q, message.payload);
                    break;
                }
                deps.build.handleSynctexReverseResult(message.payload);
                break;
            }
            case "pdf:askAxiom":
                (_t = (_s = deps.agent) === null || _s === void 0 ? void 0 : _s.askFromPdf) === null || _t === void 0 ? void 0 : _t.call(_s, message.payload);
                break;
            case "pdf:emptyLiveError":
                (_u = deps.onEmptyLiveError) === null || _u === void 0 ? void 0 : _u.call(deps, message.payload);
                break;
            case "pdf:liveIssue":
                (_v = deps.onPdfWindowIssue) === null || _v === void 0 ? void 0 : _v.call(deps, typeof message.payload === "string" ? message.payload : null);
                break;
            case "pdf:liveSource":
                {
                    const request = parseLiveSourceRequest(message.payload);
                    if (request)
                        (_w = deps.livePreview) === null || _w === void 0 ? void 0 : _w.source(request);
                }
                break;
            case "pdf:liveEdit":
                {
                    const request = parseLiveEditRequest(message.payload);
                    if (request)
                        (_x = deps.livePreview) === null || _x === void 0 ? void 0 : _x.edit(request);
                }
                break;
            case "pdf:liveEditAnchor": {
                const envelope = message.payload;
                const request = parseLiveAnchorRequest(envelope === null || envelope === void 0 ? void 0 : envelope.request);
                if (!(envelope === null || envelope === void 0 ? void 0 : envelope.windowRequestId) || !request)
                    break;
                const reply = (result) => {
                    var _a, _b;
                    void ((_b = (_a = bridgeWindow.tex64Tdom) === null || _a === void 0 ? void 0 : _a.replyWindowAnchor) === null || _b === void 0 ? void 0 : _b.call(_a, {
                        windowRequestId: envelope.windowRequestId,
                        result,
                    }));
                };
                if (deps.livePreview)
                    deps.livePreview.anchor(request, reply);
                else
                    reply({
                        sessionId: request.sessionId,
                        requestId: request.requestId,
                        activationId: request.activationId,
                        documentEpoch: request.documentEpoch,
                        file: request.file,
                        sourceRev: request.sourceRev,
                        ok: false,
                    });
                break;
            }
            case "renameResult":
                (_y = bridgeWindow.tex64RenameResult) === null || _y === void 0 ? void 0 : _y.call(bridgeWindow, message.payload);
                break;
            case "env:checkResult":
                (_z = deps.settings) === null || _z === void 0 ? void 0 : _z.updateEnvStatus((_0 = message.payload.command) !== null && _0 !== void 0 ? _0 : "", Boolean(message.payload.available));
                break;
            case "env:detectResult":
                (_2 = (_1 = deps.settings) === null || _1 === void 0 ? void 0 : _1.handleEnvDetectResult) === null || _2 === void 0 ? void 0 : _2.call(_1, message.payload);
                break;
            case "env:installStart":
                (_4 = (_3 = deps.settings) === null || _3 === void 0 ? void 0 : _3.handleEnvInstallStart) === null || _4 === void 0 ? void 0 : _4.call(_3, message.payload);
                break;
            case "env:installResult":
                (_6 = (_5 = deps.settings) === null || _5 === void 0 ? void 0 : _5.handleEnvInstallResult) === null || _6 === void 0 ? void 0 : _6.call(_5, message.payload);
                break;
            case "env:installProgress":
                (_8 = (_7 = deps.settings) === null || _7 === void 0 ? void 0 : _7.handleEnvInstallProgress) === null || _8 === void 0 ? void 0 : _8.call(_7, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            case "recentProjects":
                deps.handleRecentProjects((_9 = message.payload.projects) !== null && _9 !== void 0 ? _9 : []);
                break;
            case "agent:settings":
                (_10 = deps.agent) === null || _10 === void 0 ? void 0 : _10.handleSettings(message.payload.settings);
                break;
            case "agent:state":
                // AI mode shares the renderer-wide host bus, but its request-correlated
                // state belongs only to the embedded document workspace. Passing it to
                // Code would replace Code's chat list with the AI document thread.
                if (!isAiModeAgentPayload(message.payload)) {
                    (_12 = (_11 = deps.agent) === null || _11 === void 0 ? void 0 : _11.handleState) === null || _12 === void 0 ? void 0 : _12.call(_11, message.payload);
                }
                break;
            case "blocks:saveError": {
                const payload = message.payload;
                if (payload.rootPath === externalWorkspaceRoot)
                    (_13 = deps.onBlockHistorySaveError) === null || _13 === void 0 ? void 0 : _13.call(deps, payload.invalid === true);
                break;
            }
            case "settings:request": {
                const payload = message.payload;
                const requestId = payload === null || payload === void 0 ? void 0 : payload.requestId;
                if (!requestId) {
                    break;
                }
                let snapshot = null;
                let ok = false;
                if ((payload === null || payload === void 0 ? void 0 : payload.action) === "set") {
                    snapshot = (_17 = (_15 = (_14 = deps.settings) === null || _14 === void 0 ? void 0 : _14.applySettingsPatch) === null || _15 === void 0 ? void 0 : _15.call(_14, (_16 = payload.settings) !== null && _16 !== void 0 ? _16 : {})) !== null && _17 !== void 0 ? _17 : null;
                    ok = Boolean(snapshot);
                }
                else {
                    snapshot = (_20 = (_19 = (_18 = deps.settings) === null || _18 === void 0 ? void 0 : _18.getSettingsSnapshot) === null || _19 === void 0 ? void 0 : _19.call(_18)) !== null && _20 !== void 0 ? _20 : null;
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
                (_21 = deps.agent) === null || _21 === void 0 ? void 0 : _21.handleStatus(message.payload.state, message.payload.message, message.payload.conversationId);
                break;
            case "agent:requestRejected":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_23 = (_22 = deps.agent) === null || _22 === void 0 ? void 0 : _22.handleRequestRejected) === null || _23 === void 0 ? void 0 : _23.call(_22, message.payload);
                break;
            case "agent:message": {
                if (isAiModeAgentPayload(message.payload))
                    break;
                const reply = message.payload;
                (_24 = deps.agent) === null || _24 === void 0 ? void 0 : _24.handleMessage((_25 = reply.text) !== null && _25 !== void 0 ? _25 : "", reply.conversationId, {
                    proposals: Array.isArray(reply.proposals) ? reply.proposals : undefined,
                    question: reply.question && typeof reply.question === "object" ? reply.question : undefined,
                    plan: reply.plan && typeof reply.plan === "object" ? reply.plan : undefined,
                });
                break;
            }
            case "agent:messageReset":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_27 = (_26 = deps.agent) === null || _26 === void 0 ? void 0 : _26.handleMessageReset) === null || _27 === void 0 ? void 0 : _27.call(_26, message.payload);
                break;
            case "agent:title":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_29 = (_28 = deps.agent) === null || _28 === void 0 ? void 0 : _28.handleTitle) === null || _29 === void 0 ? void 0 : _29.call(_28, message.payload);
                break;
            case "agent:feedbackResult":
                (_31 = (_30 = deps.agent) === null || _30 === void 0 ? void 0 : _30.handleFeedbackResult) === null || _31 === void 0 ? void 0 : _31.call(_30, message.payload);
                break;
            case "agent:branchResult":
                (_33 = (_32 = deps.agent) === null || _32 === void 0 ? void 0 : _32.handleBranchResult) === null || _33 === void 0 ? void 0 : _33.call(_32, message.payload);
                break;
            case "agent:proposalScope":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_35 = (_34 = deps.agent) === null || _34 === void 0 ? void 0 : _34.handleProposalScope) === null || _35 === void 0 ? void 0 : _35.call(_34, message.payload);
                break;
            case "agent:transcribeResult":
                (_37 = (_36 = deps.agent) === null || _36 === void 0 ? void 0 : _36.handleTranscribeResult) === null || _37 === void 0 ? void 0 : _37.call(_36, message.payload);
                break;
            case "agent:steerResult":
                // The AI workspace reads its own answers through its webview.
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_39 = (_38 = deps.agent) === null || _38 === void 0 ? void 0 : _38.handleSteerResult) === null || _39 === void 0 ? void 0 : _39.call(_38, message.payload);
                break;
            case "agent:documentMap":
                (_41 = (_40 = deps.agent) === null || _40 === void 0 ? void 0 : _40.handleDocumentMap) === null || _41 === void 0 ? void 0 : _41.call(_40, message.payload);
                break;
            case "agent:messageDelta":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_43 = (_42 = deps.agent) === null || _42 === void 0 ? void 0 : _42.handleMessageDelta) === null || _43 === void 0 ? void 0 : _43.call(_42, (_44 = message.payload.text) !== null && _44 !== void 0 ? _44 : "", message.payload.conversationId);
                break;
            case "agent:tool":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_45 = deps.agent) === null || _45 === void 0 ? void 0 : _45.handleTool(message.payload);
                break;
            case "agent:proposal":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_46 = deps.agent) === null || _46 === void 0 ? void 0 : _46.handleProposal(message.payload.proposal);
                break;
            case "agent:applyResult":
                (_47 = deps.agent) === null || _47 === void 0 ? void 0 : _47.handleApplyResult(message.payload);
                break;
            case "agent:undoResult":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_48 = deps.agent) === null || _48 === void 0 ? void 0 : _48.handleUndoResult(message.payload);
                break;
            case "agent:undoAvailability":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_50 = (_49 = deps.agent) === null || _49 === void 0 ? void 0 : _49.handleUndoAvailability) === null || _50 === void 0 ? void 0 : _50.call(_49, message.payload);
                break;
            case "agent:scratchpad":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_52 = (_51 = deps.agent) === null || _51 === void 0 ? void 0 : _51.handleScratchpad) === null || _52 === void 0 ? void 0 : _52.call(_51, message.payload);
                break;
            case "agent:thought":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_54 = (_53 = deps.agent) === null || _53 === void 0 ? void 0 : _53.handleThought) === null || _54 === void 0 ? void 0 : _54.call(_53, message.payload);
                break;
            case "agent:error":
                if (isAiModeAgentPayload(message.payload))
                    break;
                (_55 = deps.agent) === null || _55 === void 0 ? void 0 : _55.handleError((_56 = message.payload.message) !== null && _56 !== void 0 ? _56 : uiText("Axiom error", "Axiomエラー"), message.payload.conversationId);
                break;
            case "api:usage":
                (_57 = deps.api) === null || _57 === void 0 ? void 0 : _57.handleUsage(message.payload);
                break;
            case "platform:auth":
                (_58 = deps.platform) === null || _58 === void 0 ? void 0 : _58.handleAuth(message.payload);
                break;
            case "platform:aiAccess":
                (_59 = deps.platform) === null || _59 === void 0 ? void 0 : _59.handleAiAccess(message.payload);
                break;
            case "platform:usage":
                (_60 = deps.platform) === null || _60 === void 0 ? void 0 : _60.handleUsage(message.payload);
                break;
            case "platform:update":
                (_61 = deps.platform) === null || _61 === void 0 ? void 0 : _61.handleUpdate(message.payload);
                break;
            case "platform:updateStatus":
                (_62 = deps.platform) === null || _62 === void 0 ? void 0 : _62.handleUpdateStatus(message.payload);
                break;
            case "platform:feedback":
                (_63 = deps.platform) === null || _63 === void 0 ? void 0 : _63.handleFeedback(message.payload);
                break;
            case "platform:announcements":
                (_65 = (_64 = deps.platform) === null || _64 === void 0 ? void 0 : _64.handleAnnouncements) === null || _65 === void 0 ? void 0 : _65.call(_64, message.payload);
                break;
            case "billing:checkoutClosed":
                (_66 = deps.billing) === null || _66 === void 0 ? void 0 : _66.handleCheckoutClosed(message.payload);
                break;
            case "app:command":
                (_67 = deps.app) === null || _67 === void 0 ? void 0 : _67.handleCommand((_68 = message.payload.command) !== null && _68 !== void 0 ? _68 : "");
                break;
            case "file:previewResult":
                (_69 = deps.filePreview) === null || _69 === void 0 ? void 0 : _69.handlePreviewResult(message.payload);
                break;
            case "file:excerptResult":
                (_70 = deps.fileExcerpt) === null || _70 === void 0 ? void 0 : _70.handleExcerptResult(message.payload);
                break;
            case "agent:applyContent":
                {
                    const applyPayload = message.payload;
                    // A conflict is reported to Axiom whether the edit applied at once or
                    // waited for an IME composition to end.
                    const reportConflict = () => {
                        var _a, _b;
                        if (typeof applyPayload.conversationId === "string" && applyPayload.conversationId.trim()) {
                            deps.postToNative({
                                type: "agent:contentConflict",
                                conversationId: applyPayload.conversationId,
                                path: (_b = (_a = applyPayload.fileIdentity) !== null && _a !== void 0 ? _a : applyPayload.path) !== null && _b !== void 0 ? _b : "",
                            });
                        }
                    };
                    const applyResult = deps.editorSession.applyContentToOpenFile((_71 = applyPayload.path) !== null && _71 !== void 0 ? _71 : "", (_72 = applyPayload.content) !== null && _72 !== void 0 ? _72 : "", {
                        fileIdentity: applyPayload.fileIdentity,
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
                        onDeferredConflict: reportConflict,
                    });
                    if (applyResult.conflict)
                        reportConflict();
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
