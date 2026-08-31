import { uiText } from "./i18n.js";
// AI mode hosts the tex64-ai document agent (services/tex64-ai) in a
// <webview>. The guest is the exact app that ships as the standalone web
// service; electron/ai-web-preload.cjs injects window.tex64Native so the one
// codebase can branch small native-vs-web differences itself.
export const resolveAiEmbedUrl = (base) => {
    try {
        const url = new URL(base);
        url.searchParams.set("embed", "native");
        return url.toString();
    }
    catch {
        return base;
    }
};
/**
 * What the AI mode webview may ask the host to do. The guest is a web page, so
 * the surface is an allowlist rather than the whole message bus: the workspace
 * it can read and write, the build it can run, SyncTeX both ways, and the
 * agent — the same things Code mode uses, and nothing else.
 */
const GUEST_REQUESTS = new Set([
    "workspace:state:get",
    "openWorkspace",
    "createProject",
    "file:excerpt",
    "file:bytes",
    "file:replaceLines",
    "build",
    "build:cancel",
    "synctex:reverse",
    "agent:model:get",
    "agent:model:set",
    "agent:state:get",
    "agent:run",
    "agent:abort",
    "agent:undoLastRunApply",
    "agent:clear",
    "platform:state:get",
    "feature:check",
    "platform:usage:get",
    "auth:google:start",
    "auth:signout",
]);
/** What the host relays back into the webview. */
const GUEST_EVENTS = new Set([
    "updateWorkspace",
    "file:excerptResult",
    "file:bytesResult",
    "file:replaceLinesResult",
    "setBuildState",
    "synctex:reverseResult",
    "agent:model",
    "agent:state",
    "agent:status",
    "agent:message",
    "agent:messageDelta",
    "agent:tool",
    "agent:thought",
    "agent:error",
    "agent:undoAvailability",
    "agent:undoResult",
    "platform:auth",
    "platform:aiAccess",
    "platform:usage",
]);
const GUEST_CHANNEL = "tex64-ai-host";
const AI_MODE_CONVERSATION_PREFIX = "tex64-ai-mode:";
const REQUEST_SCOPED_GUEST_EVENTS = new Set([
    "file:excerptResult",
    "file:bytesResult",
    "file:replaceLinesResult",
    "synctex:reverseResult",
    "agent:state",
    "agent:undoResult",
]);
const WORKSPACE_SCOPED_GUEST_EVENTS = new Set([
    "file:excerptResult",
    "file:bytesResult",
    "file:replaceLinesResult",
    "synctex:reverseResult",
]);
const recordPayload = (value) => value && typeof value === "object" ? value : {};
const isAiModeConversation = (value, expectedWorkspace) => {
    if (typeof value !== "string" || !value.startsWith(AI_MODE_CONVERSATION_PREFIX)) {
        return false;
    }
    const suffix = value.slice(AI_MODE_CONVERSATION_PREFIX.length);
    if (!suffix || !suffix.includes(":"))
        return false;
    const workspaceId = typeof (expectedWorkspace === null || expectedWorkspace === void 0 ? void 0 : expectedWorkspace.workspaceId) === "string"
        ? expectedWorkspace.workspaceId.trim()
        : "";
    return workspaceId
        ? value.startsWith(`${AI_MODE_CONVERSATION_PREFIX}${encodeURIComponent(workspaceId)}:`)
        : true;
};
const isAiModeRequestId = (value) => typeof value === "string" && value.startsWith("ai-");
const WORKSPACE_SCOPED_REQUESTS = new Set([
    "file:excerpt",
    "file:bytes",
    "file:replaceLines",
    "build",
    "build:cancel",
    "synctex:reverse",
]);
const DOCUMENT_SCOPED_REQUESTS = new Set([
    "file:excerpt",
    "file:bytes",
    "file:replaceLines",
    "build",
    "synctex:reverse",
]);
const hasCurrentWorkspaceScope = (body, expected) => {
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const workspaceGeneration = body.workspaceGeneration;
    if (!workspaceId || !Number.isSafeInteger(workspaceGeneration))
        return false;
    if ((expected === null || expected === void 0 ? void 0 : expected.workspaceId) && workspaceId !== expected.workspaceId)
        return false;
    if (Number.isSafeInteger(expected === null || expected === void 0 ? void 0 : expected.workspaceGeneration) &&
        workspaceGeneration !== (expected === null || expected === void 0 ? void 0 : expected.workspaceGeneration)) {
        return false;
    }
    return true;
};
const isScopedAgentRequest = (type) => type === "agent:state:get" ||
    type === "agent:run" ||
    type === "agent:abort" ||
    type === "agent:undoLastRunApply" ||
    type === "agent:clear";
