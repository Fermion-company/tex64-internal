import {
  deleteUsageRecordsForUser,
  getSubscriptionRecordByUserId,
  getUsageRecordForUserPeriod,
  incrementUsageRecordForUserPeriod,
  isDatabaseConfigured,
  reconcileUsageReservationForUserPeriod,
  reserveUsageRecordForUserPeriod,
  upsertOrderedSubscriptionRecordForUser,
  upsertSubscriptionRecordForUser,
  upsertUsageRecordForUserPeriod,
  upsertUserRecord,
} from "./db-adapter.js";
import { ApiError } from "./http.js";
import {
  loadPlatformState,
  savePlatformState,
  withPlatformStateLock,
} from "./state-store.js";
import { isStateFallbackEnabled } from "./state-backend.js";
import { isSubscriptionBridgeOrderStale } from "./subscription-bridge-routing.js";
import {
  buildQuotaSummary,
  buildUsageBreakdown,
  computeRequestLimitForPlan,
  computeTokenLimitForPlan,
  consumeQuota,
  ensureSubscriptionState,
  ensureUsageRecord,
  ensureUserRecord,
  evaluateAiFeature,
  reconcileQuotaReservation,
  resolveEffectiveSubscription,
  tryReserveQuota,
  upsertSubscriptionRecord,
} from "./subscription-domain.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const ANONYMOUS_AI_PERIOD = Object.freeze({
  key: "anonymous_lifetime",
  start: "1970-01-01T00:00:00.000Z",
  end: "9999-12-31T23:59:59.999Z",
});

const isAnonymousClaims = (claims) => claims?.anonymous === true;

const enforceAnonymousSubscription = (subscription, config) => {
  if (!isObject(subscription)) {
    return false;
  }
  const expected = {
    plan: "free",
    status: "active",
    billingPeriodStart: ANONYMOUS_AI_PERIOD.start,
    billingPeriodEnd: ANONYMOUS_AI_PERIOD.end,
    graceEndsAt: null,
    quotaPeriodStart: ANONYMOUS_AI_PERIOD.start,
    quotaPeriodEnd: ANONYMOUS_AI_PERIOD.end,
    quotaLimitTokens: computeTokenLimitForPlan("free", config),
    quotaLimitRequests: computeRequestLimitForPlan("free", config),
  };
  let changed = false;
  for (const [key, value] of Object.entries(expected)) {
    if (subscription[key] !== value) {
      subscription[key] = value;
      changed = true;
    }
  }
  const metadata = isObject(subscription.metadata) ? subscription.metadata : {};
  if (metadata.anonymous !== true || metadata.resetPolicy !== "never") {
    subscription.metadata = {
      ...metadata,
      anonymous: true,
      resetPolicy: "never",
    };
    changed = true;
  }
  return changed;
};

const buildEmptyState = () => ({
  users: {},
  usersByEmail: {},
  subscriptions: {},
  usage: {},
  authRequests: {},
  refreshTokens: {},
  processedSubscriptionEvents: {},
  subscriptionEventOrders: {},
});

const applyContextFromState = (state, userClaims, config, now = new Date()) => {
  const userResult = ensureUserRecord(state, userClaims);
  const subscriptionResult = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    now
  );
  const anonymousSubscriptionChanged = isAnonymousClaims(userClaims)
    ? enforceAnonymousSubscription(subscriptionResult.subscription, config)
    : false;
  const rawSubscription = subscriptionResult.subscription;
  const effectiveSubscription = resolveEffectiveSubscription(
    rawSubscription,
    config,
  );
  const usageResult = ensureUsageRecord(
    state,
    userResult.user.id,
    effectiveSubscription,
    config,
  );
  return {
    user: userResult.user,
    subscription: effectiveSubscription,
    rawSubscription,
    usage: usageResult.usage,
    changed: Boolean(
      userResult.changed || subscriptionResult.changed || usageResult.changed
      || anonymousSubscriptionChanged
    ),
  };
};

