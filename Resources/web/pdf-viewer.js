import { fallbackPaperEditor } from "./pdf-fallback-editor.js";
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
import { resolvePdfLiveStatus, stepPdfLiveStatusMark } from "./app/pdf-live-status.js";
import {
  LIVE_HANDOFF_PAGE_SLACK,
  LIVE_RESET_STALL_MS,
  coverHoldsReaderPage,
  coverScaleFor,
  liveHandoffSyncFor,
  livePaperPresentableFor,
  liveReaderPlace,
  resolveLiveViewportTarget,
  stepLiveViewportHandoff,
} from "./app/pdf-live-handoff.js";

// This page runs in its own iframe and never goes through the app's initI18n(),
// so it reads the stored UI locale itself. English is the source language and
// the fallback, matching the app's i18n default.
const UI_LOCALE_STORAGE_KEY = "tex64.ui.locale.v1";
const UI_STRINGS = {
  noPdf: {
    en: "No PDF is loaded.",
    ja: "PDFが未読み込みです。",
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
    ja: "Axiomに聞く",
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
  liveMarkGreen: { en: "Up to date", ja: "最新", zh: "已更新", ko: "최신", fr: "À jour", de: "Aktuell", es: "Al día" },
  liveMarkOrange: { en: "Updating", ja: "更新中", zh: "更新中", ko: "업데이트 중", fr: "Mise à jour", de: "Aktualisierung", es: "Actualizando" },
  liveMarkRed: { en: "Falling behind", ja: "追いついていません", zh: "更新滞后", ko: "업데이트 지연", fr: "En retard", de: "Im Rückstand", es: "Con retraso" },
  // The failure itself is the count beside Build; here only what is on screen.
  buildFailedLastGood: { en: "Showing the previous PDF", ja: "前のPDFを表示中", zh: "正在显示上一版 PDF", ko: "이전 PDF 표시 중", fr: "PDF précédent affiché", de: "Vorherige PDF wird angezeigt", es: "Mostrando el PDF anterior" },
  liveExactRendering: { en: "Rendering exact changes…", ja: "差分を描画中…", zh: "正在精确渲染差异…", ko: "변경 사항을 정밀 렌더링 중…", fr: "Rendu exact des modifications…", de: "Exakte Änderungen werden gerendert…", es: "Renderizando cambios exactos…" },
  liveCompiling: { en: "Compiling…", ja: "組版中…", zh: "正在编译…", ko: "컴파일 중…", fr: "Compilation…", de: "Satz läuft…", es: "Compilando…" },
  liveFullCompile: { en: "Live · full compile", ja: "ライブ・全体組版", zh: "实时 · 完整编译", ko: "라이브 · 전체 컴파일", fr: "Direct · compilation complète", de: "Live · vollständiger Satz", es: "En vivo · compilación completa" },
  liveError: { en: "TeX error", ja: "TeXエラー", zh: "TeX 错误", ko: "TeX 오류", fr: "Erreur TeX", de: "TeX-Fehler", es: "Error de TeX" },
  liveUnavailable: { en: "Preview unavailable", ja: "プレビュー応答なし", zh: "预览无响应", ko: "미리보기 응답 없음", fr: "Aperçu indisponible", de: "Vorschau nicht erreichbar", es: "Vista previa no disponible" },
  loadFailed: {
    en: "Failed to load the PDF.",
    ja: "読み込めませんでした。",
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
  findInPdf: { en: "Find in PDF", ja: "PDF内を検索", zh: "在 PDF 中查找", ko: "PDF에서 찾기", fr: "Rechercher dans le PDF", de: "Im PDF suchen", es: "Buscar en el PDF" },
  findPrev: { en: "Previous match (Shift+Enter)", ja: "前の一致 (Shift+Enter)", zh: "上一个匹配 (Shift+Enter)", ko: "이전 결과 (Shift+Enter)", fr: "Résultat précédent (Maj+Entrée)", de: "Vorheriger Treffer (Umschalt+Eingabe)", es: "Resultado anterior (Mayús+Intro)" },
  findNext: { en: "Next match (Enter)", ja: "次の一致 (Enter)", zh: "下一个匹配 (Enter)", ko: "다음 결과 (Enter)", fr: "Résultat suivant (Entrée)", de: "Nächster Treffer (Eingabe)", es: "Resultado siguiente (Intro)" },
  closePdf: { en: "Close PDF", ja: "PDFを閉じる", zh: "关闭 PDF", ko: "PDF 닫기", fr: "Fermer le PDF", de: "PDF schließen", es: "Cerrar el PDF" },
  findClose: { en: "Close (Esc)", ja: "閉じる (Esc)", zh: "关闭 (Esc)", ko: "닫기 (Esc)", fr: "Fermer (Échap)", de: "Schließen (Esc)", es: "Cerrar (Esc)" },
  findNoMatch: { en: "No results", ja: "見つかりません", zh: "无结果", ko: "결과 없음", fr: "Aucun résultat", de: "Keine Treffer", es: "Sin resultados" },
  moreActions: { en: "More PDF actions", ja: "PDFのその他の操作", zh: "更多 PDF 操作", ko: "PDF 추가 작업", fr: "Autres actions PDF", de: "Weitere PDF-Aktionen", es: "Más acciones de PDF" },
  printFailed: { en: "The PDF could not be prepared for printing.", ja: "印刷用のPDFを準備できませんでした。", zh: "无法准备打印此 PDF。", ko: "PDF 인쇄를 준비할 수 없습니다.", fr: "Impossible de préparer l’impression du PDF.", de: "Der PDF-Druck konnte nicht vorbereitet werden.", es: "No se pudo preparar el PDF para imprimir." },
  download: { en: "Download", ja: "ダウンロード", zh: "下载", ko: "다운로드", fr: "Télécharger", de: "Herunterladen", es: "Descargar" },
  print: { en: "Print", ja: "印刷", zh: "打印", ko: "인쇄", fr: "Imprimer", de: "Drucken", es: "Imprimir" },
  reload: { en: "Reload", ja: "再読み込み", zh: "重新加载", ko: "다시 로드", fr: "Recharger", de: "Neu laden", es: "Recargar" },
  waiting: { en: "Waiting", ja: "待機中", zh: "等待中", ko: "대기 중", fr: "En attente", de: "Wartend", es: "En espera" },
  outline: { en: "Outline", ja: "目次", zh: "目录", ko: "목차", fr: "Sommaire", de: "Gliederung", es: "Índice" },
  thumbnails: { en: "Thumbnails", ja: "サムネイル", zh: "缩略图", ko: "썸네일", fr: "Vignettes", de: "Miniaturen", es: "Miniaturas" },
  untitled: { en: "(untitled)", ja: "（無題）", zh: "（无标题）", ko: "(제목 없음)", fr: "(sans titre)", de: "(ohne Titel)", es: "(sin título)" },
};
const readUiLocale = () => {
  try {
    const stored = localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (stored && Object.hasOwn(UI_STRINGS.waiting, stored)) return stored;
  } catch {
    // Keep English when storage is unavailable.
  }
  return "en";
};
let uiLocale = readUiLocale();
const uiString = (key) => UI_STRINGS[key][uiLocale];

// Only labels owned by the viewer are translated. Authored bookmark titles,
// raw error details and search queries remain in the document's language.
const setLocalizedText = (element, key) => {
  element.dataset.pdfUiText = key;
  element.textContent = uiString(key);
};
const liveMarkLabel = (color) => ({
  green: "liveMarkGreen", orange: "liveMarkOrange", red: "liveMarkRed",
})[color] || "liveMarkOrange";

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
  setTitle("pdf-more", "moreActions");
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
  setTitle("pdf-close", "closePdf");
  setTitle("pdf-download", "download");
  setTitle("pdf-print", "print");
  setTitle("pdf-reload", "reload");
  setTitle("pdf-live-mark", liveMarkLabel(document.getElementById("pdf-live-mark")?.dataset.color));
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
  setText("pdf-tab-outline", "outline");
  setText("pdf-tab-thumbs", "thumbnails");
  document.documentElement.lang = uiLocale;
  for (const el of document.querySelectorAll("[data-pdf-ui-text]")) {
    el.textContent = uiString(el.dataset.pdfUiText);
  }
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

// Keep a single button and event handler for every action in both toolbar layouts.
function initPdfOverflow(embedded) {
  const more = document.getElementById("pdf-more");
  const panel = document.getElementById("pdf-more-actions");
  const compact = matchMedia("(max-width: 760px)");
  const actions = ["pdf-search-open", "pdf-sidebar-toggle", "pdf-rotate-left", "pdf-rotate-right", "pdf-download", "pdf-print", "pdf-reload"].map(id => {
    const button = document.getElementById(id);
    const slot = document.createComment(id);
    button.before(slot);
    button.setAttribute("aria-label", button.title);
    return { button, slot };
  });
  const position = () => {
    const button = more.getBoundingClientRect();
    panel.style.top = (button.bottom + 4) + "px";
    panel.style.right = Math.max(4, innerWidth - button.right) + "px";
  };
  const arrange = () => {
    const useOverflow = embedded || compact.matches;
    if (panel.matches(":popover-open")) panel.hidePopover();
    more.hidden = !useOverflow;
    for (const { button, slot } of actions) {
      if (useOverflow) panel.append(button);
      else slot.after(button);
    }
  };
  panel.addEventListener("beforetoggle", event => {
    if (event.newState === "open") position();
  });
  panel.addEventListener("click", event => {
    if (event.target.closest("button")) panel.hidePopover();
  }, true);
  window.addEventListener("resize", () => { if (panel.matches(":popover-open")) position(); });
  compact.addEventListener("change", arrange);
  arrange();
}

const initPdfViewer = () => {
  const bridge = resolveBridge();
  const embedded = isEmbeddedViewer();
  document.body.classList.toggle("is-embedded", embedded);
  localizeChrome();
  window.addEventListener("storage", (event) => {
    if (event.key !== UI_LOCALE_STORAGE_KEY && event.key !== null) return;
    uiLocale = readUiLocale();
    localizeChrome();
  });
  initPdfOverflow(embedded);
  // In the app the PDF pane has no tab strip; this × closes it as the tab's
  // × did. A separate PDF window closes like any window.
  const closeButton = document.getElementById("pdf-close");
  if (closeButton && embedded) {
    closeButton.hidden = false;
    closeButton.addEventListener("click", () => bridge?.postMessage?.({ type: "close" }));
  }
  const titleEl = document.getElementById("pdf-title");
  const statusEl = document.getElementById("pdf-status");
  if (statusEl) setLocalizedText(statusEl, "waiting");
  const liveMarkEl = document.getElementById("pdf-live-mark");
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
  // (a Jump made on the static PDF during a Build, asked for again on the
  // Build's PDF: applySync, settleBuildJump)
  let buildJump = null;
  let buildJumpSequence = 0;
  // (a replacing PDF kept hidden until it is placed: loadDocument, releaseStaticPaint)
  let staticPaintHold = null;
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
  let pendingPdfLoad = null;
  let requestedStaticOpen = null;
  let staticLoadFailed = false;
  let streamRetryTimer = null;
  let streamRetryDelay = 300;
  let displayedFallback = false;
  let displayedFallbackGeneration = null;
  let fallbackDocumentId = 0;
  let printing = false;
  const updateExportButtons = () => {
    if (downloadBtn) downloadBtn.disabled = !state.doc;
    if (printBtn) printBtn.disabled = !state.doc || printing;
  };
  updateExportButtons();

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  // A re-search after a reload or a paper switch only refreshes the count
  // and highlights. pdf.js would otherwise scroll to the next hit (through
  // the link service's page and scrollMatchIntoView) and undo where the
  // reader, or a SyncTeX jump, had put the page.
  let findScrollQuiet = false;
  const findLinkService = new Proxy(linkService, {
    get(target, prop) {
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === "page" && findScrollQuiet) return true;
      target[prop] = value;
      return true;
    },
  });
  const findController = new PDFFindController({ eventBus, linkService: findLinkService });
  const scrollMatchIntoView = findController.scrollMatchIntoView.bind(findController);
  findController.scrollMatchIntoView = (args) => {
    if (findScrollQuiet) {
      // Dropped for good, or a later text-layer render would still scroll.
      findController._scrollMatches = false;
      return;
    }
    scrollMatchIntoView(args);
  };
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

  // Progress lives in the Build button only: a busy paper shows nothing here.
  // Words appear for a stale paper, a search count and failures.
  const setStatusDirect = (text, tone = "idle") => {
    if (!statusEl) return;
    if (typeof text === "string") {
      delete statusEl.dataset.pdfUiText;
      statusEl.textContent = text;
    } else {
      setLocalizedText(statusEl, text.key);
    }
    statusEl.classList.toggle("is-error", tone === "error");
  };
  const setStatus = (text, tone = "idle") => {
    if (buildPreviewState === "building") {
      setStatusDirect("", "busy");
      return;
    }
    if (buildPreviewState === "failed" && (state.doc || isLive())) {
      setStatusDirect({ key: "buildFailedLastGood" });
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
      // Only a stale paper is worth a word; "waiting" / "loaded" stay silent.
      if (staticLoadFailed) setStatus({ key: "loadFailed" }, "error");
      else if (reloadInFlight && !state.doc) setStatus({ key: "loading" });
      else setStatus(stale && state.doc ? { key: "rebuildNeeded" } : "");
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
    // The saved choice is "dark", "light" or "system"; with "system" (or none
    // saved) the window follows prefers-color-scheme, which tracks the OS.
    const darkScheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const readChoice = () => {
      try {
        return localStorage.getItem(appearanceKey);
      } catch {
        return null;
      }
    };
    const applyChoice = (choice) => {
      applyViewerTheme(choice === "light" || choice === "dark" ? choice : darkScheme && !darkScheme.matches ? "light" : "dark");
    };
    applyChoice(readChoice());
    window.addEventListener("storage", (event) => {
      if (event.key === appearanceKey) applyChoice(event.newValue);
    });
    darkScheme?.addEventListener?.("change", () => applyChoice(readChoice()));
  }

  const updateZoomLabel = (value = state.scale) => {
    if (!zoomLabel) return;
    zoomLabel.textContent = `${Math.round(value * 100)}%`;
  };

  // The last complete page count shown. While a rebuilt paper is still
  // arriving its count is partial; the previous one stays instead of "—".
  let lastPageCount = 0;
  const updatePageCount = () => {
    if (pageInput) {
      pageInput.max = String(state.pageCount || 1);
    }
    if (pageCountEl) {
      pageCountEl.textContent = `/ ${state.pageCount || 0}`;
    }
    if (state.pageCount > 0) lastPageCount = state.pageCount;
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
    for (const marker of state.extraMarkers ?? []) marker.remove();
    state.extraMarkers = [];
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
      delete outlineEl.dataset.pdfUiText;
    }
    if (thumbnailsEl) {
      thumbnailsEl.innerHTML = "";
      delete thumbnailsEl.dataset.pdfUiText;
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
    delete outlineEl.dataset.pdfUiText;
    if (!state.doc) {
      setLocalizedText(outlineEl, "noPdf");
      return;
    }
    const doc = state.doc;
    const outline = await doc.getOutline().catch(() => null);
    if (doc !== state.doc) return;
    if (!Array.isArray(outline) || outline.length === 0) {
      setLocalizedText(outlineEl, "noOutline");
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
        if (title) button.textContent = title;
        else setLocalizedText(button, "untitled");
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
    delete thumbnailsEl.dataset.pdfUiText;
    if (!state.doc || !state.pageCount) {
      setLocalizedText(thumbnailsEl, "noPdf");
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
    if (displayedFallback && !Number.isSafeInteger(displayedFallbackGeneration)) return;
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
        ...(displayedFallback ? { fallbackGeneration: displayedFallbackGeneration } : {}),
        ...(payload.context ? { context: payload.context } : {}),
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
    setLocalizedText(button, "askAxiom");
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
    setLocalizedText(button, "jumpToSource");
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
    setLocalizedText(askItem, "askAxiom");
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

  // The clicked word and its neighbours on the same typeset line, read from
  // the text layer. The host matches them against the source lines near
  // SyncTeX's answer (SyncTeX alone misplaces a line's first word).
  const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
  const wordContextAt = (event) => {
    try {
      const target = event?.target;
      const span = target instanceof Element ? target.closest(".textLayer span") : null;
      const layer = span?.closest(".textLayer");
      if (!span || !layer || typeof document.caretRangeFromPoint !== "function") return null;
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      const node = range?.startContainer;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const owner = node.parentElement?.closest(".textLayer span");
      if (!owner || !layer.contains(owner)) return null;
      const ownerRect = owner.getBoundingClientRect();
      const lineHeight = Math.max(1, ownerRect.height);
      const sameLine = Array.from(layer.querySelectorAll("span"))
        .filter((item) => item.childElementCount === 0 && item.textContent)
        .map((item) => ({ item, rect: item.getBoundingClientRect() }))
        .filter(({ rect }) => Math.abs(rect.top + rect.height / 2 - (ownerRect.top + ownerRect.height / 2)) < lineHeight * 0.5)
        .sort((a, b) => a.rect.left - b.rect.left);
      let text = "";
      let clicked = -1;
      let previousRight = null;
      for (const { item, rect } of sameLine) {
        if (previousRight !== null && rect.left - previousRight > lineHeight * 0.15 && !/\s$/.test(text)) text += " ";
        if (item === owner || item.contains(node)) {
          let offset = range.startOffset;
          for (const child of item.childNodes) {
            if (child === node) break;
            offset += child.textContent?.length ?? 0;
          }
          clicked = text.length + offset;
        }
        text += item.textContent;
        previousRight = rect.right;
      }
      if (clicked < 0) return null;
      const words = [];
      for (const match of text.matchAll(WORD_PATTERN)) words.push({ value: match[0], start: match.index, end: match.index + match[0].length });
      if (!words.length) return null;
      let at = words.findIndex((item) => clicked >= item.start && clicked <= item.end);
      if (at < 0) {
        at = words.reduce((best, item, i) => (Math.abs(item.start - clicked) < Math.abs(words[best].start - clicked) ? i : best), 0);
      }
      return {
        word: words[at].value,
        prev: words[at - 1]?.value ?? null,
        next: words[at + 1]?.value ?? null,
      };
    } catch {
      return null;
    }
  };

  const resolveClickPoint = (event, textBias = true, includeContext = true) => {
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
    const applyTextBias = textBias && isTextLayerClick && !isNearActiveMarker();
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
    const context = isTextLayerClick && includeContext ? wordContextAt(event) : null;
    return { page, x: synctexX, y: synctexY, ...(context ? { context } : {}) };
  };


  const applySyncHighlight = (pageView, payload, viewX, viewY) => {
    if (!pageView || !(pageView.div instanceof HTMLElement)) {
      return;
    }
    const viewportScale = resolveViewportScale(pageView);
    const pagePdfHeight = resolvePagePdfHeight(pageView);
    // A position that is only roughly known (a neighbouring line stood in,
    // or there is no box for the line at all) is shown as a soft band across
    // the page: "about here", not a frame around a line that may be wrong.
    const placeBand = () => {
      const pageHeight = pageView.div.clientHeight || 1;
      const band = document.createElement("div");
      band.className = "pdf-sync-highlight pdf-sync-highlight-band";
      if (payload.direction === "tate") {
        // Vertical writing: the line is a column, so "about here" is a
        // narrow band down the page around its x (Jump: forward-index.cjs).
        const pageWidth = pageView.div.clientWidth || 1;
        const width = Math.max(18, pageWidth * 0.045);
        band.style.left = `${Math.max(0, Math.min(pageWidth - width, viewX - width / 2))}px`;
        band.style.top = "0px";
        band.style.width = `${width}px`;
        band.style.height = `${pageHeight}px`;
      } else {
        const height = Math.max(18, pageHeight * 0.045);
        band.style.left = "0px";
        band.style.top = `${Math.max(0, Math.min(pageHeight - height, viewY - height / 2))}px`;
        band.style.width = `${pageView.div.clientWidth}px`;
        band.style.height = `${height}px`;
      }
      pageView.div.appendChild(band);
      state.activeMarker = band;
      state.markerTimer = setTimeout(() => {
        clearSyncMarker();
      }, 2400);
    };
    if (payload.approximate === true) {
      placeBand();
      return;
    }
    const hasBlock =
      Number.isFinite(payload.blockWidth) &&
      payload.blockWidth > 0 &&
      Number.isFinite(payload.blockHeight) &&
      Math.abs(payload.blockHeight) > 0;
    // One rectangle per run of typeset lines (a line cut short beside a
    // table is its own), else the single block.
    const blocks = Array.isArray(payload.blocks)
      ? payload.blocks.filter((block) => block && [block.x, block.y, block.width, block.height].every(Number.isFinite) &&
        block.width > 0 && block.height > 0).slice(0, 32)
      : [];
    if (blocks.length > 1) {
      const pad = 2;
      const placed = [];
      for (const block of blocks) {
        const view = Number.isSafeInteger(block.page) && block.page !== payload.page
          ? pdfViewer.getPageView(block.page - 1)
          : pageView;
        if (!view?.viewport || !view.div?.isConnected) continue;
        const pdfHeight = view === pageView ? pagePdfHeight : resolvePagePdfHeight(view);
        const scale = view === pageView ? viewportScale : resolveViewportScale(view);
        const normTop = pdfHeight > 0 ? pdfHeight - block.y : block.y;
        const normBottom = pdfHeight > 0 ? pdfHeight - (block.y + block.height) : block.y + block.height;
        const [ax, ay] = view.viewport.convertToViewportPoint(block.x, normTop);
        const [bx2, by2] = view.viewport.convertToViewportPoint(block.x + block.width, normBottom);
        const left = Math.min(ax, bx2) * scale.x;
        const top = Math.min(ay, by2) * scale.y;
        const width = Math.abs(bx2 - ax) * scale.x;
        const height = Math.abs(by2 - ay) * scale.y;
        if (width <= 1 || height <= 1) continue;
        const marker = document.createElement("div");
        marker.className = "pdf-sync-highlight";
        marker.style.left = `${left - pad}px`;
        marker.style.top = `${top - 1}px`;
        marker.style.width = `${width + pad * 2}px`;
        marker.style.height = `${height + 2}px`;
        view.div.appendChild(marker);
        placed.push(marker);
      }
      if (placed.length) {
        state.activeMarker = placed[0];
        state.extraMarkers = placed.slice(1);
        state.markerTimer = setTimeout(() => {
          clearSyncMarker();
        }, 2400);
        return;
      }
    }
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
        marker.style.top = `${rectTop - 1}px`;
        marker.style.width = `${rectWidth + pad * 2}px`;
        marker.style.height = `${rectHeight + 2}px`;
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
    placeBand();
  };

  const cancelViewportRestore = () => {
    state.pendingRestore = null;
    if (restoreRafId !== null) {
      cancelAnimationFrame(restoreRafId);
      restoreRafId = null;
    }
    if (fallbackHandoff && displayedFallback && fallbackHandoff.generation === displayedFallbackGeneration) {
      fallbackHandoff = null;
      discardRetainedPaper();
    }
  };
  const applySync = (payload) => {
    cancelViewportRestore();
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
    // (a Jump made on this PDF while a Build makes the next one: its line is
    // asked for again once that PDF is on screen, recheckBuildJump)
    if (payload.recheckToken == null) {
      buildJump = buildPreviewState === "building" && payload.marker !== false && payload.sourceFile &&
        Number.isInteger(Number(payload.sourceLine))
        ? { file: payload.sourceFile, line: Number(payload.sourceLine), column: Number(payload.sourceColumn) || 1,
          token: ++buildJumpSequence, reload: false }
        : null;
    }
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

  let lastBuiltPaper = null;
  let openedPaperPath = null;
  // PDF.js chooses its invisible selection font for layout. Japanese
  // Mincho fonts, for example, are often classified there as monospace.
  // Resolve the actual face and baseline only for a run being edited.
  const pageText = new WeakMap();
  const paperTypeface = async (page, node) => {
    const view = pdfViewer.getPageView(page - 1), pdf = view?.pdfPage;
    const div = node.parentElement?.closest('span[role="presentation"]');
    const index = div ? view?.textLayer?.highlighter?.textDivs?.indexOf(div) : -1;
    if (!pdf || index == null || index < 0) return null;
    if (!pageText.has(pdf)) pageText.set(pdf, pdf.getTextContent({ disableNormalization: true })
      .then(content => content.items.filter(item => typeof item.str === "string")));
    const item = (await pageText.get(pdf))[index];
    if (!item || !div.isConnected || item.str !== div.textContent || !pdf.commonObjs.has(item.fontName)) return null;
    const font = pdf.commonObjs.get(item.fontName);
    const name = String(font.name || "").replace(/^[A-Z]{6}\+/, "");
    const family = name.split("-")[0].replace(/["\\]/g, "");
    const generic = /mincho|ming|song|明朝/i.test(name) ? '"Hiragino Mincho ProN", "Yu Mincho", serif'
      : /gothic|goth|sans/i.test(name) ? '"Hiragino Sans", "Yu Gothic", sans-serif'
      : /roman|times|serif/i.test(name) ? '"Times New Roman", serif'
      : getComputedStyle(div).fontFamily;
    const style = { family: family ? '"' + family + '", ' + generic : generic, bold: Boolean(font.bold || /bold/i.test(name)),
      italic: Boolean(font.italic || /italic|oblique/i.test(name)) };
    const rect = view.div.getBoundingClientRect(), scale = resolveViewportScale(view);
    const [, baseline] = view.viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const em = Math.hypot(item.transform[2], item.transform[3]) * view.viewport.scale * scale.y;
    if (!rect.height || !(em > 0) || view.viewport.rotation % 360 !== 0) return null;
    const context = document.createElement("canvas").getContext("2d");
    context.font = (style.italic ? "italic " : "") + (style.bold ? "bold " : "") + em + "px " + style.family;
    const metrics = context.measureText(item.str);
    const ascent = (em + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
    return { ...style, em: em / rect.height,
      top: (resolvePageContentOffset(view.div).top + baseline * scale.y - ascent) / rect.height };
  };
  const paperEditor = fallbackPaperEditor({ bridge, pages: pagesEl, scroll: scrollEl, typeAt: paperTypeface,
    pointAt: event => resolveClickPoint(event, false, false),
    emptyTextRect: (page, point) => {
      const view = pdfViewer.getPageView(page - 1);
      if (!view?.div.isConnected || !view.viewport || view.viewport.rotation % 360 !== 0) return null;
      const [x, baseline] = view.viewport.convertToViewportPoint(point.x, point.y);
      const scale = resolveViewportScale(view), rect = view.div.getBoundingClientRect();
      const offset = resolvePageContentOffset(view.div), height = point.em * view.viewport.scale * scale.y;
      return new DOMRect(rect.left + offset.left + x * scale.x,
        rect.top + offset.top + baseline * scale.y - height * 0.8, 0, height);
    },
    currentPaper: () => displayedFallback && fallbackPaperUrl && openedPaperPath === state.path && Number.isSafeInteger(displayedFallbackGeneration)
      ? { generation: displayedFallbackGeneration, pdfPath: state.path, documentId: fallbackDocumentId } : null });
  let fallbackPaperUrl = null;
  let fallbackGeneration = null;
  let fallbackHandoff = null;
  const clearFallbackPaper = () => {
    clearTimeout(streamRetryTimer);
    streamRetryDelay = 300;
    if (!fallbackPaperUrl) return false;
    if (fallbackPaperUrl.startsWith("blob:")) URL.revokeObjectURL(fallbackPaperUrl);
    fallbackPaperUrl = null;
    return true;
  };

  const loadDocument = async (url, path) => {
    const loadSequence = ++staticLoadSequence;
    staticLoadFailed = false;
    const supersededLoad = pendingPdfLoad;
    pendingPdfLoad = null;
    void supersededLoad?.destroy().catch(() => {});
    // Re-opening the SAME PDF (a rebuild, or the reload button) should keep the
    // current scroll position instead of jumping back to the top — the user is
    // often zoomed into one spot and rebuilding repeatedly. Zoom level is
    // already preserved via state.scale/scaleMode (re-applied on pagesinit).
    const isReload = !!state.doc && state.path !== null && state.path === path;
    // (the paper point at the centre, not the scroll offset: a rebuilt PDF's
    // pages can stand at other offsets, restoreScrollPosition)
    const restorePosition =
      isReload && scrollEl
        ? { scrollTop: scrollEl.scrollTop, scrollLeft: scrollEl.scrollLeft, sync: captureStaticViewportSync(),
          page: pdfViewer.currentPageNumber }
        : null;
    // (the PDF a Jump during the Build was made on is being replaced)
    if (isReload && buildJump) buildJump.reload = true;
    const isFallback = url === fallbackPaperUrl;
    scrollEl?.classList.toggle("pdf-live-viewport", isFallback && (
      !!fallbackHandoff || (isReload && scrollEl.classList.contains("pdf-live-viewport"))
    ));
    const generation = isFallback ? fallbackGeneration : null;
    if (state.doc && !isReload) {
      const previous = state.doc;
      state.doc = null;
      state.path = null;
      state.url = null;
      displayedFallback = false;
      displayedFallbackGeneration = null;
      fallbackDocumentId++;
      paperEditor.view(null, generation);
      pdfViewer.setDocument(null);
      linkService.setDocument(null, null);
      void previous.destroy().catch(() => {});
      clearSidebarContent();
      hideAskButton();
      if (restoreRafId !== null) {
        cancelAnimationFrame(restoreRafId);
        restoreRafId = null;
      }
      state.pageCount = 0;
      lastPageCount = 0;
      if (pageInput) pageInput.value = "";
      updatePageCount();
      updateExportButtons();
      if (isFindOpen()) renderFindCount(0, 0);
    }
    if (titleEl) titleEl.textContent = path ? path.split(/[\\/]/).pop() : "PDF";
    state.pendingSync = null;
    state.pendingRestore = restorePosition;
    reloadInFlight = true;
    clearSyncMarker();
    setStatus({ key: "loading" });
    let task;
    try {
      task = pdfjs.getDocument(createPdfDocumentOptions(url));
      pendingPdfLoad = task;
      const nextDocument = await task.promise;
      if (pendingPdfLoad === task) pendingPdfLoad = null;
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
      const previousDocument = state.doc;
      state.doc = nextDocument;
      state.path = path;
      state.url = url;
      displayedFallback = isFallback;
      displayedFallbackGeneration = generation;
      streamRetryDelay = 300;
      paperEditor.view(generation, null);
      if (!isFallback || !isReload) paperEditor.close();
      updateExportButtons();
      state.pageCount = state.doc.numPages;
      if (!isLive()) updatePageCount();
      clearSidebarContent();
      // A PDF replacing one on screen (a Build's, a reload) is laid out at the
      // old scale and the top before pagesinit gives it its width and place:
      // it is not shown until then and its first page is drawn (at most
      // 600 ms), so no frame shows it at another width or scroll (app
      // measurement: 964 px for 100 ms, scroll 5369 → 0 → 5369).
      if ((isReload || state.pendingSync) && pdfViewer.viewer?.style) {
        pdfViewer.viewer.style.visibility = "hidden";
        staticPaintHold = { since: performance.now(), positioned: false };
        setTimeout(() => releaseStaticPaint(true), 600);
      }
      pdfViewer.setDocument(state.doc);
      linkService.setDocument(state.doc, null);
      void previousDocument?.destroy?.().catch(() => {});
      renderOutline();
      if (!embedded) {
        renderThumbnails();
      }
      refreshStaticStatus();
    } catch (error) {
      if (task && pendingPdfLoad === task) {
        pendingPdfLoad = null;
        void task.destroy().catch(() => {});
      }
      if (loadSequence !== staticLoadSequence) return;
      if (liveSurfaceOwned) {
        deferredStaticOpen = { url, path };
        reloadInFlight = false;
        return;
      }
      reloadInFlight = false;
      staticLoadFailed = true;
      setStatus({ key: "loadFailed" }, "error");
      const temporaryReadError = error?.name === "ResponseException" ? !error.status || error.status >= 500 :
        error?.name === "TypeError" || error?.name === "NetworkError";
      if (url === fallbackPaperUrl && url.startsWith("tex64-pdf:") && temporaryReadError) {
        // Only the visible workspace revision may retry. Reopen its stream,
        // without compiling the source again for a transient read failure.
        clearTimeout(streamRetryTimer);
        streamRetryTimer = setTimeout(() => {
          if (loadSequence === staticLoadSequence && url === fallbackPaperUrl && path === openedPaperPath) {
            requestStaticDocument(url, path);
          }
        }, streamRetryDelay);
        streamRetryDelay = Math.min(30000, streamRetryDelay * 2);
      }
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  const requestStaticDocument = (url, path) => {
    // A newer PDF open also supersedes a deferred post-Live fallback. Its
    // blob may already have been revoked when the viewer changed tabs.
    clearTimeout(streamRetryTimer);
    deferredStaticFlushToken += 1;
    requestedStaticOpen = { url, path };
    if (liveSurfaceOwned && state.doc) {
      deferredStaticOpen = { url, path };
      return;
    }
    deferredStaticOpen = null;
    void loadDocument(url, path);
  };

  const downloadPdf = async () => {
    if (!state.doc) return;
    const { doc, path } = state;
    const data = await doc.getData().catch(() => {
      if (doc === state.doc) setStatus({ key: "loadFailed" }, "error");
      return null;
    });
    if (!data || doc !== state.doc) return;
    const blob = new Blob([data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const filename = path ? path.split(/[\\/]/).pop() : "document.pdf";
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

  // The scroll offset that puts a paper point ({ page, y } from the top, in
  // PDF units) at the viewport's centre, as applySync centres it.
  const scrollTopForPoint = (point) => {
    const pageView = point && state.doc ? pdfViewer.getPageView(Math.max(1, Math.min(state.doc.numPages, point.page)) - 1) : null;
    if (!(pageView?.div instanceof HTMLElement) || !pageView.viewport) return null;
    const pagePdfHeight = resolvePagePdfHeight(pageView);
    if (!(pagePdfHeight > 0)) return null;
    const [, rawViewY] = pageView.viewport.convertToViewportPoint(0, pagePdfHeight - Number(point.y));
    const viewY = rawViewY * resolveViewportScale(pageView).y;
    const contentOffset = resolvePageContentOffset(pageView.div);
    return pageView.div.offsetTop + contentOffset.top + viewY - scrollEl.clientHeight / 2;
  };
  const restoreScrollPosition = (target) => {
    if (!scrollEl || !target) return;
    const apply = () => {
      const top = target.sync ? scrollTopForPoint(target.sync) : null;
      scrollEl.scrollTop = Number.isFinite(top) ? top : target.scrollTop;
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
      const wanted = target.sync ? scrollTopForPoint(target.sync) : null;
      if (Math.abs(scrollEl.scrollTop - (Number.isFinite(wanted) ? wanted : target.scrollTop)) <= 2) {
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
  // The host's answer to "jump-recheck": the Jump's line on the PDF the Build
  // made. Already well in view (the middle 70% of the viewport): the paper
  // does not move again. Elsewhere (the Build moved it): one move there.
  const settleBuildJump = (payload) => {
    const ask = buildJump;
    if (!ask || payload.recheckToken !== ask.token || !scrollEl) return;
    buildJump = null;
    const y = Number.isFinite(Number(payload.blockY))
      ? Number(payload.blockY) + (Number(payload.blockHeight) || 0) / 2 : Number(payload.y);
    const top = scrollTopForPoint({ page: Number(payload.page), y });
    if (!Number.isFinite(top) || Math.abs(top - scrollEl.scrollTop) <= scrollEl.clientHeight * 0.35) return;
    applySync({ ...payload, recheckToken: undefined });
  };
  // The reader's own move ends the re-assertion: the paper is theirs again
  // (it went on for up to 90 frames, pulling the page back from under a
  // wheel or a drag). The restore itself is called off by
  // cancelViewportRestore (the wheel/pointer/touch and paging-key listeners
  // below); this one forgets a Jump made during a Build.
  const stopRestoreOnInput = () => {
    // (the reader has moved on from a Jump made during a Build)
    buildJump = null;
  };
  for (const type of ["wheel", "pointerdown", "touchstart"]) {
    scrollEl?.addEventListener(type, stopRestoreOnInput, { passive: true, capture: true });
  }
  scrollEl?.addEventListener("keydown", stopRestoreOnInput, true);

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
    } else if (fallbackHandoff && displayedFallback && displayedFallbackGeneration === fallbackHandoff.generation) {
      state.pendingRestore = null;
      // At pagesinit PDF.js gives every page the dimensions of page one.
      // Bring the target into view so PDF.js fetches its actual paper box.
      setPage(fallbackHandoff.viewport?.page ?? fallbackHandoff.page ?? 1);
    } else if (pendingPage && state.doc) {
      state.pendingRestore = null;
      pdfViewer.currentPageNumber = Math.max(1, Math.min(state.doc.numPages, pendingPage));
      if (scrollEl) restoreScrollPosition({ scrollTop: scrollEl.scrollTop, scrollLeft: scrollEl.scrollLeft });
    } else if (state.pendingRestore) {
      const target = state.pendingRestore;
      state.pendingRestore = null;
      if (target.page > state.doc.numPages) {
        // The page under the reader was removed. Its old pixel offset can
        // otherwise land in the empty bottom margin of the remaining page.
        setPage(state.doc.numPages);
        const page = pdfViewer.getPageView(state.doc.numPages - 1)?.div;
        if (page) target.scrollTop = Math.max(0, scrollEl.scrollTop + page.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top);
        // (that page's paper point is gone too: the remaining page's top stands)
        target.sync = null;
      }
      restoreScrollPosition(target);
    }
    // A Jump made during the Build that made this PDF: the host is asked for
    // its line on this PDF (Jump agent: "jump-recheck" → "sync" with the
    // same recheckToken), settleBuildJump places it.
    if (buildJump?.reload) {
      const ask = buildJump;
      ask.reload = false;
      requestAnimationFrame(() => {
        if (buildJump !== ask) return;
        bridge?.postMessage?.({ type: "jump-recheck",
          payload: { file: ask.file, line: ask.line, column: ask.column, path: state.path, token: ask.token } });
      });
    }
    // (its width and place are set: it shows once a page of it is drawn)
    if (staticPaintHold) staticPaintHold.positioned = true;
    // Live can start before the first static fallback finishes loading. Seed
    // its viewport handoff after pdf.js has real pages and a scroll position.
    scheduleHeldMirror();
    // A rebuilt PDF has new text: count and mark it again, without moving.
    if (isFindOpen() && findQuery && !isLive()) runFind(findQuery, { quiet: true });
  });

  // (shown again once placed and a page is drawn, or at the cap)
  const releaseStaticPaint = (force = false) => {
    if (!staticPaintHold || (!force && !staticPaintHold.positioned)) return;
    staticPaintHold = null;
    if (pdfViewer.viewer?.style) pdfViewer.viewer.style.visibility = "";
  };
  eventBus.on("pagerendered", () => releaseStaticPaint());
  eventBus.on("pagerendered", ({ pageNumber, source, cssTransform, error }) => {
    if (fallbackHandoff && displayedFallback && fallbackHandoff.generation === displayedFallbackGeneration &&
        !cssTransform && !error && source === pdfViewer.getPageView(pageNumber - 1)) {
      const page = Math.min(fallbackHandoff.viewport?.page ?? fallbackHandoff.page ?? 1, state.doc.numPages);
      if (page === pageNumber) {
        const previousScale = pdfViewer.currentScale;
        positionStaticAtViewport(fallbackHandoff.viewport, page);
        state.scale = pdfViewer.currentScale;
        state.scaleMode = "manual";
        restoreScrollPosition({ scrollTop: scrollEl.scrollTop, scrollLeft: scrollEl.scrollLeft });
        // A scale change schedules a new bitmap. Reveal the page when
        // the bitmap at the reader's magnification has actually painted.
        if (state.scale === previousScale) {
          fallbackHandoff = null;
          discardRetainedPaper();
        }
      }
    }
    paperEditor.position();
    if (!state.pendingSync) {
      return;
    }
    const payload = state.pendingSync;
    state.pendingSync = null;
    applySync(payload);
  });

  // The Jump marker says where the jump landed; any operation of the
  // reader's own (zoom, scroll, click, keys) ends that moment at once.
  eventBus.on("scalechanging", () => clearSyncMarker());
  for (const type of ["wheel", "pointerdown", "touchstart"]) {
    scrollEl?.addEventListener(type, () => {
      cancelViewportRestore();
      if (state.activeMarker) clearSyncMarker();
    }, { passive: true, capture: true });
  }
  document.addEventListener("keydown", (event) => {
    if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key) &&
        !event.target.closest?.("input, textarea, math-field, [contenteditable=true]")) cancelViewportRestore();
    if (state.activeMarker) clearSyncMarker();
  }, true);
  for (const control of [prevBtn, nextBtn, zoomInBtn, zoomOutBtn, fitWidthBtn, fitPageBtn]) {
    control?.addEventListener("click", cancelViewportRestore, true);
  }
  window.addEventListener("resize", () => {
    if (state.activeMarker) clearSyncMarker();
  });
  eventBus.on("scalechanging", (event) => {
    if (!event || typeof event.scale !== "number") {
      return;
    }
    state.scale = event.scale;
    if (!isLive()) updateZoomLabel(event.scale);
  });

  eventBus.on("pagechanging", (event) => {
    // A reset's cover, while it stands where it put the reader's live place,
    // keeps the live toolbar's page: PDF.js names the most visible page, the
    // live paper the top one (tex64-internal #121). Moved, it names its own.
    if (scrollEl && coverHoldsReaderPage(liveViewportHandoff, scrollEl.scrollTop)) return;
    if (pageInput && !isLive()) {
      pageInput.value = String(event.pageNumber);
    }
  });

  window.addEventListener("resize", scheduleScaleModeRefresh);
  // A pane that changes width changes this viewer's fit: the live paper's
  // zoom 1 follows it (staticPaperWidths), once PDF.js has refitted.
  if (typeof ResizeObserver === "function" && scrollEl) {
    let fitFrame = 0;
    new ResizeObserver(() => {
      if (fitFrame || !hasLiveSession()) return;
      fitFrame = requestAnimationFrame(() => requestAnimationFrame(() => {
        fitFrame = 0;
        const widths = staticPaperWidths();
        if (!widths || !hasLiveSession()) return;
        // (Live shows a width the reader chose: it keeps it; at its fit it follows the pane)
        const livePx = Number(liveViewportCenter?.paperPx);
        const zoomed = isLive() && Math.abs(liveToolbar.zoom - 1) > 0.005 && livePx > 0;
        postLive("paper-width", { fitPx: widths.fitPx, ...(zoomed ? { paperPx: livePx } : isLive() ? {} : widths) });
      }));
    }).observe(scrollEl);
  }

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
      cancelViewportRestore();
      const value = Number.parseInt(pageInput.value, 10);
      if (Number.isFinite(value)) setPage(value);
      // Staying on the current page does not emit a pdf.js pagechanging event.
      pageInput.value = String(pdfViewer.currentPageNumber || 1);
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const current = pdfViewer.currentPageNumber;
      scrollToPage(Math.max(1, current - 1));
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const current = pdfViewer.currentPageNumber;
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
      zoomInBtn?.click();
    } else if (event.key === "-") {
      event.preventDefault();
      zoomOutBtn?.click();
    } else if (event.key === "0") {
      event.preventDefault();
      fitWidthBtn?.click();
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
    if (noMatch) setLocalizedText(findCount, "findNoMatch");
    else {
      delete findCount.dataset.pdfUiText;
      findCount.textContent = findQuery ? `${current} / ${total}` : "";
    }
  };
  const clearFindHighlights = () => {
    if (liveFindQuery) {
      liveFindQuery = "";
      postLive("search", { query: "" });
    }
    if (state.doc) eventBus.dispatch("findbarclose", { source: findBar });
  };
  const runFind = (rawQuery, { again = false, findPrevious = false, quiet = false } = {}) => {
    window.clearTimeout(findTypingTimer);
    findTypingTimer = null;
    findScrollQuiet = quiet;
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
    if (returnTo instanceof HTMLElement) {
      if (returnTo.isConnected && returnTo.checkVisibility()) {
        returnTo.focus({ preventScroll: true });
      } else {
        // Resizing the PDF can move its search action into or out of the closed menu.
        const trigger = searchOpenBtn?.checkVisibility() ? searchOpenBtn : document.getElementById("pdf-more");
        trigger?.focus({ preventScroll: true });
      }
    }
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

  const printPdf = async () => {
    const doc = state.doc;
    if (!doc || printBtn.disabled) return;
    printing = true;
    updateExportButtons();
    const paper = document.createElement("div");
    paper.id = "pdf-print-pages";
    const sheetStyle = document.createElement("style");
    const objectUrls = [];
    const sizes = [];
    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        if (doc !== state.doc) return;
        const page = await doc.getPage(pageNumber);
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, 6000 / Math.max(size.width, size.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport, intent: "print" }).promise;
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("Empty print image");
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        await image.decode();
        const sheet = document.createElement("section");
        const name = "pdfsheet" + pageNumber;
        sheet.style.page = name;
        sheet.style.width = size.width + "pt";
        sheet.style.height = size.height + "pt";
        sizes.push(`@page ${name} { size: ${size.width}pt ${size.height}pt; margin: 0; }`);
        sheet.append(image);
        paper.append(sheet);
      }
      if (doc !== state.doc) return;
      sheetStyle.textContent = sizes.join("\n");
      document.head.append(sheetStyle);
      document.body.append(paper);
      window.print();
    } catch {
      if (doc === state.doc) setStatus({ key: "printFailed" }, "error");
    } finally {
      paper.remove();
      sheetStyle.remove();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      printing = false;
      updateExportButtons();
    }
  };
  printBtn?.addEventListener("click", printPdf);
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p" && !event.altKey && !isLive() && state.doc) {
      event.preventDefault();
      void printPdf();
    }
  });

  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      if (!requestedStaticOpen) return;
      const url = new URL(requestedStaticOpen.url, location.href);
      if (["file:", "http:", "https:"].includes(url.protocol)) {
        url.searchParams.set("t", String(Date.now()));
      }
      requestStaticDocument(url.href, requestedStaticOpen.path);
    });
  }

  // ---- live preview (tdom) -----------------------------------------------
  let liveFrame = document.getElementById("pdf-live-frame");
  let retainedLiveFrame = null;
  const discardRetainedPaper = () => {
    retainedLiveFrame?.remove();
    retainedLiveFrame = null;
  };
  let liveToolbar = normalizeLiveToolbarSnapshot();
  let livePdfScale = null;
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
  let liveReloadSequence = 0;
  // The paper point at the centre of the active frame's viewport (its last
  // snapshot): where a document reset hands the reader back to.
  let liveViewportCenter = null;
  // (the static viewer's scale mode before a reset's cover drew it at the live width)
  let scaleModeBeforeCover = null;
  // Live gives the paper back to the static PDF (a Build holds it, Live is
  // turned off): the static PDF opens at the paper point Live had at its
  // centre, not at its page's top nor at its own stale scroll. A paper the
  // reader zoomed in Live keeps its width (an explicit zoom); at Live's
  // fit the static viewer keeps its own scale mode.
  const liveReaderSync = () => {
    const center = liveViewportCenter;
    if (!center || !Number.isFinite(Number(center.page)) || !Number.isFinite(Number(center.y))) return null;
    return { page: Number(center.page), x: 0, y: Number(center.y), blockY: Number(center.y), blockHeight: 0, marker: false };
  };
  // One paper, one width, on either surface (R1). The live frame's zoom 1 is
  // this viewer's fit: PDF.js draws a page-width page `container width - 40`
  // px wide (SCROLLBAR_PADDING; none without page borders). The frame is
  // told that width, and the paper width shown now, before it is revealed
  // or while it follows hidden (postLive); the paper it hands back keeps its
  // width (carryLiveWidth). A reader who never zooms sees the same width on
  // both, at whatever pane width.
  const staticPaperWidths = () => {
    if (!state.doc || !scrollEl) return null;
    const fitPx = scrollEl.clientWidth - (pdfViewer.removePageBorders ? 0 : 40);
    if (!(fitPx > 0)) return null;
    if (state.scaleMode === "fit-width") return { fitPx, paperPx: fitPx };
    const view = pdfViewer.getPageView(Math.max(1, Number(pdfViewer.currentPageNumber) || 1) - 1);
    const paperPx = Number(view?.viewport?.width);
    return paperPx > 0 ? { fitPx, paperPx } : { fitPx };
  };
  // The static cover uses the old page point. The rebuilding frame can
  // recover the reader's text in the new pagination.
  const withLiveReadingAnchor = (place, center) => {
    const source = center?.source;
    if (place && typeof source?.text === "string") return { ...place, sourceAnchor: source };
    if (!place || !source?.file || !Number.isInteger(Number(source.line))) return place;
    return { ...place, sourceFile: source.file, sourceLine: Number(source.line), sourceFraction: Number(source.fraction) || 0 };
  };
  // (the CSS width of the current page at scale 1: a width on screen as PDF.js's scale)
  const cssPerScaleOne = (pageNumber) => {
    const view = state.doc ? pdfViewer.getPageView(Math.max(1, Math.min(state.doc.numPages, Number(pageNumber) || 1)) - 1) : null;
    return view?.viewport && pdfViewer.currentScale > 0 ? view.viewport.width / pdfViewer.currentScale : null;
  };
  const carryLiveWidth = (center) => {
    if (!state.doc || !center || !Number.isFinite(liveToolbar.zoom)) return;
    // Live at its fit is this viewer at its fit (the same width, staticPaperWidths)
    if (Math.abs(liveToolbar.zoom - 1) <= 0.005) {
      // (fitted again now: a fit taken for another container width, before
      // Live covered this viewer, showed for a frame at that width)
      applyScaleMode(state.scaleMode === "fit-page" ? "fit-page" : "fit-width");
      return;
    }
    const scale = coverScaleFor(center.paperPx, cssPerScaleOne(center.page));
    if (!scale) return;
    pdfViewer.currentScale = clampScale(scale);
    state.scaleMode = "manual";
    state.scale = pdfViewer.currentScale;
    updateZoomLabel();
  };
  let heldMirrorTimer = null;
  let liveActivation = null;
  const isLive = () => document.body.classList.contains("is-live");
  const isLivePending = () => document.body.classList.contains("is-live-pending");
  const isLiveHeld = () => document.body.classList.contains("is-live-held");
  const hasLiveSession = () => isLive() || isLivePending() || isLiveHeld();
  const liveViewportSync = (viewport) => {
    if (!Number.isInteger(viewport?.page) || viewport.page < 1) return null;
    const sync = { page: viewport.page, marker: false };
    if (viewport.width > 0 && Number.isFinite(viewport.x)) {
      sync.viewportWidth = viewport.width;
      sync.viewportX = viewport.x;
    }
    if (viewport.paperHeight > 0 && Number.isFinite(viewport.y)) {
      sync.y = viewport.y * viewport.paperHeight;
    }
    return sync;
  };
  const postLive = (action, extra) => {
    const target = liveFrame && liveFrame.contentWindow;
    // (a frame placed while this PDF is what the reader sees draws it as wide: staticPaperWidths)
    const widths = target && action === "goto-sync" && !isLive() ? staticPaperWidths() : null;
    if (widths) target.postMessage({ source: "tdom-host", activationId: liveActivation?.id, action: "paper-width", ...widths }, "*");
    if (target) target.postMessage({
      source: "tdom-host",
      activationId: liveActivation?.id,
      action,
      ...(extra || {}),
    }, "*");
  };
  const paperKey = "tex64.appearance.darkPdfPages";
  const syncPaperColor = () => {
    let dark = false;
    try {
      dark = embedded ? window.parent.document.documentElement.dataset.darkPdfPages === "true"
                      : localStorage.getItem(paperKey) === "true";
    } catch { /* Use the original paper color if the host is unavailable. */ }
    document.documentElement.dataset.darkPdfPages = String(dark);
    if (liveActivation) postLive("paper-appearance", { dark });
  };
  syncPaperColor();
  if (embedded) {
    const observer = new MutationObserver(syncPaperColor);
    observer.observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["data-dark-pdf-pages"] });
  } else {
    window.addEventListener("storage", event => { if (event.key === paperKey) syncPaperColor(); });
  }
  liveFrame?.addEventListener("load", syncPaperColor);
  const retainVisiblePaper = () => {
    // An unbuilt manuscript has no static PDF behind the live frame.
    // Leave the painted browser surface in place during engine recovery.
    // Moving an iframe in the DOM would reload it and lose that surface.
    discardRetainedPaper();
    retainedLiveFrame = liveFrame;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = liveFrame.id;
    nextFrame.title = liveFrame.title;
    nextFrame.className = liveFrame.className;
    liveFrame.removeAttribute("id");
    liveFrame.className = "pdf-retained-live-frame";
    liveFrame.inert = true;
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.removeEventListener("load", syncPaperColor);
    liveFrame.after(nextFrame);
    liveFrame = nextFrame;
    liveFrame.addEventListener("load", syncPaperColor);
  };
  const renderLiveToolbar = () => {
    if (pageCountEl) {
      if (liveToolbar.pageCountAuthoritative) {
        pageCountEl.textContent = `/ ${liveToolbar.pageCount}`;
        if (liveToolbar.pageCount > 0) lastPageCount = liveToolbar.pageCount;
      } else {
        const kept = Math.max(lastPageCount, liveToolbar.pageCount);
        pageCountEl.textContent = kept > 0 ? `/ ${kept}` : "/ —";
      }
    }
    if (pageInputForLive) {
      pageInputForLive.max = String(liveToolbar.pageCount || 1);
      if (document.activeElement !== pageInputForLive) {
        pageInputForLive.value = String(liveToolbar.page);
      }
    }
    // (on this viewer's scale: one paper at one width reads one number on either surface;
    // an engine without the paper width says its PDF scale itself)
    const css1 = cssPerScaleOne(liveViewportCenter?.page);
    const paperPx = Number(liveViewportCenter?.paperPx);
    updateZoomLabel(css1 > 0 && paperPx > 0 ? paperPx / css1 : livePdfScale ?? liveToolbar.zoom);
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
      // Live is still staging (a large document's first typeset can take
      // minutes): the static PDF is the paper on screen, so move it now. Its
      // scroll reaches the frame through the staging viewport mirror, as the
      // reader's own scrolling does; nothing is replayed later over it.
      pendingLiveSync = null;
      applySync(payload);
      return true;
    }
    pendingLiveSync = null;
    renderLiveToolbar();
    postLive("goto-sync", payload);
    return true;
  };
  let liveStatusMark = null;
  const renderLiveMark = (data) => {
    // The frame posts periodic snapshots even while idle; no UI timer or
    // animation is needed for the overload threshold.
    liveStatusMark = stepPdfLiveStatusMark(data?.status, {
      previous: liveStatusMark,
      now: performance.now(),
      presentationPending: isLivePending() || data?.presentationPending,
      appliedSrcRev: data?.srcRev,
    });
    if (!liveMarkEl) return;
    const color = liveStatusMark.color;
    const label = uiString(liveMarkLabel(color));
    liveMarkEl.dataset.color = color;
    liveMarkEl.setAttribute("aria-label", label);
    liveMarkEl.title = label;
  };
  const reportLiveRuntimeError = (error) => {
    bridge?.postMessage?.({ type: "live-runtime-error", payload: error ?? null,
      generation: liveActivation?.generation, url: liveActivation?.url });
  };
  const resetLiveMark = () => {
    reportLiveRuntimeError(null);
    liveStatusMark = null;
    renderLiveMark(null);
  };
  const renderLiveStatus = (data) => {
    renderLiveMark(data);
    const view = resolvePdfLiveStatus(data?.status, data?.presentationPending);
    const error = view?.key === "liveError" && view.detail
      ? { code: "TDOM_TEX_ERROR", message: view.detail }
      : data?.status?.structuredBootError ?? (data?.status?.bibliographyError
        ? { code: "TDOM_TEX_ERROR", message: data.status.bibliographyError } : null);
    reportLiveRuntimeError(error);
    const firstPaperMissing = isLivePending() && !state.doc && !retainedLiveFrame && !data?.status?.canonical?.id;
    const emptied = data?.status?.canonical?.errorCode === "TDOM_PREVIEW_NO_PAGES";
    // A resident page can still show the previous source when TeX stops in
    // a newly opened formula. Let the shell try the current manuscript while
    // keeping the painted page and any focused native field in place.
    const stoppedManuscript = isLive() && !(document.hasFocus() && document.activeElement === liveFrame) &&
      /Emergency stop\.|Missing \$ inserted|File ended while scanning|ended by \\end\{document\}/i.test(view?.detail || "");
    if (view?.key === "liveError" && (firstPaperMissing || emptied || stoppedManuscript) && Number.isInteger(data.status?.srcRev) &&
        data.status.canonical.errorRev === data.status.srcRev) {
      bridge?.postMessage?.({ type: "live-empty-error", payload: {
        generation: liveActivation.generation, url: liveActivation.url, srcRev: data.status.srcRev, retainedPaper: stoppedManuscript,
      } });
    }
    const search = data?.search;
    if (isFindOpen() && findQuery && search?.query === findQuery) {
      renderFindCount(Number(search.current) || 0, Number(search.total) || 0);
    }
    if (search?.query) {
      setStatus(`${Number(search.current) || 0} / ${Number(search.total) || 0}`);
      if (statusEl) statusEl.title = search.query;
      return;
    }
    if (!view) return;
    // While typing the paper just follows the keys: no "updating", "rendering"
    // or compile chatter, and no spinner (progress belongs to the Build
    // button); errors keep their text.
    if (view.tone === "error") setStatus({ key: view.key }, "error");
    else setStatus("", "idle");
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
    // (the paper point Live had at its centre: liveReaderSync; a handoff to
    // the fallback paper carries the reader's place itself: fallbackHandoff)
    const readerSync = isLive() && !fallbackHandoff ? liveReaderSync() : null;
    if (readerSync) carryLiveWidth(liveViewportCenter);
    if (!fallbackHandoff) discardRetainedPaper();
    // Advancing the sequence also invalidates a delayed ready message from a
    // frame that is about to be navigated to about:blank.
    liveActivationSequence += 1;
    cancelLiveReveal();
    liveActivation = null;
    resetLiveMark();
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
    if (isFindOpen() && findQuery) runFind(findQuery, { quiet: true });
    refreshStaticStatus();
    const deferredSync = pendingLiveSync;
    pendingLiveSync = null;
    liveViewportHandoff = null;
    liveViewportCenter = null;
    clearTimeout(heldMirrorTimer);
    // (a Jump that waited for Live wins over the reader's place)
    const placeSync = deferredSync ?? readerSync;
    if (placeSync) requestAnimationFrame(() => applySync(placeSync));
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
        // (the newer PDF opens at that place too)
        if (placeSync && !state.pendingSync) state.pendingSync = placeSync;
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
    if (!(pageView?.div instanceof HTMLElement) || !pageView.viewport) return { page, x: 0, y: 0, marker: false };
    const pageRect = pageView.div.getBoundingClientRect();
    const contentOffset = resolvePageContentOffset(pageView.div);
    const viewportScale = resolveViewportScale(pageView);
    const renderedHeight = Math.max(1, Number(pageView.viewport.height) * viewportScale.y);
    const within = Math.max(0, Math.min(renderedHeight,
      scrollRect.top + scrollEl.clientHeight / 2 - pageRect.top - contentOffset.top));
    const paperHeight = Math.max(1, Number(resolvePagePdfHeight(pageView)) || renderedHeight);
    const paperY = within / renderedHeight * paperHeight;
    // Where the reader was, not a Jump target: no landing marker.
    const viewportWidth = pageView.div.clientWidth;
    const viewportX = (scrollRect.left + scrollEl.clientWidth / 2 - pageRect.left - contentOffset.left) / viewportWidth;
    return { page, x: 0, y: paperY, blockY: paperY, blockHeight: 0, marker: false, viewportWidth, viewportX };
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
      const previous = liveViewportHandoff;
      // A reset's cover where it was put (its own scroll there lands here
      // too): the reader's place taken from the live paper stands.
      if (coverHoldsReaderPage(previous, scrollEl.scrollTop)) return;
      liveViewportHandoff = viewportHandoff(sync);
      // (the reader moved a reset's cover: still a reset's handoff)
      if (previous?.stallMs) liveViewportHandoff.stallMs = previous.stallMs;
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
    // (the paper point Live had at its centre: liveReaderSync)
    const readerSync = isLive() ? liveReaderSync() : null;
    const readerCenter = isLive() ? liveViewportCenter : null;
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
    carryLiveWidth(readerCenter);
    // (the PDF already loaded is shown at once: it stands at the reader's
    // place too, not at its own stale scroll, until the Build's replaces it)
    if (readerSync && state.doc && !reloadInFlight) applySync({ ...readerSync });
    if (pendingStatic) {
      // The Build PDF replaces the static fallback that was hidden under
      // Live; open it where the reader was looking, not at its stale scroll.
      if (readerSync) state.pendingSync = readerSync;
      else if (livePage) state.pendingPage = livePage;
      requestStaticDocument(pendingStatic.url, pendingStatic.path);
      // (requestStaticDocument's load starts afresh: the place goes with it)
      if (readerSync && !state.pendingSync) state.pendingSync = readerSync;
    } else if (readerSync && state.doc) {
      applySync(readerSync);
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
    resetLiveMark();
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = "activation-pending";
    setStatus("", "idle");
    if (liveViewportHandoff) postLive("goto-sync", liveViewportHandoff.sync);
  };
  const livePaperHasAuthoritativePageCount = (data) => {
    if (data?.presentationPending !== false || data?.pageCountAuthoritative === false) return false;
    const expected = liveActivation?.expectedSrcRev;
    return Number.isInteger(expected)
      ? Number(data.srcRev) >= expected
      : data?.ready === true;
  };
  // A frame that stopped building its new paper (a reset's handoff stalled
  // short of the reader's page) boots the document again from the engine,
  // under the same activation.
  const reloadLiveFrame = () => {
    if (!liveFrame || !liveActivation || !liveFrame.src || liveFrame.src === "about:blank") return;
    const next = new URL(liveFrame.src);
    next.searchParams.set("reload", String(++liveReloadSequence));
    liveFrame.src = next.toString();
  };
  // Moves the still-covered frame toward the handed-off point (an unavailable
  // target is left quiet) and says whether the handoff still holds the reveal
  // (app/pdf-live-handoff.ts). A reset's handoff that stalls short of the
  // point reloads the frame, once per reset (kept on the activation: moving
  // the cover replaces the handoff). Whatever else stalls stays under the
  // cover, the static PDF at the reader's place, with the place kept: Live
  // is revealed only where it has painted it.
  const syncAtRemainingPage = (sync, page) => page === sync.page
    ? sync : { ...sync, page, blockY: 0, y: 0, blockHeight: 0 };
  const liveViewportPositioned = (data) => {
    const handoff = liveViewportHandoff;
    if (!handoff) return true;
    const epoch = liveActivation?.pendingDocumentEpoch ?? null;
    const step = stepLiveViewportHandoff(handoff, data, {
      now: performance.now(),
      presentable: livePaperPresentable(data),
      authoritative: livePaperHasAuthoritativePageCount(data),
      reloadAvailable: !!liveActivation && liveActivation.reloadedEpoch !== epoch,
      expectedSrcRev: liveActivation?.expectedSrcRev ?? null,
    });
    // (under the token of the page it is sent to: liveHandoffSyncFor)
    if (step.goto) postLive("goto-sync", liveHandoffSyncFor(handoff, step.goto));
    // (kept until the reveal itself: each snapshot before it must still show
    // the point, activateLive)
    if (step.done) return true;
    if (step.reload) {
      liveActivation.reloadedEpoch = epoch;
      handoff.progress = null;
      reloadLiveFrame();
    }

    return false;
  };
  // After a Build the frame may only replace its PDF once it has applied the
  // revision the engine accepted for the first change and holds complete
  // paper. A certified local edit stays presentationPending until canonical
  // confirms it (and pages beyond a shorter resident pagination stay pending
  // until then), so either completeness signal is accepted here. Other
  // activations wait for an exact paint.
  // While the hands keep moving the frame's applied revision runs ahead of
  // every paper it can show, so "complete for the latest keystroke" never
  // holds until they stop. A canonical generation at or past the first
  // post-Build edit is paper that already contains it: hand over then too,
  // instead of keeping the Build PDF up for the whole run of typing.
  // (app/pdf-live-handoff.ts livePaperPresentableFor: the frame's paint first;
  // a first paper with nothing beneath it shows once the frame painted it)
  const livePaperPresentable = (data) => livePaperPresentableFor(data, liveActivation?.expectedSrcRev) ||
    (!Number.isInteger(liveActivation?.expectedSrcRev) && !state.doc && !retainedLiveFrame &&
      data?.painted !== false && data?.firstPaperPainted === true);
  // A held frame keeps following the static viewport so the first edit can
  // replace the paper without a positioning round trip.
  const alignHeldFrame = (data) => {
    if (heldMirrorTimer) return;
    const sync = captureStaticViewportSync();
    if (!sync) return;
    const target = resolveLiveViewportTarget(sync, data, livePaperHasAuthoritativePageCount(data));
    if (!target) return;
    const page = Number(data.syncPage ?? data.page);
    if (page <= target && page >= target - LIVE_HANDOFF_PAGE_SLACK) return;
    postLive("goto-sync", syncAtRemainingPage(sync, target));
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
    renderLiveStatus(data);
    // Keep the focused paper field, including a native IME composition,
    // until the user finishes. The resident frame can paint underneath.
    if (paperEditor.isEditing()) {
      if (liveActivation.reveal) cancelLiveReveal();
      return false;
    }
    // Move the still-covered frame before judging its paper: the pages it
    // must present are the ones at the handed-off viewport. A reveal staged
    // on an earlier snapshot is called off when this one no longer shows
    // the point (the frame acknowledged it, then scrolled off it).
    if (!liveViewportPositioned(data)) {
      if (liveActivation.reveal) cancelLiveReveal();
      return true;
    }
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
        if (paperEditor.isEditing()) { cancelLiveReveal(); return; }
        if (activation.id !== data.activationId || reveal.documentEpoch !== documentEpoch) return;
        if (Number.isInteger(activation.pendingDocumentEpoch) &&
            documentEpoch !== activation.pendingDocumentEpoch) return;
        const latestData = reveal.data;
        if (!latestData || !livePaperPresentable(latestData)) return;
        if (Number(latestData.documentEpoch) !== documentEpoch) return;

        activation.reveal = null;
        activation.documentEpoch = documentEpoch;
        activation.viewport = latestData.viewport;
        activation.pendingDocumentEpoch = null;
        // The handoff ends here, and the place it reached is the reader's:
        // a reset before the frame's next snapshot still has it.
        liveViewportHandoff = null;
        liveViewportCenter = latestData.viewportCenter ?? liveViewportCenter;
        // (the frame keeps the reader's place again from here: app.js viewAnchor)
        postLive("handoff-done");
        // A reset's cover drew the static PDF at the live paper's width; the
        // static viewer gets back the scale mode it had (it is hidden now).
        if (scaleModeBeforeCover) {
          const mode = scaleModeBeforeCover;
          scaleModeBeforeCover = null;
          if (mode !== "manual") applyScaleMode(mode);
        }
        // Both mutations happen in one task. The already-painted iframe
        // replaces the opaque pdf.js cover on this compositor commit.
        document.body.classList.remove("is-live-pending");
        document.body.classList.add("is-live");
        discardRetainedPaper();
        liveFrame.setAttribute("aria-hidden", "false");
        liveFrame.dataset.livePhase = "active";
        renderLiveToolbar();
        setStatus("", "idle");
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
  // The static PDF stands in for the live paper while a reset rebuilds it: the
  // live zoom (relative to the frame's fit-width paper) and the reader's
  // place. Returns that place in the goto-sync form for the new paper.
  const coverLivePaper = ({ place, page, zoom, paperPx }) => {
    const pageOnly = { page, x: 0, y: 0, blockY: 0, blockHeight: 0, marker: false };
    if (!state.doc) return place ?? pageOnly;
    const wanted = place?.page ?? page;
    const shown = Math.max(1, Math.min(state.doc.numPages, wanted));
    // As wide as the live paper was drawn: at its fit that is this viewer's
    // page width (the frame's zoom 1 is told it, staticPaperWidths), a zoom
    // the reader chose there is its paper width; a frame that did not say
    // falls back to the page width times the live zoom.
    const view = pdfViewer.getPageView(shown - 1);
    const scale = coverScaleFor(paperPx, view?.viewport ? view.viewport.width / pdfViewer.currentScale : null);
    // (given back when Live is revealed again: activateLive)
    if (!scaleModeBeforeCover) scaleModeBeforeCover = state.scaleMode;
    if (Number.isFinite(zoom) && Math.abs(zoom - 1) <= 0.005) {
      pdfViewer.currentScaleValue = "page-width";
      state.scaleMode = "fit-width";
    } else if (scale) {
      pdfViewer.currentScale = clampScale(scale);
      state.scaleMode = "manual";
    } else {
      pdfViewer.currentScaleValue = "page-width";
      if (Number.isFinite(zoom) && Math.abs(zoom - 1) > 0.005) {
        pdfViewer.currentScale = clampScale(pdfViewer.currentScale * zoom);
        state.scaleMode = "manual";
      } else {
        state.scaleMode = "fit-width";
      }
    }
    state.scale = pdfViewer.currentScale;
    if (place && shown === wanted) {
      applySync(place);
      return place;
    }
    pdfViewer.currentPageNumber = shown;
    if (place) return place;
    // No point from the frame: the top of the reader's page, as far down as
    // the static viewport centres it.
    const sync = captureStaticViewportSync();
    return sync ? { ...sync, page: sync.page + (wanted - shown) } : pageOnly;
  };
  const positionStaticAtViewport = (viewport, defaultPage) => {
    const view = state.doc && Number.isInteger(viewport?.page) && viewport.page >= 1
      ? pdfViewer.getPageView(Math.min(viewport.page, state.doc.numPages) - 1)
      : null;
    if (view && viewport.width > 0 && view.viewport?.width > 0 &&
        Number.isFinite(viewport.x) && Number.isFinite(viewport.y)) {
      // Both zoom indicators use PDF points, but the two renderers have
      // different fit-width baselines. Match the sheet's rendered width.
      if (Math.abs(view.viewport.width - viewport.width) > 0.5) {
        pdfViewer.currentScale = clampScale(view.scale * viewport.width / view.viewport.width);
      }
      setPage(viewport.page);
      const rect = view.div.getBoundingClientRect();
      const bounds = scrollEl.getBoundingClientRect();
      scrollEl.scrollLeft += rect.left + view.div.clientLeft + view.div.clientWidth * viewport.x - bounds.left - scrollEl.clientWidth / 2;
      scrollEl.scrollTop += rect.top + view.div.clientTop + view.div.clientHeight * viewport.y - bounds.top - scrollEl.clientHeight / 2;
    } else if (state.doc) {
      setPage(defaultPage);
    }
  };
  const holdStaticForDocumentReset = (data) => {
    if (!liveFrame || !liveActivation) return false;
    const documentEpoch = Number(data?.documentEpoch);
    if (!Number.isInteger(documentEpoch)) return false;
    const adoptedEpoch = Number(liveActivation.documentEpoch);
    const pendingEpoch = Number(liveActivation.pendingDocumentEpoch);
    if (Number.isInteger(adoptedEpoch) && documentEpoch <= adoptedEpoch) return false;
    if (Number.isInteger(pendingEpoch) && documentEpoch < pendingEpoch) return false;
    if (isLive() && data.viewport) liveActivation.viewport = data.viewport;
    if (!state.doc && isLive() && liveActivation.target) {
      // The child keeps its old pages until reset-ack. Keep that surface
      // intact and let a fresh iframe adopt the new document instead.
      const sync = liveViewportSync(data.viewport ?? liveActivation.viewport) ??
        { page: liveToolbar.page, marker: false };
      setLiveMode(liveActivation, { documentEpoch, sync });
      return true;
    }

    // The reader's place on the live paper (tex64-internal #121). The cover
    // shows it instead of its own stale scroll (often its first page), the
    // toolbar keeps the reader's page and zoom, and the new paper is moved
    // back there before it replaces the cover.
    const reader = isLive() && liveToolbar.page > 0
      ? { place: withLiveReadingAnchor(liveReaderPlace(liveViewportCenter), liveViewportCenter), page: liveToolbar.page, zoom: liveToolbar.zoom,
        paperPx: liveViewportCenter?.paperPx }
      : null;
    // a reset that supersedes one still covered: that cover and its toolbar stay
    const covered = !reader && !!liveViewportHandoff?.stallMs;
    cancelLiveReveal();
    liveActivation.pendingDocumentEpoch = documentEpoch;
    resetLiveMark();
    if (!reader && !covered) liveToolbar = normalizeLiveToolbarSnapshot();
    liveViewportCenter = null;
    document.body.classList.remove("is-live");
    document.body.classList.add("is-live-pending");
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = "reset-pending";
    const place = reader ? coverLivePaper(reader) : null;
    if (!covered) restoreStaticToolbar();
    if (reader) renderLiveToolbar();
    if (place && !pendingLiveSync) {
      liveViewportHandoff = {
        ...viewportHandoff(place),
        stallMs: LIVE_RESET_STALL_MS,
        coverScrollTop: scrollEl ? scrollEl.scrollTop : null,
      };
    } else if (covered) {
      // (its stall clock restarts with the newer paper)
      liveViewportHandoff.progress = null;
    }
    setStatus("", "idle");
    // Resolve the new stacking order before allowing the child to discard
    // its old document DOM. The iframe stays paintable below the static PDF.
    getComputedStyle(liveFrame).zIndex;
    postLive("reset-ack", { documentEpoch });
    return true;
  };
  const setLiveMode = (payload, reset = null) => {
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
    fallbackHandoff = null;

    const url = rawUrl.replace(/\/+$/, "");
    const generation = Number(payload?.generation) || 0;
    const hold = payload?.hold === true;
    const expectedSrcRev = Number.isInteger(payload?.expectedSrcRev) ? payload.expectedSrcRev : null;
    if (!reset && liveActivation?.url === url && liveActivation?.generation === generation && hasLiveSession()) {
      // Same engine session and document generation: Build ownership only
      // moves the paper between the static PDF and this frame.
      if (hold && !isLiveHeld()) enterLiveHeld();
      else if (!hold && isLiveHeld()) resumeLiveFromHold(expectedSrcRev);
      return;
    }

    const target = payload.target;
    const samePaper = target?.workspaceRoot && target?.pdfPath &&
      target.workspaceRoot === liveActivation?.target?.workspaceRoot &&
      target.pdfPath === liveActivation?.target?.pdfPath;
    // Reconnecting the existing frame can announce a reset just before
    // the host supplies the new engine generation. Both activations must
    // use the reader's last visible viewport.
    const recoverySync = samePaper && !hold && !isLiveHeld()
      ? liveViewportHandoff?.sync ?? liveViewportSync(liveActivation?.viewport) : null;
    if (!samePaper || hold) discardRetainedPaper();
    else if (isLive()) {
      retainVisiblePaper();
    }
    liveSurfaceOwned = !hold;
    deferredStaticFlushToken += 1;
    const id = `${Date.now().toString(36)}-${(++liveActivationSequence).toString(36)}`;
    cancelLiveReveal();
    liveActivation = {
      id,
      url,
      generation,
      target,
      documentEpoch: null,
      pendingDocumentEpoch: reset?.documentEpoch ?? null,
      viewport: samePaper ? liveActivation?.viewport : null,
      expectedSrcRev: hold ? null : expectedSrcRev,
      reveal: null,
    };
    liveToolbar = normalizeLiveToolbarSnapshot();
    liveViewportCenter = null;
    livePdfScale = null;
    // A new frame opens at its first page. Carry the static viewport so it
    // replaces the paper where the reader is, not at the document start.
    const sync = reset?.sync ?? recoverySync ?? (!hold && state.doc ? captureStaticViewportSync() : null);
    liveViewportHandoff = sync && !pendingLiveSync ? viewportHandoff(sync) : null;
    document.body.classList.remove("is-live", "is-live-pending", "is-live-held");
    document.body.classList.add(hold ? "is-live-held" : "is-live-pending");
    resetLiveMark();
    liveFrame.setAttribute("aria-hidden", "true");
    liveFrame.dataset.livePhase = hold ? "build-held" : "activation-pending";
    hideContextMenu();
    restoreStaticToolbar();
    if (hold) refreshStaticStatus();
    else setStatus("", "idle");

    const params = new URLSearchParams({
      embed: "1",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      activationId: id,
      darkPaper: document.documentElement.dataset.darkPdfPages,
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
      if (isLive()) setStatus("", "idle");
      else if (isLivePending()) setStatus("", "idle");
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
    liveToolbar = normalizeLiveToolbarSnapshot(liveToolbar, { ...data, page: data.activePage ?? data.page });
    if (!data.action) {
      if (isLive() && data.viewport) liveActivation.viewport = data.viewport;
      const scale = data.viewport?.pdfScale;
      livePdfScale = Number.isFinite(scale) && scale > 0 ? scale : null;
    }
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
    if (!data.action) liveViewportCenter = data.viewportCenter ?? null;
    if (data.action === "source") {
      if (!isReverseSynctexEnabled()) return;
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
        const keepPreview = fallbackPaperUrl && openedPaperPath === payload.path &&
          Number.isSafeInteger(payload.previewGeneration) && fallbackGeneration === payload.previewGeneration;
        if (!keepPreview && fallbackHandoff && (payload.url || openedPaperPath !== payload.path)) {
          fallbackHandoff = null;
          discardRetainedPaper();
        }
        openedPaperPath = payload.path || null;
        if (payload.url) {
          lastBuiltPaper = { url: payload.url, path: payload.path || null };
          staticSourceStates.set(payload.path || null, payload.needsRebuild === true);
          document.body.classList.toggle("pdf-needs-rebuild", payload.needsRebuild === true);
          // Build can deliver its saved PDF before announcing success. Keep
          // the current paper until its owner releases this exact generation.
          if (!keepPreview) {
            if (clearFallbackPaper()) {
              fallbackDocumentId++;
              paperEditor.view(null, null);
            }
            requestStaticDocument(payload.url, payload.path || null);
          } else if (staticLoadFailed) requestStaticDocument(fallbackPaperUrl, payload.path);
        }
      }
      if (message.type === "preview-open") {
        const payload = message.payload;
        if (!payload) {
          if (fallbackHandoff) {
            fallbackHandoff = null;
            discardRetainedPaper();
          }
          paperEditor.close();
          fallbackDocumentId++;
          paperEditor.view(null, null);
          if (clearFallbackPaper() && lastBuiltPaper) requestStaticDocument(lastBuiltPaper.url, lastBuiltPaper.path);
          return;
        }
        if (openedPaperPath !== payload.path) return;
        if (fallbackPaperUrl && fallbackGeneration === payload.generation && !staticLoadFailed) return;
        const streamed = typeof payload.url === "string" && /^tex64-pdf:\/\/preview\/[a-f0-9-]{36}$/.test(payload.url);
        if (!streamed && typeof payload.data !== "string") return;
        clearFallbackPaper();
        if (liveActivation && (isLive() || retainedLiveFrame)) {
          fallbackHandoff = { viewport: liveActivation.viewport, page: liveToolbar.page, generation: payload.generation };
          if (isLive()) retainVisiblePaper();
          deactivateLive();
        } else if (fallbackHandoff) {
          fallbackHandoff.generation = payload.generation;
        }
        fallbackGeneration = payload.generation;
        paperEditor.view(displayedFallbackGeneration, fallbackGeneration);
        if (streamed) fallbackPaperUrl = payload.url;
        else {
          const bytes = Uint8Array.from(atob(payload.data), character => character.charCodeAt(0));
          fallbackPaperUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        }
        requestStaticDocument(fallbackPaperUrl, payload.path);
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
        if (buildPreviewState === "building") setStatusDirect("", "busy");
        else if (buildPreviewState === "failed" && (state.doc || isLive())) setStatusDirect({ key: "buildFailedLastGood" });
        else if (isLive()) setStatus("", "idle");
        else if (isLivePending()) setStatus("", "idle");
        else refreshStaticStatus();
      }
      if (message.type === "sync" && message.payload && !fallbackPaperUrl) {
        if (message.payload.recheckToken != null) settleBuildJump(message.payload);
        else if (!applyLiveSync(message.payload)) applySync(message.payload);
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
      // PDF.js covers the whole sheet with its text layer, including empty margins.
      if (!(target instanceof Element) || target.closest(".textLayer span, .textLayer br, .annotationLayer section")) {
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
        if (displayedFallback && !event.shiftKey && !event.altKey) {
          void paperEditor.open(event, resolveClickPoint(event, false, false)).catch(error => console.warn("[preview-edit]", error));
        }
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
