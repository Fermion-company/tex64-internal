"use client";

import clsx from "clsx";
import { CircleAlert, Minus, Plus, RotateCw } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  ZOOM_STEP_PERCENT,
  anchoredScrollOffset,
  bpRectToPx,
  clampZoomPercent,
  computePageOffsets,
  currentPageFromScroll,
  fitToWidthPercent,
  groupRectsByPage,
  pinchZoomPercent,
  preservedScrollTop,
  type PageRegionRect,
  type PdfElementRegion,
  type ScrollMetrics,
} from "./pdf-preview-geometry";
import {
  findTextBlock,
  hasSelectableText,
  type TextItemLike,
  type TextRect,
} from "./pdf-text-blocks";
import styles from "./pdf-preview.module.css";

/** Composes two 2-D affine transforms, as pdf.js stores them. */
function applyTransform(outer: number[], inner: number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = outer;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export type { PdfElementRegion, PdfRegionRect } from "./pdf-preview-geometry";

export interface PdfPreviewProps {
  /** Same-origin URL of the compiled PDF; null = nothing compiled yet. */
  pdfUrl: string | null;
  /** Element regions for the overlay; null/[] = overlay disabled. */
  regions: PdfElementRegion[] | null;
  selectedId: string | null;
  /** True while a newer PDF is compiling. Shows a pill; never blocks the page. */
  refreshing: boolean;
  /** False = plain viewer without the hover/click overlay (e.g. mobile). */
  interactive: boolean;
  onSelect: (id: string | null) => void;
  /**
   * A click on the page itself, in PDF points from the page's top-left. Used
   * where there is no element map — the workspace's own build — to ask SyncTeX
   * what the reader pointed at.
   */
  onPointSelect?: (point: {
    page: number;
    x: number;
    y: number;
    /** Lines of the text block the click landed in, for outlining it. */
    rects: TextRect[];
    /** Human-visible text used to resolve generated structures such as titles. */
    text: string;
  }) => void;
  /** False removes a native point highlight after it proved non-editable. */
  pointSelectionActive?: boolean;
  emptyHint?: string;
  /** Card anchored just below the selected region (編集カード). */
  selectionCard?: ReactNode;
  /** Extra control at the toolbar's right end (e.g. the build button). */
  toolbarAction?: ReactNode;
}

/** Gap between pages inside the scroller (kept in JS so scroll math matches). */
const PAGE_GAP_PX = 16;
/** Padding around the page stack (kept in JS so scroll math matches). */
const STAGE_PADDING_PX = 24;
/** Keep pinch frames cheap; redraw the PDF crisply after the gesture settles. */
const HIGH_RES_RENDER_DELAY_MS = 120;
/** Commit the GPU preview to actual page layout once the pinch stream pauses. */
const PINCH_COMMIT_DELAY_MS = 80;

type PdfJsModule = typeof import("pdfjs-dist");
type PdfDocumentInitParameters = NonNullable<Parameters<PdfJsModule["getDocument"]>[0]>;

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

/**
 * Load pdfjs lazily on the client only. The worker is created from the
 * bundler-emitted asset (`new URL(..., import.meta.url)` works under both
 * turbopack and webpack) so the production CSP (`worker-src 'self' blob:`,
 * no `unsafe-eval`) is satisfied without any CDN or eval fallback.
 */
function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsModulePromise ??= import("pdfjs-dist").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(
        new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
        { type: "module" },
      );
    }
    return pdfjs;
  });
  return pdfjsModulePromise;
}

interface LoadedDocument {
  /** Monotonic key: bumps once per successfully swapped-in document. */
  key: number;
  pages: PDFPageProxy[];
  /** Per-page size of `getViewport({ scale: 1 })`, i.e. bp. */
  baseSizes: { width: number; height: number }[];
}

type ZoomState = { mode: "fit" } | { mode: "manual"; percent: number };

type PendingZoomAnchor = {
  clientX: number;
  clientY: number;
  fromPercent: number;
  pageIndex: number | null;
  pageXRatio: number;
  pageYRatio: number;
  scrollLeft: number;
  scrollTop: number;
  viewportX: number;
  viewportY: number;
};

type ActivePinch = {
  basePercent: number;
  targetPercent: number;
  anchor: PendingZoomAnchor;
  originX: number;
  originY: number;
};