const withFallbackState = async (config, userClaims, callback) => {
  return withPlatformStateLock(config, async () => {
    const state = await loadPlatformState(config);
    const ctx = applyContextFromState(state, userClaims, config, new Date());
    return callback({
      backend: "fallback",
      state,
      ...ctx,
      save: async () => {
        await savePlatformState(config, state);
      },
      consumeUsage: async ({ featureName, consumedTokens, consumedRequests }) =>
        withPlatformStateLock(config, async () => {
          const latestState = await loadPlatformState(config);
          const latest = applyContextFromState(
            latestState,
            userClaims,
            config,
            new Date()
          );
          const quota = consumeQuota(
            latest.usage,
            featureName,
            consumedTokens,
            consumedRequests
          );
          await savePlatformState(config, latestState);
          Object.assign(ctx.usage, latest.usage);
          return { usage: latest.usage, quota };
        }),
      reserveUsage: async ({ featureName, reservedTokens, reservedRequests }) =>
        withPlatformStateLock(config, async () => {
          const latestState = await loadPlatformState(config);
          const latest = applyContextFromState(
            latestState,
            userClaims,
            config,
            new Date(),
          );
          const quota = tryReserveQuota(
            latest.usage,
            featureName,
            reservedTokens,
            reservedRequests,
          );
          if (!quota) {
            return {
              reserved: false,
              usage: latest.usage,
              quota: buildQuotaSummary(latest.usage),
            };
          }
          await savePlatformState(config, latestState);
          Object.assign(ctx.usage, latest.usage);
          return { reserved: true, usage: latest.usage, quota };
        }),
      reconcileUsage: async ({
        featureName,
        reservedTokens,
        actualTokens,
        actualCostUsd,
        blendedCostPerTokenUsd,
      }) =>
        withPlatformStateLock(config, async () => {
          const latestState = await loadPlatformState(config);
          const latest = applyContextFromState(
            latestState,
            userClaims,
            config,
            new Date(),
          );
          const quota = reconcileQuotaReservation(
            latest.usage,
            featureName,
            reservedTokens,
            actualTokens,
            actualCostUsd === undefined
              ? {}
              : {
                  actualCostUsd,
                  blendedCostPerTokenUsd,
                },
          );
          await savePlatformState(config, latestState);
          Object.assign(ctx.usage, latest.usage);
          return { usage: latest.usage, quota };
        }),
    });
  });
};

