import type { AppContext } from "./context.js";
import { getUiLocale } from "./i18n.js";

type BillingBridge = {
  checkout: (
    plan: string
  ) => Promise<{ clientSecret?: string; publishableKey?: string; error?: string; code?: string }>;
  openPortal: () => Promise<{ ok?: boolean; error?: string }>;
};

type EmbeddedCheckout = { mount: (el: HTMLElement | string) => void; destroy: () => void };
type StripeFactory = (publishableKey: string) => {
  initEmbeddedCheckout: (opts: {
    fetchClientSecret: () => Promise<string>;
    onComplete?: () => void;
  }) => Promise<EmbeddedCheckout>;
};

const getBilling = (): BillingBridge | null => {
  const bridge = (window as unknown as { tex64Billing?: BillingBridge }).tex64Billing;
  return bridge && typeof bridge.checkout === "function" ? bridge : null;
};

const getStripeFactory = (): StripeFactory | null => {
  const factory = (window as unknown as { Stripe?: StripeFactory }).Stripe;
  return typeof factory === "function" ? factory : null;
};

type PlanCopy = { desc: string; items: string[] };
type LocaleCopy = {
  heading: string;
  subheading: string;
  currentPlan: string;
  recommended: string;
  priceMeta: string;
  startBasic: string;
  startPro: string;
  manage: string;
  free: PlanCopy;
  basic: PlanCopy;
  pro: PlanCopy;
};

// Mirrors tex64.com's /pricing copy so the in-app screen matches the website.
// TODO: serve this from GET /api/v2/billing/plans to keep a single source.
const CONTENT: Record<string, LocaleCopy> = {
  en: {
    heading: "Pricing",
    subheading:
      "Core features plus a monthly AI allowance (~200K tokens) are free. Use Basic or Pro for daily AI work.",
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
        "AI: ~200,000 tokens / month",
        "Documentation access (guides / updates)",
        "Basic account controls",
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
        "Axiom 0.9.1 Pro — most capable model (Pro only)",
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
    subheading:
      "基本機能と毎月の AI 利用枠（約20万トークン）は無料。日常的に使うなら Basic か Pro を。",
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
        "AI：月 約 200,000 トークン",
        "ドキュメント閲覧（ガイド/更新情報）",
        "アカウント管理（基本）",
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
        "Axiom 0.9.1 Pro — 最も高性能なモデル（Pro限定）",
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
    subheading: "核心功能与每月 AI 额度（约 20 万 tokens）免费。日常使用 AI 请选择 Basic 或 Pro。",
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
        "AI：每月约 200,000 tokens",
        "文档访问（指南 / 更新）",
        "基本账户管理",
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
        "Axiom 0.9.1 Pro — 最强模型（仅 Pro）",
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
    subheading:
      "Kernfunktionen und ein monatliches KI-Kontingent (~200K Tokens) sind kostenlos. Nutzen Sie Basic oder Pro für tägliche KI-Arbeit.",
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
        "KI: ~200.000 Tokens / Monat",
        "Dokumentationszugang (Anleitungen / Updates)",
        "Grundlegende Kontoverwaltung",
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
        "Axiom 0.9.1 Pro — leistungsstärkstes Modell (nur Pro)",
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
    subheading:
      "핵심 기능과 매월 AI 사용량(약 20만 토큰)은 무료입니다. 일상적인 AI 사용은 Basic 또는 Pro를 이용하세요.",
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
        "AI: 월 약 200,000 토큰",
        "문서 접근(가이드 / 업데이트)",
        "기본 계정 관리",
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
        "Axiom 0.9.1 Pro — 가장 강력한 모델(Pro 전용)",
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
    subheading:
      "Les fonctionnalités principales et une allocation IA mensuelle (~200K jetons) sont gratuites. Utilisez Basic ou Pro pour un usage IA quotidien.",
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
        "IA : ~200 000 jetons / mois",
        "Accès à la documentation (guides / mises à jour)",
        "Contrôles de compte de base",
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
        "Axiom 0.9.1 Pro — modèle le plus performant (Pro uniquement)",
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
    subheading:
      "Las funciones principales y una asignación de IA mensual (~200K tokens) son gratis. Usa Basic o Pro para el uso diario de IA.",
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
        "IA: ~200.000 tokens / mes",
        "Acceso a la documentación (guías / actualizaciones)",
        "Controles básicos de cuenta",
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
        "Axiom 0.9.1 Pro — el modelo más capaz (solo Pro)",
        "Cuota mensual más alta",
        "Procesamiento prioritario del chat de IA",
        "Contexto más amplio para tareas largas",
        "Comentarios prioritarios",
        "Acceso anticipado a versiones seleccionadas",
      ],
    },
  },
};

