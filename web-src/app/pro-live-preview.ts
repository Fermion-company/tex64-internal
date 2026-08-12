import type { EditorGroupState } from "./editor-session/types.js";
import type { BridgeWindow } from "./types.js";

export const PRO_LIVE_STORAGE_KEY = "tex64.proLivePreview.v1";

export type FermionEditPayload = { start: number; end: number; text: string };

export const buildFullReplacementEdit = (previous: string, next: string): FermionEditPayload => ({
  start: 0,
  end: previous.length,
  text: next,
});

export const createDebouncedTask = (task: () => void, delayMs = 300) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; task(); }, delayMs);
  };
  schedule.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return schedule;
};

type LiveEditor = {
  getValue?: () => string;
  onDidChangeModelContent?: (listener: () => void) => { dispose: () => void };
};

export const initProLivePreview = ({ getActiveGroup }: { getActiveGroup: () => EditorGroupState }) => {
  const button = document.getElementById("pro-preview-live-toggle");
  const status = document.getElementById("pro-preview-live-status");
  const liveFrame = document.getElementById("pro-preview-live");
  const staticViewer = document.getElementById("pro-preview-viewer");
  if (!(button instanceof HTMLButtonElement) || !(liveFrame instanceof HTMLIFrameElement)) return null;

  const bridge = (window as BridgeWindow).tex64Fermion;
  let enabled = localStorage.getItem(PRO_LIVE_STORAGE_KEY) === "true";
  let boundEditor: LiveEditor | null = null;
  let boundPath: string | null = null;
  let disposable: { dispose: () => void } | null = null;
  let lastSource = "";
  let pushChain = Promise.resolve();

  const setStatus = (message = "", error = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", error);
  };
  const applyVisibility = () => {
    button.classList.toggle("is-active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    liveFrame.classList.toggle("is-visible", enabled);
    liveFrame.setAttribute("aria-hidden", String(!enabled));
    staticViewer?.classList.toggle("is-live-hidden", enabled);
  };
  const currentTex = () => {
    const group = getActiveGroup();
    const path = group.currentFilePath;
    const editor = group.editor as LiveEditor | null;
    if (!path?.toLowerCase().endsWith(".tex") || !editor?.getValue) return null;
    return { path, editor, source: editor.getValue() };
  };
  const pushCurrent = () => {
    if (!enabled || !bridge?.push) return;
    const current = currentTex();
    if (!current || (current.path === boundPath && current.source === lastSource)) return;
    const edit = buildFullReplacementEdit(lastSource, current.source);
    lastSource = current.source;
    pushChain = pushChain.then(async () => {
      const result = await bridge.push!({ source: current.source, edit });
      if (!result?.ok) throw new Error(result?.error || "Live preview update failed");
      if (result.url && liveFrame.src !== `${result.url}/`) liveFrame.src = result.url;
      setStatus("");
    }).catch((error) => setStatus(error?.message || String(error), true));
  };
  const debouncedPush = createDebouncedTask(pushCurrent, 300);
  const bindActiveEditor = () => {
    if (!enabled) return;
    const current = currentTex();
    const nextEditor = current?.editor ?? null;
    const nextPath = current?.path ?? null;
    if (nextEditor === boundEditor && nextPath === boundPath) return;
    disposable?.dispose();
    disposable = null;
    boundEditor = nextEditor;
    boundPath = nextPath;
    lastSource = "";
    if (boundEditor?.onDidChangeModelContent) disposable = boundEditor.onDidChangeModelContent(debouncedPush);
    debouncedPush();
  };
  const start = async () => {
    if (!bridge?.start) {
      enabled = false;
      applyVisibility();
      setStatus("Live preview service is unavailable.", true);
      return;
    }
    setStatus("Starting…");
    const result = await bridge.start();
    if (!result?.ok || !result.url) {
      enabled = false;
      localStorage.setItem(PRO_LIVE_STORAGE_KEY, "false");
      applyVisibility();
      setStatus(result?.error || "Live preview failed to start.", true);
      return;
    }
    liveFrame.src = result.url;
    setStatus(result.backend ? `Live · ${result.backend}` : "Live");
    bindActiveEditor();
  };
  const setEnabled = (next: boolean) => {
    enabled = next;
    localStorage.setItem(PRO_LIVE_STORAGE_KEY, String(enabled));
    applyVisibility();
    if (enabled) void start();
    else {
      debouncedPush.cancel();
      disposable?.dispose();
      disposable = null;
      boundEditor = null;
      boundPath = null;
      setStatus("");
    }
  };

  button.addEventListener("click", () => setEnabled(!enabled));
  const poll = window.setInterval(bindActiveEditor, 200);
  window.addEventListener("beforeunload", () => window.clearInterval(poll), { once: true });
  applyVisibility();
  if (enabled) void start();
  return { isEnabled: () => enabled, setEnabled };
};
