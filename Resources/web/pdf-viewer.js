import * as pdfjs from "./pdfjs/pdf.min.mjs";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
} from "./pdfjs/pdf_viewer.mjs";

const createParentBridge = () => {
  if (!window.parent || window.parent === window) {
    return null;
  }
  const handlers = new Set();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== "tex64-pdf") {
      return;
    }
    handlers.forEach((handler) => {
      try {
        handler(data.payload);
      } catch {
        // ignore handler errors
      }
    });
  });
  return {
    postMessage: (payload) => {
      window.parent.postMessage({ source: "tex64-pdf", payload }, "*");
    },
    onMessage: (handler) => {
      if (typeof handler !== "function") {
        return () => {};
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
};

const resolveBridge = () => window.tex64Pdf || createParentBridge();
const isEmbeddedViewer = () =>
  !window.tex64Pdf && Boolean(window.parent && window.parent !== window);

const initPdfViewer = () => {
  const bridge = resolveBridge();
  document.body.classList.toggle("is-embedded", isEmbeddedViewer());
  const titleEl = document.getElementById("pdf-title");
  const statusEl = document.getElementById("pdf-status");
  const sidebarToggleBtn = document.getElementById("pdf-sidebar-toggle");
  const sidebarEl = document.getElementById("pdf-sidebar");
  const outlineTabBtn = document.getElementById("pdf-tab-outline");
  const thumbsTabBtn = document.getElementById("pdf-tab-thumbs");
  const outlineEl = document.getElementById("pdf-outline");
  const thumbnailsEl = document.getElementById("pdf-thumbnails");
  const pageInput = document.getElementById("pdf-page-input");
  const pageCountEl = document.getElementById("pdf-page-count");
  const prevBtn = document.getElementById("pdf-prev");
  const nextBtn = document.getElementById("pdf-next");
  const zoomOutBtn = document.getElementById("pdf-zoom-out");
  const zoomInBtn = document.getElementById("pdf-zoom-in");
  const zoomLabel = document.getElementById("pdf-zoom-label");
  const fitWidthBtn = document.getElementById("pdf-fit-width");
  const fitPageBtn = document.getElementById("pdf-fit-page");
  const rotateLeftBtn = document.getElementById("pdf-rotate-left");
  const rotateRightBtn = document.getElementById("pdf-rotate-right");
  const searchInput = document.getElementById("pdf-search-input");
  const searchPrevBtn = document.getElementById("pdf-search-prev");
  const searchNextBtn = document.getElementById("pdf-search-next");
  const invertBtn = document.getElementById("pdf-invert");
  const downloadBtn = document.getElementById("pdf-download");
  const printBtn = document.getElementById("pdf-print");
  const reloadBtn = document.getElementById("pdf-reload");
  const scrollEl = document.getElementById("pdf-scroll");
  const pagesEl = document.getElementById("pdf-pages");

  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "./pdfjs/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3;
  const WHEEL_ZOOM_SENSITIVITY = 0.008;
  const ZOOM_DRAW_DELAY = 160;
  const CLICK_BIAS_X_PT = 0;
  const CLICK_BIAS_Y_PT = 2;
  const state = {
    doc: null,
    url: null,
    path: null,
    pageCount: 0,
    scale: 1,
    scaleMode: "fit-width",
    rotation: 0,
    pendingSync: null,
    activeMarker: null,
    lastSync: null,
    lastSyncDebug: null,
    lastReverseDebug: null,
    markerTimer: null,
    sidebarVisible: false,
    sidebarTab: "outline",
    thumbObserver: null,
    thumbRendered: new Set(),
    pendingRestore: null,
  };

  // Tracks the scroll-restore re-apply frame so a SyncTeX jump can cancel it.
  let restoreRafId = null;
  // True while a (re)load is loading the new document. A SyncTeX "sync" that
  // arrives during this window must NOT be applied to the still-showing OLD
  // document — setDocument would then reset us to the top and lose the jump.
  // Defer it instead and let pagesinit apply it to the freshly loaded pages.
  let reloadInFlight = false;

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const pdfViewer = new PDFViewer({
    container: scrollEl,
    viewer: pagesEl,
    eventBus,
    linkService,
    findController,
    textLayerMode: 2,
    annotationMode: 2,
    useOnlyCssZoom: true,
  });
  linkService.setViewer(pdfViewer);
  window.__tex64PdfViewer = {
    pdfViewer,
    state,
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const invertKey = "tex64.pdf.invert";
  const setInverted = (enabled) => {
    document.body.classList.toggle("is-inverted", enabled === true);
    try {
      localStorage.setItem(invertKey, enabled === true ? "true" : "false");
    } catch {
      // ignore
    }
  };
  try {
    const storedInvert = localStorage.getItem(invertKey);
    if (storedInvert === "true") {
      document.body.classList.add("is-inverted");
    }
  } catch {
    // ignore
  }

  const updateZoomLabel = (value = state.scale) => {
    if (!zoomLabel) return;
    zoomLabel.textContent = `${Math.round(value * 100)}%`;
  };

  const updatePageCount = () => {
    if (pageInput) {
      pageInput.max = String(state.pageCount || 1);
    }
    if (pageCountEl) {
      pageCountEl.textContent = `/ ${state.pageCount || 0}`;
    }
  };

  const clampScale = (value) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

  const getZoomOrigin = (clientX, clientY) => {
    if (!scrollEl) return null;
    return [clientX, clientY];
  };

  const getScrollCenter = () => {
    if (!scrollEl) return null;
    const rect = scrollEl.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  };

  const updateScaleState = (value = pdfViewer.currentScale) => {
    state.scale = value;
    updateZoomLabel(value);
  };

  const applyZoomFactor = (scaleFactor, origin) => {
    if (!state.doc) return;
    if (!Number.isFinite(scaleFactor) || scaleFactor === 1) return;
    state.scaleMode = "manual";
    pdfViewer.updateScale({
      scaleFactor,
      drawingDelay: ZOOM_DRAW_DELAY,
      origin,
    });
    updateScaleState();
  };

  const applyScaleTo = (nextScale, origin) => {
    const target = clampScale(nextScale);
    const base = state.scale || pdfViewer.currentScale || 1;
    applyZoomFactor(target / base, origin);
  };

  const applyScaleMode = (mode) => {
    if (!state.doc) return;
    if (mode === "fit-width") {
      pdfViewer.currentScaleValue = "page-width";
      state.scaleMode = mode;
    } else if (mode === "fit-page") {
      pdfViewer.currentScaleValue = "page-fit";
      state.scaleMode = mode;
    } else {
      pdfViewer.currentScale = state.scale;
      state.scaleMode = "manual";
    }
    state.scale = pdfViewer.currentScale;
    updateZoomLabel();
  };

  const scrollToPage = (pageNumber) => {
    if (!state.doc) return;
    pdfViewer.scrollPageIntoView({ pageNumber });
  };

  const setPage = (pageNumber) => {
    if (!state.doc) return;
    const clamped = Math.min(Math.max(1, pageNumber), state.pageCount || 1);
    pdfViewer.currentPageNumber = clamped;
  };

  const clearSyncMarker = () => {
    if (state.markerTimer) {
      clearTimeout(state.markerTimer);
      state.markerTimer = null;
    }
    if (state.activeMarker) {
      state.activeMarker.remove();
      state.activeMarker = null;
    }
  };

  const sidebarVisibleKey = "tex64.pdf.sidebarVisible";
  const sidebarTabKey = "tex64.pdf.sidebarTab";

  const setSidebarVisible = (visible) => {
    state.sidebarVisible = visible === true;
    if (sidebarEl) {
      sidebarEl.classList.toggle("is-hidden", !state.sidebarVisible);
    }
    try {
      localStorage.setItem(sidebarVisibleKey, state.sidebarVisible ? "true" : "false");
    } catch {
      // ignore
    }
  };

  const setSidebarTab = (tab) => {
    state.sidebarTab = tab === "thumbs" ? "thumbs" : "outline";
    if (outlineTabBtn) {
      outlineTabBtn.classList.toggle("is-active", state.sidebarTab === "outline");
    }
    if (thumbsTabBtn) {
      thumbsTabBtn.classList.toggle("is-active", state.sidebarTab === "thumbs");
    }
    if (outlineEl) {
      outlineEl.classList.toggle("is-active", state.sidebarTab === "outline");
    }
    if (thumbnailsEl) {
      thumbnailsEl.classList.toggle("is-active", state.sidebarTab === "thumbs");
    }
    try {
      localStorage.setItem(sidebarTabKey, state.sidebarTab);
    } catch {
      // ignore
    }
  };

  try {
    const storedVisible = localStorage.getItem(sidebarVisibleKey);
    if (storedVisible === "true") {
      state.sidebarVisible = true;
    }
    const storedTab = localStorage.getItem(sidebarTabKey);
    if (storedTab === "thumbs" || storedTab === "outline") {
      state.sidebarTab = storedTab;
    }
  } catch {
    // ignore
  }
  setSidebarVisible(state.sidebarVisible);
  setSidebarTab(state.sidebarTab);

  const clearSidebarContent = () => {
    if (outlineEl) {
      outlineEl.innerHTML = "";
    }
    if (thumbnailsEl) {
      thumbnailsEl.innerHTML = "";
    }
    if (state.thumbObserver) {
      state.thumbObserver.disconnect();
      state.thumbObserver = null;
    }
    state.thumbRendered.clear();
  };

  const renderOutline = async () => {
    if (!outlineEl) {
      return;
    }
    outlineEl.innerHTML = "";
    if (!state.doc) {
      outlineEl.textContent = "PDF が未読み込みです。";
      return;
    }
    const outline = await state.doc.getOutline().catch(() => null);
    if (!Array.isArray(outline) || outline.length === 0) {
      outlineEl.textContent = "目次がありません。";
      return;
    }

    const renderItems = (items, depth = 0) => {
      items.forEach((item) => {
        if (!item) {
          return;
        }
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pdf-outline-item";
        button.textContent = title || "(untitled)";
        button.style.paddingLeft = `${8 + depth * 12}px`;
        const dest = item.dest ?? null;
        if (dest) {
          button.addEventListener("click", () => {
            linkService.goToDestination(dest);
          });
        } else {
          button.disabled = true;
        }
        outlineEl.appendChild(button);
        if (Array.isArray(item.items) && item.items.length > 0) {
          renderItems(item.items, depth + 1);
        }
      });
    };

    renderItems(outline, 0);
  };

  const renderThumbnail = async (pageNumber, canvas) => {
    if (!state.doc || !canvas || state.thumbRendered.has(pageNumber)) {
      return;
    }
    state.thumbRendered.add(pageNumber);
    const page = await state.doc.getPage(pageNumber).catch(() => null);
    if (!page) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = 56 * dpr;
    const viewport = page.getViewport({ scale: 1 });
    const scale = viewport?.width ? targetWidth / viewport.width : 0.12;
    const thumbViewport = page.getViewport({ scale });
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    canvas.width = Math.max(1, Math.floor(thumbViewport.width));
    canvas.height = Math.max(1, Math.floor(thumbViewport.height));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: thumbViewport }).promise.catch(() => null);
  };

  const renderThumbnails = () => {
    if (!thumbnailsEl) {
      return;
    }
    thumbnailsEl.innerHTML = "";
    if (!state.doc || !state.pageCount) {
      thumbnailsEl.textContent = "PDF が未読み込みです。";
      return;
    }
    if (state.thumbObserver) {
      state.thumbObserver.disconnect();
    }
    state.thumbRendered.clear();

    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                  return;
                }
                const target = entry.target;
                if (!(target instanceof HTMLElement)) {
                  return;
                }
                const page = Number.parseInt(target.dataset.page ?? "", 10);
                const canvas = target.querySelector("canvas");
                if (Number.isFinite(page) && canvas instanceof HTMLCanvasElement) {
                  renderThumbnail(page, canvas);
                }
                observer.unobserve(target);
              });
            },
            { root: thumbnailsEl, rootMargin: "200px" }
          )
        : null;
    state.thumbObserver = observer;

    for (let page = 1; page <= state.pageCount; page += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pdf-thumb";
      button.dataset.page = String(page);

      const canvas = document.createElement("canvas");
      button.appendChild(canvas);

      const label = document.createElement("div");
      label.className = "pdf-thumb-label";
      label.textContent = `${page}`;
      button.appendChild(label);

      button.addEventListener("click", () => {
        scrollToPage(page);
      });

      thumbnailsEl.appendChild(button);
      if (observer) {
        observer.observe(button);
      } else {
        renderThumbnail(page, canvas);
      }
    }
  };

  const postReverseRequest = (payload) => {
    if (!bridge || typeof bridge.postMessage !== "function") {
      return;
    }
    if (!payload || typeof payload !== "object") {
      return;
    }
    bridge.postMessage({
      type: "reverse",
      payload: {
        page: payload.page,
        x: payload.x,
        y: payload.y,
        path: state.path || null,
      },
    });
  };

  const reverseSynctexKey = "tex64.editor.reverseSynctex";
  const isReverseSynctexEnabled = () => {
    try {
      return localStorage.getItem(reverseSynctexKey) !== "false";
    } catch (_error) {
      return true;
    }
  };

  const contextMenuState = {
    menuEl: null,
    dismissHandlers: [],
  };

  const hideContextMenu = () => {
    if (contextMenuState.menuEl) {
      contextMenuState.menuEl.remove();
      contextMenuState.menuEl = null;
    }
    contextMenuState.dismissHandlers.forEach((handler) => {
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("scroll", handler, true);
      document.removeEventListener("keydown", handler);
    });
    contextMenuState.dismissHandlers = [];
  };

  const scheduleContextMenuDismiss = () => {
    const dismiss = (event) => {
      if (event.type === "pointerdown") {
        if (event.target instanceof Node && contextMenuState.menuEl?.contains(event.target)) {
          return;
        }
      }
      if (event.type === "keydown" && event.key !== "Escape") {
        return;
      }
      hideContextMenu();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", dismiss);
    contextMenuState.dismissHandlers.push(dismiss);
  };

  const openReverseContextMenu = (event, point) => {
    if (!isReverseSynctexEnabled()) {
      return;
    }
    hideContextMenu();
    if (!point) {
      return;
    }
    const menu = document.createElement("div");
    menu.className = "pdf-context-menu";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-context-menu-item";
    button.textContent = "ソースへ移動";
    button.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      hideContextMenu();
      postReverseRequest(point);
    });
    menu.appendChild(button);
    if (document.body) {
      document.body.appendChild(menu);
    }
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || 150;
    const menuHeight = menuRect.height || 42;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const top = Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - menuHeight - 8)
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    contextMenuState.menuEl = menu;
    scheduleContextMenuDismiss();
    button.focus();
  };

  const resolvePageContentOffset = (pageEl) => {
    if (!(pageEl instanceof HTMLElement)) {
      return { left: 0, top: 0 };
    }
    const clientLeft = Number(pageEl.clientLeft);
    const clientTop = Number(pageEl.clientTop);
    if (
      Number.isFinite(clientLeft) &&
      Number.isFinite(clientTop) &&
      (clientLeft > 0 || clientTop > 0)
    ) {
      return {
        left: clientLeft,
        top: clientTop,
      };
    }
    const style = window.getComputedStyle(pageEl);
    const borderLeft = Number.parseFloat(style.borderLeftWidth ?? "0");
    const borderTop = Number.parseFloat(style.borderTopWidth ?? "0");
    return {
      left: Number.isFinite(borderLeft) ? borderLeft : 0,
      top: Number.isFinite(borderTop) ? borderTop : 0,
    };
  };

  const resolveViewportScale = (pageView) => {
    const pageDiv = pageView?.div;
    const viewportWidth = Number(pageView?.viewport?.width);
    const viewportHeight = Number(pageView?.viewport?.height);
    const contentWidth =
      pageDiv instanceof HTMLElement && Number.isFinite(pageDiv.clientWidth)
        ? pageDiv.clientWidth
        : Number.NaN;
    const contentHeight =
      pageDiv instanceof HTMLElement && Number.isFinite(pageDiv.clientHeight)
        ? pageDiv.clientHeight
        : Number.NaN;
    const scaleX =
      Number.isFinite(contentWidth) &&
      contentWidth > 0 &&
      Number.isFinite(viewportWidth) &&
      viewportWidth > 0
        ? contentWidth / viewportWidth
        : 1;
    const scaleY =
      Number.isFinite(contentHeight) &&
      contentHeight > 0 &&
      Number.isFinite(viewportHeight) &&
      viewportHeight > 0
        ? contentHeight / viewportHeight
        : 1;
    return {
      x: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
      y: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
    };
  };

  const resolvePagePdfHeight = (pageView) => {
    const rawHeight = Number(pageView?.viewport?.rawDims?.pageHeight);
    if (Number.isFinite(rawHeight) && rawHeight > 0) {
      return rawHeight;
    }
    const viewBox = pageView?.viewport?.viewBox;
    if (Array.isArray(viewBox) && viewBox.length >= 4) {
      const top = Number(viewBox[1]);
      const bottom = Number(viewBox[3]);
      const height = Math.abs(bottom - top);
      if (Number.isFinite(height) && height > 0) {
        return height;
      }
    }
    const vp = pageView?.viewport;
    if (vp) {
      const rotation = Number(vp.rotation) || 0;
      const isRotated = rotation === 90 || rotation === 270;
      const scaledDim = Number(isRotated ? vp.width : vp.height);
      const scale = Number(vp.scale);
      if (
        Number.isFinite(scaledDim) &&
        scaledDim > 0 &&
        Number.isFinite(scale) &&
        scale > 0
      ) {
        const derivedHeight = scaledDim / scale;
        if (Number.isFinite(derivedHeight) && derivedHeight > 0) {
          return derivedHeight;
        }
      }
    }
    return null;
  };

  const resolveClickPoint = (event) => {
    if (!event || typeof event !== "object") {
      return null;
    }
    if (!state.doc) {
      return null;
    }
    if (!pagesEl) {
      return null;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return null;
    }
    const pageEl = target.closest?.(".page");
    if (!(pageEl instanceof HTMLElement)) {
      return null;
    }
    const rawPage = pageEl.getAttribute("data-page-number");
    const page = Number.parseInt(rawPage ?? "", 10);
    if (!Number.isFinite(page) || page <= 0) {
      return null;
    }
    const pageView = pdfViewer.getPageView(page - 1);
    if (!pageView?.viewport) {
      return null;
    }
    const isNearActiveMarker = () => {
      if (!(state.activeMarker instanceof HTMLElement)) {
        return false;
      }
      const markerRect = state.activeMarker.getBoundingClientRect();
      if (!Number.isFinite(markerRect.left) || !Number.isFinite(markerRect.top)) {
        return false;
      }
      const markerX = markerRect.left + markerRect.width / 2;
      const markerY = markerRect.top + markerRect.height / 2;
      const dx = Number(event.clientX) - markerX;
      const dy = Number(event.clientY) - markerY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        return false;
      }
      return dx * dx + dy * dy <= 2 * 2;
    };
    const rect = pageEl.getBoundingClientRect();
    const contentOffset = resolvePageContentOffset(pageEl);
    const viewportScale = resolveViewportScale(pageView);
    const isTextLayerClick =
      target instanceof Element && target.closest(".textLayer") instanceof Element;
    const applyTextBias = isTextLayerClick && !isNearActiveMarker();
    const rawContentX = event.clientX - rect.left - contentOffset.left;
    const rawContentY = event.clientY - rect.top - contentOffset.top;
    if (!Number.isFinite(rawContentX) || !Number.isFinite(rawContentY)) {
      return null;
    }
    const rawViewX = rawContentX / viewportScale.x;
    const rawViewY = rawContentY / viewportScale.y;
    if (!Number.isFinite(rawViewX) || !Number.isFinite(rawViewY)) {
      return null;
    }
    const maxViewX =
      Number.isFinite(pageView.viewport.width) && pageView.viewport.width > 0
        ? pageView.viewport.width
        : Number.POSITIVE_INFINITY;
    const maxViewY =
      Number.isFinite(pageView.viewport.height) && pageView.viewport.height > 0
        ? pageView.viewport.height
        : Number.POSITIVE_INFINITY;
    const viewX = Math.min(Math.max(rawViewX, 0), maxViewX);
    const viewY = Math.min(Math.max(rawViewY, 0), maxViewY);
    const [pdfX, pdfYBottom] = pageView.viewport.convertToPdfPoint(viewX, viewY);
    if (!Number.isFinite(pdfX) || !Number.isFinite(pdfYBottom)) {
      return null;
    }
    const pagePdfHeight = resolvePagePdfHeight(pageView);
    const biasX = applyTextBias ? CLICK_BIAS_X_PT : 0;
    const biasY = applyTextBias ? CLICK_BIAS_Y_PT : 0;
    const synctexY =
      Number.isFinite(pagePdfHeight) && pagePdfHeight > 0
        ? pagePdfHeight - pdfYBottom + biasY
        : pdfYBottom + biasY;
    const synctexX = pdfX + biasX;
    state.lastReverseDebug = {
      page,
      x: synctexX,
      y: synctexY,
      rawContentX,
      rawContentY,
      viewX,
      viewY,
      biasX,
      biasY,
      textLayerClick: isTextLayerClick,
      nearMarker: isNearActiveMarker(),
    };
    return { page, x: synctexX, y: synctexY };
  };


  const applySyncHighlight = (pageView, payload, viewX, viewY) => {
    if (!pageView || !(pageView.div instanceof HTMLElement)) {
      return;
    }
    const viewportScale = resolveViewportScale(pageView);
    const pagePdfHeight = resolvePagePdfHeight(pageView);
    const hasBlock =
      Number.isFinite(payload.blockWidth) &&
      payload.blockWidth > 0 &&
      Number.isFinite(payload.blockHeight) &&
      Math.abs(payload.blockHeight) > 0;
    if (hasBlock) {
      const bx = Number.isFinite(payload.blockX) ? payload.blockX : payload.x;
      const by = Number.isFinite(payload.blockY) ? payload.blockY : payload.y;
      const bw = payload.blockWidth;
      const bh = payload.blockHeight;
      const left = Math.min(bx, bx + bw);
      const right = Math.max(bx, bx + bw);
      const topSynctex = Math.min(by, by + bh);
      const bottomSynctex = Math.max(by, by + bh);
      const normTop =
        Number.isFinite(pagePdfHeight) && pagePdfHeight > 0
          ? pagePdfHeight - topSynctex
          : topSynctex;
      const normBottom =
        Number.isFinite(pagePdfHeight) && pagePdfHeight > 0
          ? pagePdfHeight - bottomSynctex
          : bottomSynctex;
      const [rvx1, rvy1] = pageView.viewport.convertToViewportPoint(left, normTop);
      const [rvx2, rvy2] = pageView.viewport.convertToViewportPoint(right, normBottom);
      const vx1 = rvx1 * viewportScale.x;
      const vy1 = rvy1 * viewportScale.y;
      const vx2 = rvx2 * viewportScale.x;
      const vy2 = rvy2 * viewportScale.y;
      const rectLeft = Math.min(vx1, vx2);
      const rectTop = Math.min(vy1, vy2);
      const rectWidth = Math.abs(vx2 - vx1);
      const rectHeight = Math.abs(vy2 - vy1);
      if (rectWidth > 1 && rectHeight > 1) {
        const pad = 2;
        const marker = document.createElement("div");
        marker.className = "pdf-sync-highlight";
        marker.style.left = `${rectLeft - pad}px`;
        marker.style.top = `${rectTop - pad}px`;
        marker.style.width = `${rectWidth + pad * 2}px`;
        marker.style.height = `${rectHeight + pad * 2}px`;
        pageView.div.appendChild(marker);
        state.activeMarker = marker;
        state.markerTimer = setTimeout(() => {
          clearSyncMarker();
        }, 2400);
        return;
      }
    }
    const textLayer = pageView.div.querySelector(".textLayer");
    if (textLayer) {
      const spans = textLayer.querySelectorAll("span");
      let bestSpan = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const span of spans) {
        const rect = span.getBoundingClientRect();
        const pageRect = pageView.div.getBoundingClientRect();
        const contentOffset = resolvePageContentOffset(pageView.div);
        const spanCx = rect.left + rect.width / 2 - pageRect.left - contentOffset.left;
        const spanCy = rect.top + rect.height / 2 - pageRect.top - contentOffset.top;
        const dx = spanCx - viewX;
        const dy = spanCy - viewY;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestSpan = span;
        }
      }
      if (bestSpan && bestDist < 2500) {
        const pageRect = pageView.div.getBoundingClientRect();
        const contentOffset = resolvePageContentOffset(pageView.div);
        const spanRect = bestSpan.getBoundingClientRect();
        const pad = 2;
        const marker = document.createElement("div");
        marker.className = "pdf-sync-highlight";
        marker.style.left = `${spanRect.left - pageRect.left - contentOffset.left - pad}px`;
        marker.style.top = `${spanRect.top - pageRect.top - contentOffset.top - pad}px`;
        marker.style.width = `${spanRect.width + pad * 2}px`;
        marker.style.height = `${spanRect.height + pad * 2}px`;
        pageView.div.appendChild(marker);
        state.activeMarker = marker;
        state.markerTimer = setTimeout(() => {
          clearSyncMarker();
        }, 2400);
        return;
      }
    }
    const fallbackMarker = document.createElement("div");
    fallbackMarker.className = "pdf-sync-highlight pdf-sync-highlight-dot";
    fallbackMarker.style.left = `${viewX}px`;
    fallbackMarker.style.top = `${viewY}px`;
    fallbackMarker.style.width = "20px";
    fallbackMarker.style.height = "20px";
    fallbackMarker.style.borderRadius = "999px";
    fallbackMarker.style.transform = "translate(-50%, -50%)";
    pageView.div.appendChild(fallbackMarker);
    state.activeMarker = fallbackMarker;
    state.markerTimer = setTimeout(() => {
      clearSyncMarker();
    }, 2400);
  };

  const applySync = (payload) => {
    // A SyncTeX jump overrides any scroll-position restore from a reload —
    // including a re-apply already scheduled for the next animation frame.
    state.pendingRestore = null;
    if (restoreRafId !== null) {
      cancelAnimationFrame(restoreRafId);
      restoreRafId = null;
    }
    if (reloadInFlight) {
      // The rebuilt PDF is still loading; applying now would scroll the OLD
      // document and the imminent setDocument would reset us to the top,
      // losing the jump. Defer so pagesinit lands it on the NEW pages.
      state.pendingSync = payload;
      return;
    }
    const pageIndex = payload.page - 1;
    const pageView = pdfViewer.getPageView(pageIndex);
    if (
      !pageView ||
      !scrollEl ||
      !(pageView.div instanceof HTMLElement) ||
      !pageView.div.isConnected ||
      !pageView.viewport
    ) {
      state.pendingSync = payload;
      return;
    }
    state.lastSync = payload;
    clearSyncMarker();
    const pagePdfHeight = resolvePagePdfHeight(pageView);
    const payloadY = Number(payload.y);
    const normalizedY =
      Number.isFinite(pagePdfHeight) &&
      pagePdfHeight > 0 &&
      Number.isFinite(payloadY)
        ? pagePdfHeight - payloadY
        : payloadY;
    const [rawViewX, rawViewY] = pageView.viewport.convertToViewportPoint(
      payload.x,
      normalizedY
    );
    const viewportScale = resolveViewportScale(pageView);
    const viewX = rawViewX * viewportScale.x;
    const viewY = rawViewY * viewportScale.y;
    state.lastSyncDebug = {
      page: payload.page,
      x: payload.x,
      y: payload.y,
      normalizedY,
      viewX,
      viewY,
    };
    const contentOffset = resolvePageContentOffset(pageView.div);
    scrollEl.scrollTo({
      top:
        pageView.div.offsetTop +
        contentOffset.top +
        viewY -
        scrollEl.clientHeight / 2,
      behavior: "auto",
    });
    applySyncHighlight(pageView, payload, viewX, viewY);
  };

  const loadDocument = async (url, path) => {
    // Re-opening the SAME PDF (a rebuild, or the reload button) should keep the
    // current scroll position instead of jumping back to the top — the user is
    // often zoomed into one spot and rebuilding repeatedly. Zoom level is
    // already preserved via state.scale/scaleMode (re-applied on pagesinit).
    const isReload = !!state.doc && state.path !== null && state.path === path;
    const restorePosition =
      isReload && scrollEl
        ? { scrollTop: scrollEl.scrollTop, scrollLeft: scrollEl.scrollLeft }
        : null;
    state.url = url;
    state.path = path;
    state.pendingSync = null;
    state.pendingRestore = restorePosition;
    reloadInFlight = true;
    clearSidebarContent();
    clearSyncMarker();
    setStatus("読み込み中...");
    try {
      const task = pdfjs.getDocument(url);
      state.doc = await task.promise;
      state.pageCount = state.doc.numPages;
      updatePageCount();
      if (titleEl) {
        titleEl.textContent = path ? path.split(/[\\/]/).slice(-1)[0] : "PDF";
      }
      pdfViewer.setDocument(state.doc);
      linkService.setDocument(state.doc, null);
      renderOutline();
      renderThumbnails();
      setStatus("準備完了");
    } catch (error) {
      reloadInFlight = false;
      setStatus("読み込みに失敗しました。");
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  const runSearch = (findPrevious = false) => {
    if (!state.doc || !searchInput) return;
    const query = searchInput.value.trim();
    if (!query) return;
    eventBus.dispatch("find", {
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      phraseSearch: true,
      matchDiacritics: false,
    });
  };

  const downloadPdf = async () => {
    if (!state.doc) return;
    const data = await state.doc.getData();
    const blob = new Blob([data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const filename = state.path ? state.path.split(/[\\/]/).pop() : "document.pdf";
    const link = document.createElement("a");
    link.href = url;
    if (filename) {
      link.download = filename;
    }
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const rotate = (direction) => {
    if (!state.doc) return;
    const delta = direction === "right" ? 90 : -90;
    state.rotation = (state.rotation + delta + 360) % 360;
    pdfViewer.pagesRotation = state.rotation;
    clearSyncMarker();
  };

  const restoreScrollPosition = (target) => {
    if (!scrollEl || !target) return;
    const apply = () => {
      scrollEl.scrollTop = target.scrollTop;
      scrollEl.scrollLeft = target.scrollLeft;
    };
    // pdf.js keeps snapping the view back toward the top for several frames
    // after `pagesinit` — page sizing finalizes asynchronously and the scale
    // re-apply re-scrolls to the current page (which reset to 1 on reload).
    // A single re-apply loses that race, so re-assert our target every frame
    // until it sticks for a few consecutive frames (or we hit the safety cap).
    // A SyncTeX jump cancels restoreRafId via applySync to take precedence.
    let frames = 0;
    let heldFrames = 0;
    const maxFrames = 90;
    apply();
    const tick = () => {
      if (Math.abs(scrollEl.scrollTop - target.scrollTop) <= 2) {
        heldFrames += 1;
      } else {
        heldFrames = 0;
      }
      apply();
      frames += 1;
      if (heldFrames >= 4 || frames >= maxFrames) {
        restoreRafId = null;
        return;
      }
      restoreRafId = requestAnimationFrame(tick);
    };
    if (restoreRafId !== null) cancelAnimationFrame(restoreRafId);
    restoreRafId = requestAnimationFrame(tick);
  };

  eventBus.on("pagesinit", () => {
    // The new document's pages are ready; deferred SyncTeX jumps may now apply.
    reloadInFlight = false;
    applyScaleMode(state.scaleMode);
    updateZoomLabel();
    updatePageCount();
    if (state.pendingSync) {
      const payload = state.pendingSync;
      state.pendingSync = null;
      state.pendingRestore = null;
      applySync(payload);
    } else if (state.pendingRestore) {
      const target = state.pendingRestore;
      state.pendingRestore = null;
      restoreScrollPosition(target);
    }
  });

  eventBus.on("pagerendered", () => {
    if (!state.pendingSync) {
      return;
    }
    const payload = state.pendingSync;
    state.pendingSync = null;
    applySync(payload);
  });

  eventBus.on("scalechanging", (event) => {
    if (!event || typeof event.scale !== "number") {
      return;
    }
    updateScaleState(event.scale);
  });

  eventBus.on("pagechanging", (event) => {
    if (pageInput) {
      pageInput.value = String(event.pageNumber);
    }
  });

  if (scrollEl) {
    scrollEl.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }
        event.preventDefault();
        const zoomFactor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
        const origin = getZoomOrigin(event.clientX, event.clientY);
        applyZoomFactor(zoomFactor, origin);
      },
      { passive: false }
    );

    let touchPinch = null;
    const getTouchDistance = (touches) => {
      if (touches.length < 2) return 0;
      const [first, second] = touches;
      const dx = second.clientX - first.clientX;
      const dy = second.clientY - first.clientY;
      return Math.hypot(dx, dy);
    };

    const getTouchCenter = (touches) => {
      if (touches.length < 2) return null;
      const [first, second] = touches;
      return {
        x: (first.clientX + second.clientX) / 2,
        y: (first.clientY + second.clientY) / 2,
      };
    };

    scrollEl.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length === 2) {
          const startDistance = getTouchDistance(event.touches);
          const center = getTouchCenter(event.touches);
          touchPinch = {
            lastDistance: startDistance,
            lastCenter: center,
          };
        }
      },
      { passive: true }
    );

    scrollEl.addEventListener(
      "touchmove",
      (event) => {
        if (!touchPinch || event.touches.length !== 2) {
          return;
        }
        event.preventDefault();
        const distance = getTouchDistance(event.touches);
        if (!distance || !touchPinch.lastDistance) {
          return;
        }
        const ratio = distance / touchPinch.lastDistance;
        const center = getTouchCenter(event.touches) ?? touchPinch.lastCenter;
        if (!Number.isFinite(ratio) || ratio <= 0) {
          return;
        }
        const origin = center ? getZoomOrigin(center.x, center.y) : null;
        applyZoomFactor(ratio, origin);
        touchPinch.lastDistance = distance;
        touchPinch.lastCenter = center;
      },
      { passive: false }
    );

    const clearTouchPinch = (event) => {
      if (touchPinch && event.touches.length < 2) {
        touchPinch = null;
      }
    };
    scrollEl.addEventListener("touchend", clearTouchPinch);
    scrollEl.addEventListener("touchcancel", clearTouchPinch);
  }

  if (pageInput) {
    pageInput.addEventListener("change", () => {
      const value = Number.parseInt(pageInput.value, 10);
      if (Number.isFinite(value)) {
        setPage(value);
      }
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const current = Number.parseInt(pageInput?.value ?? "1", 10);
      scrollToPage(Math.max(1, current - 1));
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const current = Number.parseInt(pageInput?.value ?? "1", 10);
      scrollToPage(Math.min(state.pageCount, current + 1));
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      applyScaleTo(state.scale - 0.1, getScrollCenter());
    });
  }

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      applyScaleTo(state.scale + 0.1, getScrollCenter());
    });
  }

  if (fitWidthBtn) {
    fitWidthBtn.addEventListener("click", () => {
      applyScaleMode("fit-width");
    });
  }

  if (fitPageBtn) {
    fitPageBtn.addEventListener("click", () => {
      applyScaleMode("fit-page");
    });
  }

  if (rotateLeftBtn) {
    rotateLeftBtn.addEventListener("click", () => {
      rotate("left");
    });
  }

  if (rotateRightBtn) {
    rotateRightBtn.addEventListener("click", () => {
      rotate("right");
    });
  }

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      setSidebarVisible(!state.sidebarVisible);
    });
  }

  if (outlineTabBtn) {
    outlineTabBtn.addEventListener("click", () => {
      setSidebarVisible(true);
      setSidebarTab("outline");
    });
  }

  if (thumbsTabBtn) {
    thumbsTabBtn.addEventListener("click", () => {
      setSidebarVisible(true);
      setSidebarTab("thumbs");
    });
  }

  if (invertBtn) {
    invertBtn.addEventListener("click", () => {
      setInverted(!document.body.classList.contains("is-inverted"));
    });
  }

  if (searchInput) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(event.shiftKey);
      }
    });
  }

  if (searchPrevBtn) {
    searchPrevBtn.addEventListener("click", () => {
      runSearch(true);
    });
  }

  if (searchNextBtn) {
    searchNextBtn.addEventListener("click", () => {
      runSearch(false);
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      downloadPdf();
    });
  }

  if (printBtn) {
    printBtn.addEventListener("click", () => {
      window.print();
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      if (!state.url) {
        return;
      }
      const baseUrl = state.url.split("?")[0];
      const nextUrl = `${baseUrl}?t=${Date.now()}`;
      loadDocument(nextUrl, state.path);
    });
  }

  if (bridge && typeof bridge.onMessage === "function") {
    bridge.onMessage((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "open") {
        const payload = message.payload || {};
        if (payload.url) {
          loadDocument(payload.url, payload.path || null);
        }
      }
      if (message.type === "sync" && message.payload) {
        applySync(message.payload);
      }
    });
    if (typeof bridge.postMessage === "function") {
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", () => {
          bridge.postMessage({ type: "ready" });
        });
      } else {
        bridge.postMessage({ type: "ready" });
      }
    }
  }

  if (pagesEl) {
    pagesEl.addEventListener("contextmenu", (event) => {
      if (!event) {
        return;
      }
      if (!isReverseSynctexEnabled()) {
        return;
      }
      const point = resolveClickPoint(event);
      if (!point) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openReverseContextMenu(event, point);
    });

    pagesEl.addEventListener("click", (event) => {
      if (!event) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (!isReverseSynctexEnabled()) {
        return;
      }
      const point = resolveClickPoint(event);
      if (!point) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      postReverseRequest(point);
    });
  }
};

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initPdfViewer);
} else {
  initPdfViewer();
}