// Transient status / error strings + the "back" label, localized for all 7 UI
// languages (uiText only covers en/ja, so we keep our own table here).
type BillingMessages = {
  back: string;
  billingUnavailable: string;
  stripeLoad: string;
  preparing: string;
  complete: string;
  embedError: string;
  signIn: string;
  checkoutUnavailable: string;
  openingPortal: string;
  noSub: string;
  portalErrorPrefix: string;
};

const MSG: Record<string, BillingMessages> = {
  en: {
    back: "Back to plans",
    billingUnavailable: "Billing is unavailable in this build.",
    stripeLoad: "Couldn't load Stripe. Check your connection and try again.",
    preparing: "Preparing secure checkout…",
    complete: "Payment complete — unlocking your plan…",
    embedError: "Couldn't start the embedded checkout. Please try again.",
    signIn: "Please sign in first, then try again.",
    checkoutUnavailable: "Checkout isn't available right now.",
    openingPortal: "Opening your billing portal…",
    noSub: "No active subscription to manage yet.",
    portalErrorPrefix: "Couldn't open the billing portal: ",
  },
  ja: {
    back: "プランに戻る",
    billingUnavailable: "このビルドでは課金を利用できません。",
    stripeLoad: "Stripe を読み込めませんでした。接続を確認して再試行してください。",
    preparing: "安全な決済を準備しています…",
    complete: "決済が完了しました — プランを反映しています…",
    embedError: "埋め込みチェックアウトを開始できませんでした。もう一度お試しください。",
    signIn: "先にサインインしてから再試行してください。",
    checkoutUnavailable: "現在チェックアウトを利用できません。",
    openingPortal: "請求ポータルを開いています…",
    noSub: "管理できる有効なサブスクリプションがありません。",
    portalErrorPrefix: "請求ポータルを開けませんでした：",
  },
  zh: {
    back: "返回方案",
    billingUnavailable: "此版本无法使用计费。",
    stripeLoad: "无法加载 Stripe。请检查网络后重试。",
    preparing: "正在准备安全结账…",
    complete: "支付完成 — 正在更新您的方案…",
    embedError: "无法启动嵌入式结账，请重试。",
    signIn: "请先登录后再试。",
    checkoutUnavailable: "暂时无法结账。",
    openingPortal: "正在打开计费门户…",
    noSub: "暂无可管理的有效订阅。",
    portalErrorPrefix: "无法打开计费门户：",
  },
  de: {
    back: "Zurück zu den Plänen",
    billingUnavailable: "Abrechnung ist in diesem Build nicht verfügbar.",
    stripeLoad: "Stripe konnte nicht geladen werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
    preparing: "Sicherer Checkout wird vorbereitet…",
    complete: "Zahlung abgeschlossen — Ihr Plan wird aktiviert…",
    embedError: "Eingebetteter Checkout konnte nicht gestartet werden. Bitte erneut versuchen.",
    signIn: "Bitte zuerst anmelden und erneut versuchen.",
    checkoutUnavailable: "Checkout ist derzeit nicht verfügbar.",
    openingPortal: "Abrechnungsportal wird geöffnet…",
    noSub: "Noch kein aktives Abo zum Verwalten.",
    portalErrorPrefix: "Abrechnungsportal konnte nicht geöffnet werden: ",
  },
  ko: {
    back: "플랜으로 돌아가기",
    billingUnavailable: "이 빌드에서는 결제를 사용할 수 없습니다.",
    stripeLoad: "Stripe를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.",
    preparing: "안전한 결제를 준비하는 중…",
    complete: "결제가 완료되었습니다 — 플랜을 반영하는 중…",
    embedError: "임베디드 결제를 시작하지 못했습니다. 다시 시도해 주세요.",
    signIn: "먼저 로그인한 후 다시 시도하세요.",
    checkoutUnavailable: "지금은 결제를 사용할 수 없습니다.",
    openingPortal: "결제 포털을 여는 중…",
    noSub: "관리할 활성 구독이 아직 없습니다.",
    portalErrorPrefix: "결제 포털을 열지 못했습니다: ",
  },
  fr: {
    back: "Retour aux offres",
    billingUnavailable: "La facturation n'est pas disponible dans cette version.",
    stripeLoad: "Impossible de charger Stripe. Vérifiez votre connexion et réessayez.",
    preparing: "Préparation du paiement sécurisé…",
    complete: "Paiement terminé — activation de votre offre…",
    embedError: "Impossible de démarrer le paiement intégré. Veuillez réessayer.",
    signIn: "Veuillez d'abord vous connecter, puis réessayer.",
    checkoutUnavailable: "Le paiement n'est pas disponible pour le moment.",
    openingPortal: "Ouverture du portail de facturation…",
    noSub: "Aucun abonnement actif à gérer pour l'instant.",
    portalErrorPrefix: "Impossible d'ouvrir le portail de facturation : ",
  },
  es: {
    back: "Volver a los planes",
    billingUnavailable: "La facturación no está disponible en esta versión.",
    stripeLoad: "No se pudo cargar Stripe. Comprueba tu conexión e inténtalo de nuevo.",
    preparing: "Preparando el pago seguro…",
    complete: "Pago completado: activando tu plan…",
    embedError: "No se pudo iniciar el pago integrado. Inténtalo de nuevo.",
    signIn: "Inicia sesión primero y vuelve a intentarlo.",
    checkoutUnavailable: "El pago no está disponible ahora mismo.",
    openingPortal: "Abriendo tu portal de facturación…",
    noSub: "Aún no hay una suscripción activa que gestionar.",
    portalErrorPrefix: "No se pudo abrir el portal de facturación: ",
  },
};

