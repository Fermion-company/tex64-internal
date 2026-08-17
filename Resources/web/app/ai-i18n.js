/**
 * User-facing strings for the AI (Axiom) panel UI, localized to the 7 supported
 * UI locales. This covers ONLY what the user reads on screen — the usage meter,
 * model picker, status messages, and login/delete controls. Prompts, tool
 * names, and anything sent to the model are intentionally NOT localized.
 *
 * Dynamic AI strings previously had no localization (and one stray mixed
 * "AI Used量"); this gives them parity with the rest of the app.
 */
import { getUiLocale } from "./i18n.js";
const STRINGS = {
    // ── Usage meter / tooltip ──
    usage_title: { en: "AI usage", ja: "AI使用量", zh: "AI 用量", ko: "AI 사용량", fr: "Utilisation IA", de: "KI-Nutzung", es: "Uso de IA" },
    usage_used: { en: "Used", ja: "使用済み", zh: "已用", ko: "사용", fr: "Utilisé", de: "Verbraucht", es: "Usado" },
    usage_limit: { en: "Limit", ja: "上限", zh: "上限", ko: "한도", fr: "Limite", de: "Limit", es: "Límite" },
    usage_remaining: { en: "Remaining", ja: "残り", zh: "剩余", ko: "남음", fr: "Restant", de: "Verbleibend", es: "Restante" },
    usage_reset: { en: "Reset", ja: "リセット", zh: "重置", ko: "초기화", fr: "Réinit.", de: "Reset", es: "Reinicio" },
    usage_tokens: { en: "tokens", ja: "トークン", zh: "tokens", ko: "토큰", fr: "jetons", de: "Tokens", es: "tokens" },
    // ── Model picker ──
    model_efficient: { en: "Fast and efficient", ja: "高速・低コスト", zh: "快速高效", ko: "빠르고 효율적", fr: "Rapide et efficace", de: "Schnell und effizient", es: "Rápido y eficiente" },
    model_autonomous: { en: "Advanced autonomous writing", ja: "高度な自律執筆", zh: "高级自主写作", ko: "고급 자율 글쓰기", fr: "Rédaction autonome avancée", de: "Fortgeschrittenes autonomes Schreiben", es: "Redacción autónoma avanzada" },
    model_requires_pro: { en: "Requires Pro plan", ja: "Proプランが必要", zh: "需要 Pro 套餐", ko: "Pro 플랜 필요", fr: "Nécessite le plan Pro", de: "Erfordert Pro-Plan", es: "Requiere plan Pro" },
    model_codex: { en: "Uses your ChatGPT subscription", ja: "あなたのChatGPTサブスクで動作", zh: "使用您的 ChatGPT 订阅", ko: "내 ChatGPT 구독으로 실행", fr: "Utilise votre abonnement ChatGPT", de: "Nutzt Ihr ChatGPT-Abo", es: "Usa tu suscripción de ChatGPT" },
    upsell_title: { en: "Axiom 1.0 Pro is a Pro feature", ja: "Axiom 1.0 Pro は Pro 限定です", zh: "Axiom 1.0 Pro 是 Pro 功能", ko: "Axiom 1.0 Pro는 Pro 전용입니다", fr: "Axiom 1.0 Pro est une fonctionnalité Pro", de: "Axiom 1.0 Pro ist eine Pro-Funktion", es: "Axiom 1.0 Pro es una función Pro" },
    upsell_sub: { en: "Upgrade to Pro for advanced autonomous writing.", ja: "Proにアップグレードすると高度な自律執筆を利用できます。", zh: "升级到 Pro 即可使用高级自主写作。", ko: "Pro로 업그레이드하면 고급 자율 글쓰기를 사용할 수 있습니다.", fr: "Passez à Pro pour la rédaction autonome avancée.", de: "Mit Pro erhalten Sie fortgeschrittenes autonomes Schreiben.", es: "Cambia a Pro para usar la redacción autónoma avanzada." },
    see_pro_plans: { en: "See Pro plans", ja: "Proプランを見る", zh: "查看 Pro 套餐", ko: "Pro 플랜 보기", fr: "Voir les plans Pro", de: "Pro-Pläne ansehen", es: "Ver planes Pro" },
    // ── Status messages ──
    status_quota_reached: { en: "You've reached your monthly token limit.", ja: "今月のトークン上限に達しました。", zh: "您已达到本月的 token 上限。", ko: "이번 달 토큰 한도에 도달했습니다.", fr: "Vous avez atteint votre limite de jetons mensuelle.", de: "Sie haben Ihr monatliches Token-Limit erreicht.", es: "Has alcanzado tu límite de tokens del mes." },
    status_next_reset: { en: "Next reset", ja: "次回リセット", zh: "下次重置", ko: "다음 초기화", fr: "Prochaine réinitialisation", de: "Nächster Reset", es: "Próximo reinicio" },
    status_see_plan: { en: "See plan", ja: "プランを見る", zh: "查看套餐", ko: "플랜 보기", fr: "Voir le plan", de: "Plan ansehen", es: "Ver plan" },
    status_plan_check: { en: "Check your plan or contract status.", ja: "プラン/契約状況を確認してください。", zh: "请检查您的套餐或合约状态。", ko: "플랜 또는 계약 상태를 확인하세요.", fr: "Vérifiez votre plan ou l'état de votre contrat.", de: "Prüfen Sie Ihren Plan- oder Vertragsstatus.", es: "Revisa tu plan o el estado del contrato." },
    status_unavailable: { en: "Axiom is not available.", ja: "Axiom は利用できません。", zh: "Axiom 当前不可用。", ko: "Axiom을 사용할 수 없습니다.", fr: "Axiom n'est pas disponible.", de: "Axiom ist nicht verfügbar.", es: "Axiom no está disponible." },
    login_processing: { en: "Signing in with Google…", ja: "Googleでログイン中…", zh: "正在使用 Google 登录…", ko: "Google로 로그인 중…", fr: "Connexion avec Google…", de: "Anmeldung mit Google…", es: "Iniciando sesión con Google…" },
    // ── Login / overlay ──
    login: { en: "Login", ja: "ログイン", zh: "登录", ko: "로그인", fr: "Connexion", de: "Anmelden", es: "Entrar" },
    login_with_google: { en: "Log in with Google", ja: "Googleでログイン", zh: "使用 Google 登录", ko: "Google로 로그인", fr: "Se connecter avec Google", de: "Mit Google anmelden", es: "Iniciar sesión con Google" },
    login_failed: { en: "Login failed.", ja: "ログインに失敗しました。", zh: "登录失败。", ko: "로그인에 실패했습니다.", fr: "Échec de la connexion.", de: "Anmeldung fehlgeschlagen.", es: "Error al iniciar sesión." },
    overlay_title: { en: "Accelerate TeX writing with Axiom", ja: "Axiom で TeX 執筆を加速", zh: "用 Axiom 加速 TeX 写作", ko: "Axiom으로 TeX 작성 가속화", fr: "Accélérez l'écriture TeX avec Axiom", de: "TeX-Schreiben mit Axiom beschleunigen", es: "Acelera la escritura TeX con Axiom" },
    overlay_subtitle: { en: "Log in to use Axiom", ja: "Axiom を使うにはログイン", zh: "登录后即可使用 Axiom", ko: "Axiom을 사용하려면 로그인", fr: "Connectez-vous pour utiliser Axiom", de: "Anmelden, um Axiom zu nutzen", es: "Inicia sesión para usar Axiom" },
    login_err_open: { en: "The login page could not be opened.", ja: "ログインページを開けませんでした。", zh: "无法打开登录页面。", ko: "로그인 페이지를 열 수 없습니다.", fr: "Impossible d'ouvrir la page de connexion.", de: "Die Anmeldeseite konnte nicht geöffnet werden.", es: "No se pudo abrir la página de inicio de sesión." },
    login_err_browser: { en: "Failed to start the browser.", ja: "ブラウザを起動できませんでした。", zh: "无法启动浏览器。", ko: "브라우저를 시작하지 못했습니다.", fr: "Échec du démarrage du navigateur.", de: "Browser konnte nicht gestartet werden.", es: "No se pudo iniciar el navegador." },
    login_err_timeout: { en: "Login timed out.", ja: "ログインがタイムアウトしました。", zh: "登录超时。", ko: "로그인 시간이 초과되었습니다.", fr: "Délai de connexion dépassé.", de: "Zeitüberschreitung bei der Anmeldung.", es: "Tiempo de inicio de sesión agotado." },
    login_err_confirm: { en: "Could not confirm login status.", ja: "ログイン状態を確認できませんでした。", zh: "无法确认登录状态。", ko: "로그인 상태를 확인할 수 없습니다.", fr: "Impossible de confirmer l'état de connexion.", de: "Anmeldestatus konnte nicht bestätigt werden.", es: "No se pudo confirmar el estado de inicio de sesión." },
    login_err_validate: { en: "Login validation failed.", ja: "ログインの検証に失敗しました。", zh: "登录验证失败。", ko: "로그인 검증에 실패했습니다.", fr: "Échec de la validation de la connexion.", de: "Login-Überprüfung fehlgeschlagen.", es: "Falló la validación del inicio de sesión." },
    // ── Agent activity (thinking bubble / status line) ──
    status_thinking: { en: "Thinking...", ja: "考え中...", zh: "思考中...", ko: "생각 중...", fr: "Réflexion...", de: "Denkt nach...", es: "Pensando..." },
    status_working: { en: "Working...", ja: "作業中...", zh: "处理中...", ko: "작업 중...", fr: "En cours...", de: "Arbeitet...", es: "Trabajando..." },
    status_preparing: { en: "Preparing...", ja: "準備中...", zh: "准备中...", ko: "준비 중...", fr: "Préparation...", de: "Vorbereitung...", es: "Preparando..." },
    // ── Tool activity labels (shown while the agent runs a tool) ──
    tool_read_file: { en: "Reading file", ja: "ファイルを読み取り中", zh: "正在读取文件", ko: "파일 읽는 중", fr: "Lecture du fichier", de: "Datei wird gelesen", es: "Leyendo archivo" },
    tool_list_files: { en: "Checking folder structure", ja: "フォルダ構成を確認中", zh: "正在查看目录结构", ko: "폴더 구조 확인 중", fr: "Analyse des dossiers", de: "Ordnerstruktur wird geprüft", es: "Revisando carpetas" },
    tool_list_sections: { en: "Reading document outline", ja: "文書構成を確認中", zh: "正在读取文档大纲", ko: "문서 개요 읽는 중", fr: "Lecture du plan du document", de: "Dokumentgliederung wird gelesen", es: "Leyendo el esquema" },
    tool_read_section: { en: "Reading section", ja: "セクションを読み取り中", zh: "正在读取章节", ko: "섹션 읽는 중", fr: "Lecture de la section", de: "Abschnitt wird gelesen", es: "Leyendo sección" },
    tool_replace_section: { en: "Rewriting section", ja: "セクションを書き換え中", zh: "正在改写章节", ko: "섹션 다시 쓰는 중", fr: "Réécriture de la section", de: "Abschnitt wird umgeschrieben", es: "Reescribiendo sección" },
    tool_append_to_section: { en: "Extending section", ja: "セクションに追記中", zh: "正在扩写章节", ko: "섹션에 덧붙이는 중", fr: "Extension de la section", de: "Abschnitt wird erweitert", es: "Ampliando sección" },
    tool_find_math_region: { en: "Locating equation", ja: "数式を特定中", zh: "正在定位公式", ko: "수식 찾는 중", fr: "Localisation de l'équation", de: "Formel wird gesucht", es: "Localizando ecuación" },
    tool_replace_lines: { en: "Replacing lines", ja: "行を置換中", zh: "正在替换行", ko: "행 바꾸는 중", fr: "Remplacement de lignes", de: "Zeilen werden ersetzt", es: "Reemplazando líneas" },
    tool_insert_lines: { en: "Inserting lines", ja: "行を挿入中", zh: "正在插入行", ko: "행 삽입 중", fr: "Insertion de lignes", de: "Zeilen werden eingefügt", es: "Insertando líneas" },
    tool_delete_lines: { en: "Deleting lines", ja: "行を削除中", zh: "正在删除行", ko: "행 삭제 중", fr: "Suppression de lignes", de: "Zeilen werden gelöscht", es: "Eliminando líneas" },
    tool_create_file: { en: "Creating file", ja: "ファイルを作成中", zh: "正在创建文件", ko: "파일 만드는 중", fr: "Création du fichier", de: "Datei wird erstellt", es: "Creando archivo" },
    tool_write_file: { en: "Writing file", ja: "ファイルを書き込み中", zh: "正在写入文件", ko: "파일 쓰는 중", fr: "Écriture du fichier", de: "Datei wird geschrieben", es: "Escribiendo archivo" },
    tool_apply_patch: { en: "Applying changes", ja: "変更を適用中", zh: "正在应用更改", ko: "변경 적용 중", fr: "Application des modifications", de: "Änderungen werden angewendet", es: "Aplicando cambios" },
    tool_get_compile_log: { en: "Checking build log", ja: "ビルドログを確認中", zh: "正在查看编译日志", ko: "빌드 로그 확인 중", fr: "Vérification du journal de compilation", de: "Build-Log wird geprüft", es: "Revisando registro de compilación" },
    tool_arxiv_search: { en: "Searching arXiv", ja: "arXiv を検索中", zh: "正在搜索 arXiv", ko: "arXiv 검색 중", fr: "Recherche sur arXiv", de: "arXiv wird durchsucht", es: "Buscando en arXiv" },
    tool_arxiv_bibtex: { en: "Fetching BibTeX", ja: "BibTeX を取得中", zh: "正在获取 BibTeX", ko: "BibTeX 가져오는 중", fr: "Récupération du BibTeX", de: "BibTeX wird geladen", es: "Obteniendo BibTeX" },
    tool_run_command: { en: "Running command", ja: "コマンドを実行中", zh: "正在运行命令", ko: "명령 실행 중", fr: "Exécution de la commande", de: "Befehl wird ausgeführt", es: "Ejecutando comando" },
    tool_check_environment: { en: "Checking environment", ja: "環境を確認中", zh: "正在检查环境", ko: "환경 확인 중", fr: "Vérification de l'environnement", de: "Umgebung wird geprüft", es: "Comprobando entorno" },
    tool_install_environment: { en: "Installing environment", ja: "環境をインストール中", zh: "正在安装环境", ko: "환경 설치 중", fr: "Installation de l'environnement", de: "Umgebung wird installiert", es: "Instalando entorno" },
    // ── Background-chat toast ──
    toast_done: { en: "Done", ja: "完了", zh: "完成", ko: "완료", fr: "Terminé", de: "Fertig", es: "Listo" },
    toast_issues: { en: "Issues", ja: "問題あり", zh: "有问题", ko: "문제 발생", fr: "Problèmes", de: "Probleme", es: "Problemas" },
    toast_view: { en: "View", ja: "表示", zh: "查看", ko: "보기", fr: "Afficher", de: "Anzeigen", es: "Ver" },
    // ── Delete-chat modal ──
    delete_chat: { en: "Delete chat", ja: "チャットを削除", zh: "删除对话", ko: "채팅 삭제", fr: "Supprimer la conversation", de: "Chat löschen", es: "Eliminar chat" },
    cancel: { en: "Cancel", ja: "キャンセル", zh: "取消", ko: "취소", fr: "Annuler", de: "Abbrechen", es: "Cancelar" },
    confirm_delete: { en: "Delete", ja: "削除", zh: "删除", ko: "삭제", fr: "Supprimer", de: "Löschen", es: "Eliminar" },
    new_chat: { en: "New chat", ja: "新規チャット", zh: "新对话", ko: "새 채팅", fr: "Nouvelle conversation", de: "Neuer Chat", es: "Chat nuevo" },
};
/** Localized AI-UI string for the current UI locale (falls back to English). */
export const aiText = (key) => {
    var _a;
    const entry = STRINGS[key];
    if (!entry)
        return String(key);
    return (_a = entry[getUiLocale()]) !== null && _a !== void 0 ? _a : entry.en;
};
// Backend agent statuses arrive as fixed English strings (the main process
// is locale-agnostic). Map the known ones to localized text; anything else
// (e.g. tool detail labels already localized upstream) passes through.
const BACKEND_STATUS_KEYS = {
    "Thinking...": "status_thinking",
    "Working...": "status_working",
    "Preparing...": "status_preparing",
};
/** Localize a backend-issued status string when it is one of the known ones. */
export const localizeAgentStatus = (text) => {
    const key = BACKEND_STATUS_KEYS[text.trim()];
    return key ? aiText(key) : text;
};
/** Localized label for an agent tool by tool name; falls back to `fallback`. */
export const localizeToolLabel = (name, fallback) => {
    var _a;
    const key = `tool_${name}`;
    const entry = STRINGS[key];
    if (!entry)
        return fallback;
    return (_a = entry[getUiLocale()]) !== null && _a !== void 0 ? _a : entry.en;
};
