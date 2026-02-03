export type FilePreviewResultPayload = {
  requestId: string;
  ok: boolean;
  path?: string;
  data?: string;
  mimeType?: string;
  error?: string;
};

type FilePreviewBroker = {
  requestPreview: (path: string) => Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>;
  handlePreviewResult: (payload: FilePreviewResultPayload) => void;
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
    { resolve: (value: { ok: boolean; dataUrl?: string | null; error?: string }) => void; timeoutId: number }
  >();
  const cache = new Map<string, { dataUrl: string; updatedAt: number }>();
  const cacheTtlMs = 60_000;

  const requestPreview = (
    path: string
  ): Promise<{ ok: boolean; dataUrl?: string | null; error?: string }> => {
    const trimmed = typeof path === "string" ? path.trim() : "";
    if (!trimmed) {
      return Promise.resolve({ ok: false, error: "path が空です。" });
    }
    const cached = cache.get(trimmed);
    if (cached && Date.now() - cached.updatedAt < cacheTtlMs) {
      return Promise.resolve({ ok: true, dataUrl: cached.dataUrl });
    }
    const requestId = buildRequestId();
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "プレビューがタイムアウトしました。" });
      }, 1600);
      pending.set(requestId, { resolve, timeoutId });
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
      entry.resolve({ ok: false, error: payload.error ?? "プレビューに失敗しました。" });
      return;
    }
    const data = typeof payload.data === "string" ? payload.data : "";
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/*";
    if (!data) {
      entry.resolve({ ok: false, error: "画像データが空です。" });
      return;
    }
    const dataUrl = `data:${mimeType};base64,${data}`;
    if (typeof payload.path === "string" && payload.path.trim()) {
      cache.set(payload.path.trim(), { dataUrl, updatedAt: Date.now() });
    }
    entry.resolve({ ok: true, dataUrl });
  };

  return { requestPreview, handlePreviewResult };
};
