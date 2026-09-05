import crypto from "node:crypto";
import { costToDisplayedQuotaTokens } from "./ai-request-budget.js";
import { PLAN_VALUES, STATUS_VALUES } from "./runtime-config.js";

const PLAN_SET = new Set(PLAN_VALUES);
const STATUS_SET = new Set(STATUS_VALUES);

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const sanitizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseInteger = (value, fallback = 0) => {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric);
};

const parseNonNegativeNumber = (value, fallback = 0) => {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
      ? Number.parseFloat(value)
      : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const normalizedBlendedRate = (value) => {
  const parsed = parseNonNegativeNumber(value, 0);
  return parsed > 0 ? parsed : 0.000005;
};

const cumulativeCostTokens = (cost, blendedCostPerTokenUsd) =>
  costToDisplayedQuotaTokens(cost, {
    blendedCostPerTokenUsd: normalizedBlendedRate(blendedCostPerTokenUsd),
  });

const parseDate = (value) => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
};

const toIso = (date) => {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

/**
 * Add N calendar months to a date, preserving the day-of-month anchor.
 * If the target month has fewer days than the source day, clamps to the
 * last day of the target month (Stripe-compatible behavior).
 *
 * Examples:
 *   2026-01-15 + 1mo → 2026-02-15
 *   2026-01-31 + 1mo → 2026-02-28 (clamped, non-leap)
 *   2026-01-31 + 1mo → 2026-02-29 (clamped, leap year)
 *   2026-12-31 + 1mo → 2027-01-31 (cross-year)
 *
 * Hours/minutes/seconds/milliseconds are preserved.
 */
export const addCalendarMonthsUtc = (date, months) => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonth = month + months;
  // Last day of the target month: day 0 of the *next* month = last day of this month
  const lastDayOfTargetMonth = new Date(
    Date.UTC(year, targetMonth + 1, 0)
  ).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(
    Date.UTC(
      year,
      targetMonth,
      targetDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
};

const addDaysUtc = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const normalizePlan = (value, fallback = "free") => {
  const normalized = sanitizeString(value)?.toLowerCase() ?? "";
  return PLAN_SET.has(normalized) ? normalized : fallback;
};

export const normalizeStatus = (value, fallback = "active") => {
  const normalized = sanitizeString(value)?.toLowerCase() ?? "";
  return STATUS_SET.has(normalized) ? normalized : fallback;
};

export const computeTokenLimitForPlan = (plan, config) => {
  const normalizedPlan = normalizePlan(plan, "free");
  if (normalizedPlan === "free") {
    return Math.max(0, parseInteger(config.freeMonthlyTokens, 0));
  }
  const budgetUsd =
    normalizedPlan === "basic" ? Number(config.basicBudgetUsd) : Number(config.proBudgetUsd);
  const blendedCostPerTokenUsd = Math.max(0.000000001, Number(config.blendedCostPerTokenUsd));
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(budgetUsd / blendedCostPerTokenUsd));
};

export const computeRequestLimitForPlan = (plan, config) => {
  const normalizedPlan = normalizePlan(plan, "free");
  if (normalizedPlan === "pro") {
    return Math.max(0, parseInteger(config.requestLimitPro, 0));
  }
  if (normalizedPlan === "basic") {
    return Math.max(0, parseInteger(config.requestLimitBasic, 0));
  }
  return Math.max(0, parseInteger(config.requestLimitFree, 0));
};

/**
 * Keep the Stripe subscription record intact for history and event ordering,
 * while exposing the entitlement that is effective after a paid subscription
 * has actually been deleted. A scheduled cancellation remains `active` in the
 * raw record and therefore keeps its paid entitlement until Stripe sends the
 * terminal canceled state.
 */
export const resolveEffectiveSubscription = (subscription, config = {}) => {
  if (!isObject(subscription)) {
    return subscription;
  }
  const rawStatus = normalizeStatus(subscription.status, "active");
  // Every account keeps the Free entitlement. A canceled record, whatever plan
  // it once carried, is therefore Free and active, never "AI disabled".
  if (rawStatus !== "canceled") {
    return subscription;
  }
  return {
    ...subscription,
    plan: "free",
    status: "active",
    graceEndsAt: null,
    quotaLimitTokens: computeTokenLimitForPlan("free", config),
    quotaLimitRequests: computeRequestLimitForPlan("free", config),
    metadata: isObject(subscription.metadata)
      ? { ...subscription.metadata }
      : {},
  };
};

const ensurePeriod = (rawStart, rawEnd, now) => {
  const parsedStart = parseDate(rawStart);
  const parsedEnd = parseDate(rawEnd);
  if (parsedStart && parsedEnd && parsedEnd.getTime() > parsedStart.getTime()) {
    return { start: parsedStart, end: parsedEnd };
  }
  // Fallback: anchor to `now` (signup time). This ensures a user who signs up
  // mid-month gets a full month, not a partial calendar-month period.
  // When Stripe later sends current_period_start/end via webhook, those values
  // replace this fallback via upsertSubscriptionRecord.
  const start = new Date(now.getTime());
  const end = addCalendarMonthsUtc(start, 1);
  return { start, end };
};

const buildSubscriptionRecord = ({ plan, status, now, config }) => {
  const period = ensurePeriod(null, null, now);
  const quotaLimitTokens = computeTokenLimitForPlan(plan, config);
  const quotaLimitRequests = computeRequestLimitForPlan(plan, config);
  return {
    plan,
    status,
    billingPeriodStart: toIso(period.start),
    billingPeriodEnd: toIso(period.end),
    graceEndsAt: null,
    quotaPeriodStart: toIso(period.start),
    quotaPeriodEnd: toIso(period.end),
    quotaLimitTokens,
    quotaLimitRequests,
    metadata: {},
    updatedAt: toIso(now),
    createdAt: toIso(now),
  };
};

const normalizeSubscriptionRecord = (subscription, config, now) => {
  const plan = normalizePlan(subscription?.plan, normalizePlan(config.defaultPlan, "free"));
  const status = normalizeStatus(
    subscription?.status,
    normalizeStatus(config.defaultStatus, "active")
  );
  const period = ensurePeriod(subscription?.billingPeriodStart, subscription?.billingPeriodEnd, now);
  const quotaPeriod = ensurePeriod(
    subscription?.quotaPeriodStart,
    subscription?.quotaPeriodEnd,
    period.start
  );
  const parsedQuotaLimitTokens = parseInteger(subscription?.quotaLimitTokens, Number.NaN);
  const parsedQuotaLimitRequests = parseInteger(subscription?.quotaLimitRequests, Number.NaN);
  const quotaLimitTokens = Number.isFinite(parsedQuotaLimitTokens)
    ? Math.max(0, parsedQuotaLimitTokens)
    : computeTokenLimitForPlan(plan, config);
  const quotaLimitRequests = Number.isFinite(parsedQuotaLimitRequests)
    ? Math.max(0, parsedQuotaLimitRequests)
    : computeRequestLimitForPlan(plan, config);
  const graceEndsAt = parseDate(subscription?.graceEndsAt);
  return {
    plan,
    status,
    billingPeriodStart: toIso(period.start),
    billingPeriodEnd: toIso(period.end),
    graceEndsAt: toIso(graceEndsAt),
    quotaPeriodStart: toIso(quotaPeriod.start),
    quotaPeriodEnd: toIso(quotaPeriod.end),
    quotaLimitTokens,
    quotaLimitRequests,
    metadata: isObject(subscription?.metadata)
      ? { ...subscription.metadata }
      : {},
    createdAt: sanitizeString(subscription?.createdAt) || toIso(now),
    updatedAt: toIso(now),
  };
};

/**
 * Lazy rollover fallback for when Stripe webhooks haven't arrived yet.
 *
 * Stripe is the authoritative source of period boundaries — each successful
 * charge triggers a webhook that updates billingPeriodStart/End via
 * upsertSubscriptionRecord. This function only runs if the stored period has
 * already passed AND no webhook has replaced it.
 *
 * Advances month-by-month while preserving the day-of-month anchor from the
 * original Stripe period. For example, a user whose Stripe cycle is the 15th
 * will always have periods of [..15, next month 15), not calendar months.
 */
const applyActiveRollover = (subscription, now, config) => {
  let changed = false;
  let billingStart = parseDate(subscription.billingPeriodStart);
  let billingEnd = parseDate(subscription.billingPeriodEnd);
  if (!billingStart || !billingEnd || billingEnd.getTime() <= billingStart.getTime()) {
    const reset = ensurePeriod(null, null, now);
    billingStart = reset.start;
    billingEnd = reset.end;
    changed = true;
  }
  let guard = 0;
  while (billingEnd.getTime() <= now.getTime() && guard < 60) {
    // Advance by one calendar month, preserving the day-of-month anchor.
    // Compute next billingEnd FIRST from the current billingEnd (which becomes
    // the new billingStart), so the anchor day stays consistent across rollovers.
    const nextBillingEnd = addCalendarMonthsUtc(billingEnd, 1);
    billingStart = billingEnd;
    billingEnd = nextBillingEnd;
    subscription.quotaPeriodStart = toIso(billingStart);
    subscription.quotaPeriodEnd = toIso(billingEnd);
    subscription.quotaLimitTokens = computeTokenLimitForPlan(subscription.plan, config);
    subscription.quotaLimitRequests = computeRequestLimitForPlan(subscription.plan, config);
    changed = true;
    guard += 1;
  }
  subscription.billingPeriodStart = toIso(billingStart);
  subscription.billingPeriodEnd = toIso(billingEnd);
  return changed;
};

const applyGraceState = (subscription, now, config) => {
  let changed = false;
  // Fallback: if billingPeriodEnd is missing, anchor 1 month from now (not month start).
  // In practice this path should be unreachable because normalizeSubscriptionRecord
  // always fills in a period via ensurePeriod.
  const billingEnd =
    parseDate(subscription.billingPeriodEnd) || addCalendarMonthsUtc(new Date(now.getTime()), 1);
  const existingGraceEndsAt = parseDate(subscription.graceEndsAt);
  const graceEndsAt = existingGraceEndsAt || addDaysUtc(billingEnd, Math.max(0, config.graceDays || 3));
  if (!existingGraceEndsAt) {
    subscription.graceEndsAt = toIso(graceEndsAt);
    changed = true;
  }
  if (graceEndsAt.getTime() <= now.getTime()) {
    subscription.status = "past_due";
    changed = true;
  }
  return changed;
};

export const ensureSubscriptionState = (state, userId, config, nowValue = new Date()) => {
  const now = parseDate(nowValue) || new Date();
  if (!isObject(state.subscriptions)) {
    state.subscriptions = {};
  }
  let subscription = state.subscriptions[userId];
  let changed = false;
  if (!isObject(subscription)) {
    subscription = buildSubscriptionRecord({
      plan: normalizePlan(config.defaultPlan, "free"),
      status: normalizeStatus(config.defaultStatus, "active"),
      now,
      config,
    });
    changed = true;
  } else {
    subscription = normalizeSubscriptionRecord(subscription, config, now);
  }

  if (subscription.status === "active") {
    changed = applyActiveRollover(subscription, now, config) || changed;
    if (subscription.graceEndsAt) {
      subscription.graceEndsAt = null;
      changed = true;
    }
  } else if (subscription.status === "grace") {
    changed = applyGraceState(subscription, now, config) || changed;
  }

  const normalizedPlan = normalizePlan(subscription.plan, "free");
  if (normalizedPlan !== subscription.plan) {
    subscription.plan = normalizedPlan;
    changed = true;
  }
  const normalizedStatus = normalizeStatus(subscription.status, "active");
  if (normalizedStatus !== subscription.status) {
    subscription.status = normalizedStatus;
    changed = true;
  }
  subscription.updatedAt = toIso(now);
  state.subscriptions[userId] = subscription;
  return {
    changed,
    subscription,
  };
};

const normalizeFeatureUsage = (
  entry,
  blendedCostPerTokenUsd = 0.000005,
  migrateLegacyFloor = false,
) => {
  const source = isObject(entry) ? entry : {};
  const usedCostUsd = parseNonNegativeNumber(source.usedCostUsd, 0);
  const usedTokens = Math.max(0, parseInteger(source.usedTokens, 0));
  const derivedLegacyFloor = Math.max(
    0,
    usedTokens - cumulativeCostTokens(usedCostUsd, blendedCostPerTokenUsd),
  );
  const legacyUsedTokens = Math.max(
    0,
    parseInteger(source.legacyUsedTokens, 0),
    migrateLegacyFloor ? derivedLegacyFloor : 0,
  );
  return {
    usedTokens: Math.max(
      usedTokens,
      legacyUsedTokens + cumulativeCostTokens(usedCostUsd, blendedCostPerTokenUsd),
    ),
    usedRequests: Math.max(0, parseInteger(source.usedRequests, 0)),
    legacyUsedTokens,
    usedCostUsd,
  };
};

export const ensureUsageRecord = (state, userId, subscription, config = {}) => {
  if (!isObject(state.usage)) {
    state.usage = {};
  }
  const current = isObject(state.usage[userId]) ? state.usage[userId] : null;
  let changed = false;
  let usage = current;
  const shouldReset =
    !usage ||
    usage.periodStart !== subscription.quotaPeriodStart ||
    usage.periodEnd !== subscription.quotaPeriodEnd;
  if (shouldReset) {
    usage = {
      periodStart: subscription.quotaPeriodStart,
      periodEnd: subscription.quotaPeriodEnd,
      limitTokens: Math.max(0, parseInteger(subscription.quotaLimitTokens, 0)),
      limitRequests: Math.max(0, parseInteger(subscription.quotaLimitRequests, 0)),
      usedTokens: 0,
      usedRequests: 0,
      costAccountingVersion: 1,
      legacyUsedTokens: 0,
      usedCostUsd: 0,
      byFeature: {
        chat: {
          usedTokens: 0,
          usedRequests: 0,
          legacyUsedTokens: 0,
          usedCostUsd: 0,
        },
        completion: {
          usedTokens: 0,
          usedRequests: 0,
          legacyUsedTokens: 0,
          usedCostUsd: 0,
        },
      },
      updatedAt: toIso(new Date()),
    };
    changed = true;
  } else {
    const blendedCostPerTokenUsd = normalizedBlendedRate(
      config.blendedCostPerTokenUsd,
    );
    const migrateLegacyFloor = parseInteger(usage.costAccountingVersion, 0) < 1;
    const usedCostUsd = parseNonNegativeNumber(usage.usedCostUsd, 0);
    const usedTokens = Math.max(0, parseInteger(usage.usedTokens, 0));
    const derivedLegacyFloor = Math.max(
      0,
      usedTokens - cumulativeCostTokens(usedCostUsd, blendedCostPerTokenUsd),
    );
    const legacyUsedTokens = Math.max(
      0,
      parseInteger(usage.legacyUsedTokens, 0),
      migrateLegacyFloor ? derivedLegacyFloor : 0,
    );
    const normalizedByFeature = {
      chat: normalizeFeatureUsage(
        usage.byFeature?.chat,
        blendedCostPerTokenUsd,
        migrateLegacyFloor,
      ),
      completion: normalizeFeatureUsage(
        usage.byFeature?.completion,
        blendedCostPerTokenUsd,
        migrateLegacyFloor,
      ),
    };
    const normalized = {
      ...usage,
      limitTokens: Math.max(0, parseInteger(subscription.quotaLimitTokens, usage.limitTokens)),
      limitRequests: Math.max(0, parseInteger(subscription.quotaLimitRequests, usage.limitRequests)),
      usedTokens: Math.max(
        usedTokens,
        legacyUsedTokens + cumulativeCostTokens(usedCostUsd, blendedCostPerTokenUsd),
      ),
      usedRequests: Math.max(0, parseInteger(usage.usedRequests, 0)),
      costAccountingVersion: 1,
      legacyUsedTokens,
      usedCostUsd,
      byFeature: normalizedByFeature,
      updatedAt: toIso(new Date()),
    };
    if (JSON.stringify(usage) !== JSON.stringify(normalized)) {
      usage = normalized;
      changed = true;
    }
  }
  state.usage[userId] = usage;
  return {
    changed,
    usage,
  };
};

export const buildQuotaSummary = (usage) => {
  const limitTokens = Math.max(0, parseInteger(usage?.limitTokens, 0));
  const usedTokens = Math.max(0, parseInteger(usage?.usedTokens, 0));
  const limitRequests = Math.max(0, parseInteger(usage?.limitRequests, 0));
  const usedRequests = Math.max(0, parseInteger(usage?.usedRequests, 0));
  const remainingTokens = Math.max(0, limitTokens - usedTokens);
  const remainingRequests = Math.max(0, limitRequests - usedRequests);
  return {
    limitTokens,
    usedTokens,
    remainingTokens,
    usedRequests,
    remainingRequests,
    periodStart: sanitizeString(usage?.periodStart),
    periodEnd: sanitizeString(usage?.periodEnd),
  };
};

const resolveQuotaDisabledReason = (subscription, quota) => {
  if (subscription.status === "past_due") {
    return "PAYMENT_PAST_DUE";
  }
  if (subscription.plan === "free" && quota.limitTokens <= 0) {
    return "PLAN_REQUIRED";
  }
  if (quota.remainingTokens <= 0 || quota.remainingRequests <= 0) {
    return "QUOTA_EXCEEDED";
  }
  return null;
};

export const evaluateAiFeature = (subscription, usage, pricingUrl = "https://tex64.com/pricing") => {
  const quota = buildQuotaSummary(usage);
  const disabledReason = resolveQuotaDisabledReason(subscription, quota);
  const status = normalizeStatus(subscription?.status, "active");
  return {
    enabled: !disabledReason,
    reason:
      disabledReason || (status === "grace" ? "PAYMENT_GRACE" : "active"),
    status,
    graceEndsAt: sanitizeString(subscription?.graceEndsAt),
    periodStart: quota.periodStart,
    periodEnd: quota.periodEnd,
    pricingUrl,
    quota,
  };
};

const ensureUsageAccountingForMutation = (
  usage,
  blendedCostPerTokenUsd = 0.000005,
) => {
  const rate = normalizedBlendedRate(blendedCostPerTokenUsd);
  const migrateLegacyFloor = parseInteger(usage?.costAccountingVersion, 0) < 1;
  const usedCostUsd = parseNonNegativeNumber(usage?.usedCostUsd, 0);
  const usedTokens = Math.max(0, parseInteger(usage?.usedTokens, 0));
  const legacyUsedTokens = Math.max(
    0,
    parseInteger(usage?.legacyUsedTokens, 0),
    migrateLegacyFloor
      ? usedTokens - cumulativeCostTokens(usedCostUsd, rate)
      : 0,
  );
  usage.costAccountingVersion = 1;
  usage.usedCostUsd = usedCostUsd;
  usage.legacyUsedTokens = legacyUsedTokens;
  usage.usedTokens = Math.max(
    usedTokens,
    legacyUsedTokens + cumulativeCostTokens(usedCostUsd, rate),
  );
  if (!isObject(usage.byFeature)) usage.byFeature = {};
  usage.byFeature.chat = normalizeFeatureUsage(
    usage.byFeature.chat,
    rate,
    migrateLegacyFloor,
  );
  usage.byFeature.completion = normalizeFeatureUsage(
    usage.byFeature.completion,
    rate,
    migrateLegacyFloor,
  );
  return rate;
};

export const consumeQuota = (
  usage,
  featureName,
  consumedTokensInput,
  consumedRequestsInput = 1
) => {
  const consumedTokens = Math.max(0, parseInteger(consumedTokensInput, 0));
  const consumedRequests = Math.max(1, parseInteger(consumedRequestsInput, 1));
  const rate = ensureUsageAccountingForMutation(usage);
  const summaryBefore = buildQuotaSummary(usage);
  // Admission is checked before the provider request. The provider's actual
  // usage can legitimately be larger than the remaining estimate, so the
  // completed turn must still be recorded in full. buildQuotaSummary clamps
  // the user-visible remaining amount to zero while retaining actual usage.
  usage.usedTokens = summaryBefore.usedTokens + consumedTokens;
  usage.usedRequests = summaryBefore.usedRequests + consumedRequests;
  usage.legacyUsedTokens += consumedTokens;
  const featureKey = featureName === "completion" ? "completion" : "chat";
  if (!isObject(usage.byFeature)) {
    usage.byFeature = {};
  }
  const featureUsage = normalizeFeatureUsage(usage.byFeature[featureKey], rate);
  featureUsage.usedTokens += consumedTokens;
  featureUsage.usedRequests += consumedRequests;
  featureUsage.legacyUsedTokens += consumedTokens;
  usage.byFeature[featureKey] = featureUsage;
  usage.updatedAt = toIso(new Date());
  return buildQuotaSummary(usage);
};

/**
 * Reserve the worst-case cost before a provider call. Returning null is an
 * admission denial and must happen without mutating the usage record.
 */
export const tryReserveQuota = (
  usage,
  featureName,
  reservedTokensInput,
  reservedRequestsInput = 1
) => {
  const reservedTokens = Math.max(0, parseInteger(reservedTokensInput, 0));
  const reservedRequests = Math.max(1, parseInteger(reservedRequestsInput, 1));
  const rate = ensureUsageAccountingForMutation(usage);
  const before = buildQuotaSummary(usage);
  if (
    reservedTokens > before.remainingTokens ||
    reservedRequests > before.remainingRequests
  ) {
    return null;
  }
  usage.usedTokens = before.usedTokens + reservedTokens;
  usage.usedRequests = before.usedRequests + reservedRequests;
  const featureKey = featureName === "completion" ? "completion" : "chat";
  const featureUsage = normalizeFeatureUsage(usage.byFeature[featureKey], rate);
  featureUsage.usedTokens += reservedTokens;
  featureUsage.usedRequests += reservedRequests;
  usage.byFeature[featureKey] = featureUsage;
  usage.updatedAt = toIso(new Date());
  return buildQuotaSummary(usage);
};

/**
 * Replace an earlier worst-case reservation with measured provider usage.
 * Request count was already charged at reservation time and is not changed.
 */
export const reconcileQuotaReservation = (
  usage,
  featureName,
  reservedTokensInput,
  actualTokensInput,
  accounting = {},
) => {
  const reservedTokens = Math.max(0, parseInteger(reservedTokensInput, 0));
  const actualTokens = Math.max(0, parseInteger(actualTokensInput, 0));
  const hasMeasuredCost = hasOwn(accounting, "actualCostUsd");
  const actualCostUsd = parseNonNegativeNumber(accounting.actualCostUsd, 0);
  const rate = ensureUsageAccountingForMutation(
    usage,
    accounting.blendedCostPerTokenUsd,
  );
  const previousCostTokens = cumulativeCostTokens(usage.usedCostUsd, rate);
  const nextCostUsd = hasMeasuredCost
    ? usage.usedCostUsd + actualCostUsd
    : usage.usedCostUsd;
  const nextCostTokens = cumulativeCostTokens(nextCostUsd, rate);
  const committedRawTokens = hasMeasuredCost ? 0 : actualTokens;
  usage.legacyUsedTokens += committedRawTokens;
  usage.usedCostUsd = nextCostUsd;
  usage.usedTokens = Math.max(
    usage.legacyUsedTokens + nextCostTokens,
    Math.max(0, parseInteger(usage.usedTokens, 0)) - reservedTokens +
      committedRawTokens + (nextCostTokens - previousCostTokens),
  );
  const featureKey = featureName === "completion" ? "completion" : "chat";
  const featureUsage = normalizeFeatureUsage(usage.byFeature[featureKey], rate);
  const previousFeatureCostTokens = cumulativeCostTokens(
    featureUsage.usedCostUsd,
    rate,
  );
  const nextFeatureCostUsd = hasMeasuredCost
    ? featureUsage.usedCostUsd + actualCostUsd
    : featureUsage.usedCostUsd;
  const nextFeatureCostTokens = cumulativeCostTokens(nextFeatureCostUsd, rate);
  featureUsage.legacyUsedTokens += committedRawTokens;
  featureUsage.usedCostUsd = nextFeatureCostUsd;
  featureUsage.usedTokens = Math.max(
    featureUsage.legacyUsedTokens + nextFeatureCostTokens,
    featureUsage.usedTokens - reservedTokens + committedRawTokens +
      (nextFeatureCostTokens - previousFeatureCostTokens),
  );
  usage.byFeature[featureKey] = featureUsage;
  usage.updatedAt = toIso(new Date());
  return buildQuotaSummary(usage);
};

const normalizeEmailKey = (email) =>
  sanitizeString(email)?.toLowerCase() ?? null;

const deriveUserId = (email) => {
  const emailKey = normalizeEmailKey(email);
  if (!emailKey) {
    return `usr_${crypto.randomBytes(12).toString("hex")}`;
  }
  const hash = crypto.createHash("sha256").update(emailKey).digest("hex").slice(0, 24);
  return `usr_${hash}`;
};

export const ensureUserRecord = (state, claims) => {
  if (!isObject(state.users)) {
    state.users = {};
  }
  if (!isObject(state.usersByEmail)) {
    state.usersByEmail = {};
  }
  const email = sanitizeString(claims?.email);
  const explicitId = sanitizeString(claims?.id);
  const byEmailId = email ? sanitizeString(state.usersByEmail[normalizeEmailKey(email)]) : null;
  const userId = explicitId || byEmailId || deriveUserId(email);
  const current = isObject(state.users[userId]) ? state.users[userId] : null;
  const nowIso = toIso(new Date());
  let changed = false;
  let user = current;
  if (!user) {
    user = {
      id: userId,
      email: email,
      name: sanitizeString(claims?.name),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    changed = true;
  } else {
    const nextEmail = email || sanitizeString(user.email);
    const nextName = sanitizeString(claims?.name) || sanitizeString(user.name);
    if (nextEmail !== user.email || nextName !== user.name) {
      user = {
        ...user,
        email: nextEmail,
        name: nextName,
        updatedAt: nowIso,
      };
      changed = true;
    }
  }
  state.users[userId] = user;
  if (email) {
    const emailKey = normalizeEmailKey(email);
    if (state.usersByEmail[emailKey] !== userId) {
      state.usersByEmail[emailKey] = userId;
      changed = true;
    }
  }
  return { user, changed };
};

export const upsertSubscriptionRecord = (
  state,
  userId,
  patch,
  config,
  nowValue = new Date()
) => {
  const now = parseDate(nowValue) || new Date();
  const existing = isObject(state.subscriptions?.[userId])
    ? state.subscriptions[userId]
    : buildSubscriptionRecord({
        plan: normalizePlan(config.defaultPlan, "free"),
        status: normalizeStatus(config.defaultStatus, "active"),
        now,
        config,
      });
  const patchObject = isObject(patch) ? patch : {};
  const nextPlan = normalizePlan(patchObject.plan, existing.plan);
  const nextStatus = normalizeStatus(patchObject.status, existing.status);
  const patchBillingPeriodStart = sanitizeString(patchObject.billingPeriodStart);
  const patchBillingPeriodEnd = sanitizeString(patchObject.billingPeriodEnd);
  const patchQuotaPeriodStart = sanitizeString(patchObject.quotaPeriodStart);
  const patchQuotaPeriodEnd = sanitizeString(patchObject.quotaPeriodEnd);
  const hasPatchBillingPeriodStart = Boolean(patchBillingPeriodStart);
  const hasPatchBillingPeriodEnd = Boolean(patchBillingPeriodEnd);
  const hasPatchQuotaPeriodStart = Boolean(patchQuotaPeriodStart);
  const hasPatchQuotaPeriodEnd = Boolean(patchQuotaPeriodEnd);
  const billingPeriodStart =
    patchBillingPeriodStart || sanitizeString(existing.billingPeriodStart);
  const billingPeriodEnd = patchBillingPeriodEnd || sanitizeString(existing.billingPeriodEnd);
  const quotaPeriodStart =
    patchQuotaPeriodStart ||
    (hasPatchBillingPeriodStart || hasPatchBillingPeriodEnd
      ? billingPeriodStart
      : sanitizeString(existing.quotaPeriodStart));
  const quotaPeriodEnd =
    patchQuotaPeriodEnd ||
    (hasPatchBillingPeriodStart || hasPatchBillingPeriodEnd
      ? billingPeriodEnd
      : sanitizeString(existing.quotaPeriodEnd));
  const shouldRecomputeQuotaLimits =
    nextPlan !== normalizePlan(existing.plan, nextPlan) ||
    quotaPeriodStart !== sanitizeString(existing.quotaPeriodStart) ||
    quotaPeriodEnd !== sanitizeString(existing.quotaPeriodEnd);
  const quotaLimitTokens = hasOwn(patchObject, "quotaLimitTokens")
    ? patchObject.quotaLimitTokens
    : shouldRecomputeQuotaLimits
    ? computeTokenLimitForPlan(nextPlan, config)
    : existing.quotaLimitTokens;
  const quotaLimitRequests = hasOwn(patchObject, "quotaLimitRequests")
    ? patchObject.quotaLimitRequests
    : shouldRecomputeQuotaLimits
    ? computeRequestLimitForPlan(nextPlan, config)
    : existing.quotaLimitRequests;
  const next = normalizeSubscriptionRecord(
    {
      ...existing,
      ...patchObject,
      plan: nextPlan,
      status: nextStatus,
      billingPeriodStart,
      billingPeriodEnd,
      quotaPeriodStart,
      quotaPeriodEnd,
      quotaLimitTokens,
      quotaLimitRequests,
    },
    config,
    now
  );
  state.subscriptions[userId] = next;
  return next;
};

export const buildUsageBreakdown = (usage) => {
  const byFeature = isObject(usage?.byFeature) ? usage.byFeature : {};
  const chat = normalizeFeatureUsage(byFeature.chat);
  const completion = normalizeFeatureUsage(byFeature.completion);
  return {
    chat: {
      usedTokens: chat.usedTokens,
      usedRequests: chat.usedRequests,
    },
    completion: {
      usedTokens: completion.usedTokens,
      usedRequests: completion.usedRequests,
    },
  };
};
