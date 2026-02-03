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

const initPdfViewer = () => {
  const bridge = resolveBridge();
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
  const CLICK_BIAS_X = 0;
  const CLICK_BIAS_Y = 0;
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
    markerTimer: null,
    sidebarVisible: false,
    sidebarTab: "outline",
    thumbObserver: null,
    thumbRendered: new Set(),
  };

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
      outlineEl.textContent = "Outline がありません。";
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
    const rect = pageEl.getBoundingClientRect();
    const viewX = event.clientX - rect.left;
    const viewY = event.clientY - rect.top;
    if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) {
      return null;
    }
    const [x, y] = pageView.viewport.convertToPdfPoint(viewX, viewY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { page, x, y };
  };


  const applySync = (payload) => {
    const pageIndex = payload.page - 1;
    const pageView = pdfViewer.getPageView(pageIndex);
    if (!pageView || !scrollEl) {
      state.pendingSync = payload;
      return;
    }
    state.lastSync = payload;
    clearSyncMarker();
    const [viewX, viewY] = pageView.viewport.convertToViewportPoint(
      payload.x,
      payload.y
    );
    scrollEl.scrollTo({
      top: pageView.div.offsetTop + viewY - scrollEl.clientHeight / 2,
      behavior: "auto",
    });
    if (pageView.div) {
      const marker = document.createElement("div");
      marker.className = "pdf-sync-marker";
      marker.style.left = `${viewX}px`;
      marker.style.top = `${viewY}px`;
      pageView.div.appendChild(marker);
      state.activeMarker = marker;
      state.markerTimer = setTimeout(() => {
        clearSyncMarker();
      }, 1400);
    }
  };

  const loadDocument = async (url, path) => {
    state.url = url;
    state.path = path;
    state.pendingSync = null;
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

  eventBus.on("pagesinit", () => {
    applyScaleMode(state.scaleMode);
    updateZoomLabel();
    updatePageCount();
    if (state.pendingSync) {
      const payload = state.pendingSync;
      state.pendingSync = null;
      applySync(payload);
    }
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
