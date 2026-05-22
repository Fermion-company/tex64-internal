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
    model_standard: { en: "Standard", ja: "標準", zh: "标准", ko: "표준", fr: "Standard", de: "Standard", es: "Estándar" },
    model_most_capable: { en: "Most capable", ja: "最高性能", zh: "最强性能", ko: "최고 성능", fr: "Le plus performant", de: "Leistungsstärkste", es: "Más capaz" },
    model_requires_pro: { en: "Requires Pro plan", ja: "Proプランが必要", zh: "需要 Pro 套餐", ko: "Pro 플랜 필요", fr: "Nécessite le plan Pro", de: "Erfordert Pro-Plan", es: "Requiere plan Pro" },
    upsell_title: { en: "Axiom 0.9.1 Pro is a Pro feature", ja: "Axiom 0.9.1 Pro は Pro 限定です", zh: "Axiom 0.9.1 Pro 是 Pro 功能", ko: "Axiom 0.9.1 Pro는 Pro 전용입니다", fr: "Axiom 0.9.1 Pro est une fonctionnalité Pro", de: "Axiom 0.9.1 Pro ist eine Pro-Funktion", es: "Axiom 0.9.1 Pro es una función Pro" },
    upsell_sub: { en: "Upgrade to the Pro plan to use the most capable model.", ja: "Proプランにアップグレードすると最高性能のモデルを使えます。", zh: "升级到 Pro 套餐即可使用最强性能的模型。", ko: "Pro 플랜으로 업그레이드하면 최고 성능 모델을 사용할 수 있습니다.", fr: "Passez au plan Pro pour utiliser le modèle le plus performant.", de: "Mit dem Pro-Plan nutzen Sie das leistungsstärkste Modell.", es: "Cambia al plan Pro para usar el modelo más capaz." },
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
