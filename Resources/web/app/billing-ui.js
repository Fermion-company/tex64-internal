import { getUiLocale } from "./i18n.js";
import { aiText } from "./ai-i18n.js";
const getBilling = () => {
    const bridge = window.tex64Billing;
    return bridge && typeof bridge.checkout === "function" ? bridge : null;
};
const getStripeFactory = () => {
    const factory = window.Stripe;
    return typeof factory === "function" ? factory : null;
};
// Mirrors tex64.com's /pricing copy so the in-app screen matches the website.
// TODO: serve this from GET /api/v2/billing/plans to keep a single source.
const CONTENT = {
    en: {
        heading: "Pricing",
        subheading: "Core local features are free. Basic and Pro expand your monthly Axiom allowance.",
        currentPlan: "Current plan",
        recommended: "Recommended",
        priceMeta: "USD / mo",
        startBasic: "Start Basic",
        startPro: "Start Pro",
        manage: "Manage or cancel subscription",
        free: {
            desc: "Start free with local editing and a monthly AI allowance",
            items: [
                "Local editing & build",
                "PDF preview + SyncTeX",
                "Blocks (math input)",
                "On-device math OCR",
                "Monthly Axiom allowance shown in the app",
                "Documentation access (guides / updates)",
            ],
        },
        basic: {
            desc: "Add AI support to daily writing for faster output",
            items: [
                "AI chat",
                "AI completion (draft / rewrite)",
                "Usage dashboard",
                "Monthly token quota",
                "Longer chat context",
                "Standard-priority feedback handling",
            ],
        },
        pro: {
            desc: "For advanced workflows with expanded AI and platform limits",
            items: [
                "Axiom 1.0 Pro — advanced autonomous writing (Pro only)",
                "Higher monthly quota",
                "Priority AI chat throughput",
                "Wider context for long-form tasks",
                "Priority feedback",
                "Early access to selected releases",
            ],
        },
    },
    ja: {
        heading: "料金",
        subheading: "ローカル基本機能は無料。Basic と Pro で毎月の Axiom 利用枠を拡張できます。",
        currentPlan: "現在のプラン",
        recommended: "おすすめ",
        priceMeta: "USD / 月",
        startBasic: "Basicを開始",
        startPro: "Proを開始",
        manage: "サブスクの管理・解約",
        free: {
            desc: "まずは無料で、ローカル執筆と毎月の AI 利用枠を使う",
            items: [
                "ローカル編集・ビルド",
                "PDFプレビュー + SyncTeX",
                "Blocks（数式入力）",
                "端末内の数式OCR",
                "Axiomの月次利用枠はアプリ内に表示",
                "ドキュメント閲覧（ガイド/更新情報）",
            ],
        },
        basic: {
            desc: "AI補助を日常執筆に組み込み、作業速度を上げる",
            items: [
                "AIチャット",
                "AI補完（下書き・言い換え）",
                "使用量表示",
                "月次トークン上限",
                "会話コンテキストの継続",
                "改善提案の優先反映（通常）",
            ],
        },
        pro: {
            desc: "高度な制作フロー向け。AIと運用の上限を拡張",
            items: [
                "Axiom 1.0 Pro — 高度な自律執筆（Pro限定）",
                "より大きい月次上限",
                "AIチャット優先処理",
                "長文タスク向けの広い文脈",
                "優先改善対象",
                "先行機能の早期アクセス枠",
            ],
        },
    },
    zh: {
        heading: "定价",
        subheading: "核心本地功能免费。Basic 和 Pro 可扩展每月 Axiom 额度。",
        currentPlan: "当前方案",
        recommended: "推荐",
        priceMeta: "美元 / 月",
        startBasic: "开始 Basic",
        startPro: "开始 Pro",
        manage: "管理或取消订阅",
        free: {
            desc: "从免费开始，本地编辑加上每月 AI 额度",
            items: [
                "本地编辑与构建",
                "PDF 预览 + SyncTeX",
                "Blocks（数学输入）",
                "设备端数学 OCR",
                "每月 Axiom 额度显示在应用内",
                "文档访问（指南 / 更新）",
            ],
        },
        basic: {
            desc: "将 AI 支持融入日常写作，提升输出速度",
            items: [
                "AI 聊天",
                "AI 补全（草稿 / 改写）",
                "使用量看板",
                "月度 token 配额",
                "更长的对话上下文",
                "标准优先级的反馈处理",
            ],
        },
        pro: {
            desc: "面向高级工作流，扩展的 AI 与平台限额",
            items: [
                "Axiom 1.0 Pro — 高级自主写作（仅 Pro）",
                "更高的月度配额",
                "优先级 AI 聊天处理",
                "长篇任务的更宽上下文",
                "优先反馈",
                "部分新版本的抢先体验",
            ],
        },
    },
    de: {
        heading: "Preise",
        subheading: "Die lokalen Kernfunktionen sind kostenlos. Basic und Pro erweitern das monatliche Axiom-Kontingent.",
        currentPlan: "Aktueller Plan",
        recommended: "Empfohlen",
        priceMeta: "USD / Monat",
        startBasic: "Basic starten",
        startPro: "Pro starten",
        manage: "Abo verwalten oder kündigen",
        free: {
            desc: "Starten Sie kostenlos mit lokaler Bearbeitung und einem monatlichen KI-Kontingent",
            items: [
                "Lokale Bearbeitung & Build",
                "PDF-Vorschau + SyncTeX",
                "Blocks (Mathematik-Eingabe)",
                "Mathematik-OCR auf dem Gerät",
                "Monatliches Axiom-Kontingent wird in der App angezeigt",
                "Dokumentationszugang (Anleitungen / Updates)",
            ],
        },
        basic: {
            desc: "Integrieren Sie KI-Unterstützung in das tägliche Schreiben für mehr Produktivität",
            items: [
                "KI-Chat",
                "KI-Vervollständigung (Entwurf / Umformulierung)",
                "Nutzungs-Dashboard",
                "Monatliches Token-Kontingent",
                "Längerer Chat-Kontext",
                "Feedback-Bearbeitung mit Standardpriorität",
            ],
        },
        pro: {
            desc: "Für fortgeschrittene Workflows mit erweiterten KI- und Plattformlimits",
            items: [
                "Axiom 1.0 Pro — fortgeschrittenes autonomes Schreiben (nur Pro)",
                "Höheres monatliches Kontingent",
                "Priorisierter KI-Chat-Durchsatz",
                "Weiterer Kontext für längere Texte",
                "Prioritäts-Feedback",
                "Frühzeitiger Zugriff auf ausgewählte Releases",
            ],
        },
    },
    ko: {
        heading: "요금제",
        subheading: "핵심 로컬 기능은 무료입니다. Basic과 Pro는 매월 Axiom 사용량을 확장합니다.",
        currentPlan: "현재 플랜",
        recommended: "추천",
        priceMeta: "USD / 월",
        startBasic: "Basic 시작",
        startPro: "Pro 시작",
        manage: "구독 관리 또는 취소",
        free: {
            desc: "로컬 편집과 매월 AI 사용량으로 무료로 시작합니다",
            items: [
                "로컬 편집 및 빌드",
                "PDF 미리보기 + SyncTeX",
                "Blocks(수식 입력)",
                "기기 내 수식 OCR",
                "월간 Axiom 사용량은 앱에 표시",
                "문서 접근(가이드 / 업데이트)",
            ],
        },
        basic: {
            desc: "일상 집필에 AI 지원을 더해 작업 속도를 높입니다",
            items: [
                "AI 채팅",
                "AI 보완(초안 / 다시쓰기)",
                "사용량 대시보드",
                "월간 토큰 한도",
                "더 긴 채팅 컨텍스트",
                "표준 우선순위 피드백 처리",
            ],
        },
        pro: {
            desc: "고급 워크플로용. 확장된 AI 및 플랫폼 한도",
            items: [
                "Axiom 1.0 Pro — 고급 자율 글쓰기(Pro 전용)",
                "더 높은 월간 한도",
                "우선순위 AI 채팅 처리",
                "장문 작업을 위한 넓은 컨텍스트",
                "우선순위 피드백",
                "선별된 릴리스의 얼리 액세스",
            ],
        },
    },
    fr: {
        heading: "Tarifs",
        subheading: "Les fonctions locales essentielles sont gratuites. Basic et Pro augmentent l’allocation Axiom mensuelle.",
        currentPlan: "Plan actuel",
        recommended: "Recommandé",
        priceMeta: "USD / mois",
        startBasic: "Démarrer Basic",
        startPro: "Démarrer Pro",
        manage: "Gérer ou annuler l'abonnement",
        free: {
            desc: "Commencez gratuitement avec l'édition locale et une allocation IA mensuelle",
            items: [
                "Édition & build en local",
                "Prévisualisation PDF + SyncTeX",
                "Blocks (saisie mathématique)",
                "OCR mathématique sur l’appareil",
                "Allocation Axiom mensuelle affichée dans l’application",
                "Accès à la documentation (guides / mises à jour)",
            ],
        },
        basic: {
            desc: "Intégrez le support IA à votre écriture quotidienne pour gagner en rapidité",
            items: [
                "Chat IA",
                "Complétion IA (brouillon / reformulation)",
                "Tableau de bord d'utilisation",
                "Quota mensuel de jetons",
                "Contexte de chat plus long",
                "Traitement des retours en priorité standard",
            ],
        },
        pro: {
            desc: "Pour les workflows avancés avec des limites IA et plateforme étendues",
            items: [
                "Axiom 1.0 Pro — rédaction autonome avancée (Pro uniquement)",
                "Quota mensuel plus élevé",
                "Débit prioritaire pour le chat IA",
                "Contexte plus large pour les tâches longues",
                "Retours prioritaires",
                "Accès anticipé à des versions sélectionnées",
            ],
        },
    },
    es: {
        heading: "Precios",
        subheading: "Las funciones locales principales son gratis. Basic y Pro amplían la asignación mensual de Axiom.",
        currentPlan: "Plan actual",
        recommended: "Recomendado",
        priceMeta: "USD / mes",
        startBasic: "Iniciar Basic",
        startPro: "Iniciar Pro",
        manage: "Gestionar o cancelar la suscripción",
        free: {
            desc: "Empieza gratis con edición local y una asignación de IA mensual",
            items: [
                "Edición y build en local",
                "Vista previa de PDF + SyncTeX",
                "Blocks (entrada matemática)",
                "OCR matemático en el dispositivo",
                "La asignación mensual de Axiom se muestra en la app",
                "Acceso a la documentación (guías / actualizaciones)",
            ],
        },
        basic: {
            desc: "Añade soporte de IA a tu escritura diaria para producir más rápido",
            items: [
                "Chat de IA",
                "Completado de IA (borrador / reescritura)",
                "Panel de uso",
                "Cuota mensual de tokens",
                "Contexto de chat más largo",
                "Atención de comentarios con prioridad estándar",
            ],
        },
        pro: {
            desc: "Para flujos de trabajo avanzados con límites ampliados de IA y plataforma",
            items: [
                "Axiom 1.0 Pro — redacción autónoma avanzada (solo Pro)",
                "Cuota mensual más alta",
                "Procesamiento prioritario del chat de IA",
                "Contexto más amplio para tareas largas",
                "Comentarios prioritarios",
                "Acceso anticipado a versiones seleccionadas",
            ],
        },
    },
};
const MSG = {
    en: {
        back: "Back to plans",
        billingUnavailable: "Billing is unavailable in this build.",
        stripeLoad: "Couldn't load Stripe. Check your connection and try again.",
        preparing: "Preparing secure checkout…",
        checkoutOpened: "Checkout in progress…",
        complete: "Payment complete — unlocking your plan…",
        embedError: "Couldn't start the embedded checkout. Please try again.",
        signIn: "Please sign in first, then try again.",
        checkoutUnavailable: "Checkout isn't available right now.",
        openingPortal: "Opening your billing portal…",
        noSub: "No active subscription to manage yet.",
        portalErrorPrefix: "Couldn't open the billing portal: ",
        activating: "Payment received — activating your plan…",
        activated: "Your plan is now active. Enjoy!",
        activationSlow: "Payment received. Activation is taking longer than usual — it will finish in the background.",
    },
    ja: {
        back: "プランに戻る",
        billingUnavailable: "このビルドでは課金を利用できません。",
        stripeLoad: "Stripe を読み込めませんでした。接続を確認して再試行してください。",
        preparing: "安全な決済を準備しています…",
        checkoutOpened: "決済中…",
        complete: "決済が完了しました — プランを反映しています…",
        embedError: "埋め込みチェックアウトを開始できませんでした。もう一度お試しください。",
        signIn: "先にサインインしてから再試行してください。",
        checkoutUnavailable: "現在チェックアウトを利用できません。",
        openingPortal: "請求ポータルを開いています…",
        noSub: "管理できる有効なサブスクリプションがありません。",
        portalErrorPrefix: "請求ポータルを開けませんでした：",
        activating: "決済を受け付けました — プランを反映しています…",
        activated: "プランが有効になりました。",
        activationSlow: "決済は完了しています。反映に時間がかかっていますが、バックグラウンドで完了します。",
    },
    zh: {
        back: "返回方案",
        billingUnavailable: "此版本无法使用计费。",
        stripeLoad: "无法加载 Stripe。请检查网络后重试。",
        preparing: "正在准备安全结账…",
        checkoutOpened: "正在结账…",
        complete: "支付完成 — 正在更新您的方案…",
        embedError: "无法启动嵌入式结账，请重试。",
        signIn: "请先登录后再试。",
        checkoutUnavailable: "暂时无法结账。",
        openingPortal: "正在打开计费门户…",
        noSub: "暂无可管理的有效订阅。",
        portalErrorPrefix: "无法打开计费门户：",
        activating: "已收到付款 — 正在激活您的方案…",
        activated: "您的方案已生效。",
        activationSlow: "已收到付款。激活时间比平常长，将在后台完成。",
    },
    de: {
        back: "Zurück zu den Plänen",
        billingUnavailable: "Abrechnung ist in diesem Build nicht verfügbar.",
        stripeLoad: "Stripe konnte nicht geladen werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
        preparing: "Sicherer Checkout wird vorbereitet…",
        checkoutOpened: "Checkout läuft…",
        complete: "Zahlung abgeschlossen — Ihr Plan wird aktiviert…",
        embedError: "Eingebetteter Checkout konnte nicht gestartet werden. Bitte erneut versuchen.",
        signIn: "Bitte zuerst anmelden und erneut versuchen.",
        checkoutUnavailable: "Checkout ist derzeit nicht verfügbar.",
        openingPortal: "Abrechnungsportal wird geöffnet…",
        noSub: "Noch kein aktives Abo zum Verwalten.",
        portalErrorPrefix: "Abrechnungsportal konnte nicht geöffnet werden: ",
        activating: "Zahlung eingegangen — Ihr Plan wird aktiviert…",
        activated: "Ihr Plan ist jetzt aktiv.",
        activationSlow: "Zahlung eingegangen. Die Aktivierung dauert länger als üblich und wird im Hintergrund abgeschlossen.",
    },
    ko: {
        back: "플랜으로 돌아가기",
        billingUnavailable: "이 빌드에서는 결제를 사용할 수 없습니다.",
        stripeLoad: "Stripe를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.",
        preparing: "안전한 결제를 준비하는 중…",
        checkoutOpened: "결제 진행 중…",
        complete: "결제가 완료되었습니다 — 플랜을 반영하는 중…",
        embedError: "임베디드 결제를 시작하지 못했습니다. 다시 시도해 주세요.",
        signIn: "먼저 로그인한 후 다시 시도하세요.",
        checkoutUnavailable: "지금은 결제를 사용할 수 없습니다.",
        openingPortal: "결제 포털을 여는 중…",
        noSub: "관리할 활성 구독이 아직 없습니다.",
        portalErrorPrefix: "결제 포털을 열지 못했습니다: ",
        activating: "결제가 완료되었습니다 — 플랜을 적용하는 중…",
        activated: "플랜이 활성화되었습니다.",
        activationSlow: "결제는 완료되었습니다. 적용이 평소보다 오래 걸리고 있으며 백그라운드에서 완료됩니다.",
    },
    fr: {
        back: "Retour aux offres",
        billingUnavailable: "La facturation n'est pas disponible dans cette version.",
        stripeLoad: "Impossible de charger Stripe. Vérifiez votre connexion et réessayez.",
        preparing: "Préparation du paiement sécurisé…",
        checkoutOpened: "Paiement en cours…",
        complete: "Paiement terminé — activation de votre offre…",
        embedError: "Impossible de démarrer le paiement intégré. Veuillez réessayer.",
        signIn: "Veuillez d'abord vous connecter, puis réessayer.",
        checkoutUnavailable: "Le paiement n'est pas disponible pour le moment.",
        openingPortal: "Ouverture du portail de facturation…",
        noSub: "Aucun abonnement actif à gérer pour l'instant.",
        portalErrorPrefix: "Impossible d'ouvrir le portail de facturation : ",
        activating: "Paiement reçu — activation de votre offre…",
        activated: "Votre offre est maintenant active.",
        activationSlow: "Paiement reçu. L'activation prend plus de temps que d'habitude et se terminera en arrière-plan.",
    },
    es: {
        back: "Volver a los planes",
        billingUnavailable: "La facturación no está disponible en esta versión.",
        stripeLoad: "No se pudo cargar Stripe. Comprueba tu conexión e inténtalo de nuevo.",
        preparing: "Preparando el pago seguro…",
        checkoutOpened: "Pago en curso…",
        complete: "Pago completado: activando tu plan…",
        embedError: "No se pudo iniciar el pago integrado. Inténtalo de nuevo.",
        signIn: "Inicia sesión primero y vuelve a intentarlo.",
        checkoutUnavailable: "El pago no está disponible ahora mismo.",
        openingPortal: "Abriendo tu portal de facturación…",
        noSub: "Aún no hay una suscripción activa que gestionar.",
        portalErrorPrefix: "No se pudo abrir el portal de facturación: ",
        activating: "Pago recibido: activando tu plan…",
        activated: "Tu plan ya está activo.",
        activationSlow: "Pago recibido. La activación está tardando más de lo habitual y se completará en segundo plano.",
    },
};
const msg = () => MSG[getUiLocale()] || MSG.en;
const PLANS = [
    { key: "free", name: "Free", price: "$0", highlight: false },
    { key: "basic", name: "Basic", price: "$12", highlight: true },
    { key: "pro", name: "Pro", price: "$25", highlight: false },
];
const PLAN_RANK = { free: 0, basic: 1, pro: 2 };
export const initBillingUi = (context, deps) => {
    var _a, _b, _c, _d;
    const { plansModal, plansModalClose, plansHeading, plansSub, plansList, plansCheckout, plansCheckoutBack, plansCheckoutMount, plansStatus, } = context.dom;
    let embedded = null;
    let activationTimer = null;
    let checkoutPending = false;
    const setStatus = (message) => {
        if (plansStatus) {
            plansStatus.textContent = message;
        }
    };
    // Status area with a sign-in CTA: checkout needs an account, and a plain
    // "please sign in" text with no way to act on it is a dead end.
    const setStatusWithSignIn = (message) => {
        if (!plansStatus)
            return;
        plansStatus.textContent = "";
        const text = document.createElement("span");
        text.textContent = message;
        plansStatus.appendChild(text);
        if (typeof deps.startSignIn === "function") {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "panel-button plans-signin";
            button.textContent = aiText("login_with_google");
            button.addEventListener("click", () => {
                var _a;
                (_a = deps.startSignIn) === null || _a === void 0 ? void 0 : _a.call(deps);
                setStatus(aiText("login_processing"));
            });
            plansStatus.appendChild(button);
        }
    };
    const stopActivationPoll = () => {
        if (activationTimer !== null) {
            window.clearInterval(activationTimer);
            activationTimer = null;
        }
    };
    // After Stripe reports completion the entitlement lands via webhook, which
    // can lag by seconds. Poll the plan until it flips (or give up gracefully)
    // instead of closing the modal while the old plan is still showing.
    const beginActivationPoll = (purchasedPlan) => {
        var _a;
        stopActivationPoll();
        const targetRank = (_a = PLAN_RANK[purchasedPlan]) !== null && _a !== void 0 ? _a : 1;
        setStatus(msg().activating);
        let ticks = 0;
        activationTimer = window.setInterval(() => {
            var _a;
            ticks += 1;
            deps.onPlanRefresh();
            const current = (deps.getCurrentPlan() || "free").toLowerCase();
            if (((_a = PLAN_RANK[current]) !== null && _a !== void 0 ? _a : 0) >= targetRank) {
                stopActivationPoll();
                showPlansView();
                renderPlans();
                setStatus(msg().activated);
                return;
            }
            if (ticks >= 20) {
                stopActivationPoll();
                showPlansView();
                renderPlans();
                setStatus(msg().activationSlow);
            }
        }, 1500);
    };
    const destroyEmbedded = () => {
        if (embedded) {
            try {
                embedded.destroy();
            }
            catch {
                /* ignore */
            }
            embedded = null;
        }
        if (plansCheckoutMount) {
            plansCheckoutMount.innerHTML = "";
        }
    };
    const showPlansView = () => {
        destroyEmbedded();
        plansCheckout === null || plansCheckout === void 0 ? void 0 : plansCheckout.classList.add("is-hidden");
        plansList === null || plansList === void 0 ? void 0 : plansList.classList.remove("is-hidden");
    };
    (_b = (_a = getBilling()) === null || _a === void 0 ? void 0 : _a.onCheckoutClosed) === null || _b === void 0 ? void 0 : _b.call(_a, ({ plan, outcome }) => {
        var _a;
        deps.onPlanRefresh();
        (_a = deps.refreshUsage) === null || _a === void 0 ? void 0 : _a.call(deps);
        if (outcome === "success") {
            beginActivationPoll(plan || "basic");
            return;
        }
        showPlansView();
        setStatus(outcome === "error" ? msg().checkoutUnavailable : "");
    });
    (_d = (_c = getBilling()) === null || _c === void 0 ? void 0 : _c.onPortalClosed) === null || _d === void 0 ? void 0 : _d.call(_c, () => {
        setStatus("");
        const repaint = () => {
            if ((plansModal === null || plansModal === void 0 ? void 0 : plansModal.classList.contains("is-open")) &&
                (!plansCheckout || plansCheckout.classList.contains("is-hidden"))) {
                renderPlans();
            }
        };
        // Portal changes also arrive through Stripe webhooks. Refresh a few times
        // so a tier change or cancellation does not depend on a fast webhook, and
        // repaint shortly after each renderer → main → network round trip.
        for (const delay of [0, 1500, 4000, 8000]) {
            window.setTimeout(() => {
                var _a;
                deps.onPlanRefresh();
                (_a = deps.refreshUsage) === null || _a === void 0 ? void 0 : _a.call(deps);
                window.setTimeout(repaint, 350);
            }, delay);
        }
    });
    const performCheckout = async (plan) => {
        const billing = getBilling();
        if (!billing) {
            setStatus(msg().billingUnavailable);
            return;
        }
        setStatus(msg().preparing);
        const result = await billing.checkout(plan);
        if (!result || result.error) {
            if ((result === null || result === void 0 ? void 0 : result.code) === "AUTH_REQUIRED") {
                setStatusWithSignIn(msg().signIn);
            }
            else {
                setStatus((result === null || result === void 0 ? void 0 : result.error) || msg().checkoutUnavailable);
            }
            return;
        }
        if (result.hosted) {
            setStatus(msg().checkoutOpened);
            return;
        }
        if (!result.clientSecret || !result.publishableKey) {
            setStatus(msg().checkoutUnavailable);
            return;
        }
        const stripeFactory = getStripeFactory();
        if (!stripeFactory) {
            setStatus(msg().stripeLoad);
            return;
        }
        plansList === null || plansList === void 0 ? void 0 : plansList.classList.add("is-hidden");
        plansCheckout === null || plansCheckout === void 0 ? void 0 : plansCheckout.classList.remove("is-hidden");
        setStatus("");
        try {
            const stripe = stripeFactory(result.publishableKey);
            const checkout = await stripe.initEmbeddedCheckout({
                fetchClientSecret: () => Promise.resolve(result.clientSecret),
                onComplete: () => {
                    var _a;
                    setStatus(msg().complete);
                    deps.onPlanRefresh();
                    (_a = deps.refreshUsage) === null || _a === void 0 ? void 0 : _a.call(deps);
                    beginActivationPoll(plan);
                },
            });
            embedded = checkout;
            if (plansCheckoutMount) {
                checkout.mount(plansCheckoutMount);
            }
        }
        catch {
            setStatus(msg().embedError);
            showPlansView();
        }
    };
    const startCheckout = async (plan) => {
        if (checkoutPending) {
            return;
        }
        checkoutPending = true;
        try {
            await performCheckout(plan);
        }
        finally {
            checkoutPending = false;
        }
    };
    const openPortal = async () => {
        const billing = getBilling();
        if (!billing) {
            setStatus(msg().billingUnavailable);
            return;
        }
        setStatus(msg().openingPortal);
        const result = await billing.openPortal();
        if (result === null || result === void 0 ? void 0 : result.error) {
            setStatus(result.error === "portal unavailable"
                ? msg().noSub
                : `${msg().portalErrorPrefix}${result.error}`);
        }
        else {
            setStatus("");
        }
    };
    const buildCard = (plan, copy, current, currentRank) => {
        var _a;
        const planCopy = copy[plan.key];
        const isCurrent = plan.key === current;
        const rank = (_a = PLAN_RANK[plan.key]) !== null && _a !== void 0 ? _a : 0;
        const card = document.createElement("div");
        card.className = "plan-card";
        if (plan.highlight)
            card.classList.add("is-recommended");
        if (isCurrent)
            card.classList.add("is-current");
        const head = document.createElement("div");
        head.className = "plan-card-head";
        const name = document.createElement("h3");
        name.className = "plan-card-name";
        name.textContent = plan.name;
        head.appendChild(name);
        if (isCurrent || plan.highlight) {
            const chip = document.createElement("span");
            chip.className = "plan-chip";
            chip.textContent = isCurrent ? copy.currentPlan : copy.recommended;
            head.appendChild(chip);
        }
        card.appendChild(head);
        const priceRow = document.createElement("div");
        priceRow.className = "plan-price-row";
        const price = document.createElement("span");
        price.className = "plan-price";
        price.textContent = plan.price;
        priceRow.appendChild(price);
        if (plan.key !== "free") {
            const meta = document.createElement("span");
            meta.className = "plan-price-meta";
            meta.textContent = copy.priceMeta;
            priceRow.appendChild(meta);
        }
        card.appendChild(priceRow);
        const desc = document.createElement("p");
        desc.className = "plan-desc";
        desc.textContent = planCopy.desc;
        card.appendChild(desc);
        const list = document.createElement("ul");
        list.className = "plan-features";
        for (const item of planCopy.items) {
            const li = document.createElement("li");
            const mark = document.createElement("span");
            mark.className = "plan-feature-mark";
            mark.setAttribute("aria-hidden", "true");
            mark.textContent = "✦";
            const text = document.createElement("span");
            text.textContent = item;
            li.append(mark, text);
            list.appendChild(li);
        }
        card.appendChild(list);
        const footer = document.createElement("div");
        footer.className = "plan-card-foot";
        if (isCurrent) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "plan-cta is-current";
            btn.textContent = copy.currentPlan;
            btn.disabled = true;
            footer.appendChild(btn);
        }
        else if (rank > currentRank) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "plan-cta" + (plan.highlight ? " primary" : "");
            btn.textContent = plan.key === "basic" ? copy.startBasic : copy.startPro;
            if (current === "free") {
                btn.addEventListener("click", () => startCheckout(plan.key));
            }
            else {
                // Existing subscribers change tier through the portal (avoids a 2nd sub).
                btn.addEventListener("click", () => openPortal());
            }
            footer.appendChild(btn);
        }
        // Tiers below the current plan show no button (informational).
        card.appendChild(footer);
        return card;
    };
    // Compact usage banner (tokens only, per policy): what you've used this
    // period and when it resets — the numbers people need to pick a plan.
    const buildUsageBanner = () => {
        var _a;
        const usage = (_a = deps.getUsageSnapshot) === null || _a === void 0 ? void 0 : _a.call(deps);
        const summary = usage === null || usage === void 0 ? void 0 : usage.summary;
        if (!(usage === null || usage === void 0 ? void 0 : usage.authenticated) ||
            !summary ||
            !Number.isFinite(summary.limitTokens) ||
            summary.limitTokens <= 0) {
            return null;
        }
        const locale = getUiLocale();
        const formatter = new Intl.NumberFormat(locale);
        const used = Math.max(0, Math.floor(summary.usedTokens || 0));
        const limit = Math.floor(summary.limitTokens);
        const banner = document.createElement("div");
        banner.className = "plans-usage";
        const line = document.createElement("div");
        line.className = "plans-usage-line";
        const label = document.createElement("span");
        label.textContent = `${aiText("usage_title")}: ${formatter.format(used)} / ${formatter.format(limit)} ${aiText("usage_tokens")}`;
        line.appendChild(label);
        if (typeof summary.periodEnd === "string" && summary.periodEnd) {
            const resetAt = Date.parse(summary.periodEnd);
            if (Number.isFinite(resetAt)) {
                const reset = document.createElement("span");
                reset.className = "plans-usage-reset";
                reset.textContent = `${aiText("usage_reset")}: ${new Intl.DateTimeFormat(locale, {
                    month: "short",
                    day: "numeric",
                }).format(new Date(resetAt))}`;
                line.appendChild(reset);
            }
        }
        banner.appendChild(line);
        const bar = document.createElement("div");
        bar.className = "plans-usage-bar";
        const fill = document.createElement("div");
        fill.className = "plans-usage-bar-fill";
        const ratio = Math.max(0, Math.min(1, used / limit));
        fill.style.width = `${Math.round(ratio * 100)}%`;
        if (ratio >= 0.9)
            fill.classList.add("is-high");
        bar.appendChild(fill);
        banner.appendChild(bar);
        return banner;
    };
    const renderPlans = () => {
        var _a;
        const copy = CONTENT[getUiLocale()] || CONTENT.en;
        if (plansHeading)
            plansHeading.textContent = copy.heading;
        if (plansSub)
            plansSub.textContent = copy.subheading;
        if (!plansList)
            return;
        const current = (deps.getCurrentPlan() || "free").toLowerCase();
        const currentRank = (_a = PLAN_RANK[current]) !== null && _a !== void 0 ? _a : 0;
        const onPaidPlan = current === "basic" || current === "pro";
        plansList.innerHTML = "";
        const usageBanner = buildUsageBanner();
        if (usageBanner) {
            plansList.appendChild(usageBanner);
        }
        const grid = document.createElement("div");
        grid.className = "plans-grid-inner";
        for (const plan of PLANS) {
            grid.appendChild(buildCard(plan, copy, current, currentRank));
        }
        plansList.appendChild(grid);
        if (onPaidPlan) {
            const manage = document.createElement("button");
            manage.type = "button";
            manage.className = "plans-manage";
            manage.textContent = copy.manage;
            manage.addEventListener("click", () => openPortal());
            plansList.appendChild(manage);
        }
    };
    const open = () => {
        var _a;
        if (!plansModal) {
            return;
        }
        // Ask for fresh plan + usage; the banner re-renders on the next open if
        // the numbers changed (snapshot updates arrive asynchronously).
        deps.onPlanRefresh();
        (_a = deps.refreshUsage) === null || _a === void 0 ? void 0 : _a.call(deps);
        renderPlans();
        if (plansCheckoutBack)
            plansCheckoutBack.textContent = msg().back;
        showPlansView();
        setStatus("");
        plansModal.classList.add("is-open");
        plansModal.setAttribute("aria-hidden", "false");
        // Refreshed plan/usage arrive async — repaint once they've had a moment,
        // unless the user has already moved into the checkout view.
        window.setTimeout(() => {
            if (plansModal.classList.contains("is-open") &&
                (plansCheckout === null || plansCheckout === void 0 ? void 0 : plansCheckout.classList.contains("is-hidden"))) {
                renderPlans();
            }
        }, 900);
    };
    const close = () => {
        if (!plansModal) {
            return;
        }
        stopActivationPoll();
        destroyEmbedded();
        plansModal.classList.remove("is-open");
        plansModal.setAttribute("aria-hidden", "true");
    };
    plansModalClose === null || plansModalClose === void 0 ? void 0 : plansModalClose.addEventListener("click", close);
    plansCheckoutBack === null || plansCheckoutBack === void 0 ? void 0 : plansCheckoutBack.addEventListener("click", () => {
        showPlansView();
        setStatus("");
    });
    plansModal === null || plansModal === void 0 ? void 0 : plansModal.addEventListener("click", (event) => {
        if (event.target === plansModal) {
            close();
        }
    });
    // Capture phase so Escape reliably closes the modal over other global handlers.
    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && (plansModal === null || plansModal === void 0 ? void 0 : plansModal.classList.contains("is-open"))) {
            event.stopPropagation();
            close();
        }
    }, true);
    window.addEventListener("tex64:open-plans", open);
    return { open, close };
};