/** Keep the guest inside its own conversations and current workspace turn. */
export const isAllowedAiGuestRequest = (type, payload, expectedWorkspace) => {
    if (!GUEST_REQUESTS.has(type))
        return false;
    const body = recordPayload(payload);
    if (WORKSPACE_SCOPED_REQUESTS.has(type)) {
        if (!hasCurrentWorkspaceScope(body, expectedWorkspace))
            return false;
        if (type !== "build:cancel" && !isAiModeRequestId(body.requestId))
            return false;
        if (DOCUMENT_SCOPED_REQUESTS.has(type) &&
            (typeof body.documentMainFile !== "string" || !body.documentMainFile.trim())) {
            return false;
        }
    }
    if (type === "file:bytes") {
        return (typeof body.path === "string" &&
            body.path.toLowerCase().endsWith(".pdf"));
    }
    if (!isScopedAgentRequest(type))
        return true;
    if (!isAiModeConversation(body.conversationId, expectedWorkspace))
        return false;
    if (type !== "agent:run")
        return true;
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const documentMainFile = typeof body.documentMainFile === "string"
        ? body.documentMainFile.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
        : "";
    return Boolean(workspaceId &&
        Number.isSafeInteger(body.workspaceGeneration) &&
        documentMainFile &&
        body.conversationId ===
            `${AI_MODE_CONVERSATION_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(documentMainFile)}`);
};
/** Never relay Code-mode transcripts or agent events into the webview. */
export const sanitizeAiGuestEvent = (message, expectedWorkspace) => {
    if (!GUEST_EVENTS.has(message.type))
        return null;
    if (message.type === "agent:model")
        return message;
    const payload = recordPayload(message.payload);
    // Replies share the renderer-wide host bus with Code mode. Do not expose a
    // Code request's source excerpt, file bytes, document list, or operation
    // result merely because the AI webview happens to be alive in the
    // background. Every native AI round trip uses an `ai-*` correlation id.
    if (REQUEST_SCOPED_GUEST_EVENTS.has(message.type) &&
        !isAiModeRequestId(payload.requestId)) {
        return null;
    }
    if (WORKSPACE_SCOPED_GUEST_EVENTS.has(message.type) &&
        (expectedWorkspace === null || expectedWorkspace === void 0 ? void 0 : expectedWorkspace.workspaceId) &&
        Number.isSafeInteger(expectedWorkspace.workspaceGeneration) &&
        !hasCurrentWorkspaceScope(payload, expectedWorkspace)) {
        return null;
    }
    if (!message.type.startsWith("agent:"))
        return message;
    if (!isAiModeConversation(payload.conversationId, expectedWorkspace))
        return null;
    if (message.type !== "agent:state")
        return message;
    const sessions = Array.isArray(payload.sessions)
        ? payload.sessions.filter((session) => session &&
            typeof session === "object" &&
            session.conversationId === payload.conversationId)
        : [];
    return { ...message, payload: { ...payload, sessions } };
};
export const initAiModeUi = (deps) => {
    const host = document.getElementById("ai-mode-webview-host");
    const fallback = document.getElementById("ai-mode-fallback");
    const status = document.getElementById("ai-mode-fallback-status");
    const retryButton = document.getElementById("ai-mode-retry");
    const devHint = document.getElementById("ai-mode-dev-hint");
    const bridge = window.tex64AiWeb;
    let webview = null;
    const pending = [];
    const MAX_PENDING = 200;
    /**
     * State a guest joining late still needs: what project is open, and how the
     * last build went. Both are announced once, and the AI mode is created on
     * demand — long after.
     */
    const STICKY_EVENTS = [
        "updateWorkspace",
        "setBuildState",
        "agent:model",
        "agent:state",
        "platform:auth",
        "platform:aiAccess",
        "platform:usage",
    ];
    const sticky = new Map();
    const WORKSPACE_BOUND_STICKY_EVENTS = new Set([
        "agent:state",
        "setBuildState",
    ]);
    let currentWorkspaceScope = {};
    let currentUrl = "";
    let creating = false;
    const showFallback = (message) => {
        if (status)
            status.textContent = message;
        fallback === null || fallback === void 0 ? void 0 : fallback.classList.remove("is-hidden");
    };
    const hideFallback = () => fallback === null || fallback === void 0 ? void 0 : fallback.classList.add("is-hidden");
    const discardWebview = () => {
        const previous = webview;
        webview = null;
        currentUrl = "";
        pending.length = 0;
        previous === null || previous === void 0 ? void 0 : previous.remove();
    };
    const createWebview = async () => {
        var _a;
        if (webview || creating || !host)
            return;
        creating = true;
        showFallback(uiText("Connecting to the AI workspace…", "AIワークスペースに接続しています…"));
        const config = await ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.getConfig) === null || _a === void 0 ? void 0 : _a.call(bridge).catch(() => null));
        creating = false;
        if (!(config === null || config === void 0 ? void 0 : config.ok) || !config.url) {
            showFallback(uiText("Could not load the AI workspace settings.", "AIワークスペースの設定を取得できませんでした。"));
            return;
        }
        if (devHint)
            devHint.hidden = config.packaged !== false;
        currentUrl = config.url;
        const element = document.createElement("webview");
        element.setAttribute("src", resolveAiEmbedUrl(config.url));
        // Keep the agent's session cookie (its per-browser workspace) across app
        // restarts.
        element.setAttribute("partition", "persist:tex64-ai");
        if (config.preloadFileUrl) {
            element.setAttribute("preload", config.preloadFileUrl);
        }
        element.className = "ai-mode-webview";
        pending.length = 0;
        // did-finish-load also fires after a failed navigation, so remember the
        // failure until the next load attempt starts.
        let lastLoadFailed = false;
        element.addEventListener("dom-ready", () => {
            if (webview !== element)
                return;
            for (const message of sticky.values()) {
                const safeMessage = sanitizeAiGuestEvent(message, currentWorkspaceScope);
                if (safeMessage)
                    sendToGuest(element, safeMessage);
            }
            const backlog = pending.splice(0, pending.length);
            for (const message of backlog) {
                const safeMessage = sanitizeAiGuestEvent(message, currentWorkspaceScope);
                if (safeMessage)
                    sendToGuest(element, safeMessage);
            }
        });
        element.addEventListener("did-start-loading", () => {
            if (webview !== element)
                return;
            // A reload gives us a new guest; anything queued was for the old one.
            pending.length = 0;
            lastLoadFailed = false;
        });
        element.addEventListener("did-fail-load", (event) => {
            if (webview !== element)
                return;
            // -3 = ERR_ABORTED (in-page navigations); not a connection failure.
            if (event.isMainFrame === false || event.errorCode === -3)
                return;
            lastLoadFailed = true;
            showFallback(uiText("Could not connect to the AI workspace. Try reconnecting.", "AIワークスペースに接続できませんでした。再接続してください。"));
        });
        element.addEventListener("did-finish-load", () => {
            if (webview !== element)
                return;
            if (!lastLoadFailed)
                hideFallback();
        });
        element.addEventListener("render-process-gone", () => {
            if (webview !== element)
                return;
            showFallback(uiText("The AI workspace stopped. Try reconnecting.", "AIワークスペースが停止しました。再接続してください。"));
        });
        element.addEventListener("ipc-message", (event) => {
            var _a, _b, _c, _d;
            if (webview !== element)
                return;
            if (event.channel !== "tex64-ai-web")
                return;
            const payload = (_a = event.args) === null || _a === void 0 ? void 0 : _a[0];
            if ((payload === null || payload === void 0 ? void 0 : payload.type) === "open-external" && typeof payload.url === "string") {
                void ((_b = bridge === null || bridge === void 0 ? void 0 : bridge.openExternal) === null || _b === void 0 ? void 0 : _b.call(bridge, payload.url));
                return;
            }
            if ((payload === null || payload === void 0 ? void 0 : payload.type) === "host-request") {
                const requestType = (_c = payload.request) === null || _c === void 0 ? void 0 : _c.type;
                const body = (_d = payload.request) === null || _d === void 0 ? void 0 : _d.payload;
                if (requestType === "billing:open-plans") {
                    const request = recordPayload(body);
                    deps.openPlans(request.plan === "basic" || request.plan === "pro"
                        ? request.plan
                        : undefined);
                    return;
                }
                if (typeof requestType !== "string" ||
                    !isAllowedAiGuestRequest(requestType, body, currentWorkspaceScope)) {
                    // A request the AI mode makes but the host does not open is a wiring
                    // mistake, and silence is the worst way to report one.
                    console.warn("[ai-mode] blocked host request:", requestType);
                    return;
                }
                console.debug("[ai-mode] host request:", requestType);
                deps.postToNative({
                    type: requestType,
                    ...(body && typeof body === "object" ? body : {}),
                });
            }
        });
        webview = element;
        host.appendChild(element);
    };
    retryButton === null || retryButton === void 0 ? void 0 : retryButton.addEventListener("click", () => {
        // A packaged AI server owns a loopback port for the lifetime of its child
        // process. If that process died, reloading the old URL can never recover;
        // discard the guest so getConfig starts the server again and returns its
        // new port/token.
        discardWebview();
        showFallback(uiText("Reconnecting to the AI workspace…", "AIワークスペースに再接続しています…"));
        void createWebview();
    });
    /**
     * Delivers to the guest, or holds the message until it can.
     *
     * <webview>.send throws while the guest is not ready, and readiness is not
     * something to track: the events that announce it are not reliably paired
     * across reloads and in-page navigations. Trying and catching is, so that is
     * what decides whether a message goes now or waits.
     */
    const sendToGuest = (target, message) => {
        if (!(target === null || target === void 0 ? void 0 : target.send))
            return false;
        try {
            target.send(GUEST_CHANNEL, message);
            return true;
        }
        catch {
            return false;
        }
    };
    const deliver = (message) => {
        const safeMessage = sanitizeAiGuestEvent(message, currentWorkspaceScope);
        if (!safeMessage)
            return;
        if (safeMessage.type === "updateWorkspace") {
            const body = recordPayload(safeMessage.payload);
            const nextWorkspaceScope = {
                workspaceId: typeof body.workspaceId === "string" && body.workspaceId.trim()
                    ? body.workspaceId.trim()
                    : null,
                workspaceGeneration: Number.isSafeInteger(body.workspaceGeneration)
                    ? body.workspaceGeneration
                    : null,
            };
            const workspaceChanged = currentWorkspaceScope.workspaceId !== nextWorkspaceScope.workspaceId ||
                currentWorkspaceScope.workspaceGeneration !==
                    nextWorkspaceScope.workspaceGeneration;
            currentWorkspaceScope = nextWorkspaceScope;
            if (workspaceChanged) {
                // Messages already sanitized for workspace A are not safe merely
                // because they sit in a renderer queue when workspace B becomes
                // current. Drop request results/transcripts and replay only state that
                // is either global or freshly scoped to B.
                pending.length = 0;
                for (const type of WORKSPACE_BOUND_STICKY_EVENTS)
                    sticky.delete(type);
            }
        }
        if (STICKY_EVENTS.includes(safeMessage.type)) {
            sticky.set(safeMessage.type, safeMessage);
        }
        if (sendToGuest(webview, safeMessage))
            return;
        if (pending.length < MAX_PENDING)
            pending.push(safeMessage);
    };
    return {
        deliver,
        activate: () => {
            void createWebview();
        },
    };
};
