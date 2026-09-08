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
      cacheKey: string;
    }
  >();
  const cache = new Map<string, { dataUrl: string; updatedAt: number }>();
  const cacheTtlMs = 60_000;
  let workspaceScopeKey = "none:0";

  const setWorkspaceScope = (scope: WorkspaceFileCacheScope) => {
    const workspace = scope.workspaceId || scope.rootPath || "none";
    const generation = Number.isSafeInteger(scope.workspaceGeneration)
      ? scope.workspaceGeneration
      : 0;
    const nextScopeKey = `${workspace}:${generation}`;
    if (nextScopeKey === workspaceScopeKey) return;
    workspaceScopeKey = nextScopeKey;
    cache.clear();
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
      return Promise.resolve({ ok: false, error: uiText("path is empty.", "path が空です。") });
    }
    const cacheKey = `${workspaceScopeKey}\0${trimmed}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < cacheTtlMs) {
      return Promise.resolve({ ok: true, dataUrl: cached.dataUrl });
    }
    const requestId = buildRequestId();
    return new Promise((resolve) => {
      // PDFs (up to 5MB) take longer to read and ship over IPC than small
      // images, so the deadline is sized for the slowest allowed payload.
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: uiText("Preview timed out.", "プレビューがタイムアウトしました。") });
      }, 4000);
      pending.set(requestId, { resolve, timeoutId, cacheKey });
      postToNative(
        {
          type: "file:preview",
          requestId,
          path: trimmed,
        },
        true
      );
    });
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
    window.clearTimeout(entry.timeoutId);
    if (!payload.ok) {
      entry.resolve({ ok: false, error: payload.error ?? uiText("Preview failed.", "プレビューに失敗しました。") });
      return;
    }
    const data = typeof payload.data === "string" ? payload.data : "";
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/*";
    if (!data) {
      entry.resolve({ ok: false, error: uiText("Image data is empty.", "画像データが空です。") });
      return;
    }
    const dataUrl = `data:${mimeType};base64,${data}`;
    cache.set(entry.cacheKey, { dataUrl, updatedAt: Date.now() });
    entry.resolve({ ok: true, dataUrl });
  };

  return { requestPreview, handlePreviewResult, setWorkspaceScope };
};
