import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "./_lib/http.js";

const LOCALES = ["en", "ja", "zh", "ko", "fr", "de", "es"];

const DEFAULT_ANNOUNCEMENTS = [
  {
    id: "tex64-0.1.17-terminal-billing-hover",
    kind: "info",
    title: {
      en: "Integrated terminal, in-app plans, richer hovers",
      ja: "ターミナル統合・アプリ内プラン管理・ホバー強化",
      zh: "集成终端、应用内方案管理、更强悬停预览",
      ko: "통합 터미널, 앱 내 플랜 관리, 더 풍부한 호버",
      fr: "Terminal intégré, offres dans l'app, survols enrichis",
      de: "Integriertes Terminal, Pläne in der App, reichere Hover",
      es: "Terminal integrado, planes en la app, vistas mejoradas",
    },
    body: {
      en:
        "TeX64 now has an integrated terminal (Ctrl+` in the bottom panel, opens in your project folder) and fully in-app plan management — check your token usage, upgrade, and manage your subscription without leaving the app. Hovers now preview referenced equations, formatted citations, color swatches, PDF figures, and macro definitions. Axiom shows exactly what it's working on, renders math in replies, and no longer jumps while you scroll.",
      ja:
        "ターミナルを統合しました（下部パネル、Ctrl+`、プロジェクトフォルダで起動）。プラン管理もアプリ内で完結：トークン使用量の確認、アップグレード、サブスクリプション管理までアプリを離れずに行えます。ホバーは参照先の数式・整形された文献情報・色スウォッチ・PDF 図版・マクロ定義をプレビューし、Axiom は作業中の内容を表示、チャットの数式をレンダリングし、スクロール中に飛ばされることもなくなりました。",
      zh:
        "TeX64 集成了终端（底部面板，Ctrl+`，在项目文件夹中启动），方案管理也完全在应用内完成：查看 token 用量、升级和管理订阅都无需离开应用。悬停可预览所引用的公式、排版好的文献信息、色块、PDF 插图和宏定义。Axiom 会显示正在处理的内容，在回复中渲染数学公式，滚动时也不会再跳动。",
      ko:
        "터미널이 통합되었습니다(하단 패널, Ctrl+`, 프로젝트 폴더에서 시작). 플랜 관리도 앱 안에서 완결됩니다 — 토큰 사용량 확인, 업그레이드, 구독 관리를 앱을 떠나지 않고 할 수 있습니다. 호버는 참조된 수식, 정리된 문헌 정보, 색상 견본, PDF 그림, 매크로 정의를 미리 보여주며, Axiom은 작업 내용을 표시하고 답변의 수식을 렌더링하며 스크롤 중 튀지 않습니다.",
      fr:
        "TeX64 intègre désormais un terminal (panneau inférieur, Ctrl+`, ouvert dans le dossier du projet) et une gestion des offres entièrement dans l'app : consultez votre utilisation de jetons, passez à une offre supérieure et gérez votre abonnement sans quitter l'application. Les survols prévisualisent les équations référencées, les citations mises en forme, les échantillons de couleur, les figures PDF et les définitions de macros. Axiom montre ce qu'il fait, rend les mathématiques dans ses réponses et ne saute plus pendant le défilement.",
      de:
        "TeX64 hat jetzt ein integriertes Terminal (unteres Panel, Ctrl+`, startet im Projektordner) und vollständige Planverwaltung in der App: Token-Nutzung prüfen, upgraden und das Abo verwalten, ohne die App zu verlassen. Hover zeigen referenzierte Formeln, formatierte Zitate, Farbfelder, PDF-Abbildungen und Makro-Definitionen. Axiom zeigt, woran es arbeitet, rendert Mathematik in Antworten und springt beim Scrollen nicht mehr.",
      es:
        "TeX64 ahora tiene un terminal integrado (panel inferior, Ctrl+`, se abre en la carpeta del proyecto) y gestión de planes totalmente dentro de la app: consulta tu uso de tokens, mejora tu plan y gestiona tu suscripción sin salir de la aplicación. Las vistas al pasar el cursor muestran ecuaciones referenciadas, citas formateadas, muestras de color, figuras PDF y definiciones de macros. Axiom muestra en qué está trabajando, renderiza matemáticas en las respuestas y ya no salta al hacer scroll.",
    },
    url: "https://tex64.com/releases/0.1.17",
    urlLabel: {
      en: "Release notes",
      ja: "リリースノート",
      zh: "发行说明",
      ko: "릴리스 노트",
      fr: "Notes de version",
      de: "Versionshinweise",
      es: "Notas de la versión",
    },
    publishedAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2026-10-31T23:59:59.000Z",
  },
  {
    id: "tex64-0.1.16-axiom-without-login",
    kind: "info",
    title: {
      en: "Axiom is available before sign-in",
      ja: "ログイン前でもAxiomを使えます",
      zh: "无需登录即可使用 Axiom",
      ko: "로그인 전에도 Axiom을 사용할 수 있습니다",
      fr: "Axiom est disponible avant la connexion",
      de: "Axiom ist auch ohne Anmeldung nutzbar",
      es: "Axiom está disponible antes de iniciar sesión",
    },
    body: {
      en:
        "You can now open TeX64 and use Axiom right away, even before signing in. Sign in later if you want usage connected to your account and plan.",
      ja:
        "TeX64を開いてすぐ、ログイン前でもAxiomを使えるようになりました。アカウントやプランに紐づけて使いたい場合は、あとからログインできます。",
      zh:
        "现在打开 TeX64 后，即使尚未登录也可以立即使用 Axiom。若要将使用情况关联到你的账户和方案，可稍后登录。",
      ko:
        "이제 TeX64를 열자마자 로그인 전에도 Axiom을 사용할 수 있습니다. 계정과 플랜에 사용량을 연결하려면 나중에 로그인하면 됩니다.",
      fr:
        "Vous pouvez maintenant ouvrir TeX64 et utiliser Axiom immédiatement, même avant de vous connecter. Connectez-vous ensuite si vous voulez rattacher l’utilisation à votre compte et à votre formule.",
      de:
        "Du kannst TeX64 jetzt öffnen und Axiom sofort nutzen, auch vor der Anmeldung. Melde dich später an, wenn die Nutzung mit deinem Konto und Tarif verbunden werden soll.",
      es:
        "Ahora puedes abrir TeX64 y usar Axiom de inmediato, incluso antes de iniciar sesión. Inicia sesión después si quieres asociar el uso a tu cuenta y plan.",
    },
    url: "https://tex64.com/releases/0.1.16",
    urlLabel: {
      en: "Release notes",
      ja: "リリースノート",
      zh: "发行说明",
      ko: "릴리스 노트",
      fr: "Notes de version",
      de: "Versionshinweise",
      es: "Notas de la versión",
    },
    publishedAt: "2026-06-29T03:48:26.000Z",
    expiresAt: "2026-09-30T23:59:59.000Z",
  },
  {
    id: "tex64-0.1.15-code-comments-pdf-sidebar",
    kind: "info",
    title: {
      en: "Code comments and cleaner PDF sidebar",
      ja: "コードコメントとPDFサイドバー改善",
      zh: "代码评论和更简洁的 PDF 侧边栏",
      ko: "코드 댓글과 더 깔끔한 PDF 사이드바",
      fr: "Commentaires de code et barre PDF plus claire",
      de: "Kommentare im Code und übersichtlichere PDF-Seitenleiste",
      es: "Comentarios de código y barra PDF más clara",
    },
    body: {
      en:
        "You can now comment selected ranges in LaTeX source from the editor context menu. Embedded PDF previews hide thumbnails, while separate PDF windows can still show them.",
      ja:
        "LaTeXコードの選択範囲に、エディタのコンテキストメニューからコメントを付けられるようになりました。アプリ内のPDFプレビューではサムネイルを非表示にし、別ウィンドウのPDFでは引き続き表示できます。",
      zh:
        "现在可以从编辑器的上下文菜单为 LaTeX 源代码中的选中范围添加评论。应用内嵌的 PDF 预览会隐藏缩略图，单独打开的 PDF 窗口仍可显示缩略图。",
      ko:
        "이제 편집기 컨텍스트 메뉴에서 LaTeX 소스의 선택 범위에 댓글을 달 수 있습니다. 앱 안의 PDF 미리보기에서는 썸네일을 숨기고, 별도 PDF 창에서는 계속 표시할 수 있습니다.",
      fr:
        "Vous pouvez maintenant commenter une sélection dans le code LaTeX depuis le menu contextuel de l'éditeur. Les aperçus PDF intégrés masquent les vignettes, tandis que les fenêtres PDF séparées peuvent toujours les afficher.",
      de:
        "Du kannst jetzt ausgewählte Stellen im LaTeX-Code über das Kontextmenü kommentieren. Eingebettete PDF-Vorschauen blenden Thumbnails aus, separate PDF-Fenster können sie weiterhin anzeigen.",
      es:
        "Ahora puedes comentar rangos seleccionados del código LaTeX desde el menú contextual del editor. Las vistas PDF integradas ocultan las miniaturas, mientras que las ventanas PDF separadas aún pueden mostrarlas.",
    },
    url: "https://tex64.com/releases/0.1.15",
    urlLabel: {
      en: "Release notes",
      ja: "リリースノート",
      zh: "发行说明",
      ko: "릴리스 노트",
      fr: "Notes de version",
      de: "Versionshinweise",
      es: "Notas de la versión",
    },
    publishedAt: "2026-06-21T00:00:00.000Z",
    expiresAt: "2026-08-31T23:59:59.000Z",
  },
];

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeLocalizedText = (value) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!isObject(value)) {
    return "";
  }
  const output = {};
  for (const locale of LOCALES) {
    if (typeof value[locale] === "string" && value[locale].trim()) {
      output[locale] = value[locale].trim();
    }
  }
  return Object.keys(output).length > 0 ? output : "";
};

const normalizeUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const normalizeDateText = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const normalizeAnnouncement = (entry) => {
  if (!isObject(entry)) {
    return null;
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const title = normalizeLocalizedText(entry.title);
  const body = normalizeLocalizedText(entry.body);
  if (!id || !title || !body) {
    return null;
  }
  return {
    id,
    kind: entry.kind === "feedback" ? "feedback" : "info",
    title,
    body,
    url: normalizeUrl(entry.url),
    urlLabel: normalizeLocalizedText(entry.urlLabel) || null,
    publishedAt: normalizeDateText(entry.publishedAt),
    expiresAt: normalizeDateText(entry.expiresAt),
  };
};

const readConfiguredAnnouncements = () => {
  const raw = process.env.TEX64_ANNOUNCEMENTS_JSON;
  let configured = [];
  if (typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_ANNOUNCEMENTS;
  }
  try {
    const parsed = JSON.parse(raw);
    configured = Array.isArray(parsed) ? parsed : [];
  } catch {
    configured = [];
  }
  const defaultIds = new Set(DEFAULT_ANNOUNCEMENTS.map((entry) => entry.id));
  const configuredOnly = configured.filter(
    (entry) => !isObject(entry) || !defaultIds.has(String(entry.id || "").trim())
  );
  return [...DEFAULT_ANNOUNCEMENTS, ...configuredOnly];
};

const toTimestamp = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isActiveAnnouncement = (entry, now) => {
  const publishedAt = toTimestamp(entry.publishedAt);
  if (publishedAt !== null && publishedAt > now) {
    return false;
  }
  const expiresAt = toTimestamp(entry.expiresAt);
  if (expiresAt !== null && expiresAt <= now) {
    return false;
  }
  return true;
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "GET") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const now = Date.now();
    const announcements = readConfiguredAnnouncements()
      .map(normalizeAnnouncement)
      .filter((entry) => entry !== null)
      .filter((entry) => isActiveAnnouncement(entry, now));

    sendJson(res, 200, {
      requestId,
      announcements,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