const withDatabaseState = async (
  config,
  userClaims,
  callback,
  { persistInitialState = true } = {}
) => {
  const now = new Date();
  const state = buildEmptyState();
  const userRow = await upsertUserRecord(config, userClaims);
  const resolvedClaims = userRow
    ? {
        id: userRow.id,
        email: isAnonymousClaims(userClaims) ? null : userRow.email,
        name: userRow.name,
        anonymous: isAnonymousClaims(userClaims),
      }
    : userClaims;
  const userResult = ensureUserRecord(state, resolvedClaims);
  const userId = userResult.user.id;
  const dbSubscription = await getSubscriptionRecordByUserId(config, userId);
  if (dbSubscription) {
    state.subscriptions[userId] = dbSubscription;
  }
  const subscriptionResult = ensureSubscriptionState(state, userId, config, now);
  const anonymousSubscriptionChanged = isAnonymousClaims(userClaims)
    ? enforceAnonymousSubscription(subscriptionResult.subscription, config)
    : false;
  const rawSubscription = subscriptionResult.subscription;
  const effectiveSubscription = resolveEffectiveSubscription(
    rawSubscription,
    config,
  );
  const dbUsage = await getUsageRecordForUserPeriod(config, {
    userId,
    periodStart: effectiveSubscription.quotaPeriodStart,
    periodEnd: effectiveSubscription.quotaPeriodEnd,
  });
  if (dbUsage) {
    state.usage[userId] = dbUsage;
  }
  const usageResult = ensureUsageRecord(
    state,
    userId,
    effectiveSubscription,
    config,
  );
  const persist = async () => {
    await upsertUserRecord(config, userResult.user);
    await upsertSubscriptionRecordForUser(config, {
      userId,
      ...rawSubscription,
    });
    await upsertUsageRecordForUserPeriod(config, {
      userId,
      ...usageResult.usage,
    });
  };
  if (
    persistInitialState &&
    (userResult.changed ||
      subscriptionResult.changed ||
      anonymousSubscriptionChanged ||
      usageResult.changed ||
      !dbSubscription ||
      !dbUsage)
  ) {
    await persist();
  }
  return callback({
    backend: "database",
    state,
    user: userResult.user,
    subscription: effectiveSubscription,
    rawSubscription,
    usage: usageResult.usage,
    changed: false,
    save: persist,
    consumeUsage: async ({ featureName, consumedTokens, consumedRequests }) => {
      const updated = await incrementUsageRecordForUserPeriod(config, {
        userId,
        periodStart: usageResult.usage.periodStart,
        periodEnd: usageResult.usage.periodEnd,
        limitTokens: usageResult.usage.limitTokens,
        limitRequests: usageResult.usage.limitRequests,
        featureName,
        consumedTokens,
        consumedRequests,
      });
      if (updated) {
        Object.assign(usageResult.usage, updated);
      }
      return {
        usage: updated || usageResult.usage,
        quota: buildQuotaSummary(updated || usageResult.usage),
      };
    },
    reserveUsage: async ({ featureName, reservedTokens, reservedRequests }) => {
      const updated = await reserveUsageRecordForUserPeriod(config, {
        userId,
        periodStart: usageResult.usage.periodStart,
        periodEnd: usageResult.usage.periodEnd,
        featureName,
        reservedTokens,
        reservedRequests,
        blendedCostPerTokenUsd: config.blendedCostPerTokenUsd,
      });
      if (updated) Object.assign(usageResult.usage, updated);
      return {
        reserved: Boolean(updated),
        usage: updated || usageResult.usage,
        quota: buildQuotaSummary(updated || usageResult.usage),
      };
    },
    reconcileUsage: async ({
      featureName,
      reservedTokens,
      actualTokens,
      actualCostUsd,
      blendedCostPerTokenUsd,
    }) => {
      const updated = await reconcileUsageReservationForUserPeriod(config, {
        userId,
        periodStart: usageResult.usage.periodStart,
        periodEnd: usageResult.usage.periodEnd,
        featureName,
        reservedTokens,
        actualTokens,
        ...(actualCostUsd === undefined
          ? {}
          : {
              actualCostUsd,
              blendedCostPerTokenUsd,
            }),
      });
      if (updated) Object.assign(usageResult.usage, updated);
      return {
        usage: updated || usageResult.usage,
        quota: buildQuotaSummary(updated || usageResult.usage),
      };
    },
  });
};

const ensureBackendAvailable = (config) => {
  if (isDatabaseConfigured(config) || isStateFallbackEnabled(config)) {
    return;
  }
  throw new ApiError(
    "STATE_BACKEND_UNAVAILABLE",
    "Persistent state backend is unavailable.",
    503
  );
};

export const withUserContext = async (config, userClaims, callback, options = {}) => {
  ensureBackendAvailable(config);
  if (isDatabaseConfigured(config)) {
    return withDatabaseState(config, userClaims, callback, options);
  }
  return withFallbackState(config, userClaims, callback);
};

export const getUserContext = async (config, userClaims, options = {}) =>
  withUserContext(config, userClaims, async (ctx) => {
    if (ctx.changed && typeof ctx.save === "function") {
      await ctx.save();
    }
    return {
      backend: ctx.backend,
      state: ctx.state,
      user: ctx.user,
      subscription: ctx.subscription,
      rawSubscription: ctx.rawSubscription,
      usage: ctx.usage,
      save: ctx.save,
      consumeUsage: ctx.consumeUsage,
      reserveUsage: ctx.reserveUsage,
      reconcileUsage: ctx.reconcileUsage,
    };
  }, options);

