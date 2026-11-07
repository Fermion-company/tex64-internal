import type { AppContext } from "./context.js";
import type { PlatformUsageSnapshot } from "./types.js";
import { getUiLocale } from "./i18n.js";
import { aiText } from "./ai-i18n.js";

type BillingBridge = {
  checkout: (
    plan: string
  ) => Promise<{
    hosted?: boolean;
    error?: string;
    code?: string;
  }>;
  openPortal: () => Promise<{ ok?: boolean; error?: string }>;
  onPortalClosed?: (handler: () => void) => () => void;
};

export type BillingCheckoutClosedPayload = {
  plan?: string;
  outcome?: "success" | "cancel" | "closed" | "error";
};

const getBilling = (): BillingBridge | null => {
  const bridge = (window as unknown as { tex64Billing?: BillingBridge }).tex64Billing;
  return bridge && typeof bridge.checkout === "function" ? bridge : null;
};

type LocaleCopy = {
  heading: string;
  currentPlan: string;
  priceMeta: string;
  startBasic: string;
  startPro: string;
  changePlan: string;
  manage: string;
  // What each plan includes, one short line per feature.
  free: string[];
  basic: string[];
  pro: string[];
};

// TODO: serve this from GET /api/v2/billing/plans to keep a single source.
const CONTENT: Record<string, LocaleCopy> = {
  en: {
    heading: "Pricing",
    currentPlan: "Current",
    priceMeta: "USD / mo",
    startBasic: "Start Basic",
    startPro: "Start Pro",
    changePlan: "Change plan",
    manage: "Manage or cancel subscription",
    free: [
      "Local editing & build",
      "PDF preview + SyncTeX",
      "Math input",
      "Math OCR",
    ],
    basic: [
      "AI chat",
      "Monthly token quota",
      "Longer chat context",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "Higher monthly quota",
      "Priority AI chat throughput",
      "Wider context",
      "Early access",
    ],
  },
  ja: {
    heading: "料金",
    currentPlan: "利用中",
    priceMeta: "USD / 月",
    startBasic: "Basicを開始",
    startPro: "Proを開始",
    changePlan: "プランを変更",
    manage: "サブスクの管理・解約",
    free: [
      "ローカル編集・ビルド",
      "PDFプレビュー + SyncTeX",
      "数式入力",
      "数式OCR",
    ],
    basic: [
      "AIチャット",
      "月次トークン上限",
      "会話の継続",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "月次上限の拡大",
      "AIチャット優先処理",
      "長文対応",
      "先行アクセス",
    ],
  },
  zh: {
    heading: "定价",
    currentPlan: "当前",
    priceMeta: "美元 / 月",
    startBasic: "开始 Basic",
    startPro: "开始 Pro",
    changePlan: "更改方案",
    manage: "管理或取消订阅",
    free: [
      "本地编辑与构建",
      "PDF 预览 + SyncTeX",
      "数学输入",
      "数学 OCR",
    ],
    basic: [
      "AI 聊天",
      "月度 token 配额",
      "更长的对话上下文",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "更高的月度配额",
      "优先级 AI 聊天处理",
      "更宽的上下文",
      "抢先体验",
    ],
  },
  de: {
    heading: "Preise",
    currentPlan: "Aktuell",
    priceMeta: "USD / Monat",
    startBasic: "Basic starten",
    startPro: "Pro starten",
    changePlan: "Plan ändern",
    manage: "Abo verwalten oder kündigen",
    free: [
      "Lokale Bearbeitung & Build",
      "PDF-Vorschau + SyncTeX",
      "Mathematik-Eingabe",
      "Mathematik-OCR",
    ],
    basic: [
      "KI-Chat",
      "Monatliches Token-Kontingent",
      "Längerer Chat-Kontext",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "Höheres monatliches Kontingent",
      "Priorisierter KI-Chat-Durchsatz",
      "Weiterer Kontext",
      "Frühzeitiger Zugriff",
    ],
  },
  ko: {
    heading: "요금제",
    currentPlan: "이용 중",
    priceMeta: "USD / 월",
    startBasic: "Basic 시작",
    startPro: "Pro 시작",
    changePlan: "플랜 변경",
    manage: "구독 관리 또는 취소",
    free: [
      "로컬 편집 및 빌드",
      "PDF 미리보기 + SyncTeX",
      "수식 입력",
      "수식 OCR",
    ],
    basic: [
      "AI 채팅",
      "월간 토큰 한도",
      "더 긴 채팅 컨텍스트",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "더 높은 월간 한도",
      "우선순위 AI 채팅 처리",
      "더 넓은 컨텍스트",
      "얼리 액세스",
    ],
  },
  fr: {
    heading: "Tarifs",
    currentPlan: "Actuel",
    priceMeta: "USD / mois",
    startBasic: "Démarrer Basic",
    startPro: "Démarrer Pro",
    changePlan: "Changer d'offre",
    manage: "Gérer ou annuler l'abonnement",
    free: [
      "Édition & build en local",
      "Prévisualisation PDF + SyncTeX",
      "Saisie mathématique",
      "OCR mathématique",
    ],
    basic: [
      "Chat IA",
      "Quota mensuel de jetons",
      "Contexte de chat plus long",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "Quota mensuel plus élevé",
      "Débit prioritaire pour le chat IA",
      "Contexte plus large",
      "Accès anticipé",
    ],
  },
  es: {
    heading: "Precios",
    currentPlan: "Actual",
    priceMeta: "USD / mes",
    startBasic: "Iniciar Basic",
    startPro: "Iniciar Pro",
    changePlan: "Cambiar de plan",
    manage: "Gestionar o cancelar la suscripción",
    free: [
      "Edición y build en local",
      "Vista previa de PDF + SyncTeX",
      "Entrada matemática",
      "OCR matemático",
    ],
    basic: [
      "Chat de IA",
      "Cuota mensual de tokens",
      "Contexto de chat más largo",
    ],
    pro: [
      "Axiom 1.0 Pro",
      "Cuota mensual más alta",
      "Procesamiento prioritario del chat de IA",
      "Contexto más amplio",
      "Acceso anticipado",
    ],
  },
};

