import { IMAGE_MIME_TYPES, getFileExtension } from "./files.js";

export type ViewerMode = "hidden" | "image" | "pdf" | "unsupported";

export type PdfSyncPayload = {
  page: number;
  x: number;
  y: number;
  pdfPath?: string;
  blockX?: number;
  blockY?: number;
  blockWidth?: number;
  blockHeight?: number;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
};

export type LivePdfSnapshot = {
  path: string;
  data: string;
  mimeType: string;
  generation: number;
  documentEpoch: number;
};

export type ViewerDeps = {
  editorViewer: HTMLElement | null;
  editorViewerImage: HTMLImageElement | null;
  editorViewerPdf: HTMLIFrameElement | null;
  editorHost: HTMLElement | null;
  onPdfReverseRequest?: (payload: {
    page: number;
    x: number;
    y: number;
    pdfPath: string | null;
  }) => void;
};

export const createViewer = (deps: ViewerDeps) => {
  let viewerBlobUrl: string | null = null;
  let viewerMode: ViewerMode = "hidden";
  let pdfViewerReady = false;
  let pdfViewerPath: string | null = null;
  let pendingPdfOpen: { url: string; path: string | null } | null = null;
  let pendingPdfSync: PdfSyncPayload | null = null;
  let staticPdf: { path: string; data: string; mimeType: string } | null = null;
  let livePreview: LivePdfSnapshot | null = null;
  const pdfViewerUrl = new URL("pdf-viewer.html", window.location.href).toString();

  const postPdfMessage = (payload: { type: string; payload?: unknown }) => {
    if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      return false;
    }
    const target = deps.editorViewerPdf.contentWindow;
    if (!target) {
      return false;
    }
    target.postMessage({ source: "tex64-pdf", payload }, "*");
    return true;
  };

  const ensurePdfFrame = () => {
    if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      return;
    }
    const current = deps.editorViewerPdf.src;
    if (!current || !current.includes("pdf-viewer.html")) {
      pdfViewerReady = false;
      deps.editorViewerPdf.src = pdfViewerUrl;
    }
  };

  window.addEventListener("message", (event) => {
    if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      return;
    }
    if (event.source !== deps.editorViewerPdf.contentWindow) {
      return;
    }
    const data = event.data as { source?: string; payload?: { type?: string } };
    if (!data || data.source !== "tex64-pdf") {
      return;
    }
    const payload = data.payload;
    if (!payload || typeof payload.type !== "string") {
      return;
    }
    if (payload.type === "ready") {
      pdfViewerReady = true;
      if (pendingPdfOpen) {
        postPdfMessage({ type: "open", payload: pendingPdfOpen });
        pendingPdfOpen = null;
      }
      if (pendingPdfSync) {
        postPdfMessage({ type: "sync", payload: pendingPdfSync });
        pendingPdfSync = null;
      }
      return;
    }
    if (payload.type === "reverse") {
      const detail = (payload as { payload?: unknown }).payload as
        | { page?: unknown; x?: unknown; y?: unknown; path?: unknown }
        | null
        | undefined;
      const page = typeof detail?.page === "number" ? detail.page : Number(detail?.page);
      const x = typeof detail?.x === "number" ? detail.x : Number(detail?.x);
      const y = typeof detail?.y === "number" ? detail.y : Number(detail?.y);
      if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const pdfPath = typeof detail?.path === "string" ? detail.path : null;
      deps.onPdfReverseRequest?.({ page, x, y, pdfPath });
      return;
    }
  });

  const clearViewerUrl = () => {
    if (viewerBlobUrl) {
      URL.revokeObjectURL(viewerBlobUrl);
      viewerBlobUrl = null;
    }
  };

  const setViewerMode = (mode: ViewerMode) => {
    viewerMode = mode;
    if (deps.editorViewer instanceof HTMLElement) {
      deps.editorViewer.dataset.view = mode;
      const isVisible = mode !== "hidden";
      deps.editorViewer.classList.toggle("is-visible", isVisible);
      deps.editorViewer.setAttribute("aria-hidden", isVisible ? "false" : "true");
    }
    if (deps.editorHost instanceof HTMLElement) {
      deps.editorHost.classList.toggle("is-hidden", mode !== "hidden");
    }
  };

  const blurActiveElement = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  };

  const buildViewerBlobUrl = (data: string, mimeType: string) => {
    clearViewerUrl();
    const binary = window.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    viewerBlobUrl = URL.createObjectURL(blob);
    return viewerBlobUrl;
  };

  const hideViewer = () => {
    clearViewerUrl();
    if (deps.editorViewerImage instanceof HTMLImageElement) {
      deps.editorViewerImage.removeAttribute("src");
    }
    if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
      deps.editorViewerPdf.removeAttribute("src");
    }
    pdfViewerReady = false;
    pendingPdfOpen = null;
    pendingPdfSync = null;
    pdfViewerPath = null;
    staticPdf = null;
    setViewerMode("hidden");
  };

  const showUnsupportedViewer = (hint?: string) => {
    clearViewerUrl();
    if (deps.editorViewerImage instanceof HTMLImageElement) {
      deps.editorViewerImage.removeAttribute("src");
    }
    if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
      deps.editorViewerPdf.removeAttribute("src");
    }
    pdfViewerReady = false;
    pendingPdfOpen = null;
    pendingPdfSync = null;
    pdfViewerPath = null;
    if (deps.editorViewer instanceof HTMLElement) {
      const message = deps.editorViewer.querySelector<HTMLElement>(".editor-viewer-message");
      const existingHint = message?.querySelector<HTMLElement>(".editor-viewer-hint");
      if (hint && message) {
        const hintElement = existingHint ?? document.createElement("p");
        hintElement.className = "editor-viewer-hint";
        hintElement.textContent = hint;
        if (!existingHint) {
          message.appendChild(hintElement);
        }
      } else {
        existingHint?.remove();
      }
    }
    setViewerMode("unsupported");
    blurActiveElement();
  };

  const showImageViewer = (path: string, data?: string, mimeType?: string) => {
    if (!data || !(deps.editorViewerImage instanceof HTMLImageElement)) {
      showUnsupportedViewer();
      return;
    }
    const resolvedMime =
      mimeType ?? IMAGE_MIME_TYPES.get(getFileExtension(path)) ?? "image/*";
    try {
      const url = buildViewerBlobUrl(data, resolvedMime);
      deps.editorViewerImage.src = url;
      setViewerMode("image");
      blurActiveElement();
    } catch {
      showUnsupportedViewer();
    }
  };

  const renderPdf = (path: string, data?: string, mimeType?: string) => {
    if (!data || !(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      showUnsupportedViewer();
      return;
    }
    try {
      const url = buildViewerBlobUrl(data, mimeType ?? "application/pdf");
      pdfViewerPath = path;
      ensurePdfFrame();
      const payload = { url, path };
      if (pdfViewerReady) {
        postPdfMessage({ type: "open", payload });
        if (!pendingPdfSync?.pdfPath || pendingPdfSync.pdfPath === path) {
          if (pendingPdfSync) {
            postPdfMessage({ type: "sync", payload: pendingPdfSync });
            pendingPdfSync = null;
          }
        }
      } else {
        pendingPdfOpen = payload;
      }
      setViewerMode("pdf");
      blurActiveElement();
    } catch {
      showUnsupportedViewer();
    }
  };

  const showPdfViewer = (path: string, data?: string, mimeType?: string) => {
    if (!data) {
      showUnsupportedViewer();
      return;
    }
    staticPdf = { path, data, mimeType: mimeType ?? "application/pdf" };
    const live = livePreview?.path === path ? livePreview : null;
    renderPdf(path, live?.data ?? data, live?.mimeType ?? mimeType);
  };

  const showLivePdfViewer = (snapshot: LivePdfSnapshot) => {
    livePreview = snapshot;
    renderPdf(snapshot.path, snapshot.data, snapshot.mimeType);
  };

  const syncPdf = (payload: PdfSyncPayload) => {
    if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      return;
    }
    if (
      !pdfViewerReady ||
      (payload.pdfPath !== undefined && payload.pdfPath !== pdfViewerPath)
    ) {
      pendingPdfSync = payload;
      ensurePdfFrame();
      return;
    }
    postPdfMessage({ type: "sync", payload });
  };

  const setLivePreview = (next: LivePdfSnapshot | null) => {
    if (
      livePreview?.path === next?.path &&
      livePreview?.generation === next?.generation &&
      livePreview?.documentEpoch === next?.documentEpoch
    ) return;
    const previousPath = livePreview?.path ?? null;
    livePreview = next;
    if (next && pdfViewerPath === next.path && viewerMode === "pdf") {
      renderPdf(next.path, next.data, next.mimeType);
      return;
    }
    if (!next && staticPdf && viewerMode === "pdf" && pdfViewerPath === previousPath) {
      renderPdf(staticPdf.path, staticPdf.data, staticPdf.mimeType);
    }
  };

  return {
    hideViewer,
    showImageViewer,
    showPdfViewer,
    showLivePdfViewer,
    showUnsupportedViewer,
    setViewerMode,
    getViewerMode: () => viewerMode,
    getPdfPath: () => pdfViewerPath,
    syncPdf,
    setLivePreview,
  };
};
