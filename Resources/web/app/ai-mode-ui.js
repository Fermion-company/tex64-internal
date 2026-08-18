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
    "requestWorkspace",
    "detectRoot",
    "openFile",
    "file:excerpt",
    "file:preview",
    "file:bytes",
    "saveFile",
    "createFile",
    "createFolder",
    "search",
    "build",
    "build:cancel",
    "synctex:forward",
    "synctex:reverse",
    "agent:settings:get",
    "agent:settings:set",
    "agent:state:get",
    "agent:run",
    "agent:abort",
    "agent:clear",
]);
/** What the host relays back into the webview. */
const GUEST_EVENTS = new Set([
    "updateWorkspace",
    "updateIndex",
    "updateSearch",
    "openFileResult",
    "file:excerptResult",
    "file:previewResult",
    "file:bytesResult",
    "saveResult",
    "setBuildState",
    "buildLog",
    "updateIssues",
    "synctex:forwardResult",
    "synctex:reverseResult",
    "agent:settings",
    "agent:state",
    "agent:status",
    "agent:message",
    "agent:messageDelta",
    "agent:tool",
    "agent:thought",
    "agent:applyContent",
    "agent:error",
]);
const GUEST_CHANNEL = "tex64-ai-host";
export const initAiModeUi = (deps) => {
    const host = document.getElementById("ai-mode-webview-host");
    const fallback = document.getElementById("ai-mode-fallback");
    const status = document.getElementById("ai-mode-fallback-status");
    const retryButton = document.getElementById("ai-mode-retry");
    const browserButton = document.getElementById("ai-mode-open-browser");
    const axiomButton = document.getElementById("ai-mode-open-axiom");
    const devHint = document.getElementById("ai-mode-dev-hint");
    const bridge = window.tex64AiWeb;
    let webview = null;
    let currentUrl = "";
    let creating = false;
    const showFallback = (message) => {
        if (status)
            status.textContent = message;
        fallback === null || fallback === void 0 ? void 0 : fallback.classList.remove("is-hidden");
    };
    const hideFallback = () => fallback === null || fallback === void 0 ? void 0 : fallback.classList.add("is-hidden");
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
        // did-finish-load also fires after a failed navigation, so remember the
        // failure until the next load attempt starts.
        let lastLoadFailed = false;
        element.addEventListener("did-start-loading", () => {
            lastLoadFailed = false;
        });
        element.addEventListener("did-fail-load", (event) => {
            // -3 = ERR_ABORTED (in-page navigations); not a connection failure.
            if (event.isMainFrame === false || event.errorCode === -3)
                return;
            lastLoadFailed = true;
            showFallback(uiText("Could not connect to the AI workspace. Check that the server is running.", "AIワークスペースに接続できませんでした。サーバーが起動しているか確認してください。"));
        });
        element.addEventListener("did-finish-load", () => {
            if (!lastLoadFailed)
                hideFallback();
        });
        element.addEventListener("ipc-message", (event) => {
            var _a, _b, _c, _d;
            if (event.channel !== "tex64-ai-web")
                return;
            const payload = (_a = event.args) === null || _a === void 0 ? void 0 : _a[0];
            if ((payload === null || payload === void 0 ? void 0 : payload.type) === "open-external" && typeof payload.url === "string") {
                void ((_b = bridge === null || bridge === void 0 ? void 0 : bridge.openExternal) === null || _b === void 0 ? void 0 : _b.call(bridge, payload.url));
                return;
            }
            if ((payload === null || payload === void 0 ? void 0 : payload.type) === "host-request") {
                const requestType = (_c = payload.request) === null || _c === void 0 ? void 0 : _c.type;
                if (typeof requestType !== "string" || !GUEST_REQUESTS.has(requestType)) {
                    return;
                }
                const body = (_d = payload.request) === null || _d === void 0 ? void 0 : _d.payload;
                deps.postToNative({
                    type: requestType,
                    ...(body && typeof body === "object" ? body : {}),
                });
            }
        });
        host.appendChild(element);
        webview = element;
    };
    retryButton === null || retryButton === void 0 ? void 0 : retryButton.addEventListener("click", () => {
        var _a;
        if (webview) {
            showFallback(uiText("Reconnecting to the AI workspace…", "AIワークスペースに再接続しています…"));
            (_a = webview.reload) === null || _a === void 0 ? void 0 : _a.call(webview);
        }
        else {
            void createWebview();
        }
    });
    browserButton === null || browserButton === void 0 ? void 0 : browserButton.addEventListener("click", () => {
        var _a;
        if (currentUrl)
            void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.openExternal) === null || _a === void 0 ? void 0 : _a.call(bridge, currentUrl));
    });
    // AI mode and the Axiom chat are different surfaces, and the Codex (ChatGPT)
    // backend lives in the latter. When AI mode cannot connect — in dev it needs
    // its own server — offer the chat that is right there instead of dead-ending.
    axiomButton === null || axiomButton === void 0 ? void 0 : axiomButton.addEventListener("click", () => {
        var _a, _b;
        (_a = document
            .querySelector('[data-app-mode-tab="code"]')) === null || _a === void 0 ? void 0 : _a.click();
        (_b = document.querySelector('.tab[data-tab="ai"]')) === null || _b === void 0 ? void 0 : _b.click();
    });
    const deliver = (message) => {
        var _a;
        if (!webview || !GUEST_EVENTS.has(message.type))
            return;
        (_a = webview.send) === null || _a === void 0 ? void 0 : _a.call(webview, GUEST_CHANNEL, message);
    };
    return {
        deliver,
        activate: () => {
            void createWebview();
        },
    };
};
