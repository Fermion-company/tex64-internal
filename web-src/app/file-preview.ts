import { uiText } from "./i18n.js";

export type FilePreviewResultPayload = {
  requestId: string;
  ok: boolean;
  path?: string;
  data?: string;
  mimeType?: string;
  error?: string;
  stale?: boolean;
};

export type WorkspaceFileCacheScope = {
  workspaceId?: string | null;
  rootPath?: string | null;
  workspaceGeneration?: number;
};

type FilePreviewBroker = {
  requestPreview: (path: string) => Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>;
  handlePreviewResult: (payload: FilePreviewResultPayload) => void;
  setWorkspaceScope: (scope: WorkspaceFileCacheScope) => void;
};

const buildRequestId = (() => {
  let counter = 0;
  return () => `preview-${Date.now().toString(36)}-${counter++}`;
})();

export const createFilePreviewBroker = (
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean
): FilePreviewBroker => {
  const pending = new Map<
    string,
    {
      resolve: (value: { ok: boolean; dataUrl?: string | null; error?: string }) => void;
      timeoutId: number;
      path: string;
    }
  >();
  const inFlight = new Map<string, Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>>();
  let workspaceScopeKey = "none:0";

  const setWorkspaceScope = (scope: WorkspaceFileCacheScope) => {
    const workspace = scope.workspaceId || scope.rootPath || "none";
    const generation = Number.isSafeInteger(scope.workspaceGeneration)
      ? scope.workspaceGeneration
      : 0;
    const nextScopeKey = `${workspace}:${generation}`;
    if (nextScopeKey === workspaceScopeKey) return;
    workspaceScopeKey = nextScopeKey;
    inFlight.clear();
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timeoutId);
      entry.resolve({ ok: false, error: "Workspace changed." });
    }
    pending.clear();
  };

  const requestPreview = (
    path: string
  ): Promise<{ ok: boolean; dataUrl?: string | null; error?: string }> => {
    const trimmed = typeof path === "string" ? path.trim() : "";
    if (!trimmed) {
      return Promise.resolve({ ok: false, error: uiText("path is empty.", "pathが空です。") });
    }
    const existing = inFlight.get(trimmed);
    if (existing) return existing;
    const requestId = buildRequestId();
    const request = new Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>((resolve) => {
      // PDFs (up to 5MB) take longer to read and ship over IPC than small
      // images, so the deadline is sized for the slowest allowed payload.
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        inFlight.delete(trimmed);
        resolve({ ok: false, error: uiText("Preview timed out.", "プレビューがタイムアウトしました。") });
      }, 4000);
      pending.set(requestId, { resolve, timeoutId, path: trimmed });
      postToNative(
        {
          type: "file:preview",
          requestId,
          path: trimmed,
        },
        true
      );
    });
    inFlight.set(trimmed, request);
    return request;
  };

  const handlePreviewResult = (payload: FilePreviewResultPayload) => {
    if (!payload || typeof payload.requestId !== "string") {
      return;
    }
    const entry = pending.get(payload.requestId);
    if (!entry) {
      return;
    }
    pending.delete(payload.requestId);
    inFlight.delete(entry.path);
    window.clearTimeout(entry.timeoutId);
    if (!payload.ok) {
      entry.resolve({ ok: false, error: payload.error ?? uiText("Preview failed.", "プレビューできませんでした。") });
      return;
    }
    const data = typeof payload.data === "string" ? payload.data : "";
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/*";
    if (!data) {
      entry.resolve({ ok: false, error: uiText("Image data is empty.", "画像データが空です。") });
      return;
    }
    const dataUrl = `data:${mimeType};base64,${data}`;
    entry.resolve({ ok: true, dataUrl });
  };

  return { requestPreview, handlePreviewResult, setWorkspaceScope };
};
