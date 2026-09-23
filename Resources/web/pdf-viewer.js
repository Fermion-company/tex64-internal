import * as pdfjs from "./pdfjs/pdf.min.mjs";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
} from "./pdfjs/pdf_viewer.mjs";
import {
  calculateZoomChange,
  clampZoomScale,
  wheelDeltaToZoomFactor,
} from "./pdf-zoom-math.mjs";
import {
  normalizeLiveToolbarSnapshot,
  stepLiveToolbarPage,
} from "./pdf-live-toolbar-state.mjs";
import { resolvePdfLiveStatus } from "./app/pdf-live-status.js";

// This page runs in its own iframe and never goes through the app's initI18n(),
// so it reads the stored UI locale itself. English is the source language and
// the fallback, matching the app's i18n default.
const UI_LOCALE_STORAGE_KEY = "tex64.ui.locale.v1";
const UI_STRINGS = {
  noPdf: {
    en: "No PDF is loaded.",
    ja: "PDF が未読み込みです。",
    zh: "尚未加载 PDF。",
    ko: "PDF가 로드되지 않았습니다.",
    fr: "Aucun PDF n’est chargé.",
    de: "Es ist kein PDF geladen.",
    es: "No hay ningún PDF cargado.",
  },
  noOutline: {
    en: "No outline.",
    ja: "目次がありません。",
    zh: "没有目录。",
    ko: "목차가 없습니다.",
    fr: "Aucun sommaire.",
    de: "Keine Gliederung.",
    es: "No hay índice.",
  },
  askAxiom: {
    en: "Ask Axiom",
    ja: "Axiom に聞く",
    zh: "问 Axiom",
    ko: "Axiom에게 묻기",
    fr: "Demander à Axiom",
    de: "Axiom fragen",
    es: "Preguntar a Axiom",
  },
  jumpToSource: {
    en: "Jump to source",
    ja: "ソースへ移動",
    zh: "跳转到源码",
    ko: "소스로 이동",
    fr: "Aller à la source",
    de: "Zur Quelle springen",
    es: "Ir al código fuente",
  },
  loading: {
    en: "Loading…",
    ja: "読み込み中...",
    zh: "加载中…",
    ko: "불러오는 중…",
    fr: "Chargement…",
    de: "Wird geladen…",
    es: "Cargando…",
  },
  ready: {
    en: "PDF loaded",
    ja: "PDF読込済み",
    zh: "PDF已加载",
    ko: "PDF 로드됨",
    fr: "PDF chargé",
    de: "PDF geladen",
    es: "PDF cargado",
  },
  rebuildNeeded: { en: "Rebuild needed", ja: "再ビルドが必要", zh: "需要重新编译", ko: "다시 빌드 필요", fr: "Recompilation nécessaire", de: "Neu kompilieren", es: "Es necesario recompilar" },
  live: { en: "Live", ja: "ライブ", zh: "实时", ko: "라이브", fr: "Direct", de: "Live", es: "En vivo" },
  liveUpdating: { en: "Updating…", ja: "更新中...", zh: "正在更新…", ko: "업데이트 중…", fr: "Mise à jour…", de: "Aktualisierung…", es: "Actualizando…" },
  buildFailedLastGood: { en: "Build failed · previous PDF retained", ja: "ビルド失敗・前のPDFを保持", zh: "编译失败 · 已保留先前的 PDF", ko: "빌드 실패 · 이전 PDF 유지", fr: "Échec de la compilation · PDF précédent conservé", de: "Build fehlgeschlagen · vorherige PDF bleibt", es: "Error de compilación · se conserva el PDF anterior" },
  liveExactRendering: { en: "Rendering exact changes…", ja: "差分を描画中…", zh: "正在精确渲染差异…", ko: "변경 사항을 정밀 렌더링 중…", fr: "Rendu exact des modifications…", de: "Exakte Änderungen werden gerendert…", es: "Renderizando cambios exactos…" },
  liveCompiling: { en: "Compiling…", ja: "組版中…", zh: "正在编译…", ko: "컴파일 중…", fr: "Compilation…", de: "Satz läuft…", es: "Compilando…" },
  liveFullCompile: { en: "Live · full compile", ja: "ライブ・全体組版", zh: "实时 · 完整编译", ko: "라이브 · 전체 컴파일", fr: "Direct · compilation complète", de: "Live · vollständiger Satz", es: "En vivo · compilación completa" },
  liveError: { en: "TeX error · last good preview", ja: "TeXエラー・直前の表示を保持", zh: "TeX 错误 · 保留上次预览", ko: "TeX 오류 · 이전 미리보기 유지", fr: "Erreur TeX · dernier aperçu conservé", de: "TeX-Fehler · letzte Vorschau bleibt", es: "Error de TeX · se conserva la vista anterior" },
  liveUnavailable: { en: "Preview unavailable", ja: "プレビュー応答なし", zh: "预览无响应", ko: "미리보기 응답 없음", fr: "Aperçu indisponible", de: "Vorschau nicht erreichbar", es: "Vista previa no disponible" },
  loadFailed: {
    en: "Failed to load the PDF.",
    ja: "読み込みに失敗しました。",
    zh: "加载失败。",
    ko: "불러오지 못했습니다.",
    fr: "Échec du chargement.",
    de: "Laden fehlgeschlagen.",
    es: "Error al cargar.",
  },
  sidebar: { en: "Sidebar", ja: "サイドバー", zh: "侧边栏", ko: "사이드바", fr: "Panneau latéral", de: "Seitenleiste", es: "Barra lateral" },
  hideSidebar: { en: "Hide sidebar", ja: "サイドバーを隠す", zh: "隐藏侧边栏", ko: "사이드바 숨기기", fr: "Masquer le panneau latéral", de: "Seitenleiste ausblenden", es: "Ocultar la barra lateral" },
  prevPage: { en: "Previous page", ja: "前のページ", zh: "上一页", ko: "이전 페이지", fr: "Page précédente", de: "Vorherige Seite", es: "Página anterior" },
  nextPage: { en: "Next page", ja: "次のページ", zh: "下一页", ko: "다음 페이지", fr: "Page suivante", de: "Nächste Seite", es: "Página siguiente" },
  pageWord: { en: "Page", ja: "ページ", zh: "页面", ko: "페이지", fr: "Page", de: "Seite", es: "Página" },
  zoomOut: { en: "Zoom out", ja: "縮小", zh: "缩小", ko: "축소", fr: "Zoom arrière", de: "Verkleinern", es: "Alejar" },
  zoomIn: { en: "Zoom in", ja: "拡大", zh: "放大", ko: "확대", fr: "Zoom avant", de: "Vergrößern", es: "Acercar" },
  fitWidth: { en: "Fit width", ja: "幅に合わせる", zh: "适应宽度", ko: "폭 맞춤", fr: "Ajuster à la largeur", de: "An Breite anpassen", es: "Ajustar al ancho" },
  widthWord: { en: "Width", ja: "幅", zh: "宽度", ko: "폭", fr: "Largeur", de: "Breite", es: "Ancho" },
  fitPage: { en: "Fit page", ja: "ページに合わせる", zh: "适应页面", ko: "페이지 맞춤", fr: "Ajuster à la page", de: "An Seite anpassen", es: "Ajustar a la página" },
  rotateLeft: { en: "Rotate left", ja: "左に回転", zh: "向左旋转", ko: "왼쪽으로 회전", fr: "Pivoter à gauche", de: "Nach links drehen", es: "Girar a la izquierda" },
  rotateRight: { en: "Rotate right", ja: "右に回転", zh: "向右旋转", ko: "오른쪽으로 회전", fr: "Pivoter à droite", de: "Nach rechts drehen", es: "Girar a la derecha" },
  search: { en: "Search", ja: "検索", zh: "搜索", ko: "검색", fr: "Rechercher", de: "Suchen", es: "Buscar" },
  findInPdf: { en: "Find in PDF", ja: "PDF 内を検索", zh: "在 PDF 中查找", ko: "PDF에서 찾기", fr: "Rechercher dans le PDF", de: "Im PDF suchen", es: "Buscar en el PDF" },
  findPrev: { en: "Previous match (Shift+Enter)", ja: "前の一致 (Shift+Enter)", zh: "上一个匹配 (Shift+Enter)", ko: "이전 결과 (Shift+Enter)", fr: "Résultat précédent (Maj+Entrée)", de: "Vorheriger Treffer (Umschalt+Eingabe)", es: "Resultado anterior (Mayús+Intro)" },
  findNext: { en: "Next match (Enter)", ja: "次の一致 (Enter)", zh: "下一个匹配 (Enter)", ko: "다음 결과 (Enter)", fr: "Résultat suivant (Entrée)", de: "Nächster Treffer (Eingabe)", es: "Resultado siguiente (Intro)" },
  findClose: { en: "Close (Esc)", ja: "閉じる (Esc)", zh: "关闭 (Esc)", ko: "닫기 (Esc)", fr: "Fermer (Échap)", de: "Schließen (Esc)", es: "Cerrar (Esc)" },
  findNoMatch: { en: "No results", ja: "見つかりません", zh: "无结果", ko: "결과 없음", fr: "Aucun résultat", de: "Keine Treffer", es: "Sin resultados" },
  download: { en: "Download", ja: "ダウンロード", zh: "下载", ko: "다운로드", fr: "Télécharger", de: "Herunterladen", es: "Descargar" },
  print: { en: "Print", ja: "印刷", zh: "打印", ko: "인쇄", fr: "Imprimer", de: "Drucken", es: "Imprimir" },
  reload: { en: "Reload", ja: "再読み込み", zh: "重新加载", ko: "다시 로드", fr: "Recharger", de: "Neu laden", es: "Recargar" },
  waiting: { en: "Waiting", ja: "待機中", zh: "等待中", ko: "대기 중", fr: "En attente", de: "Wartend", es: "En espera" },
  outline: { en: "Outline", ja: "目次", zh: "目录", ko: "목차", fr: "Sommaire", de: "Gliederung", es: "Índice" },
  thumbnails: { en: "Thumbnails", ja: "サムネイル", zh: "缩略图", ko: "썸네일", fr: "Vignettes", de: "Miniaturen", es: "Miniaturas" },
  untitled: { en: "(untitled)", ja: "（無題）", zh: "（无标题）", ko: "(제목 없음)", fr: "(sans titre)", de: "(ohne Titel)", es: "(sin título)" },
};
const uiString = (key) => {
  const entry = UI_STRINGS[key];
  let locale = "en";
  try {
    const stored = localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (stored && Object.hasOwn(entry, stored)) {
      locale = stored;
    }
  } catch {
    // Keep English when storage is unavailable.
  }
  return entry[locale];
};

