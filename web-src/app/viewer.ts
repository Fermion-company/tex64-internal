import { IMAGE_MIME_TYPES, getFileExtension } from "./files.js";

type PdfSourceStatus = { rootPath: string | null; requiresRebuild: boolean; rebuiltPaths: string[] };
const pdfSourceStates = new Map<string, PdfSourceStatus>();
const pdfSourceListeners = new Set<() => void>();
let activePdfWorkspace: string | null = null;
const normalizedPdfPath = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "");

export const updatePdfSourceState = (value: unknown, activeWorkspace = false) => {
  const payload = value as Partial<PdfSourceStatus> | null;
  if (!payload || (payload.rootPath !== null && typeof payload.rootPath !== "string")) return;
  const root = payload.rootPath ? normalizedPdfPath(payload.rootPath) : null;
  if (activeWorkspace) activePdfWorkspace = root;
  if (root) pdfSourceStates.set(root, {
    rootPath: root,
    requiresRebuild: payload.requiresRebuild === true,
    rebuiltPaths: Array.isArray(payload.rebuiltPaths) ? payload.rebuiltPaths.filter((p): p is string => typeof p === "string").map(normalizedPdfPath) : [],
  });
  for (const listener of pdfSourceListeners) listener();
};

export type ViewerMode = "hidden" | "image" | "pdf" | "unsupported";

export type LivePreviewTarget = { workspaceRoot: string | null; pdfPath: string };

