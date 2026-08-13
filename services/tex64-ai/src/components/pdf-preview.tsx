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
  /** True while a newer PDF is being compiled: keep pages visible, dim them. */
  refreshing: boolean;
  /** False = plain viewer without the hover/click overlay (e.g. mobile). */
  interactive: boolean;
  onSelect: (id: string | null) => void;
  emptyHint?: string;
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
  emptyHint = "まだ紙面がありません",
}: PdfPreviewProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Loading task backing the currently displayed document. */
  const committedTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  /** Scroll metrics captured just before a new document swaps in. */
  const scrollRestoreRef = useRef<ScrollMetrics | null>(null);
  const docKeyRef = useRef(0);

  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [loading, setLoading] = useState(pdfUrl !== null);
  const [loadFailed, setLoadFailed] = useState(false);
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

  const regionsByPage = useMemo(() => groupRectsByPage(regions ?? []), [regions]);
  const overlayActive =
    interactive && regions !== null && regions.length > 0 && loaded !== null;
  // While refreshing the overlay stays visible (selected outline included) but
  // ignores the pointer, so any lingering hover state is simply not shown.
  const effectiveHoveredId = overlayActive && !refreshing ? hoveredId : null;

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
        {loadFailed ? (
          <div className={styles.errorBanner} role="alert">
            <CircleAlert aria-hidden="true" size={14} />
            <span>紙面を表示できませんでした</span>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => {
                setLoadFailed(false);
                setLoading(true);
                setRetryToken((token) => token + 1);
              }}
            >
              <RotateCw aria-hidden="true" size={13} />
              再試行
            </button>
          </div>
        ) : null}
        {refreshing && loaded && !loadFailed ? (
          <div className={styles.refreshPill} role="status">
            <span className={styles.refreshDot} aria-hidden="true" />
            紙面を更新中
          </div>
        ) : null}

        <div ref={scrollerRef} className={styles.scroller} onScroll={handleScroll}>
          {loaded ? (
            <div
              className={clsx(styles.pages, refreshing && styles.pagesDimmed)}
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
                    disabled={refreshing}
                    onHover={setHoveredId}
                    onSelect={onSelect}
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
  /** True while refreshing: overlay stays visible but ignores the pointer. */
  disabled: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
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
  disabled,
  onHover,
  onSelect,
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
    const renderTask = page.render({ canvas, viewport });
    renderTask.promise.catch(() => {
      // Cancelled or superseded renders keep the previous frame; document
      // level failures surface through the error banner instead.
    });
    return () => {
      renderTask.cancel();
    };
  }, [page, scale, dpr]);

  return (
    <div className={styles.page} style={{ width: cssWidth, height: cssHeight }}>
      <canvas
        ref={canvasRef}
        className={styles.pageCanvas}
        style={{ width: cssWidth, height: cssHeight }}
        aria-hidden="true"
      />
      {regionRects ? (
        <div
          className={clsx(styles.overlay, disabled && styles.overlayDisabled)}
          onClick={() => {
            if (!disabled) onSelect(null);
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
        </div>
      ) : null}
    </div>
  );
}
