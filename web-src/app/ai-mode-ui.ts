import type { PostToNative } from "./bridge-sender.js";
import type { AiWebBridge, BridgeWindow } from "./types.js";
import { uiText } from "./i18n.js";

// AI mode hosts the tex64-ai document agent (services/tex64-ai) in a
// <webview>. The guest is the exact app that ships as the standalone web
// service; electron/ai-web-preload.cjs injects window.tex64Native so the one
// codebase can branch small native-vs-web differences itself.

export const resolveAiEmbedUrl = (base: string): string => {
  try {
    const url = new URL(base);
    url.searchParams.set("embed", "native");
    return url.toString();
  } catch {
    return base;
  }
};

type WebviewElement = HTMLElement & {
  reload?: () => void;
  loadURL?: (url: string) => void;
  send?: (channel: string, ...args: unknown[]) => void;
};

type WebviewIpcEvent = Event & { channel?: string; args?: unknown[] };

/**
 * What the AI mode webview may ask the host to do. The guest is a web page, so
 * the surface is an allowlist rather than the whole message bus: the workspace
 * it can read and write, the build it can run, SyncTeX both ways, and the
 * agent — the same things Code mode uses, and nothing else.
 */
const GUEST_REQUESTS: ReadonlySet<string> = new Set([
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
const GUEST_EVENTS: ReadonlySet<string> = new Set([
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
type WebviewFailEvent = Event & {
  errorCode?: number;
  isMainFrame?: boolean;
};

export type AiModeApi = {
  activate: () => void;
  /** Relay one host message into the webview, when it is on the allowlist. */
  deliver: (message: { type: string; payload?: unknown }) => void;
};

export type AiModeDeps = {
  /** Sends an allowlisted request on to the main process. */
  postToNative: PostToNative;
};

export const initAiModeUi = (deps: AiModeDeps): AiModeApi => {
  const host = document.getElementById("ai-mode-webview-host");
  const fallback = document.getElementById("ai-mode-fallback");
  const status = document.getElementById("ai-mode-fallback-status");
  const retryButton = document.getElementById("ai-mode-retry");
  const browserButton = document.getElementById("ai-mode-open-browser");
  const axiomButton = document.getElementById("ai-mode-open-axiom");
  const devHint = document.getElementById("ai-mode-dev-hint");
  const bridge = (window as BridgeWindow).tex64AiWeb as AiWebBridge | undefined;

  let webview: WebviewElement | null = null;
  let currentUrl = "";
  let creating = false;

  const showFallback = (message: string) => {
    if (status) status.textContent = message;
    fallback?.classList.remove("is-hidden");
  };
  const hideFallback = () => fallback?.classList.add("is-hidden");

  const createWebview = async () => {
    if (webview || creating || !host) return;
    creating = true;
    showFallback(uiText("Connecting to the AI workspace…", "AIワークスペースに接続しています…"));
    const config = await bridge?.getConfig?.().catch(() => null);
    creating = false;
    if (!config?.ok || !config.url) {
      showFallback(uiText("Could not load the AI workspace settings.", "AIワークスペースの設定を取得できませんでした。"));
      return;
    }
    if (devHint) devHint.hidden = config.packaged !== false;
    currentUrl = config.url;

    const element = document.createElement("webview") as WebviewElement;
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
    element.addEventListener("did-fail-load", (event: WebviewFailEvent) => {
      // -3 = ERR_ABORTED (in-page navigations); not a connection failure.
      if (event.isMainFrame === false || event.errorCode === -3) return;
      lastLoadFailed = true;
      showFallback(
        uiText(
          "Could not connect to the AI workspace. Check that the server is running.",
          "AIワークスペースに接続できませんでした。サーバーが起動しているか確認してください。"
        )
      );
    });
    element.addEventListener("did-finish-load", () => {
      if (!lastLoadFailed) hideFallback();
    });
    element.addEventListener("ipc-message", (event: WebviewIpcEvent) => {
      if (event.channel !== "tex64-ai-web") return;
      const payload = event.args?.[0] as
        | {
            type?: string;
            url?: string;
            request?: { type?: unknown; payload?: unknown };
          }
        | undefined;
      if (payload?.type === "open-external" && typeof payload.url === "string") {
        void bridge?.openExternal?.(payload.url);
        return;
      }
      if (payload?.type === "host-request") {
        const requestType = payload.request?.type;
        if (typeof requestType !== "string" || !GUEST_REQUESTS.has(requestType)) {
          // A request the AI mode makes but the host does not open is a wiring
          // mistake, and silence is the worst way to report one.
          console.warn("[ai-mode] blocked host request:", requestType);
          return;
        }
        console.debug("[ai-mode] host request:", requestType);
        const body = payload.request?.payload;
        deps.postToNative({
          type: requestType,
          ...(body && typeof body === "object" ? body : {}),
        });
      }
    });
    host.appendChild(element);
    webview = element;
  };

  retryButton?.addEventListener("click", () => {
    if (webview) {
      showFallback(uiText("Reconnecting to the AI workspace…", "AIワークスペースに再接続しています…"));
      webview.reload?.();
    } else {
      void createWebview();
    }
  });
  browserButton?.addEventListener("click", () => {
    if (currentUrl) void bridge?.openExternal?.(currentUrl);
  });
  // AI mode and the Axiom chat are different surfaces, and the Codex (ChatGPT)
  // backend lives in the latter. When AI mode cannot connect — in dev it needs
  // its own server — offer the chat that is right there instead of dead-ending.
  axiomButton?.addEventListener("click", () => {
    document
      .querySelector<HTMLButtonElement>('[data-app-mode-tab="code"]')
      ?.click();
    document.querySelector<HTMLButtonElement>('.tab[data-tab="ai"]')?.click();
  });

  const deliver = (message: { type: string; payload?: unknown }) => {
    if (!webview || !GUEST_EVENTS.has(message.type)) return;
    webview.send?.(GUEST_CHANNEL, message);
  };

  return {
    deliver,
    activate: () => {
      void createWebview();
    },
  };
};
