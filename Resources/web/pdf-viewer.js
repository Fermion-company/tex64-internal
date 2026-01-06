import * as pdfjs from "./pdfjs/pdf.min.mjs";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
} from "./pdfjs/pdf_viewer.mjs";

const initPdfViewer = () => {
  const bridge = window.tex180Pdf;
  const titleEl = document.getElementById("pdf-title");
  const statusEl = document.getElementById("pdf-status");
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
  const downloadBtn = document.getElementById("pdf-download");
  const printBtn = document.getElementById("pdf-print");
  const reloadBtn = document.getElementById("pdf-reload");
  const bodyEl = document.getElementById("pdf-body");
  const scrollEl = document.getElementById("pdf-scroll");
  const pagesEl = document.getElementById("pdf-pages");
  const jumpButton = document.getElementById("pdf-jump-button");

  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "./pdfjs/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3;
  const WHEEL_ZOOM_SENSITIVITY = 0.004;

  const state = {
    doc: null,
    url: null,
    path: null,
    pageCount: 0,
    scale: 1,
    scaleMode: "fit-width",
    rotation: 0,
    pendingSync: null,
    pendingReverse: null,
    activeMarker: null,
  };
  let pendingScale = null;
  let zoomFrame = null;

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
  });
  linkService.setViewer(pdfViewer);

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const updateZoomLabel = () => {
    if (!zoomLabel) return;
    zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
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

  const getScrollAnchor = () => {
    if (!scrollEl) return null;
    const scrollHeight = scrollEl.scrollHeight || 1;
    const anchor =
      (scrollEl.scrollTop + scrollEl.clientHeight / 2) / scrollHeight;
    return Math.min(Math.max(anchor, 0), 1);
  };

  const restoreScrollAnchor = (anchor) => {
    if (!scrollEl || anchor === null) return;
    const scrollHeight = scrollEl.scrollHeight || 0;
    const target = anchor * scrollHeight - scrollEl.clientHeight / 2;
    scrollEl.scrollTop = Math.max(0, target);
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

  const setScale = (nextScale, { preserveScroll = false } = {}) => {
    const anchor = preserveScroll ? getScrollAnchor() : null;
    state.scale = clampScale(nextScale);
    state.scaleMode = "manual";
    pdfViewer.currentScale = state.scale;
    state.scale = pdfViewer.currentScale;
    updateZoomLabel();
    if (anchor !== null) {
      requestAnimationFrame(() => restoreScrollAnchor(anchor));
    }
  };

  const getZoomBaseScale = () => (pendingScale ?? state.scale);

  const scheduleScale = (nextScale) => {
    pendingScale = nextScale;
    if (zoomFrame) {
      return;
    }
    zoomFrame = requestAnimationFrame(() => {
      const target = pendingScale;
      pendingScale = null;
      zoomFrame = null;
      if (typeof target === "number") {
        setScale(target, { preserveScroll: true });
      }
    });
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
    if (state.activeMarker) {
      state.activeMarker.remove();
      state.activeMarker = null;
    }
  };

  const clearJumpTarget = () => {
    state.pendingReverse = null;
    if (jumpButton) {
      jumpButton.classList.remove("is-visible");
    }
  };

  const showJumpButton = (clientX, clientY) => {
    if (!(jumpButton && bodyEl)) return;
    jumpButton.classList.add("is-visible");
    const bounds = bodyEl.getBoundingClientRect();
    const buttonWidth = jumpButton.offsetWidth || 0;
    const buttonHeight = jumpButton.offsetHeight || 0;
    const padding = 8;
    const offset = 12;
    let left = clientX - bounds.left - buttonWidth / 2;
    let top = clientY - bounds.top - buttonHeight - offset;
    const maxLeft = Math.max(padding, bounds.width - buttonWidth - padding);
    const maxTop = Math.max(padding, bounds.height - buttonHeight - padding);
    left = Math.min(Math.max(padding, left), maxLeft);
    top = Math.min(Math.max(padding, top), maxTop);
    jumpButton.style.left = `${left}px`;
    jumpButton.style.top = `${top}px`;
  };

  const applySync = (payload) => {
    const pageIndex = payload.page - 1;
    const pageView = pdfViewer.getPageView(pageIndex);
    if (!pageView || !scrollEl) {
      state.pendingSync = payload;
      return;
    }
    const [viewX, viewY] = pageView.viewport.convertToViewportPoint(
      payload.x,
      payload.y
    );
    let marker = pageView.div.querySelector(".pdf-sync-marker");
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "pdf-sync-marker";
      pageView.div.appendChild(marker);
    }
    state.activeMarker = marker;
    marker.style.left = `${viewX}px`;
    marker.style.top = `${viewY}px`;
    scrollEl.scrollTo({
      top: pageView.div.offsetTop + viewY - scrollEl.clientHeight / 2,
      behavior: "smooth",
    });
  };

  const loadDocument = async (url, path) => {
    state.url = url;
    state.path = path;
    state.pendingSync = null;
    clearJumpTarget();
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
        scheduleScale(getZoomBaseScale() * zoomFactor);
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

    scrollEl.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length === 2) {
          const startDistance = getTouchDistance(event.touches);
          touchPinch = {
            lastDistance: startDistance,
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
        if (!Number.isFinite(ratio) || ratio <= 0) {
          return;
        }
        scheduleScale(getZoomBaseScale() * ratio);
        touchPinch.lastDistance = distance;
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
    scrollEl.addEventListener("scroll", () => {
      if (state.pendingReverse) {
        clearJumpTarget();
      }
    });
  }

  if (pagesEl) {
    pagesEl.addEventListener("click", (event) => {
      if (!bridge || !state.path) return;
      const target = event.target.closest(".page");
      if (!target) {
        clearJumpTarget();
        return;
      }
      const pageNumber = Number.parseInt(target.dataset.pageNumber, 10);
      if (!Number.isFinite(pageNumber)) return;
      const pageView = pdfViewer.getPageView(pageNumber - 1);
      if (!pageView) return;
      const rect = pageView.div.getBoundingClientRect();
      const borderX = pageView.div.clientLeft || 0;
      const borderY = pageView.div.clientTop || 0;
      let x = event.clientX - rect.left - borderX;
      let y = event.clientY - rect.top - borderY;
      x = Math.max(0, x);
      y = Math.max(0, y);
      const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(x, y);
      state.pendingReverse = {
        page: pageNumber,
        x: pdfX,
        y: pdfY,
        pdfPath: state.path,
      };
      showJumpButton(event.clientX, event.clientY);
    });
  }

  if (jumpButton) {
    jumpButton.addEventListener("click", () => {
      if (!bridge || !state.pendingReverse) {
        clearJumpTarget();
        return;
      }
      bridge.postMessage({
        type: "synctex:reverse",
        ...state.pendingReverse,
      });
      clearJumpTarget();
    });
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
      setScale(state.scale - 0.1, { preserveScroll: true });
    });
  }

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      setScale(state.scale + 0.1, { preserveScroll: true });
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

  if (bridge) {
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
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", () => {
        bridge.postMessage({ type: "ready" });
      });
    } else {
      bridge.postMessage({ type: "ready" });
    }
  }
};

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initPdfViewer);
} else {
  initPdfViewer();
}
