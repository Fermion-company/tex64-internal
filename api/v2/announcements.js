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
    id: "tex64-0.1.17-hover-axiom-polish",
    kind: "info",
    title: {
      en: "Richer hovers and a clearer Axiom",
      ja: "ホバー表示の強化とAxiomの改善",
      zh: "更强大的悬停预览与更清晰的 Axiom",
      ko: "더 풍부한 호버와 더 명확한 Axiom",
      fr: "Survols enrichis et Axiom plus clair",
      de: "Reichere Hover-Vorschauen und ein klareres Axiom",
      es: "Vistas de cursor más ricas y un Axiom más claro",
    },
    body: {
      en:
        "Hover previews got a big upgrade: \\ref shows the referenced equation, section, or caption, citations appear as a formatted reference card, color commands show inline swatches, PDF figures get thumbnails, and custom macros reveal their definition. Axiom now tells you exactly what it is working on (down to the file), renders \\( \\) and \\[ \\] math in replies, and no longer jumps to the bottom while you read older messages.",
      ja:
        "ホバーが大幅に強化されました。\\ref は参照先の数式・セクション・キャプションをプレビューし、引用は整形された文献カード、色コマンドはスウォッチ、PDF 図版はサムネイル、自作マクロは定義を表示します。Axiom は作業中の内容（どのファイルを扱っているかまで）を表示し、チャットの \\( \\) や \\[ \\] の数式をレンダリングし、過去のメッセージを読んでいる間に最下部へ飛ばされることもなくなりました。",
      zh:
        "悬停预览全面升级：\\ref 会显示所引用的公式、章节或图表标题，引用以排版好的文献卡片呈现，颜色命令显示色块，PDF 插图显示缩略图，自定义宏会显示其定义。Axiom 现在会实时显示正在处理的内容（具体到文件），聊天回复中的 \\( \\) 和 \\[ \\] 数学公式会渲染，阅读历史消息时也不会再被强制拉到底部。",
      ko:
        "호버 미리보기가 크게 강화되었습니다. \\ref는 참조된 수식·섹션·캡션을 미리 보여주고, 인용은 정리된 문헌 카드로, 색상 명령은 색상 견본, PDF 그림은 썸네일, 사용자 매크로는 정의를 표시합니다. Axiom은 지금 어떤 작업을 하는지(어느 파일인지까지) 보여주고, 채팅 답변의 \\( \\)와 \\[ \\] 수식을 렌더링하며, 이전 메시지를 읽는 동안 맨 아래로 튀지 않습니다.",
      fr:
        "Les aperçus au survol ont été nettement améliorés : \\ref affiche l'équation, la section ou la légende référencée, les citations apparaissent en fiche bibliographique mise en forme, les commandes de couleur montrent un échantillon, les figures PDF ont des vignettes et les macros personnalisées révèlent leur définition. Axiom indique désormais précisément ce qu'il fait (jusqu'au fichier), rend les mathématiques \\( \\) et \\[ \\] dans les réponses, et ne saute plus en bas pendant que vous lisez d'anciens messages.",
      de:
        "Die Hover-Vorschau wurde deutlich verbessert: \\ref zeigt die referenzierte Formel, den Abschnitt oder die Beschriftung, Zitate erscheinen als formatierte Literaturkarte, Farbbefehle zeigen ein Farbfeld, PDF-Abbildungen erhalten Vorschaubilder und eigene Makros zeigen ihre Definition. Axiom zeigt jetzt genau, woran es arbeitet (bis hin zur Datei), rendert \\( \\)- und \\[ \\]-Mathematik in Antworten und springt nicht mehr nach unten, während du ältere Nachrichten liest.",
      es:
        "Las vistas previas al pasar el cursor mejoraron mucho: \\ref muestra la ecuación, sección o leyenda referenciada, las citas aparecen como ficha bibliográfica formateada, los comandos de color muestran una muestra, las figuras PDF tienen miniaturas y las macros propias revelan su definición. Axiom ahora indica exactamente en qué está trabajando (hasta el archivo), renderiza matemáticas \\( \\) y \\[ \\] en las respuestas, y ya no salta al final mientras lees mensajes anteriores.",
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
