// Real-time preview for Code mode (beta, settings > Build > Preview).
//
// The preview REPLACES the display inside the surfaces that already show the
// built PDF — the in-tab pdf viewer (viewer.ts → pdf-viewer.html) and the
// separate PDF window — it adds no pane of its own. While the
// `preview.realtime` flag is on and the app is in Code mode, this module
// starts the local TDOM engine, streams the active .tex buffer to it as the
// user types, and flips those viewers into live mode; each viewer swaps only
// its page canvas for the engine's embedded client, keeping its own toolbar
// and chrome. Turning the flag off restores the static PDF everywhere and
// stops the engine.

import type { EditorGroupState } from "./editor-session/types.js";
import type { BridgeWindow } from "./types.js";
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { createDebouncedTask } from "./pro-live-preview.js";

type LiveEditor = {
  getValue?: () => string;
  onDidChangeModelContent?: (listener: () => void) => { dispose: () => void };
};

export const initCodeLivePreview = ({
  getActiveGroup,
  getEditorGroups,
  getAppMode,
}: {
  getActiveGroup: () => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getAppMode: () => string;
}) => {
  const bridge = (window as BridgeWindow).tex64Tdom;
  let active = false;
  let starting = false;
  let engineUrl: string | null = null;
  let distributedUrl: string | null = null;
  let boundEditor: LiveEditor | null = null;
  let boundPath: string | null = null;
  let pushedPath: string | null = null;
  let disposable: { dispose: () => void } | null = null;
  let lastSource: string | null = null;
  let pushChain = Promise.resolve();

  // Flip every PDF surface (both editor groups' viewers + the separate PDF
  // window) into or out of live mode. Idempotent; the surfaces themselves
  // re-apply the state when they (re)open.
  const distributeLive = (url: string | null) => {
    if (distributedUrl === url) return;
    distributedUrl = url;
    for (const group of getEditorGroups()) {
      group.viewer.setLivePreview(url);
    }
    void bridge?.windowLive?.({ url });
  };

  const currentTex = () => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const editor = group.editor as LiveEditor | null;
    if (!path?.toLowerCase().endsWith(".tex") || !editor?.getValue) return null;
    return { group, path, editor };
  };

  const pushCurrent = () => {
    if (!active || !bridge?.push) return;
    const current = currentTex();
    if (!current) return;
    // Never push mid-IME-composition: the buffer is transient and a typeset
    // per composition keystroke is wasted work. Try again after the debounce.
    if (current.group.isComposing) {
      debouncedPush();
      return;
    }
    const source = current.editor.getValue?.() ?? "";
    const fresh = current.path !== pushedPath;
    if (!fresh && source === lastSource) return;
    lastSource = source;
    pushedPath = current.path;
    pushChain = pushChain
      .then(async () => {
        const result = await bridge.push!({ source, fresh });
        if (!result?.ok) throw new Error(result?.error || "live preview push failed");
        if (result.url && active) {
          engineUrl = result.url;
          distributeLive(engineUrl);
        }
      })
      .catch((error) => {
        // Let the next push retry a fresh open instead of diffing against a
        // source the engine never received.
        lastSource = null;
        pushedPath = null;
        console.warn("[live-preview]", error?.message || String(error));
      });
  };
  // 80ms, matching the engine's own client: the engine typesets a keystroke
  // in 20-60ms, so the debounce dominates end-to-end latency — 300ms (the
  // Pro live preview's value) made a ~50ms pipeline feel like half a second.
  const debouncedPush = createDebouncedTask(pushCurrent, 80);

  const bindActiveEditor = () => {
    if (!active) return;
    const current = currentTex();
    const nextEditor = current?.editor ?? null;
    const nextPath = current?.path ?? null;
    if (nextEditor === boundEditor && nextPath === boundPath) return;
    disposable?.dispose();
    disposable = null;
    boundEditor = nextEditor;
    boundPath = nextPath;
    if (boundEditor?.onDidChangeModelContent) disposable = boundEditor.onDidChangeModelContent(debouncedPush);
    debouncedPush();
  };

  const start = async () => {
    if (!bridge?.start || starting) return;
    starting = true;
    try {
      const result = await bridge.start();
      if (!active) return;
      if (!result?.ok || !result.url) {
        console.warn("[live-preview] engine failed to start:", result?.error);
        return;
      }
      engineUrl = result.url;
      distributeLive(engineUrl);
      bindActiveEditor();
      debouncedPush();
    } finally {
      starting = false;
    }
  };

  const suspend = () => {
    debouncedPush.cancel();
    disposable?.dispose();
    disposable = null;
    boundEditor = null;
    boundPath = null;
    lastSource = null;
    pushedPath = null;
    engineUrl = null;
    distributeLive(null);
  };

  const applyActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    if (active) void start();
    else suspend();
  };

  const refresh = () => {
    applyActive(editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
    if (active) {
      bindActiveEditor();
      if (engineUrl) distributeLive(engineUrl);
    }
  };

  editorSettings.subscribe((change) => {
    if (change.kind !== "flag" || change.id !== "preview.realtime") return;
    refresh();
    // Off means off: release the resident LuaLaTeX tree instead of keeping it
    // warm in the background.
    if (!change.value) void bridge?.stop?.();
  });

  // Same lightweight poll as pro-live-preview: notices tab switches, editor
  // swaps and app-mode changes without threading callbacks through every
  // call site.
  const poll = window.setInterval(refresh, 200);
  window.addEventListener("beforeunload", () => window.clearInterval(poll), { once: true });
  refresh();
  return { isActive: () => active };
};