const msg = (): BillingMessages => MSG[getUiLocale()] || MSG.en;

type PlanKey = "free" | "basic" | "pro";
const PLANS: Array<{ key: PlanKey; name: string; price: string; highlight: boolean }> = [
  { key: "free", name: "Free", price: "$0", highlight: false },
  { key: "basic", name: "Basic", price: "$12", highlight: true },
  { key: "pro", name: "Pro", price: "$25", highlight: false },
];
const PLAN_RANK: Record<string, number> = { free: 0, basic: 1, pro: 2 };

export type BillingUiApi = { open: () => void; close: () => void };

export type BillingUiDeps = {
  getCurrentPlan: () => string;
  onPlanRefresh: () => void;
};

export const initBillingUi = (context: AppContext, deps: BillingUiDeps): BillingUiApi => {
  const {
    plansModal,
    plansModalClose,
    plansHeading,
    plansSub,
    plansList,
    plansCheckout,
    plansCheckoutBack,
    plansCheckoutMount,
    plansStatus,
  } = context.dom;

  let embedded: EmbeddedCheckout | null = null;

  const setStatus = (message: string) => {
    if (plansStatus) {
      plansStatus.textContent = message;
    }
  };

  const destroyEmbedded = () => {
    if (embedded) {
      try {
        embedded.destroy();
      } catch {
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
    plansCheckout?.classList.add("is-hidden");
    plansList?.classList.remove("is-hidden");
  };

  const startCheckout = async (plan: string) => {
    const billing = getBilling();
    const stripeFactory = getStripeFactory();
    if (!billing) {
      setStatus(msg().billingUnavailable);
      return;
    }
    if (!stripeFactory) {
      setStatus(msg().stripeLoad);
      return;
    }
    setStatus(msg().preparing);
    const result = await billing.checkout(plan);
    if (!result || result.error || !result.clientSecret || !result.publishableKey) {
      const reason =
        result?.code === "AUTH_REQUIRED"
          ? msg().signIn
          : result?.error || msg().checkoutUnavailable;
      setStatus(reason);
      return;
    }

    plansList?.classList.add("is-hidden");
    plansCheckout?.classList.remove("is-hidden");
    setStatus("");

    try {
      const stripe = stripeFactory(result.publishableKey);
      const checkout = await stripe.initEmbeddedCheckout({
        fetchClientSecret: () => Promise.resolve(result.clientSecret as string),
        onComplete: () => {
          setStatus(msg().complete);
          deps.onPlanRefresh();
          window.setTimeout(() => {
            deps.onPlanRefresh();
            close();
          }, 1500);
        },
      });
      embedded = checkout;
      if (plansCheckoutMount) {
        checkout.mount(plansCheckoutMount);
      }
    } catch {
      setStatus(msg().embedError);
      showPlansView();
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
    if (result?.error) {
      setStatus(
        result.error === "portal unavailable"
          ? msg().noSub
          : `${msg().portalErrorPrefix}${result.error}`
      );
    } else {
      setStatus("");
    }
  };

  const buildCard = (
    plan: (typeof PLANS)[number],
    copy: LocaleCopy,
    current: string,
    currentRank: number
  ): HTMLElement => {
    const planCopy = copy[plan.key];
    const isCurrent = plan.key === current;
    const rank = PLAN_RANK[plan.key] ?? 0;

    const card = document.createElement("div");
    card.className = "plan-card";
    if (plan.highlight) card.classList.add("is-recommended");
    if (isCurrent) card.classList.add("is-current");

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
    } else if (rank > currentRank) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "plan-cta" + (plan.highlight ? " primary" : "");
      btn.textContent = plan.key === "basic" ? copy.startBasic : copy.startPro;
      if (current === "free") {
        btn.addEventListener("click", () => startCheckout(plan.key));
      } else {
        // Existing subscribers change tier through the portal (avoids a 2nd sub).
        btn.addEventListener("click", () => openPortal());
      }
      footer.appendChild(btn);
    }
    // Tiers below the current plan show no button (informational).
    card.appendChild(footer);

    return card;
  };

  const renderPlans = () => {
    const copy = CONTENT[getUiLocale()] || CONTENT.en;
    if (plansHeading) plansHeading.textContent = copy.heading;
    if (plansSub) plansSub.textContent = copy.subheading;
    if (!plansList) return;

    const current = (deps.getCurrentPlan() || "free").toLowerCase();
    const currentRank = PLAN_RANK[current] ?? 0;
    const onPaidPlan = current === "basic" || current === "pro";

    plansList.innerHTML = "";
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
    if (!plansModal) {
      return;
    }
    renderPlans();
    if (plansCheckoutBack) plansCheckoutBack.textContent = msg().back;
    showPlansView();
    setStatus("");
    plansModal.classList.add("is-open");
    plansModal.setAttribute("aria-hidden", "false");
  };

  const close = () => {
    if (!plansModal) {
      return;
    }
    destroyEmbedded();
    plansModal.classList.remove("is-open");
    plansModal.setAttribute("aria-hidden", "true");
  };

  plansModalClose?.addEventListener("click", close);
  plansCheckoutBack?.addEventListener("click", () => {
    showPlansView();
    setStatus("");
  });
  plansModal?.addEventListener("click", (event) => {
    if (event.target === plansModal) {
      close();
    }
  });
  // Capture phase so Escape reliably closes the modal over other global handlers.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && plansModal?.classList.contains("is-open")) {
        event.stopPropagation();
        close();
      }
    },
    true
  );
  window.addEventListener("tex64:open-plans", open);

  return { open, close };
};
