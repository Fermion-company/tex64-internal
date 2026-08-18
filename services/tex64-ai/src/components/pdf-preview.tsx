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
  bpRectToPx,
  clampZoomPercent,
  computePageOffsets,
  currentPageFromScroll,
  fitToWidthPercent,
  groupRectsByPage,
  preservedScrollTop,
  type PageRegionRect,
  type PdfElementRegion,
  type ScrollMetrics,
} from "./pdf-preview-geometry";
import styles from "./pdf-preview.module.css";

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
  onPointSelect?: (point: { page: number; x: number; y: number }) => void;
  emptyHint?: string;
  /** Card anchored just below the selected region (編集カード). */
  selectionCard?: ReactNode;
}

/** Gap between pages inside the scroller (kept in JS so scroll math matches). */
const PAGE_GAP_PX = 16;
/** Padding around the page stack (kept in JS so scroll math matches). */
const STAGE_PADDING_PX = 24;

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

const EMPTY_SIZES: { width: number; height: number }[] = [];

export function PdfPreview({
  pdfUrl,
  regions,
  selectedId,
  refreshing,
  interactive,
  onSelect,
  onPointSelect,
  emptyHint = "まだ紙面がありません",
  selectionCard = null,
}: PdfPreviewProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Loading task backing the currently displayed document. */
  const committedTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  /** Scroll metrics captured just before a new document swaps in. */
  const scrollRestoreRef = useRef<ScrollMetrics | null>(null);
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
  const [viewportWidth, setViewportWidth] = useState(0);
  const [dpr, setDpr] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
  const [pointPage, setPointPage] = useState<number | null>(null);
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
                    dpr={dpr}
                    regionRects={overlayActive ? (regionsByPage.get(index + 1) ?? null) : null}
                    hoveredId={effectiveHoveredId}
                    selectedId={selectedId}
                    onHover={setHoveredId}
                    onSelect={onSelect}
                    onPointSelect={
                      onPointSelect
                        ? (point) => {
                            setPointPage(point.page);
                            onPointSelect(point);
                          }
                        : undefined
                    }
                    selectionCard={
                      (overlayActive && selectionCardPage === index + 1) ||
                      (!overlayActive && pointPage === index + 1)
                        ? selectionCard
                        : null
                    }
                    index={index}
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
  dpr: number;
  /** Rects to overlay on this page; null = overlay disabled. */
  regionRects: PageRegionRect[] | null;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onPointSelect?: (point: { page: number; x: number; y: number }) => void;
  /** Card to render just below the selected region on this page. */
  selectionCard: ReactNode;
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
  dpr,
  regionRects,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
  onPointSelect,
  selectionCard,
  index,
  onRendered,
  onRenderFailed,
}: PdfPageViewProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || scale <= 0) return;
    const viewport = page.getViewport({ scale: scale * dpr });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    // Only touch the backing store when the size actually changed: resizing
    // clears the canvas, and keeping the previous frame until pdfjs paints the
    // new one is what makes document swaps flash-free.
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
  }, [page, scale, dpr, index, onRendered, onRenderFailed]);

  return (
    <div className={styles.page} style={{ width: cssWidth, height: cssHeight }}>
      <canvas
        ref={canvasRef}
        className={styles.pageCanvas}
        style={{ width: cssWidth, height: cssHeight }}
        aria-hidden="true"
      />
      {!regionRects && onPointSelect ? (
        <div
          className={styles.overlay}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onPointSelect({
              page: index + 1,
              // The overlay covers the rendered page exactly, so undoing the
              // render scale gives PDF points from its top-left corner.
              x: (event.clientX - bounds.left) / scale,
              y: (event.clientY - bounds.top) / scale,
            });
          }}
        />
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