const livePdfPath = (path: string, workspaceRoot: string | null) => {
  let value = path.replace(/\\/g, "/");
  if (!/^(?:\/|[A-Za-z]:\/)/.test(value) && workspaceRoot) {
    value = `${workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${value}`;
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") {
      if (parts[parts.length - 1] !== "") parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
};

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

export type LivePreviewEditRequest = {
  sessionId: string;
  regionId?: string;
  kind: "text" | "math";
  file: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  baseValue: string;
  value?: string;
  replacement: string;
  cancel?: boolean;
  finish?: boolean;
  sourceRev?: number;
  sourceText?: string;
};

export type LivePreviewAnchorRequest = Pick<
  LivePreviewEditRequest,
  "sessionId" | "file" | "start" | "end" | "baseValue"
> & {
  requestId: string;
  activationId: string;
  documentEpoch: number;
  sourceText: string;
  sourceRev: number;
  previousSessionId?: string;
};

export type LivePreviewAnchorResult = Pick<
  LivePreviewAnchorRequest,
  "sessionId" | "requestId" | "activationId" | "documentEpoch" | "file" | "sourceRev"
> & {
  ok: boolean;
  sourceText?: string;
  start?: LivePreviewEditRequest["start"];
  end?: LivePreviewEditRequest["end"];
  baseValue?: string;
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
  onLiveSourceRequest?: (payload: {
    file: string;
    line: number;
    column: number;
  }) => void;
  onLiveEditRequest?: (payload: LivePreviewEditRequest) => void;
  onLiveEditAnchorRequest?: (
    request: LivePreviewAnchorRequest,
    reply: (result: LivePreviewAnchorResult) => void
  ) => void;
  /** The reader marked a place on the page and wants to talk to Axiom about it. */
  onPdfAskAxiom?: (payload: {
    page: number;
    x: number;
    y: number;
    text: string;
    pdfPath: string | null;
    /** The live preview's own source position; the static viewer has none. */
    source?: { file: string; line: number; column: number } | null;
  }) => void;
};

export const createViewer = (deps: ViewerDeps) => {
  let viewerBlobUrl: string | null = null;
  let viewerMode: ViewerMode = "hidden";
  let pdfViewerReady = false;
  let pdfViewerPath: string | null = null;
  let pdfWorkspaceRoot: string | null = null;
  let pendingPdfOpen: { url: string; path: string | null } | null = null;
  let pendingPdfSync: PdfSyncPayload | null = null;
  // Real-time preview: when set, the pdf viewer swaps its page canvas for the
  // live engine frame (same chrome). Re-sent on every viewer "ready" so it
  // survives the pdf iframe being torn down and recreated. `hold` keeps the
  // same engine frame alive below a Build-owned static PDF; it is part of
  // this state rather than a one-shot message so a viewer that becomes ready
  // later still receives it. `expectedSrcRev` is the revision the engine
  // accepted for the first change after that Build.
  let livePreview: {
    url: string;
    generation: number;
    target: LivePreviewTarget;
    hold: boolean;
    expectedSrcRev: number | null;
  } | null = null;
  const pdfViewerUrl = new URL("pdf-viewer.html", window.location.href).toString();

  const matchingLivePreview = () => livePreview && pdfViewerPath &&
    livePdfPath(pdfViewerPath, livePreview.target.workspaceRoot) ===
      livePdfPath(livePreview.target.pdfPath, livePreview.target.workspaceRoot)
    ? livePreview : null;

  const needsPdfRebuild = () => {
    if (!pdfWorkspaceRoot || !pdfViewerPath) return false;
    const status = pdfSourceStates.get(pdfWorkspaceRoot);
    if (!status?.requiresRebuild) return false;
    const name = normalizedPdfPath(pdfViewerPath);
    const absolute = name.startsWith("/") || /^[A-Za-z]:\//.test(name)
      ? name : `${pdfWorkspaceRoot}/${name.replace(/^\.\//, "")}`;
    if (!absolute.startsWith(`${pdfWorkspaceRoot}/`) || absolute.split("/").includes("..")) return false;
    return !status.rebuiltPaths.includes(absolute);
  };

  const postPdfMessage = (payload: { type: string; payload?: unknown }) => {
    if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      return false;
    }
    const target = deps.editorViewerPdf.contentWindow;
    if (!target) {
      return false;
    }
    if (payload.type === "open") payload = { ...payload, payload: { ...(payload.payload as object), needsRebuild: needsPdfRebuild() } };
    target.postMessage({ source: "tex64-pdf", payload }, "*");
    return true;
  };

  pdfSourceListeners.add(() => {
    if (pdfViewerReady && pdfViewerPath) postPdfMessage({ type: "source-state", payload: { path: pdfViewerPath, needsRebuild: needsPdfRebuild() } });
  });

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
      postPdfMessage({ type: "live", payload: matchingLivePreview() });
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
    if (payload.type === "ask-axiom") {
      const detail = (payload as { payload?: unknown }).payload as
        | { page?: unknown; x?: unknown; y?: unknown; text?: unknown; path?: unknown; source?: unknown }
        | null
        | undefined;
      const page = Number(detail?.page);
      const x = Number(detail?.x);
      const y = Number(detail?.y);
      const rawSource = detail?.source as { file?: unknown; line?: unknown; column?: unknown } | null | undefined;
      const source =
        rawSource && typeof rawSource.file === "string" && Number.isFinite(Number(rawSource.line))
          ? { file: rawSource.file, line: Number(rawSource.line), column: Number.isFinite(Number(rawSource.column)) ? Number(rawSource.column) : 1 }
          : null;
      if (!Number.isFinite(page) || (!source && (!Number.isFinite(x) || !Number.isFinite(y)))) return;
      deps.onPdfAskAxiom?.({
        page,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        text: typeof detail?.text === "string" ? detail.text : "",
        pdfPath: typeof detail?.path === "string" ? detail.path : null,
        ...(source ? { source } : {}),
      });
      return;
    }
    if (payload.type === "live-source") {
      if (!matchingLivePreview()) return;
      const detail = (payload as { payload?: unknown }).payload as
        | { file?: unknown; line?: unknown; column?: unknown }
        | null
        | undefined;
      const file = typeof detail?.file === "string" ? detail.file : "";
      const line = Number(detail?.line);
      const column = Number(detail?.column);
      if (file && Number.isFinite(line) && line >= 1) {
        deps.onLiveSourceRequest?.({
          file,
          line: Math.floor(line),
          column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
        });
      }
      return;
    }
    if (payload.type === "live-edit-anchor") {
      const requestedPreview = matchingLivePreview();
      if (!requestedPreview) return;
      const detail = (payload as { payload?: unknown }).payload as
        | Partial<LivePreviewAnchorRequest>
        | null
        | undefined;
      if (!detail || typeof detail.sessionId !== "string" || !detail.sessionId ||
          typeof detail.requestId !== "string" || !detail.requestId ||
          typeof detail.activationId !== "string" || !detail.activationId ||
          !Number.isInteger(detail.documentEpoch) ||
          typeof detail.file !== "string" || !detail.file ||
          typeof detail.baseValue !== "string" || typeof detail.sourceText !== "string" ||
          !Number.isInteger(detail.sourceRev) ||
          ![detail.start?.line, detail.start?.column, detail.end?.line, detail.end?.column]
            .every((value) => typeof value === "number" && Number.isInteger(value) && value >= 1)) return;
      const request = detail as LivePreviewAnchorRequest;
      const reply = (result: LivePreviewAnchorResult) => {
        if (matchingLivePreview() !== requestedPreview) return;
        postPdfMessage({ type: "live-edit-anchor-result", payload: result });
      };
      if (deps.onLiveEditAnchorRequest) deps.onLiveEditAnchorRequest(request, reply);
      else reply({
        sessionId: request.sessionId,
        requestId: request.requestId,
        activationId: request.activationId,
        documentEpoch: request.documentEpoch,
        sourceRev: request.sourceRev,
        file: request.file,
        ok: false,
      });
      return;
    }
    if (payload.type === "live-edit") {
      if (!matchingLivePreview()) return;
      const detail = (payload as { payload?: unknown }).payload as
        | Partial<LivePreviewEditRequest>
        | null
        | undefined;
      const startLine = Number(detail?.start?.line);
      const startColumn = Number(detail?.start?.column);
      const endLine = Number(detail?.end?.line);
      const endColumn = Number(detail?.end?.column);
      if (
        typeof detail?.sessionId === "string" &&
        detail.sessionId.length > 0 &&
        (detail.kind === "text" || detail.kind === "math") &&
        typeof detail.file === "string" &&
        detail.file.length > 0 &&
        typeof detail.baseValue === "string" &&
        typeof detail.replacement === "string" &&
        Number.isFinite(startLine) && startLine >= 1 &&
        Number.isFinite(startColumn) && startColumn >= 1 &&
        Number.isFinite(endLine) && endLine >= 1 &&
        Number.isFinite(endColumn) && endColumn >= 1
      ) {
        deps.onLiveEditRequest?.({
          ...detail,
          sourceText: typeof detail.sourceText === "string" ? detail.sourceText : undefined,
          start: { line: Math.floor(startLine), column: Math.floor(startColumn) },
          end: { line: Math.floor(endLine), column: Math.floor(endColumn) },
        } as LivePreviewEditRequest);
      }
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

  const showPdfViewer = (path: string, data?: string, mimeType?: string) => {
    if (!data || !(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
      showUnsupportedViewer();
      return;
    }
    try {
      const url = buildViewerBlobUrl(data, mimeType ?? "application/pdf");
      pdfViewerPath = path;
      pdfWorkspaceRoot = activePdfWorkspace;
      ensurePdfFrame();
      const payload = { url, path };
      if (pdfViewerReady) {
        // A different PDF tab cannot inherit this project's root paper or
        // send direct edits through it, even before the next preview poll.
        postPdfMessage({ type: "live", payload: matchingLivePreview() });
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
    const preview = matchingLivePreview();
    if (preview) {
      // The PDF frame may have been recreated while the tab was hidden.
      // Establish Live ownership synchronously before SyncTeX so the jump is
      // queued for the visible TDOM surface instead of the static fallback.
      postPdfMessage({ type: "live", payload: preview });
    }
    postPdfMessage({ type: "sync", payload });
  };

  const setLivePreview = (
    url: string | null,
    generation = 0,
    target: LivePreviewTarget | null = null,
    hold = false,
    expectedSrcRev: number | null = null,
  ) => {
    const next = url && target ? { url, generation, target, hold, expectedSrcRev } : null;
    if (livePreview?.url === next?.url && livePreview?.generation === next?.generation &&
        livePreview?.hold === next?.hold && livePreview?.expectedSrcRev === next?.expectedSrcRev &&
        livePreview?.target.workspaceRoot === next?.target.workspaceRoot &&
        livePreview?.target.pdfPath === next?.target.pdfPath) return;
    livePreview = next;
    if (pdfViewerReady) {
      postPdfMessage({ type: "live", payload: matchingLivePreview() });
    }
  };

  return {
    hideViewer,
    showImageViewer,
    showPdfViewer,
    showUnsupportedViewer,
    setViewerMode,
    getViewerMode: () => viewerMode,
    getPdfPath: () => pdfViewerPath,
    syncPdf,
    setLivePreview,
  };
};