export const getAiFeatureSnapshot = (subscription, usage, config) =>
  evaluateAiFeature(subscription, usage, config.pricingUrl);

export const getUsageSnapshot = (usage) => ({
  summary: buildQuotaSummary(usage),
  byFeature: buildUsageBreakdown(usage),
});

const syncDatabaseUsageLimits = async (config, userId, context) => {
  const persisted = await upsertUsageRecordForUserPeriod(config, {
    userId,
    ...context.usage,
  });
  if (persisted) {
    Object.assign(context.usage, persisted);
  }
  return context;
};

export const applySubscriptionPatch = async ({
  config,
  userClaims,
  patch = {},
  resetUsage = false,
  ordering = null,
}) =>
  withUserContext(config, userClaims, async (ctx) => {
    const userId = ctx.user.id;
    if (ctx.backend === "database") {
      const transient = buildEmptyState();
      transient.users[userId] = ctx.user;
      transient.subscriptions[userId] =
        ctx.rawSubscription || ctx.subscription;
      upsertSubscriptionRecord(transient, userId, patch, config, new Date());
      const normalized = ensureSubscriptionState(transient, userId, config, new Date());
      const subscriptionPayload = {
        userId,
        ...normalized.subscription,
      };
      const writeResult = ordering
        ? await upsertOrderedSubscriptionRecordForUser(
            config,
            subscriptionPayload,
            ordering
          )
        : {
            applied: true,
            stale: false,
            subscription: await upsertSubscriptionRecordForUser(
              config,
              subscriptionPayload
            ),
          };
      if (writeResult.stale) {
        const refreshed = await getUserContext(config, ctx.user, {
          persistInitialState: false,
        });
        await syncDatabaseUsageLimits(config, userId, refreshed);
        return {
          ...refreshed,
          stale: true,
          order: writeResult.current || null,
        };
      }
      if (resetUsage) {
        await deleteUsageRecordsForUser(config, userId);
      }
      const refreshed = await getUserContext(config, ctx.user, {
        persistInitialState: false,
      });
      await syncDatabaseUsageLimits(config, userId, refreshed);
      return {
        ...refreshed,
        stale: false,
        order: writeResult.current || null,
      };
    }
    if (ordering) {
      if (!isObject(ctx.state.subscriptionEventOrders)) {
        ctx.state.subscriptionEventOrders = {};
      }
      const orderKey = `${ordering.source}:${userId}`;
      const currentOrder = ctx.state.subscriptionEventOrders[orderKey] || null;
      if (isSubscriptionBridgeOrderStale(currentOrder, ordering)) {
        return { ...ctx, stale: true, order: currentOrder };
      }
      ctx.state.subscriptionEventOrders[orderKey] = {
        ...ordering,
        userId,
        updatedAt: new Date().toISOString(),
      };
    }
    upsertSubscriptionRecord(ctx.state, userId, patch, config, new Date());
    const rawSubscription = ensureSubscriptionState(
      ctx.state,
      userId,
      config,
      new Date(),
    ).subscription;
    const effectiveSubscription = resolveEffectiveSubscription(
      rawSubscription,
      config,
    );
    if (resetUsage) {
      delete ctx.state.usage[userId];
    }
    ensureUsageRecord(
      ctx.state,
      userId,
      effectiveSubscription,
      config,
    );
    await ctx.save();
    return {
      backend: ctx.backend,
      state: ctx.state,
      user: ctx.user,
      subscription: effectiveSubscription,
      rawSubscription,
      usage: ctx.state.usage[userId],
      save: ctx.save,
      consumeUsage: ctx.consumeUsage,
      stale: false,
      order: ordering || null,
    };
  }, { persistInitialState: !ordering });