const EMPTY_SIZES: { width: number; height: number }[] = [];

export function PdfPreview({
  pdfUrl,
  regions,
  selectedId,
  refreshing,
  interactive,
  onSelect,
  onPointSelect,
  pointSelectionActive,
  emptyHint = "まだ紙面がありません",
  selectionCard = null,
  toolbarAction = null,
}: PdfPreviewProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  /** Loading task backing the currently displayed document. */
  const committedTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  /** Scroll metrics captured just before a new document swaps in. */
  const scrollRestoreRef = useRef<ScrollMetrics | null>(null);
  const pendingZoomAnchorRef = useRef<PendingZoomAnchor | null>(null);
  const zoomPercentRef = useRef(100);
  const loadedRef = useRef<LoadedDocument | null>(null);
  const docKeyRef = useRef(0);
  /** Page indices whose latest render failed for a non-cancellation reason. */
  const failedPagesRef = useRef<Set<number>>(new Set());

  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(pdfUrl !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** A page render failed while the canvas still shows the previous frame. */
  const [renderFailed, setRenderFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [zoom, setZoom] = useState<ZoomState>({ mode: "fit" });
  const [renderZoomPercent, setRenderZoomPercent] = useState(100);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [dpr, setDpr] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  // Adjust state during render when the URL prop changes (the react.dev
  // "adjusting some state when a prop changes" pattern — no effect needed).
  const [lastUrl, setLastUrl] = useState<string | null>(pdfUrl);
  if (lastUrl !== pdfUrl) {
    setLastUrl(pdfUrl);
    setLoadFailed(false);
    setRenderFailed(false);
    setLoading(pdfUrl !== null);
    if (!pdfUrl) {
      setLoaded(null);
      setCurrentPage(1);
    }
  }

  // Load (or release) the document whenever the URL changes or a retry is
  // asked. The new document is fully loaded and measured *before* it replaces
  // the previous one, so a recompile never blanks the viewer.
  useEffect(() => {
    // Page-render failures belong to the document being replaced.
    failedPagesRef.current.clear();
    if (!pdfUrl) {
      docKeyRef.current = 0;
      const stale = committedTaskRef.current;
      committedTaskRef.current = null;
      if (stale) void stale.destroy().catch(() => undefined);
      return;
    }

    let cancelled = false;
    let inFlight: PDFDocumentLoadingTask | null = null;

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // pdfjs-dist 6.x dropped `isEvalSupported` (its display build contains
        // no eval path at all); the flag is kept as harmless defense-in-depth
        // for the no-unsafe-eval production CSP.
        const params: PdfDocumentInitParameters & { isEvalSupported: boolean } = {
          url: pdfUrl,
          isEvalSupported: false,
        };
        const task = pdfjs.getDocument(params);
        inFlight = task;
        const doc = await task.promise;
        const pageNumbers = Array.from({ length: doc.numPages }, (_, index) => index + 1);
        const pages = await Promise.all(pageNumbers.map((number) => doc.getPage(number)));
        if (cancelled) return;
        const baseSizes = pages.map((page) => {
          const viewport = page.getViewport({ scale: 1 });
          return { width: viewport.width, height: viewport.height };
        });
        const scroller = scrollerRef.current;
        if (scroller && docKeyRef.current > 0) {
          scrollRestoreRef.current = {
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
          };
        }
        const stale = committedTaskRef.current;
        committedTaskRef.current = task;
        inFlight = null;
        if (stale) void stale.destroy().catch(() => undefined);
        docKeyRef.current += 1;
        setLoaded({ key: docKeyRef.current, pages, baseSizes });
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          setLoading(false);
        }
        const failed = inFlight;
        inFlight = null;
        if (failed && failed !== committedTaskRef.current) {
          void failed.destroy().catch(() => undefined);
        }
      }
    })();

    return () => {
      cancelled = true;
      const abandoned = inFlight;
      inFlight = null;
      if (abandoned && abandoned !== committedTaskRef.current) {
        void abandoned.destroy().catch(() => undefined);
      }
    };
  }, [pdfUrl, retryToken]);

  // Release the displayed document on unmount.
  useEffect(
    () => () => {
      const stale = committedTaskRef.current;
      committedTaskRef.current = null;
      if (stale) void stale.destroy().catch(() => undefined);
    },
    [],
  );

  // Track the scroller width (fit-to-width) and the devicePixelRatio.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      setViewportWidth(scroller.clientWidth);
      setDpr(window.devicePixelRatio || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const baseSizes = loaded ? loaded.baseSizes : EMPTY_SIZES;
  const maxPageWidthBp = useMemo(
    () => baseSizes.reduce((max, size) => Math.max(max, size.width), 0),
    [baseSizes],
  );
  const fitPercent = fitToWidthPercent(viewportWidth - STAGE_PADDING_PX * 2, maxPageWidthBp);
  const zoomPercent = zoom.mode === "fit" ? fitPercent : zoom.percent;
  const scale = zoomPercent / 100;
  const renderScale = renderZoomPercent / 100;

  // During a pinch the previous canvas frame is stretched by CSS. Render the
  // expensive high-resolution PDF only after input has been quiet briefly.
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      setRenderZoomPercent(zoomPercent);
    }, HIGH_RES_RENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, zoomPercent]);

  // Keep the exact paper point under the fingers after the layout scale moves.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pages = pagesRef.current;
    const anchor = pendingZoomAnchorRef.current;
    pendingZoomAnchorRef.current = null;
    // React has now laid the pages out at the committed scale. Remove the
    // temporary GPU preview before measuring so this frame swaps seamlessly
    // from the gesture transform to the real scrollable geometry.
    if (pages) {
      pages.style.removeProperty("transform");
      pages.style.removeProperty("transform-origin");
      pages.style.removeProperty("will-change");
    }
    if (scroller && anchor && anchor.fromPercent !== zoomPercent) {
      const pageNode =
        anchor.pageIndex === null
          ? null
          : scroller.querySelector<HTMLElement>(
              `[data-pdf-page-index="${anchor.pageIndex}"]`,
            );
      if (pageNode) {
        const pageRect = pageNode.getBoundingClientRect();
        scroller.scrollLeft +=
          pageRect.left + pageRect.width * anchor.pageXRatio - anchor.clientX;
        scroller.scrollTop +=
          pageRect.top + pageRect.height * anchor.pageYRatio - anchor.clientY;
      } else {
        const factor = zoomPercent / anchor.fromPercent;
        scroller.scrollLeft = anchoredScrollOffset(
          anchor.scrollLeft,
          anchor.viewportX,
          factor,
        );
        scroller.scrollTop = anchoredScrollOffset(
          anchor.scrollTop,
          anchor.viewportY,
          factor,
        );
      }
    }
    zoomPercentRef.current = zoomPercent;
  }, [zoomPercent]);

  const pageHeightsPx = useMemo(
    () => baseSizes.map((size) => size.height * scale),
    [baseSizes, scale],
  );
  const pageOffsets = useMemo(
    () => computePageOffsets(pageHeightsPx, PAGE_GAP_PX, STAGE_PADDING_PX),
    [pageHeightsPx],
  );

  // Where a point-based selection landed, so its card has a page to sit under
  // when there is no element map to anchor to.
  const [pointAt, setPointAt] = useState<{
    page: number;
    y: number;
    rects: TextRect[];
  } | null>(null);
  const activePointAt = pointSelectionActive === false ? null : pointAt;
  const regionsByPage = useMemo(() => groupRectsByPage(regions ?? []), [regions]);
  // 編集カードは、選択要素の矩形が載っている最後のページの直下にアンカーする。
  const selectionCardPage = useMemo(() => {
    if (!selectedId || !selectionCard) return null;
    let host: number | null = null;
    for (const [pageNumber, rects] of regionsByPage) {
      if (rects.some((entry) => entry.regionId === selectedId)) {
        host = host === null ? pageNumber : Math.max(host, pageNumber);
      }
    }
    return host;
  }, [selectedId, selectionCard, regionsByPage]);
  const overlayActive =
    interactive && regions !== null && regions.length > 0 && loaded !== null;
  // A compile in flight is background work: the page stays readable and
  // clickable throughout, and the refresh pill is the only sign of it.
  const effectiveHoveredId = overlayActive ? hoveredId : null;

  // Restore the scroll ratio right after a new document swapped in, before
  // the browser paints the new layout.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const previous = scrollRestoreRef.current;
    if (!scroller || !previous) return;
    scrollRestoreRef.current = null;
    scroller.scrollTop = preservedScrollTop(previous, {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
  }, [loaded]);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setCurrentPage(currentPageFromScroll(scroller.scrollTop, scroller.clientHeight, pageOffsets));
  }, [pageOffsets]);

  // Chromium represents a trackpad pinch as a cancelable ctrl+wheel stream.
  // Consume only that gesture: ordinary two-finger scrolling remains native.
  // Pinch frames transform the already-painted page stack directly on the GPU;
  // React layout and PDF rendering run only once after the fingers pause.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const pages = pagesRef.current;
    if (!scroller || !pages) return;
    let frame: number | null = null;
    let commitTimer: number | null = null;
    let pendingDeltaPixels = 0;
    let gesture: ActivePinch | null = null;

    const applyPinch = () => {
      frame = null;
      if (!gesture || !loadedRef.current || pendingDeltaPixels === 0) return;
      gesture.targetPercent = pinchZoomPercent(
        gesture.targetPercent,
        pendingDeltaPixels,
      );
      pendingDeltaPixels = 0;
      const factor = gesture.targetPercent / gesture.basePercent;
      pages.style.transformOrigin = `${gesture.originX}px ${gesture.originY}px`;
      pages.style.transform = `scale(${factor})`;
      pages.style.willChange = "transform";
    };

    const commitPinch = () => {
      commitTimer = null;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
        applyPinch();
      }
      const completed = gesture;
      gesture = null;
      if (!completed) return;
      if (Math.abs(completed.targetPercent - completed.basePercent) < 0.01) {
        pages.style.removeProperty("transform");
        pages.style.removeProperty("transform-origin");
        pages.style.removeProperty("will-change");
        return;
      }
      pendingZoomAnchorRef.current = completed.anchor;
      setZoom({ mode: "manual", percent: completed.targetPercent });
    };

    const handlePinchWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !loadedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      if (!gesture) {
        const pageNode =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-pdf-page-index]")
            : null;
        const pageRect = pageNode?.getBoundingClientRect();
        const pageIndex = pageNode
          ? Number(pageNode.dataset.pdfPageIndex)
          : null;
        const scrollerBounds = scroller.getBoundingClientRect();
        const pagesBounds = pages.getBoundingClientRect();
        const viewportX = Math.min(
          scroller.clientWidth,
          Math.max(0, event.clientX - scrollerBounds.left),
        );
        const viewportY = Math.min(
          scroller.clientHeight,
          Math.max(0, event.clientY - scrollerBounds.top),
        );
        const basePercent = zoomPercentRef.current;
        gesture = {
          basePercent,
          targetPercent: basePercent,
          originX: event.clientX - pagesBounds.left,
          originY: event.clientY - pagesBounds.top,
          anchor: {
            clientX: event.clientX,
            clientY: event.clientY,
            fromPercent: basePercent,
            pageIndex:
              pageIndex !== null && Number.isSafeInteger(pageIndex)
                ? pageIndex
                : null,
            pageXRatio: pageRect
              ? Math.min(1, Math.max(0, (event.clientX - pageRect.left) / pageRect.width))
              : 0,
            pageYRatio: pageRect
              ? Math.min(1, Math.max(0, (event.clientY - pageRect.top) / pageRect.height))
              : 0,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
            viewportX,
            viewportY,
          },
        };
      }
      pendingDeltaPixels += event.deltaY * unit;
      if (frame === null) frame = window.requestAnimationFrame(applyPinch);
      if (commitTimer !== null) window.clearTimeout(commitTimer);
      commitTimer = window.setTimeout(commitPinch, PINCH_COMMIT_DELAY_MS);
    };

    scroller.addEventListener("wheel", handlePinchWheel, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", handlePinchWheel);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (commitTimer !== null) window.clearTimeout(commitTimer);
      pages.style.removeProperty("transform");
      pages.style.removeProperty("transform-origin");
      pages.style.removeProperty("will-change");
    };
  }, [loaded?.key]);

  // Keep the page indicator in sync when the layout (zoom, document) changes.
  useEffect(() => {
    handleScroll();
  }, [handleScroll]);

  const adjustZoom = (delta: number) => {
    setZoom({ mode: "manual", percent: clampZoomPercent(zoomPercent + delta) });
  };

  const handleRendered = useCallback((index: number) => {
    if (failedPagesRef.current.delete(index)) {
      setRenderFailed(failedPagesRef.current.size > 0);
    }
  }, []);
  const handleRenderFailed = useCallback((index: number) => {
    failedPagesRef.current.add(index);
    setRenderFailed(true);
  }, []);
  const retry = () => {
    failedPagesRef.current.clear();
    setLoadFailed(false);
    setRenderFailed(false);
    setLoading(true);
    setRetryToken((token) => token + 1);
  };
  const failed = loadFailed || renderFailed;

  return (
    <section className={styles.viewer} aria-label="紙面プレビュー">
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolButton}
          aria-label="縮小"
          title="縮小"
          disabled={!loaded || zoomPercent <= MIN_ZOOM_PERCENT}
          onClick={() => adjustZoom(-ZOOM_STEP_PERCENT)}
        >
          <Minus aria-hidden="true" size={14} />
        </button>
        <span className={styles.zoomReadout} title="表示倍率">
          {Math.round(zoomPercent)}%
        </span>
        <button
          type="button"
          className={styles.toolButton}
          aria-label="拡大"
          title="拡大"
          disabled={!loaded || zoomPercent >= MAX_ZOOM_PERCENT}
          onClick={() => adjustZoom(ZOOM_STEP_PERCENT)}
        >
          <Plus aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          className={clsx(styles.fitButton, zoom.mode === "fit" && styles.fitButtonActive)}
          aria-pressed={zoom.mode === "fit"}
          disabled={!loaded}
          onClick={() => setZoom({ mode: "fit" })}
        >
          幅に合わせる
        </button>
        <span className={styles.pageIndicator} aria-label="ページ位置">
          {loaded ? `${currentPage} / ${loaded.pages.length}` : "– / –"}
        </span>
        {toolbarAction}
      </div>

      <div className={styles.stage}>
        {failed ? (
          <div className={styles.errorBanner} role="alert">
            <CircleAlert aria-hidden="true" size={14} />
            <span>
              {loadFailed
                ? "紙面を表示できませんでした"
                : "最新の紙面を描画できませんでした（表示は前の版のままです）"}
            </span>
            <button type="button" className={styles.retryButton} onClick={retry}>
              <RotateCw aria-hidden="true" size={13} />
              再試行
            </button>
          </div>
        ) : null}
        {refreshing && loaded && !failed ? (
          <div className={styles.refreshPill} role="status">
            <span className={styles.refreshDot} aria-hidden="true" />
            紙面を更新中
          </div>
        ) : null}

        <div ref={scrollerRef} className={styles.scroller} onScroll={handleScroll}>
          {loaded ? (
            <div
              ref={pagesRef}
              className={styles.pages}
              style={{ padding: STAGE_PADDING_PX, gap: PAGE_GAP_PX }}
            >
              {loaded.pages.map((page, index) => {
                const size = loaded.baseSizes[index];
                if (!size) return null;
                return (
                  <PdfPageView
                    // Keyed by position on purpose: swapping in a recompiled
                    // document reuses the canvases, so the previous frame
                    // stays visible until the fresh render lands (no flash).
                    key={index}
                    page={page}
                    cssWidth={size.width * scale}
                    cssHeight={size.height * scale}
                    scale={scale}
                    renderScale={renderScale}
                    dpr={dpr}
                    regionRects={overlayActive ? (regionsByPage.get(index + 1) ?? null) : null}
                    hoveredId={effectiveHoveredId}
                    selectedId={selectedId}
                    onHover={setHoveredId}
                    onSelect={onSelect}
                    onPointSelect={
                      onPointSelect
                        ? (point) => {
                            setPointAt({
                              page: point.page,
                              y: point.y,
                              rects: point.rects,
                            });
                            onPointSelect(point);
                          }
                        : undefined
                    }
                    selectionCard={
                      (overlayActive && selectionCardPage === index + 1) ||
                      (!overlayActive && activePointAt?.page === index + 1)
                        ? selectionCard
                        : null
                    }
                    index={index}
                    // A point selection has no region to sit under, so its card
                    // sits where the reader clicked.
                    selectionCardTop={
                      !overlayActive && activePointAt?.page === index + 1
                        ? (activePointAt.rects.at(-1)
                            ? (activePointAt.rects.at(-1)!.top +
                                activePointAt.rects.at(-1)!.height) *
                              scale
                            : activePointAt.y * scale)
                        : null
                    }
                    pointRects={
                      !overlayActive && activePointAt?.page === index + 1
                        ? activePointAt.rects
                        : null
                    }
                    onRendered={handleRendered}
                    onRenderFailed={handleRenderFailed}
                  />
                );
              })}
            </div>
          ) : (
            <div className={styles.emptyState}>
              {pdfUrl && loading ? "紙面を読み込み中…" : emptyHint}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface PdfPageViewProps {
  page: PDFPageProxy;
  cssWidth: number;
  cssHeight: number;
  scale: number;
  /** Debounced high-resolution render scale; CSS uses `scale` immediately. */
  renderScale: number;
  dpr: number;
  /** Rects to overlay on this page; null = overlay disabled. */
  regionRects: PageRegionRect[] | null;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onPointSelect?: (point: {
    page: number;
    x: number;
    y: number;
    rects: TextRect[];
    text: string;
  }) => void;
  /** Outline drawn around what a point selection picked. */
  pointRects?: TextRect[] | null;
  /** Card to render just below the selected region on this page. */
  selectionCard: ReactNode;
  /** Pixels from the page top for a card with no region to follow. */
  selectionCardTop?: number | null;
  /** Position of this page in the stack; identifies it to the parent. */
  index: number;
  /** A fresh frame reached the canvas. */
  onRendered: (index: number) => void;
  /** The render failed for a reason other than being cancelled/superseded. */
  onRenderFailed: (index: number) => void;
}

/** pdfjs reports cancellations by exception name, not by a dedicated type. */
function isRenderingCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "RenderingCancelledException"
  );
}

