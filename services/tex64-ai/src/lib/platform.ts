// One codebase, two surfaces: this app ships standalone on the web and is
// embedded in the TeX64 desktop app's AI mode (a <webview> whose preload
// injects `window.tex64Native`). Branch platform-specific behavior through
// this module only, so the differences stay small and discoverable.

export type Tex64NativeBridge = {
  platform: "native";
  openExternal?: (url: string) => void;
};

declare global {
  interface Window {
    tex64Native?: Tex64NativeBridge;
  }
}

export const isNativeEmbed = (): boolean =>
  typeof window !== "undefined" && Boolean(window.tex64Native);

// Opens a URL outside the app: system browser in the native embed, new tab
// on the web.
export const openExternal = (url: string): void => {
  if (typeof window === "undefined") return;
  const bridge = window.tex64Native;
  if (bridge?.openExternal) {
    bridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};