// Translate the static toolbar/sidebar chrome. index.html gets this from the
// app-wide applyI18n observer; this standalone page has to do it itself.
const localizeChrome = () => {
  const setTitle = (id, key) => {
    const el = document.getElementById(id);
    if (el) {
      el.title = uiString(key);
      if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", uiString(key));
    }
  };
  setTitle("pdf-sidebar-toggle", "sidebar");
  setTitle("pdf-sidebar-close", "hideSidebar");
  setTitle("pdf-prev", "prevPage");
  setTitle("pdf-next", "nextPage");
  setTitle("pdf-zoom-out", "zoomOut");
  setTitle("pdf-zoom-in", "zoomIn");
  setTitle("pdf-fit-width", "fitWidth");
  setTitle("pdf-fit-page", "fitPage");
  setTitle("pdf-rotate-left", "rotateLeft");
  setTitle("pdf-rotate-right", "rotateRight");
  setTitle("pdf-search-open", "findInPdf");
  setTitle("pdf-findbar-prev", "findPrev");
  setTitle("pdf-findbar-next", "findNext");
  setTitle("pdf-findbar-close", "findClose");
  setTitle("pdf-download", "download");
  setTitle("pdf-print", "print");
  setTitle("pdf-reload", "reload");
  document.getElementById("pdf-page-input")?.setAttribute("aria-label", uiString("pageWord"));
  const searchOpen = document.getElementById("pdf-search-open");
  if (searchOpen) searchOpen.textContent = uiString("search");
  const findInput = document.getElementById("pdf-findbar-input");
  if (findInput) {
    findInput.placeholder = uiString("findInPdf");
    findInput.setAttribute("aria-label", uiString("findInPdf"));
  }
  const fitWidthSpan = document.querySelector("#pdf-fit-width span");
  if (fitWidthSpan) fitWidthSpan.textContent = uiString("widthWord");
  const fitPageSpan = document.querySelector("#pdf-fit-page span");
  if (fitPageSpan) fitPageSpan.textContent = uiString("pageWord");
  const setText = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.textContent = uiString(key);
  };
  setText("pdf-print", "print");
  setText("pdf-reload", "reload");
  setText("pdf-status", "waiting");
  setText("pdf-tab-outline", "outline");
  setText("pdf-tab-thumbs", "thumbnails");
  const stored = (() => {
    try { return localStorage.getItem(UI_LOCALE_STORAGE_KEY); } catch { return null; }
  })();
  if (stored) document.documentElement.lang = stored;
};

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