// Transient status / error strings localized for all 7 UI languages (uiText
// only covers en/ja, so we keep our own table here).
type BillingMessages = {
  billingUnavailable: string;
  preparing: string;
  checkoutOpened: string;
  signIn: string;
  checkoutUnavailable: string;
  openingPortal: string;
  noSub: string;
  portalErrorPrefix: string;
  activating: string;
  activated: string;
  activationSlow: string;
};

const MSG: Record<string, BillingMessages> = {
  en: {
    billingUnavailable: "Billing is unavailable.",
    preparing: "Preparing checkout…",
    checkoutOpened: "Checkout in progress…",
    signIn: "Sign-in required.",
    checkoutUnavailable: "Checkout is unavailable.",
    openingPortal: "Opening billing portal…",
    noSub: "No active subscription.",
    portalErrorPrefix: "Couldn't open the billing portal: ",
    activating: "Payment received. Activating your plan…",
    activated: "Your plan is now active.",
    activationSlow: "Payment received. Activation continues in the background.",
  },
  ja: {
    billingUnavailable: "課金は利用できません。",
    preparing: "決済を準備中…",
    checkoutOpened: "決済中…",
    signIn: "ログインが必要です。",
    checkoutUnavailable: "決済を利用できません。",
    openingPortal: "請求ポータルを開いています…",
    noSub: "有効なサブスクリプションはありません。",
    portalErrorPrefix: "請求ポータルを開けませんでした：",
    activating: "決済完了。プランを反映中…",
    activated: "プランが有効になりました。",
    activationSlow: "決済完了。反映はバックグラウンドで続きます。",
  },
  zh: {
    billingUnavailable: "无法使用计费。",
    preparing: "正在准备结账…",
    checkoutOpened: "正在结账…",
    signIn: "需要登录。",
    checkoutUnavailable: "无法结账。",
    openingPortal: "正在打开计费门户…",
    noSub: "没有有效订阅。",
    portalErrorPrefix: "无法打开计费门户：",
    activating: "已付款，正在激活方案…",
    activated: "您的方案已生效。",
    activationSlow: "已付款，激活将在后台完成。",
  },
  de: {
    billingUnavailable: "Abrechnung nicht verfügbar.",
    preparing: "Checkout wird vorbereitet…",
    checkoutOpened: "Checkout läuft…",
    signIn: "Anmeldung erforderlich.",
    checkoutUnavailable: "Checkout nicht verfügbar.",
    openingPortal: "Abrechnungsportal wird geöffnet…",
    noSub: "Kein aktives Abo.",
    portalErrorPrefix: "Abrechnungsportal konnte nicht geöffnet werden: ",
    activating: "Zahlung eingegangen. Plan wird aktiviert…",
    activated: "Ihr Plan ist jetzt aktiv.",
    activationSlow: "Zahlung eingegangen. Die Aktivierung läuft im Hintergrund weiter.",
  },
  ko: {
    billingUnavailable: "결제를 사용할 수 없습니다.",
    preparing: "결제 준비 중…",
    checkoutOpened: "결제 진행 중…",
    signIn: "로그인이 필요합니다.",
    checkoutUnavailable: "지금은 결제할 수 없습니다.",
    openingPortal: "결제 포털을 여는 중…",
    noSub: "활성 구독이 없습니다.",
    portalErrorPrefix: "결제 포털을 열지 못했습니다: ",
    activating: "결제 완료. 플랜 적용 중…",
    activated: "플랜이 활성화되었습니다.",
    activationSlow: "결제 완료. 적용은 백그라운드에서 계속됩니다.",
  },
  fr: {
    billingUnavailable: "Facturation indisponible.",
    preparing: "Préparation du paiement…",
    checkoutOpened: "Paiement en cours…",
    signIn: "Connexion requise.",
    checkoutUnavailable: "Paiement indisponible.",
    openingPortal: "Ouverture du portail de facturation…",
    noSub: "Aucun abonnement actif.",
    portalErrorPrefix: "Impossible d'ouvrir le portail de facturation : ",
    activating: "Paiement reçu. Activation de votre offre…",
    activated: "Votre offre est maintenant active.",
    activationSlow: "Paiement reçu. L'activation se poursuit en arrière-plan.",
  },
  es: {
    billingUnavailable: "Facturación no disponible.",
    preparing: "Preparando el pago…",
    checkoutOpened: "Pago en curso…",
    signIn: "Debes iniciar sesión.",
    checkoutUnavailable: "Pago no disponible.",
    openingPortal: "Abriendo tu portal de facturación…",
    noSub: "No hay una suscripción activa.",
    portalErrorPrefix: "No se pudo abrir el portal de facturación: ",
    activating: "Pago recibido. Activando tu plan…",
    activated: "Tu plan ya está activo.",
    activationSlow: "Pago recibido. La activación continúa en segundo plano.",
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

export type BillingUiApi = {
  open: (preferredPlan?: PlanKey) => void;
  close: () => void;
  handleCheckoutClosed: (payload: BillingCheckoutClosedPayload) => void;
  handlePlanUpdated: () => void;
  handleUsageUpdated: () => void;
};

export type BillingUiDeps = {
  getCurrentPlan: () => string;
  onPlanRefresh: () => void;
  /** Latest usage snapshot (tokens only) for the in-modal usage banner. */
  getUsageSnapshot?: () => PlatformUsageSnapshot | null;
  /** Refresh the usage snapshot (called when the modal opens). */
  refreshUsage?: () => void;
  /** Kick off Google sign-in when checkout requires an account. */
  startSignIn?: () => void;
};

export const initBillingUi = (context: AppContext, deps: BillingUiDeps): BillingUiApi => {
  const {
    plansModal,
    plansModalClose,
    plansHeading,
    plansList,
    plansStatus,
  } = context.dom;

  let activationTimer: number | null = null;
  let activationTargetRank: number | null = null;
  let activationTicks = 0;
  let checkoutPending = false;
  let preferredPlan: PlanKey | null = null;
  let focusReturnTarget: HTMLElement | null = null;
  let obscuredAiSurface: {
    element: HTMLElement;
    hidden: HTMLElement["hidden"];
    ariaHidden: string | null;
    inert: boolean;
  } | null = null;

  const focusWithoutScroll = (element: HTMLElement | null | undefined) => {
    if (!element || element.isConnected === false) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    try {
      element.focus({ preventScroll: true });
      return document.activeElement === element;
    } catch {
      return false;
    }
  };

  const activeModeTab = () =>
    document.querySelector<HTMLElement>(
      '[data-app-mode-tab].is-active, [data-app-mode-tab][aria-selected="true"]'
    );

  const obscureAiNativeSurface = () => {
    if (document.documentElement.dataset.appMode !== "ai" || obscuredAiSurface) return;
    const element = document.getElementById("ai-mode-webview-host");
    if (!(element instanceof HTMLElement)) return;
    obscuredAiSurface = {
      element,
      hidden: element.hidden,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
    };
    // Focus has already moved into the parent modal. Hiding only after that
    // avoids Chromium's "aria-hidden descendant retained focus" warning.
    element.hidden = true;
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  };

  const restoreAiNativeSurface = () => {
    const saved = obscuredAiSurface;
    obscuredAiSurface = null;
    if (!saved) return;
    saved.element.hidden = saved.hidden;
    if (saved.inert) saved.element.setAttribute("inert", "");
    else saved.element.removeAttribute("inert");
    if (saved.ariaHidden === null) saved.element.removeAttribute("aria-hidden");
    else saved.element.setAttribute("aria-hidden", saved.ariaHidden);
  };

  const setStatus = (message: string) => {
    if (plansStatus) {
      plansStatus.textContent = message;
    }
  };

  // Status area with a sign-in CTA: checkout needs an account, and a plain
  // "please sign in" text with no way to act on it is a dead end.
  const setStatusWithSignIn = (message: string) => {
    if (!plansStatus) return;
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
        deps.startSignIn?.();
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
    activationTargetRank = null;
    activationTicks = 0;
  };

  // After Stripe reports completion the entitlement lands via webhook, which
  // can lag by seconds. Poll the plan until it flips (or give up gracefully)
  // instead of closing the modal while the old plan is still showing.
  const beginActivationPoll = (purchasedPlan: string) => {
    stopActivationPoll();
    activationTargetRank = PLAN_RANK[purchasedPlan] ?? 1;
    setStatus(msg().activating);
    deps.onPlanRefresh();
    activationTimer = window.setInterval(() => {
      activationTicks += 1;
      deps.onPlanRefresh();
      if (activationTicks >= 20) {
        stopActivationPoll();
        renderPlans();
        setStatus(msg().activationSlow);
      }
    }, 1500);
  };

  const handleCheckoutClosed = ({ plan, outcome }: BillingCheckoutClosedPayload) => {
    // Closing or cancelling hosted Checkout is terminal for the current
    // attempt. Clear the progress copy immediately; only a confirmed success
    // starts webhook/entitlement polling.
    deps.refreshUsage?.();
    if (outcome === "success") {
      beginActivationPoll(plan || "basic");
      return;
    }
    if (outcome === "error") {
      setStatus(msg().checkoutUnavailable);
      return;
    }
    setStatus("");
    // A user-closed/cancelled Checkout attempt returns to the surface that
    // opened Plans. This also guarantees the hidden native webview is restored.
    close();
  };

  getBilling()?.onPortalClosed?.(() => {
    setStatus("");
    // Portal changes also arrive through Stripe webhooks. Refresh a few times
    // so a tier change or cancellation does not depend on a fast webhook.
    // Rendering is driven by handlePlanUpdated/handleUsageUpdated after the
    // corresponding native response arrives, never by a guessed round-trip.
    for (const delay of [0, 1500, 4000, 8000]) {
      window.setTimeout(() => {
        deps.onPlanRefresh();
        deps.refreshUsage?.();
      }, delay);
    }
  });

  const performCheckout = async (plan: string) => {
    const billing = getBilling();
    if (!billing) {
      setStatus(msg().billingUnavailable);
      return;
    }
    setStatus(msg().preparing);
    const result = await billing.checkout(plan);
    if (!result || result.error) {
      if (result?.code === "AUTH_REQUIRED") {
        setStatusWithSignIn(msg().signIn);
      } else {
        setStatus(result?.error || msg().checkoutUnavailable);
      }
      return;
    }
    if (result.hosted) {
      setStatus(msg().checkoutOpened);
      return;
    }
    setStatus(msg().checkoutUnavailable);
  };

  const startCheckout = async (plan: string) => {
    if (checkoutPending) {
      return;
    }
    checkoutPending = true;
    try {
      await performCheckout(plan);
    } finally {
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
    currentRank: number,
    preferred: PlanKey | null,
  ): HTMLElement => {
    const features = copy[plan.key];
    const isCurrent = plan.key === current;
    const rank = PLAN_RANK[plan.key] ?? 0;

    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.plan = plan.key;
    if (plan.highlight && preferred === null) card.classList.add("is-recommended");
    if (plan.key === preferred) card.classList.add("is-targeted");
    if (isCurrent) card.classList.add("is-current");

    const head = document.createElement("div");
    head.className = "plan-card-head";
    const name = document.createElement("h3");
    name.className = "plan-card-name";
    name.textContent = plan.name;
    head.appendChild(name);
    if (isCurrent) {
      const chip = document.createElement("span");
      chip.className = "plan-chip";
      chip.textContent = copy.currentPlan;
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


    const list = document.createElement("ul");
    list.className = "plan-features";
    for (const item of features) {
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
    if (rank > currentRank) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "plan-cta" +
        (plan.key === preferred || (plan.highlight && preferred === null)
          ? " primary"
          : "");
      if (current === "free") {
        btn.textContent = plan.key === "basic" ? copy.startBasic : copy.startPro;
        btn.addEventListener("click", () => startCheckout(plan.key));
      } else {
        // Existing subscribers change tier through the portal (avoids a 2nd sub).
        btn.textContent = copy.changePlan;
        btn.addEventListener("click", () => openPortal());
      }
      footer.appendChild(btn);
    }
    // The current plan (its chip says so) and the tiers below it show no button.
    card.appendChild(footer);

    return card;
  };

  // Compact usage banner (tokens only, per policy): what you've used this
  // period and when it resets — the numbers people need to pick a plan.
  const buildUsageBanner = (): HTMLElement | null => {
    const usage = deps.getUsageSnapshot?.();
    const summary = usage?.summary;
    if (
      !usage?.authenticated ||
      !summary ||
      !Number.isFinite(summary.limitTokens) ||
      summary.limitTokens <= 0
    ) {
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
    if (ratio >= 0.9) fill.classList.add("is-high");
    bar.appendChild(fill);
    banner.appendChild(bar);

    return banner;
  };

  const renderPlans = () => {
    const copy = CONTENT[getUiLocale()] || CONTENT.en;
    if (plansHeading) plansHeading.textContent = copy.heading;
    if (!plansList) return;

    const current = (deps.getCurrentPlan() || "free").toLowerCase();
    const currentRank = PLAN_RANK[current] ?? 0;
    const onPaidPlan = current === "basic" || current === "pro";

    plansList.innerHTML = "";
    const usageBanner = buildUsageBanner();
    if (usageBanner) {
      plansList.appendChild(usageBanner);
    }
    const grid = document.createElement("div");
    grid.className = "plans-grid-inner";
    for (const plan of PLANS) {
      grid.appendChild(buildCard(plan, copy, current, currentRank, preferredPlan));
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

  const isVisible = () => Boolean(plansModal?.classList.contains("is-open"));

  // Native plan/usage messages are delivered only after the network refresh
  // has completed and aiChatUi has stored the new snapshot. Repaint from that
  // reliable state boundary instead of estimating request latency with timers.
  const handlePlanUpdated = () => {
    if (!isVisible()) return;
    renderPlans();
    if (activationTargetRank === null) return;
    const current = (deps.getCurrentPlan() || "free").toLowerCase();
    if ((PLAN_RANK[current] ?? 0) >= activationTargetRank) {
      stopActivationPoll();
      setStatus(msg().activated);
    }
  };

  const handleUsageUpdated = () => {
    if (isVisible()) renderPlans();
  };

  const open = (nextPreferredPlan?: PlanKey) => {
    if (!plansModal) {
      return;
    }
    preferredPlan = nextPreferredPlan ?? null;
    if (isVisible()) {
      renderPlans();
      focusWithoutScroll(plansModalClose ?? undefined);
      return;
    }
    focusReturnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Ask for fresh plan + usage. Their completed native responses call the
    // state handlers above, which repaint with the stored snapshots.
    deps.onPlanRefresh();
    deps.refreshUsage?.();
    renderPlans();
    setStatus("");
    plansModal.classList.add("is-open");
    plansModal.setAttribute("aria-hidden", "false");
    // Move focus out of a native <webview> before making that surface inert.
    if (!focusWithoutScroll(plansModalClose ?? undefined)) {
      const current = document.activeElement;
      if (current instanceof HTMLElement) current.blur();
    }
    obscureAiNativeSurface();
  };

  const close = () => {
    if (!plansModal) {
      return;
    }
    stopActivationPoll();
    const surface = obscuredAiSurface?.element ?? null;
    const returnWasInsideSurface = Boolean(
      surface && focusReturnTarget && surface.contains(focusReturnTarget)
    );
    const safeReturn = returnWasInsideSurface ? activeModeTab() : focusReturnTarget;
    if (!focusWithoutScroll(safeReturn)) {
      const current = document.activeElement;
      if (current instanceof HTMLElement) current.blur();
    }
    plansModal.classList.remove("is-open");
    plansModal.setAttribute("aria-hidden", "true");
    preferredPlan = null;
    restoreAiNativeSurface();
    if (returnWasInsideSurface) focusWithoutScroll(focusReturnTarget);
    focusReturnTarget = null;
  };

  plansModalClose?.addEventListener("click", close);
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
  window.addEventListener("tex64:open-plans", (event) => {
    const detail = (event as CustomEvent<{ plan?: unknown }>).detail;
    open(detail?.plan === "basic" || detail?.plan === "pro" ? detail.plan : undefined);
  });

  return { open, close, handleCheckoutClosed, handlePlanUpdated, handleUsageUpdated };
};