function PdfPageView({
  page,
  cssWidth,
  cssHeight,
  scale,
  renderScale,
  dpr,
  regionRects,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
  onPointSelect,
  pointRects = null,
  selectionCard,
  selectionCardTop = null,
  index,
  onRendered,
  onRenderFailed,
}: PdfPageViewProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The card scrolls itself into view once, when it appears. An inline ref
  // callback runs again on every render, and re-scrolling each time pins the
  // viewport to the card — the reader could not scroll away while it was open.
  const scrolledCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || renderScale <= 0) return;
    const viewport = page.getViewport({ scale: renderScale * dpr });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    // Pinching does not reach this effect until the gesture settles, so the
    // previous bitmap remains visible and CSS-scaled throughout the motion.
    // Reuse the one canvas per page to avoid doubling memory on long PDFs.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let superseded = false;
    const renderTask = page.render({ canvas, viewport });
    renderTask.promise.then(
      () => {
        if (!superseded) onRendered(index);
      },
      (error: unknown) => {
        // A cancelled render is routine (zoom change, document swap) and keeps
        // the previous frame. A genuine failure must NOT: the canvas still
        // shows the stale frame, so silently swallowing it would report the
        // previous revision as if it were the new one.
        if (superseded || isRenderingCancelled(error)) return;
        onRenderFailed(index);
      },
    );
    return () => {
      superseded = true;
      renderTask.cancel();
    };
  }, [page, renderScale, dpr, index, onRendered, onRenderFailed]);

  return (
    <div
      className={styles.page}
      data-pdf-page-index={index}
      style={{ width: cssWidth, height: cssHeight }}
    >
      <canvas
        ref={canvasRef}
        className={styles.pageCanvas}
        style={{ width: cssWidth, height: cssHeight }}
        aria-hidden="true"
      />
      {pointRects && pointRects.length > 0 ? (
        <div className={styles.overlay} aria-hidden="true">
          {pointRects.map((rect, rectIndex) => (
            <div
              key={`${rect.top}-${rectIndex}`}
              className={clsx(styles.region, styles.regionSelected)}
              style={{
                left: rect.left * scale,
                top: rect.top * scale,
                width: rect.width * scale,
                height: rect.height * scale,
              }}
            />
          ))}
        </div>
      ) : null}
      {!regionRects && onPointSelect ? (
        <div
          className={styles.overlay}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            // The overlay covers the rendered page exactly, so undoing the
            // render scale gives PDF points from its top-left corner.
            const point = {
              x: (event.clientX - bounds.left) / scale,
              y: (event.clientY - bounds.top) / scale,
            };
            const answer = (selection: { rects: TextRect[]; text: string }) => {
              if (!hasSelectableText(selection)) return;
              onPointSelect({ page: index + 1, ...point, ...selection });
            };
            // Text items come in page space (origin bottom-left); the
            // viewport transform puts them in the frame the overlay uses.
            const base = page.getViewport({ scale: 1 });
            void page
              .getTextContent()
              .then((content) =>
                answer(
                  findTextBlock(
                    (content.items as unknown as TextItemLike[]).map((item) =>
                      item.transform
                        ? {
                            ...item,
                            transform: applyTransform(
                              base.transform,
                              item.transform,
                            ),
                          }
                        : item,
                    ),
                    point,
                  ),
                ),
              )
              // Without the page's text the click still selects; it just has
              // nothing to outline.
              .catch(() => answer({ rects: [], text: "" }));
          }}
        />
      ) : null}
      {!regionRects && selectionCard && selectionCardTop !== null ? (
        <div
          ref={(node) => {
            // An inline ref detaches (null) and reattaches on EVERY render,
            // so the null call must not clear the guard — resetting there
            // re-scrolls each render and pins the viewport to the card. The
            // stored node only differs when the card genuinely remounts.
            if (!node || scrolledCardRef.current === node) return;
            scrolledCardRef.current = node;
            node.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }}
          className={styles.selectionCard}
          data-pdf-selection-card
          style={{
            top: Math.min(selectionCardTop + 12, Math.max(8, cssHeight - 260)),
            left: Math.max(8, (cssWidth - Math.min(430, cssWidth - 16)) / 2),
            width: Math.min(430, cssWidth - 16),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {selectionCard}
        </div>
      ) : null}
      {regionRects ? (
        <div
          className={styles.overlay}
          onClick={() => {
            onSelect(null);
          }}
        >
          {regionRects.map((entry) => {
            const px = bpRectToPx(entry.rect, scale);
            const isHovered = hoveredId === entry.regionId;
            const isSelected = selectedId === entry.regionId;
            return (
              <button
                key={entry.rectKey}
                type="button"
                className={clsx(
                  styles.region,
                  isHovered && styles.regionHovered,
                  isSelected && styles.regionSelected,
                )}
                style={{ left: px.left, top: px.top, width: px.width, height: px.height }}
                aria-label={entry.label}
                aria-pressed={isSelected}
                onMouseEnter={() => onHover(entry.regionId)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(entry.regionId)}
                onBlur={() => onHover(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(entry.regionId);
                }}
              >
                {entry.isPrimary ? (
                  <span className={styles.regionLabel} aria-hidden="true">
                    {entry.label}
                  </span>
                ) : null}
              </button>
            );
          })}
          {selectionCard
            ? (() => {
                const selectedPx = regionRects
                  .filter((entry) => entry.regionId === selectedId)
                  .map((entry) => bpRectToPx(entry.rect, scale));
                if (selectedPx.length === 0) return null;
                const anchorTop = Math.min(...selectedPx.map((r) => r.top));
                const anchorBottom = Math.max(...selectedPx.map((r) => r.top + r.height));
                const anchorLeft = Math.min(...selectedPx.map((r) => r.left));
                const width = Math.min(430, cssWidth - 16);
                const left = Math.max(8, Math.min(anchorLeft, cssWidth - width - 8));
                // ページ下端に収まらないときは要素の上側に反転配置する。
                const flip = anchorBottom + 340 > cssHeight && anchorTop > 340;
                const position = flip
                  ? { bottom: cssHeight - anchorTop + 8, left, width }
                  : { top: anchorBottom + 8, left, width };
                return (
                  <div
                    className={styles.selectionCard}
                    data-pdf-selection-card
                    style={position}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {selectionCard}
                  </div>
                );
              })()
            : null}
        </div>
      ) : null}
    </div>
  );
}