const createPdfDocumentOptions = (source) => ({
  ...(typeof source === "string" ? { url: source } : source),
  cMapUrl: new URL("./pdfjs/cmaps/", import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("./pdfjs/standard_fonts/", import.meta.url).href,
  wasmUrl: new URL("./pdfjs/wasm/", import.meta.url).href,
  useSystemFonts: true,
  disableFontFace: false,
});

const initPdfViewer = () => {
  const bridge = resolveBridge();
  const embedded = isEmbeddedViewer();
  document.body.classList.toggle("is-embedded", embedded);
  localizeChrome();
  const titleEl = document.getElementById("pdf-title");
  const statusEl = document.getElementById("pdf-status");
  const sidebarToggleBtn = document.getElementById("pdf-sidebar-toggle");
  const sidebarCloseBtn = document.getElementById("pdf-sidebar-close");
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
  const searchOpenBtn = document.getElementById("pdf-search-open");
  const findBar = document.getElementById("pdf-findbar");
  const findInput = document.getElementById("pdf-findbar-input");
  const findCount = document.getElementById("pdf-findbar-count");
  const findPrevBtn = document.getElementById("pdf-findbar-prev");
  const findNextBtn = document.getElementById("pdf-findbar-next");
  const findCloseBtn = document.getElementById("pdf-findbar-close");
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
  const WHEEL_ZOOM_SENSITIVITY = 0.01;
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
  let resizeRafId = null;
  // True while a (re)load is loading the new document. A SyncTeX "sync" that
  // arrives during this window must NOT be applied to the still-showing OLD
  // document — setDocument would then reset us to the top and lose the jump.
  // Defer it instead and let pagesinit apply it to the freshly loaded pages.
  let reloadInFlight = false;
  let buildPreviewState = "idle";
  let liveSurfaceOwned = false;
  let deferredStaticOpen = null;
  let deferredStaticFlushToken = 0;
  let staticLoadSequence = 0;

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

  const setStatusDirect = (text, tone = "idle") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("is-busy", tone === "busy");
    statusEl.classList.toggle("is-error", tone === "error");
  };
  const setStatus = (text, tone = "idle") => {
    if (buildPreviewState === "building") {
      setStatusDirect(uiString("liveUpdating"), "busy");
      return;
    }
    if (buildPreviewState === "failed") {
      setStatusDirect(uiString("buildFailedLastGood"), "error");
      return;
    }
    setStatusDirect(text, tone);
  };

  const staticSourceStates = new Map();
  const staticNeedsRebuild = () => staticSourceStates.get(state.path) === true;
  const refreshStaticStatus = () => {
    const stale = staticNeedsRebuild();
    document.body.classList.toggle("pdf-needs-rebuild", stale);
    if (!isLive() && !isLivePending()) {
      setStatus(uiString(!state.doc ? "waiting" : stale ? "rebuildNeeded" : "ready"));
      if (statusEl && buildPreviewState === "idle") statusEl.title = "";
    }
  };

  const appearanceKey = "tex64.appearance.theme";
  const applyViewerTheme = (theme) => {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  };
  if (embedded) {
    const syncEmbeddedTheme = () => {
      try {
        const parentTheme = window.parent?.document?.documentElement?.dataset?.theme;
        applyViewerTheme(parentTheme);
      } catch {
        // Parent access is best-effort; both documents are normally local files.
      }
    };
    syncEmbeddedTheme();
    try {
      const parentRoot = window.parent?.document?.documentElement;
      if (parentRoot) {
        const observer = new MutationObserver(syncEmbeddedTheme);
        observer.observe(parentRoot, { attributes: true, attributeFilter: ["data-theme"] });
      }
    } catch {
      // ignore unavailable parent document
    }
  } else {
    try {
      applyViewerTheme(localStorage.getItem(appearanceKey));
    } catch {
      applyViewerTheme("dark");
    }
    window.addEventListener("storage", (event) => {
      if (event.key === appearanceKey) applyViewerTheme(event.newValue);
    });
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

  const clampScale = (value) => clampZoomScale(value, MIN_SCALE, MAX_SCALE);

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
    const base = state.scale || pdfViewer.currentScale || 1;
    const zoom = calculateZoomChange(base, scaleFactor, MIN_SCALE, MAX_SCALE);
    if (zoom.scaleFactor === 1) return;
    state.scaleMode = "manual";
    pdfViewer.updateScale({
      scaleFactor: zoom.scaleFactor,
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

  const scheduleScaleModeRefresh = () => {
    if (!state.doc || state.scaleMode === "manual") {
      return;
    }
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId);
    }
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      applyScaleMode(state.scaleMode);
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

  const setSidebarTab = (tab, options = {}) => {
    const persist = options.persist !== false;
    state.sidebarTab = tab === "thumbs" && !embedded ? "thumbs" : "outline";
    if (outlineTabBtn) {
      outlineTabBtn.classList.toggle("is-active", state.sidebarTab === "outline");
    }
    if (thumbsTabBtn) {
      thumbsTabBtn.classList.toggle("is-active", !embedded && state.sidebarTab === "thumbs");
    }
    if (outlineEl) {
      outlineEl.classList.toggle("is-active", state.sidebarTab === "outline");
    }
    if (thumbnailsEl) {
      thumbnailsEl.classList.toggle("is-active", !embedded && state.sidebarTab === "thumbs");
    }
    if (!persist) {
      return;
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
  setSidebarTab(state.sidebarTab, { persist: !(embedded && state.sidebarTab === "thumbs") });

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
      outlineEl.textContent = uiString("noPdf");
      return;
    }
    const outline = await state.doc.getOutline().catch(() => null);
    if (!Array.isArray(outline) || outline.length === 0) {
      outlineEl.textContent = uiString("noOutline");
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
        button.textContent = title || uiString("untitled");
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
      thumbnailsEl.textContent = uiString("noPdf");
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

  // The place the reader marks on the page becomes the chat's context: the
  // selection (or the clicked spot) goes to the host with its page position,
  // which SyncTeX turns into a source line.
  const postAskAxiom = (point, text, source) => {
    if (!bridge || typeof bridge.postMessage !== "function" || !point) {
      return;
    }
    bridge.postMessage({
      type: "ask-axiom",
      payload: {
        page: point.page,
        x: point.x,
        y: point.y,
        text: typeof text === "string" ? text.slice(0, 2000) : "",
        path: state.path || null,
        // The live preview already knows the source position; the static
        // viewer leaves this out and the host asks SyncTeX.
        ...(source && typeof source.file === "string" && Number.isFinite(source.line)
          ? { source: { file: source.file, line: source.line, column: Number.isFinite(source.column) ? source.column : 1 } }
          : {}),
      },
    });
  };

  const askButtonState = { el: null, point: null, text: "", source: null };
  const hideAskButton = () => {
    if (askButtonState.el) {
      askButtonState.el.remove();
      askButtonState.el = null;
    }
    askButtonState.point = null;
    askButtonState.text = "";
    askButtonState.source = null;
  };
  const ensureAskButton = () => {
    if (askButtonState.el) return askButtonState.el;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-ask-axiom";
    button.textContent = uiString("askAxiom");
    button.addEventListener("mousedown", (event) => {
      // Keep the selection: it is what the chat receives.
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      postAskAxiom(askButtonState.point, askButtonState.text, askButtonState.source);
      hideAskButton();
    });
    document.body.appendChild(button);
    askButtonState.el = button;
    return button;
  };
  const placeAskButton = (right, bottom) => {
    const button = ensureAskButton();
    const width = button.offsetWidth || 110;
    const left = Math.max(8, Math.min(right + 6, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(bottom + 4, window.innerHeight - 34));
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
  };
  // The live preview reports the place the reader marked (a selection or a
  // right-click) with its rectangle in the engine frame and its source line.
  const showAskButtonForLivePlace = (data) => {
    const frame = document.getElementById("pdf-live-frame");
    const rect = data?.rect;
    if (!frame || !rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) {
      hideAskButton();
      return;
    }
    const frameRect = frame.getBoundingClientRect();
    askButtonState.point = { page: Number.isFinite(data.pageNumber) ? data.pageNumber : 0, x: null, y: null };
    askButtonState.text = typeof data.text === "string" ? data.text : "";
    askButtonState.source =
      typeof data.file === "string" && Number.isFinite(data.line)
        ? { file: data.file, line: data.line, column: Number.isFinite(data.column) ? data.column : 1 }
        : null;
    placeAskButton(frameRect.left + rect.right, frameRect.top + rect.bottom);
  };
  const currentTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer instanceof Element ? range.startContainer : range.startContainer?.parentElement;
    if (!(startNode instanceof Element) || !startNode.closest(".textLayer")) return null;
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
    if (rects.length === 0) return null;
    return { text, first: rects[0], last: rects[rects.length - 1], startNode };
  };
  const showAskButtonForSelection = () => {
    const found = currentTextSelection();
    if (!found) {
      hideAskButton();
      return;
    }
    const point = resolveClickPoint({
      target: found.startNode,
      clientX: found.first.left + Math.min(4, found.first.width / 2),
      clientY: found.first.top + found.first.height / 2,
    });
    if (!point) {
      hideAskButton();
      return;
    }
    askButtonState.point = point;
    askButtonState.text = found.text;
    askButtonState.source = null;
    placeAskButton(found.last.right, found.last.bottom);
  };
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideAskButton();
  });
  document.addEventListener("scroll", () => hideAskButton(), true);

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
    button.textContent = uiString("jumpToSource");
    button.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      hideContextMenu();
      postReverseRequest(point);
    });
    menu.appendChild(button);
    const askItem = document.createElement("button");
    askItem.type = "button";
    askItem.className = "pdf-context-menu-item";
    askItem.textContent = uiString("askAxiom");
    const selectedText = currentTextSelection()?.text ?? "";
    askItem.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      hideContextMenu();
      postAskAxiom(point, selectedText);
    });
    menu.appendChild(askItem);
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
    // A line that is not typeset lands on the first page: nothing to mark.
    if (payload.marker !== false) applySyncHighlight(pageView, payload, viewX, viewY);
  };

  const loadDocument = async (url, path) => {
    const loadSequence = ++staticLoadSequence;
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
    setStatus(uiString("loading"));
    try {
      const task = pdfjs.getDocument(createPdfDocumentOptions(url));
      const nextDocument = await task.promise;
      // Retain an existing fallback while Live owns the surface. The first
      // static PDF must still load: activation can precede its fetch, and
      // deferring it would leave the viewer empty until canonical arrives.
      if (loadSequence !== staticLoadSequence || (liveSurfaceOwned && state.doc)) {
        if (loadSequence === staticLoadSequence && liveSurfaceOwned && state.doc) {
          deferredStaticOpen = { url, path };
          reloadInFlight = false;
        }
        try { await nextDocument?.destroy?.(); } catch { /* superseded document */ }
        return;
      }
      state.doc = nextDocument;
      state.pageCount = state.doc.numPages;
      if (!isLive()) updatePageCount();
      if (titleEl) {
        titleEl.textContent = path ? path.split(/[\\/]/).slice(-1)[0] : "PDF";
      }
      pdfViewer.setDocument(state.doc);
      linkService.setDocument(state.doc, null);
      renderOutline();
      if (!embedded) {
        renderThumbnails();
      }
      refreshStaticStatus();
    } catch (error) {
      if (loadSequence !== staticLoadSequence) return;
      if (liveSurfaceOwned) {
        deferredStaticOpen = { url, path };
        reloadInFlight = false;
        return;
      }
      reloadInFlight = false;
      setStatus(uiString("loadFailed"));
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  const requestStaticDocument = (url, path) => {
    // A newer PDF open also supersedes a deferred post-Live fallback. Its
    // blob may already have been revoked when the viewer changed tabs.
    deferredStaticFlushToken += 1;
    if (liveSurfaceOwned && state.doc) {
      deferredStaticOpen = { url, path };
      return;
    }
    deferredStaticOpen = null;
    void loadDocument(url, path);
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
    const pendingPage = state.pendingPage;
    state.pendingPage = null;
    if (state.pendingSync) {
      const payload = state.pendingSync;
      state.pendingSync = null;
      state.pendingRestore = null;
      applySync(payload);
    } else if (pendingPage && state.doc) {
      state.pendingRestore = null;
      pdfViewer.currentPageNumber = Math.max(1, Math.min(state.doc.numPages, pendingPage));
      if (scrollEl) restoreScrollPosition({ scrollTop: scrollEl.scrollTop, scrollLeft: scrollEl.scrollLeft });
    } else if (state.pendingRestore) {
      const target = state.pendingRestore;
      state.pendingRestore = null;
      restoreScrollPosition(target);
    }
    // Live can start before the first static fallback finishes loading. Seed
    // its viewport handoff after pdf.js has real pages and a scroll position.
    scheduleHeldMirror();
    // A rebuilt PDF has new text: search it again rather than keep the old count.
    if (isFindOpen() && findQuery && !isLive()) runFind(findQuery);
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

  window.addEventListener("resize", scheduleScaleModeRefresh);

  if (scrollEl) {
    scrollEl.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }
        event.preventDefault();
        const zoomFactor = wheelDeltaToZoomFactor(
          event.deltaY,
          WHEEL_ZOOM_SENSITIVITY
        );
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

  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      applyScaleTo(state.scale + 0.1, getScrollCenter());
    } else if (event.key === "-") {
      event.preventDefault();
      applyScaleTo(state.scale - 0.1, getScrollCenter());
    } else if (event.key === "0") {
      event.preventDefault();
      applyScaleMode("fit-width");
    }
  });

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

  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", () => {
      setSidebarVisible(false);
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
      if (embedded) {
        setSidebarTab("outline");
        return;
      }
      setSidebarTab("thumbs");
    });
  }

  // Find bar (Cmd/Ctrl+F, or Search in the standalone window's toolbar). It
  // searches whichever paper is visible — pdf.js for the static PDF, the
  // engine for the Live frame — and is the one search UI in both places.
  const FIND_STATE_NOT_FOUND = 1;
  const FIND_STATE_PENDING = 3;
  let findQuery = "";
  let liveFindQuery = "";
  let findTypingTimer = null;
  let findReturnFocus = null;
  const isFindOpen = () => Boolean(findBar && !findBar.hidden);
  const renderFindCount = (current, total) => {
    if (!findBar || !findCount) return;
    const noMatch = Boolean(findQuery) && total === 0;
    findBar.classList.toggle("is-no-match", noMatch);
    findCount.textContent = !findQuery ? "" : noMatch ? uiString("findNoMatch") : `${current} / ${total}`;
  };
  const clearFindHighlights = () => {
    if (liveFindQuery) {
      liveFindQuery = "";
      postLive("search", { query: "" });
    }
    if (state.doc) eventBus.dispatch("findbarclose", { source: findBar });
  };
  const runFind = (rawQuery, { again = false, findPrevious = false } = {}) => {
    window.clearTimeout(findTypingTimer);
    findTypingTimer = null;
    const query = String(rawQuery ?? "").trim();
    findQuery = query;
    if (!query) {
      renderFindCount(0, 0);
      clearFindHighlights();
      return;
    }
    if (isLive()) {
      // The engine steps to the next hit when it sees the same query again,
      // so a keystroke that leaves the query unchanged must not resend it.
      if (!again && query === liveFindQuery) return;
      liveFindQuery = query;
      postLive("search", { query, findPrevious });
      return;
    }
    if (!state.doc) return;
    eventBus.dispatch("find", {
      source: findBar,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      phraseSearch: true,
      matchDiacritics: false,
    });
  };
  const openFindBar = () => {
    if (!findBar || !findInput) return;
    const wasOpen = isFindOpen();
    if (!wasOpen) {
      const active = document.activeElement;
      findReturnFocus = active && active !== document.body && active !== findInput ? active : null;
    }
    const selected = String(window.getSelection?.() ?? "").trim();
    if (selected && !selected.includes("\n") && selected.length <= 200) {
      findInput.value = selected;
    }
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (!wasOpen || findInput.value.trim() !== findQuery) runFind(findInput.value);
  };
  const closeFindBar = () => {
    if (!isFindOpen()) return;
    findBar.hidden = true;
    window.clearTimeout(findTypingTimer);
    findTypingTimer = null;
    findQuery = "";
    renderFindCount(0, 0);
    clearFindHighlights();
    findInput?.blur();
    // Back to what had the keyboard (the Live frame, a toolbar control).
    const returnTo = findReturnFocus;
    findReturnFocus = null;
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  };
  eventBus.on("updatefindmatchescount", ({ matchesCount }) => {
    if (!isFindOpen() || isLive()) return;
    renderFindCount(matchesCount?.current ?? 0, matchesCount?.total ?? 0);
  });
  eventBus.on("updatefindcontrolstate", ({ state: findState, matchesCount }) => {
    if (!isFindOpen() || isLive()) return;
    const total = matchesCount?.total ?? 0;
    if (findState === FIND_STATE_PENDING && total === 0) return;
    if (findState === FIND_STATE_NOT_FOUND) renderFindCount(0, 0);
    else renderFindCount(matchesCount?.current ?? 0, total);
  });
  const scheduleTypedFind = () => {
    window.clearTimeout(findTypingTimer);
    findTypingTimer = window.setTimeout(() => runFind(findInput.value), 150);
  };
  // An IME composition is not a query yet; search when it is committed.
  findInput?.addEventListener("input", (event) => {
    if (event.isComposing) return;
    scheduleTypedFind();
  });
  findInput?.addEventListener("compositionend", scheduleTypedFind);
  searchOpenBtn?.addEventListener("click", openFindBar);
  findInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      runFind(findInput.value, { again: true, findPrevious: event.shiftKey });
    }
  });
  findPrevBtn?.addEventListener("click", () => runFind(findInput?.value, { again: true, findPrevious: true }));
  findNextBtn?.addEventListener("click", () => runFind(findInput?.value, { again: true }));
  findCloseBtn?.addEventListener("click", closeFindBar);
  document.addEventListener("keydown", (event) => {
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    const key = String(event.key || "").toLowerCase();
    if (mod && !event.shiftKey && key === "f") {
      event.preventDefault();
      openFindBar();
    } else if (mod && key === "g" && isFindOpen()) {
      event.preventDefault();
      runFind(findInput?.value, { again: true, findPrevious: event.shiftKey });
    } else if (event.key === "Escape" && isFindOpen() && !event.isComposing) {
      event.preventDefault();
      closeFindBar();
    }
  });

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
      requestStaticDocument(nextUrl, state.path);
    });
  }

  // ---- live preview (tdom) -----------------------------------------------
  const liveFrame = document.getElementById("pdf-live-frame");
  let liveToolbar = normalizeLiveToolbarSnapshot();
  let liveActivationSequence = 0;
  let liveRevealSequence = 0;
  let liveErrorSurfaceSequence = 0;
  let pendingLiveErrorSurface = null;
  let pendingLiveSync = null;
  // Paper point the live frame must show before it may replace the static
  // PDF. A new frame starts at its first page, and a Build-held frame may
  // have fallen behind the static viewport.
  let liveViewportHandoff = null;
  let liveViewportTokenSequence = 0;
  let heldMirrorTimer = null;
  let liveActivation = null;
  const isLive = () => document.body.classList.contains("is-live");
  const isLivePending = () => document.body.classList.contains("is-live-pending");
  const isLiveHeld = () => document.body.classList.contains("is-live-held");
  const hasLiveSession = () => isLive() || isLivePending() || isLiveHeld();
  const postLive = (action, extra) => {
    const target = liveFrame && liveFrame.contentWindow;
    if (target) target.postMessage({
      source: "tdom-host",
      activationId: liveActivation?.id,
      action,
      ...(extra || {}),
    }, "*");
  };
  const renderLiveToolbar = () => {
    if (pageCountEl) {
      pageCountEl.textContent = liveToolbar.pageCountAuthoritative
        ? `/ ${liveToolbar.pageCount}`
        : "/ —";
    }
    if (pageInputForLive) {
      pageInputForLive.max = String(liveToolbar.pageCount || 1);
      if (document.activeElement !== pageInputForLive) {
        pageInputForLive.value = String(liveToolbar.page);
      }
    }
    if (zoomLabel) zoomLabel.textContent = `${Math.round(liveToolbar.zoom * 100)}%`;
  };
  const applyLiveSync = (payload) => {
    if (!payload || !hasLiveSession()) return false;
    // While Build owns the paper, SyncTeX moves the visible static PDF and
    // the held frame follows that viewport.
    if (isLiveHeld()) return false;
    liveToolbar = normalizeLiveToolbarSnapshot(liveToolbar, {
      page: Number(payload.page),
    });
    // An explicit jump replaces any pending viewport handoff.
    liveViewportHandoff = null;
    if (!isLive()) {
      pendingLiveSync = payload;
      return true;
    }
    pendingLiveSync = null;
    renderLiveToolbar();
    postLive("goto-sync", payload);
    return true;
  };
  const renderLiveStatus = (data) => {
    const search = data?.search;
    if (isFindOpen() && findQuery && search?.query === findQuery) {
      renderFindCount(Number(search.current) || 0, Number(search.total) || 0);
    }
    if (search?.query) {
      setStatus(`${Number(search.current) || 0} / ${Number(search.total) || 0}`);
      if (statusEl) statusEl.title = search.query;
      return;
    }
    const view = resolvePdfLiveStatus(data?.status, data?.presentationPending);
    if (!view) return;
    setStatus(uiString(view.key), view.tone);
    if (statusEl) statusEl.title = view.detail;
  };
  const restoreStaticToolbar = () => {
    state.pageCount = state.doc?.numPages ?? 0;
    updatePageCount();
    if (pageInput) pageInput.value = String(pdfViewer.currentPageNumber || 1);
    updateZoomLabel(state.scale || pdfViewer.currentScale || 1);
  };
  const cancelLiveReveal = () => {
    liveRevealSequence += 1;
    if (liveActivation) liveActivation.reveal = null;
  };
  const cancelLiveErrorSurface = () => {
    liveErrorSurfaceSequence += 1;
    pendingLiveErrorSurface = null;
  };
  const deactivateLive = () => {
    // Advancing the sequence also invalidates a delayed ready message from a
    // frame that is about to be navigated to about:blank.
    liveActivationSequence += 1;
    cancelLiveReveal();
    liveActivation = null;
    liveSurfaceOwned = false;
    document.body.classList.remove("is-live", "is-live-pending", "is-live-held");
    hideContextMenu();
    if (liveFrame) {
      liveFrame.setAttribute("aria-hidden", "true");
      delete liveFrame.dataset.livePhase;
      liveFrame.src = "about:blank";
    }
    liveToolbar = normalizeLiveToolbarSnapshot();
    restoreStaticToolbar();
    // The frame is gone and its search with it; search the static PDF.
    liveFindQuery = "";
    if (isFindOpen() && findQuery) runFind(findQuery);
    refreshStaticStatus();
    const deferredSync = pendingLiveSync;
    pendingLiveSync = null;
    liveViewportHandoff = null;
    clearTimeout(heldMirrorTimer);
    if (deferredSync) requestAnimationFrame(() => applySync(deferredSync));
    const pendingStatic = deferredStaticOpen;
    if (pendingStatic) {
      deferredStaticOpen = null;
      const flushToken = ++deferredStaticFlushToken;
      // Give the retained static PDF one committed frame after removing the
      // live cover. A new activation before then keeps the request deferred.
      requestAnimationFrame(() => {
        if (flushToken !== deferredStaticFlushToken) return;
        if (liveSurfaceOwned) {
          deferredStaticOpen = pendingStatic;
          return;
        }
        requestStaticDocument(pendingStatic.url, pendingStatic.path);
      });
    }
  };
  // Paper point at the centre of the static viewport, in the goto-sync form
  // the live frame centres (top-origin y in PDF units).
  const captureStaticViewportSync = () => {
    if (!state.doc || !scrollEl) return null;
    const scrollRect = scrollEl.getBoundingClientRect();
    const centerY = scrollRect.top + scrollEl.clientHeight / 2;
    const current = Math.max(1, Number(pdfViewer.currentPageNumber) || 1);
    let page = current;
    for (let n = Math.max(1, current - 2); n <= Math.min(state.doc.numPages, current + 2); n += 1) {
      const rect = pdfViewer.getPageView(n - 1)?.div?.getBoundingClientRect?.();
      if (rect && rect.top <= centerY && rect.bottom >= centerY) {
        page = n;
        break;
      }
    }
    const pageView = pdfViewer.getPageView(page - 1);
    if (!(pageView?.div instanceof HTMLElement) || !pageView.viewport) return { page, x: 0, y: 0 };
    const pageRect = pageView.div.getBoundingClientRect();
    const contentOffset = resolvePageContentOffset(pageView.div);
    const viewportScale = resolveViewportScale(pageView);
    const renderedHeight = Math.max(1, Number(pageView.viewport.height) * viewportScale.y);
    const within = Math.max(0, Math.min(renderedHeight,
      scrollRect.top + scrollEl.clientHeight / 2 - pageRect.top - contentOffset.top));
    const paperHeight = Math.max(1, Number(resolvePagePdfHeight(pageView)) || renderedHeight);
    const paperY = within / renderedHeight * paperHeight;
    return { page, x: 0, y: paperY, blockY: paperY, blockHeight: 0 };
  };
  // A goto-sync the frame echoes back once it has scrolled to that paper point.
  const viewportHandoff = (sync) => ({
    sync: { ...sync, viewportToken: `${liveActivation?.id ?? "live"}:${++liveViewportTokenSequence}` },
  });
  const followsStaticViewport = () => isLiveHeld() || isLivePending();
  const mirrorStaticViewportToHeldLive = () => {
    clearTimeout(heldMirrorTimer);
    heldMirrorTimer = null;
    if (!liveActivation || !followsStaticViewport()) return;
    const sync = captureStaticViewportSync();
    if (!sync) return;
    // The static PDF stays scrollable until Live replaces it; the frame
    // must reach the paper the reader has moved to, not the resume point.
    if (isLivePending()) {
      liveViewportHandoff = viewportHandoff(sync);
      postLive("goto-sync", liveViewportHandoff.sync);
      return;
    }
    postLive("goto-sync", sync);
  };
  const scheduleHeldMirror = () => {
    if (!followsStaticViewport()) return;
    clearTimeout(heldMirrorTimer);
    heldMirrorTimer = setTimeout(mirrorStaticViewportToHeldLive, 120);
  };
  // Build owns the paper: show its static PDF while the same engine frame,
  // its document epoch and warm state stay alive underneath.
  const enterLiveHeld = () => {
    if (!liveFrame || !liveActivation) return;
    const livePage = isLive() ? liveToolbar.page : null;
    cancelLiveReveal();
    liveViewportHandoff = null;
    liveActivation.expectedSrcRev = null;
    liveSurfaceOwned = false;
    document.body.classList.remove("is-live", "is-live-pending");
    document.body.classList.add("is-live-held");
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = "build-held";
    hideContextMenu();
    hideAskButton();
    restoreStaticToolbar();
    refreshStaticStatus();
    const pendingStatic = deferredStaticOpen;
    deferredStaticOpen = null;
    if (pendingStatic) {
      // The Build PDF replaces the static fallback that was hidden under
      // Live; open it where the reader was looking, not at its stale scroll.
      if (livePage) state.pendingPage = livePage;
      requestStaticDocument(pendingStatic.url, pendingStatic.path);
    } else if (livePage && state.doc) {
      pdfViewer.currentPageNumber = Math.max(1, Math.min(state.doc.numPages, livePage));
    }
    scheduleHeldMirror();
  };
  // The first real edit after a Build returns the paper to Live. The static
  // PDF stays on top until the frame shows a complete paper at its viewport.
  const resumeLiveFromHold = (expectedSrcRev) => {
    if (!liveFrame || !liveActivation) return;
    clearTimeout(heldMirrorTimer);
    liveActivation.expectedSrcRev = expectedSrcRev;
    const sync = captureStaticViewportSync();
    liveViewportHandoff = sync ? viewportHandoff(sync) : null;
    liveSurfaceOwned = true;
    document.body.classList.remove("is-live-held");
    document.body.classList.add("is-live-pending");
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = "activation-pending";
    setStatus(uiString("liveUpdating"), "busy");
    if (liveViewportHandoff) postLive("goto-sync", liveViewportHandoff.sync);
  };
  // Frames without the viewport token only report their top page; a centred
  // paper point on page N leaves N or a page or two above it at the top,
  // while an unmoved frame is still at its first page.
  const LIVE_HANDOFF_PAGE_SLACK = 2;
  const livePaperHasAuthoritativePageCount = (data) => {
    if (data?.presentationPending !== false || data?.pageCountAuthoritative === false) return false;
    const expected = liveActivation?.expectedSrcRev;
    return Number.isInteger(expected)
      ? Number(data.srcRev) >= expected
      : data?.ready === true;
  };
  const resolveLiveViewportTarget = (sync, data) => {
    const desired = Math.max(1, Number(sync?.page) || 1);
    const pageCount = Math.max(0, Number(data?.pageCount) || 0);
    if (pageCount >= desired) return desired;
    // A cold or rebuilding frame can temporarily expose only its first few
    // pages. Keep the static viewport request intact until those pages exist.
    // Only a complete paper may establish that the requested page was really
    // removed and should therefore resolve to its new final page.
    if (pageCount > 0 && livePaperHasAuthoritativePageCount(data)) return pageCount;
    return null;
  };
  const liveViewportPositioned = (data) => {
    const handoff = liveViewportHandoff;
    if (!handoff) return true;
    const target = resolveLiveViewportTarget(handoff.sync, data);
    if (!target) return false;
    const page = Number(data.page);
    const pageConfirmed = page <= target && page >= target - LIVE_HANDOFF_PAGE_SLACK;
    const tokenConfirmed = "viewportToken" in data
      ? data.viewportToken === handoff.sync.viewportToken
      : true;
    const confirmed = livePaperPresentable(data) && tokenConfirmed && pageConfirmed;
    if (confirmed) {
      liveViewportHandoff = null;
      return true;
    }
    // Once the target exists, retry on snapshots until both its location and
    // token are confirmed. An unavailable target is left quiet above.
    postLive("goto-sync", { ...handoff.sync, page: target });
    return false;
  };
  // After a Build the frame may only replace its PDF once it has applied the
  // revision the engine accepted for the first change and holds complete
  // paper. A certified local edit stays presentationPending until canonical
  // confirms it (and pages beyond a shorter resident pagination stay pending
  // until then), so either completeness signal is accepted here. Other
  // activations wait for an exact paint.
  const livePaperPresentable = (data) => {
    const expected = liveActivation?.expectedSrcRev;
    if (!Number.isInteger(expected)) return data?.ready === true;
    const applied = !("srcRev" in data) || Number(data.srcRev) >= expected;
    return applied && (data.ready === true || data.presentationPending === false);
  };
  // A held frame keeps following the static viewport so the first edit can
  // replace the paper without a positioning round trip.
  const alignHeldFrame = (data) => {
    if (heldMirrorTimer) return;
    const sync = captureStaticViewportSync();
    if (!sync) return;
    const target = resolveLiveViewportTarget(sync, data);
    if (!target) return;
    const page = Number(data.page);
    if (page <= target && page >= target - LIVE_HANDOFF_PAGE_SLACK) return;
    postLive("goto-sync", { ...sync, page: target });
  };
  const activateLive = (data) => {
    if (!liveFrame || !liveActivation || !isLivePending() || data?.action) return false;
    if (data?.activationId !== liveActivation.id) {
      if (liveActivation.reveal) cancelLiveReveal();
      return false;
    }
    const documentEpoch = Number(data.documentEpoch);
    if (!Number.isInteger(documentEpoch)) return false;
    if (Number.isInteger(liveActivation.pendingDocumentEpoch) &&
        documentEpoch !== liveActivation.pendingDocumentEpoch) return false;
    if (Number.isInteger(liveActivation.documentEpoch) &&
        documentEpoch < liveActivation.documentEpoch) return false;
    // Move the still-covered frame before judging its paper: the pages it
    // must present are the ones at the handed-off viewport.
    if (!liveViewportPositioned(data)) return true;
    if (!livePaperPresentable(data)) {
      if (liveActivation.reveal) cancelLiveReveal();
      return false;
    }
    if (liveActivation.reveal?.documentEpoch === documentEpoch) {
      // The child sends periodic snapshots. Keep the newest toolbar/status
      // payload without postponing an already scheduled paint barrier.
      liveActivation.reveal.data = data;
      return true;
    }

    const activation = liveActivation;
    const revealToken = ++liveRevealSequence;
    activation.reveal = { token: revealToken, documentEpoch, data };
    liveFrame.dataset.livePhase = "staging";
    // First rAF lets the ready child paint while it is still covered by the
    // static PDF. The second rAF changes only stacking order, so the next
    // compositor commit can never contain the iframe's blank/old backing
    // store. A newer activation/reset invalidates the captured token.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const reveal = activation.reveal;
        if (!reveal || reveal.token !== revealToken || liveRevealSequence !== revealToken) return;
        if (liveActivation !== activation || !isLivePending()) return;
        if (activation.id !== data.activationId || reveal.documentEpoch !== documentEpoch) return;
        if (Number.isInteger(activation.pendingDocumentEpoch) &&
            documentEpoch !== activation.pendingDocumentEpoch) return;
        const latestData = reveal.data;
        if (!latestData || !livePaperPresentable(latestData)) return;
        if (Number(latestData.documentEpoch) !== documentEpoch) return;

        activation.reveal = null;
        activation.documentEpoch = documentEpoch;
        activation.pendingDocumentEpoch = null;
        // Both mutations happen in one task. The already-painted iframe
        // replaces the opaque pdf.js cover on this compositor commit.
        document.body.classList.remove("is-live-pending");
        document.body.classList.add("is-live");
        liveFrame.setAttribute("aria-hidden", "false");
        liveFrame.dataset.livePhase = "active";
        renderLiveToolbar();
        setStatus(uiString("live"));
        renderLiveStatus(latestData);
        if (pendingLiveSync) applyLiveSync(pendingLiveSync);
        // A query typed while the static PDF was showing has not reached the
        // engine yet; the engine keeps its own search across later updates.
        if (isFindOpen() && findQuery && liveFindQuery !== findQuery) runFind(findQuery);
        bridge?.postMessage?.({
          type: "live-surface-ready",
          payload: {
            activationId: activation.id,
            url: activation.url,
            generation: activation.generation,
            documentEpoch,
          },
        });
      });
    });
    return true;
  };
  const holdStaticForDocumentReset = (data) => {
    if (!liveFrame || !liveActivation) return false;
    const documentEpoch = Number(data?.documentEpoch);
    if (!Number.isInteger(documentEpoch)) return false;
    const adoptedEpoch = Number(liveActivation.documentEpoch);
    const pendingEpoch = Number(liveActivation.pendingDocumentEpoch);
    if (Number.isInteger(adoptedEpoch) && documentEpoch <= adoptedEpoch) return false;
    if (Number.isInteger(pendingEpoch) && documentEpoch < pendingEpoch) return false;

    cancelLiveReveal();
    liveActivation.pendingDocumentEpoch = documentEpoch;
    liveToolbar = normalizeLiveToolbarSnapshot();
    document.body.classList.remove("is-live");
    document.body.classList.add("is-live-pending");
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = "reset-pending";
    restoreStaticToolbar();
    setStatus(uiString("liveUpdating"), "busy");
    // Resolve the new stacking order before allowing the child to discard
    // its old document DOM. The iframe stays paintable below the static PDF.
    getComputedStyle(liveFrame).zIndex;
    postLive("reset-ack", { documentEpoch });
    return true;
  };
  const setLiveMode = (payload) => {
    // Any Live state message supersedes an error-paint acknowledgement that
    // has not crossed its compositor barrier yet. The following live-error
    // message, when present, schedules a new exact acknowledgement.
    cancelLiveErrorSurface();
    const rawUrl = payload && typeof payload.url === "string" ? payload.url.trim() : "";
    if (!rawUrl) {
      deactivateLive();
      return;
    }
    if (!liveFrame) return;

    const url = rawUrl.replace(/\/+$/, "");
    const generation = Number(payload?.generation) || 0;
    const hold = payload?.hold === true;
    const expectedSrcRev = Number.isInteger(payload?.expectedSrcRev) ? payload.expectedSrcRev : null;
    if (liveActivation?.url === url && liveActivation?.generation === generation && hasLiveSession()) {
      // Same engine session and document generation: Build ownership only
      // moves the paper between the static PDF and this frame.
      if (hold && !isLiveHeld()) enterLiveHeld();
      else if (!hold && isLiveHeld()) resumeLiveFromHold(expectedSrcRev);
      return;
    }

    liveSurfaceOwned = !hold;
    deferredStaticFlushToken += 1;
    const id = `${Date.now().toString(36)}-${(++liveActivationSequence).toString(36)}`;
    cancelLiveReveal();
    liveActivation = {
      id,
      url,
      generation,
      documentEpoch: null,
      pendingDocumentEpoch: null,
      expectedSrcRev: hold ? null : expectedSrcRev,
      reveal: null,
    };
    liveToolbar = normalizeLiveToolbarSnapshot();
    // A new frame opens at its first page. Carry the static viewport so it
    // replaces the paper where the reader is, not at the document start.
    const sync = !hold && state.doc ? captureStaticViewportSync() : null;
    liveViewportHandoff = sync && !pendingLiveSync ? viewportHandoff(sync) : null;
    document.body.classList.remove("is-live", "is-live-pending", "is-live-held");
    document.body.classList.add(hold ? "is-live-held" : "is-live-pending");
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = hold ? "build-held" : "activation-pending";
    hideContextMenu();
    restoreStaticToolbar();
    if (hold) refreshStaticStatus();
    else setStatus(uiString("liveUpdating"), "busy");

    const params = new URLSearchParams({
      embed: "1",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      activationId: id,
    });
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(bg)) params.set("bg", bg);
    // A new frame starts without a search; the reveal sends the open query.
    liveFindQuery = "";
    liveFrame.src = `${url}/?${params.toString()}`;
    if (hold) {
      // A Build published before this frame existed: preload below its PDF.
      const pendingStatic = deferredStaticOpen;
      deferredStaticOpen = null;
      if (pendingStatic) requestStaticDocument(pendingStatic.url, pendingStatic.path);
    }
  };
  const setLiveError = (payload) => {
    cancelLiveErrorSurface();
    const error = typeof payload?.error === "string" ? payload.error : "";
    if (!error) {
      if (statusEl) statusEl.title = "";
      if (isLive()) setStatus(uiString("live"));
      else if (isLivePending()) setStatus(uiString("liveUpdating"), "busy");
      else refreshStaticStatus();
      return;
    }

    setStatus(error, "error");
    if (statusEl) statusEl.title = error;
    const pending = {
      token: liveErrorSurfaceSequence,
      error,
      url: typeof payload?.url === "string" ? payload.url : null,
      generation: Number(payload?.generation) || 0,
    };
    pendingLiveErrorSurface = pending;
    // A new detached window can otherwise become native-visible after its
    // renderer says merely `ready`, one frame before the terminal error text
    // is actually painted. Use the same two-paint commit boundary as Live.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingLiveErrorSurface !== pending || pending.token !== liveErrorSurfaceSequence) return;
        pendingLiveErrorSurface = null;
        bridge?.postMessage?.({
          type: "live-error-surface-ready",
          payload: {
            error: pending.error,
            url: pending.url,
            generation: pending.generation,
          },
        });
      });
    });
  };
  scrollEl?.addEventListener("scroll", scheduleHeldMirror, { passive: true });
  const pageInputForLive = document.getElementById("pdf-page-input");
  window.addEventListener("message", (event) => {
    if (!liveFrame || event.source !== liveFrame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== "tdom-embed" || !hasLiveSession()) return;
    if (!liveActivation || data.activationId !== liveActivation.id) return;
    if (data.action === "reset-pending") {
      if (isLiveHeld()) {
        const documentEpoch = Number(data.documentEpoch);
        if (Number.isInteger(documentEpoch)) {
          liveActivation.pendingDocumentEpoch = documentEpoch;
          postLive("reset-ack", { documentEpoch });
        }
        return;
      }
      holdStaticForDocumentReset(data);
      return;
    }
    if (isLiveHeld() && data.action === "place") return;
    if (data.action === "place") {
      if (data.kind === "clear") hideAskButton();
      else showAskButtonForLivePlace(data);
      return;
    }

    // Status snapshots may arrive while the frame is preloading.  Keep them
    // offscreen until the same activation explicitly declares its first
    // exact paint ready.
    liveToolbar = normalizeLiveToolbarSnapshot(liveToolbar, data);
    // The retained frame may keep rendering under a Build-owned static PDF,
    // but hidden clicks/selections from its old activation cannot edit Code.
    if (isLiveHeld()) {
      if (!data.action) alignHeldFrame(data);
      return;
    }
    if (isLivePending()) {
      activateLive(data);
      return;
    }
    if (Number.isInteger(liveActivation.documentEpoch) &&
        Number(data.documentEpoch) !== liveActivation.documentEpoch) return;
    if (data.action === "source") {
      bridge?.postMessage?.({
        type: "live-source",
        payload: { file: data.file, line: data.line, column: data.column },
      });
      return;
    }
    if (data.action === "edit-anchor") {
      if (!Number.isInteger(liveActivation.documentEpoch) ||
          data.documentEpoch !== liveActivation.documentEpoch) return;
      bridge?.postMessage?.({
        type: "live-edit-anchor",
        payload: {
          sessionId: data.sessionId,
          requestId: data.requestId,
          previousSessionId: data.previousSessionId,
          activationId: data.activationId,
          documentEpoch: data.documentEpoch,
          file: data.file,
          start: data.start,
          end: data.end,
          baseValue: data.baseValue,
          sourceText: data.sourceText,
          sourceRev: data.sourceRev,
        },
      });
      return;
    }
    if (data.action === "edit") {
      bridge?.postMessage?.({
        type: "live-edit",
        payload: {
          sessionId: data.sessionId,
          regionId: data.regionId,
          kind: data.kind,
          file: data.file,
          start: data.start,
          end: data.end,
          baseValue: data.baseValue,
          value: data.value,
          replacement: data.replacement,
          cancel: data.cancel === true,
          finish: data.finish === true,
          sourceRev: data.sourceRev,
          sourceText: typeof data.sourceText === "string" ? data.sourceText : undefined,
        },
      });
      return;
    }
    renderLiveToolbar();
    renderLiveStatus(data);
  });
  // Capture-phase routing: when live, the toolbar talks to the engine frame
  // and pdf.js never sees the event.
  const routeLiveClick = (id, action) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", (event) => {
      if (!isLive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      postLive(action);
    }, true);
  };
  routeLiveClick("pdf-zoom-in", "zoom-in");
  routeLiveClick("pdf-zoom-out", "zoom-out");
  routeLiveClick("pdf-fit-width", "zoom-fit");
  routeLiveClick("pdf-fit-page", "zoom-fit");
  const routeLivePageStep = (id, delta) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", (event) => {
      if (!isLive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      liveToolbar = stepLiveToolbarPage(liveToolbar, delta);
      renderLiveToolbar();
      postLive("goto-page", { page: liveToolbar.page });
    }, true);
  };
  routeLivePageStep("pdf-prev", -1);
  routeLivePageStep("pdf-next", 1);
  pageInputForLive?.addEventListener("change", (event) => {
    if (!isLive()) return;
    event.stopImmediatePropagation();
    liveToolbar = normalizeLiveToolbarSnapshot(liveToolbar, {
      page: Number(pageInputForLive.value),
    });
    renderLiveToolbar();
    postLive("goto-page", { page: liveToolbar.page });
  }, true);

  if (bridge && typeof bridge.onMessage === "function") {
    bridge.onMessage(async (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "open") {
        const payload = message.payload || {};
        if (payload.url) {
          staticSourceStates.set(payload.path || null, payload.needsRebuild === true);
          document.body.classList.toggle("pdf-needs-rebuild", payload.needsRebuild === true);
          requestStaticDocument(payload.url, payload.path || null);
        }
      }
      if (message.type === "source-state" && message.payload) {
        staticSourceStates.set(message.payload.path || null, message.payload.needsRebuild === true);
        if ((message.payload.path || null) === state.path && !reloadInFlight) refreshStaticStatus();
      }
      if (message.type === "build-state" && message.payload) {
        const payload = message.payload;
        buildPreviewState = payload.state === "building" || payload.state === "failed"
          ? payload.state
          : "idle";
        if (statusEl) {
          statusEl.title = buildPreviewState === "failed" && typeof payload.message === "string"
            ? payload.message
            : "";
        }
        if (buildPreviewState === "building") setStatusDirect(uiString("liveUpdating"), "busy");
        else if (buildPreviewState === "failed") setStatusDirect(uiString("buildFailedLastGood"), "error");
        else if (isLive()) setStatus(uiString("live"));
        else if (isLivePending()) setStatus(uiString("liveUpdating"), "busy");
        else refreshStaticStatus();
      }
      if (message.type === "sync" && message.payload) {
        if (!applyLiveSync(message.payload)) applySync(message.payload);
      }
      if (message.type === "find-open") {
        openFindBar();
      }
      if (message.type === "live") {
        setLiveMode(message.payload || null);
      }
      if (message.type === "live-error") {
        setLiveError(message.payload || null);
      }
      if (message.type === "live-edit-anchor-result") {
        const payload = message.payload;
        if (!payload || !hasLiveSession() || !liveActivation ||
            payload.activationId !== liveActivation.id ||
            !Number.isInteger(payload.documentEpoch) ||
            payload.documentEpoch !== liveActivation.documentEpoch) return;
        postLive("edit-anchor-result", payload);
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
    pagesEl.addEventListener("dblclick", (event) => {
      if (!event || event.button !== 0 || event.ctrlKey || event.metaKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".textLayer")) {
        return;
      }
      event.preventDefault();
      applyScaleMode("fit-width");
    });

    pagesEl.addEventListener("mouseup", () => {
      // After the selection settles.
      window.setTimeout(showAskButtonForSelection, 0);
    });

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
