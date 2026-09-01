import {
  deleteUsageRecordsForUser,
  getSubscriptionRecordByUserId,
  getUsageRecordForUserPeriod,
  isDatabaseConfigured,
  upsertOrderedSubscriptionRecordForUser,
  upsertSubscriptionRecordForUser,
  upsertUsageRecordForUserPeriod,
  upsertUserRecord,
} from "./db-adapter.js";
import { ApiError } from "./http.js";
import { loadPlatformState, savePlatformState } from "./state-store.js";
import { isStateFallbackEnabled } from "./state-backend.js";
import { isSubscriptionBridgeOrderStale } from "./subscription-bridge-routing.js";
import {
  buildQuotaSummary,
  buildUsageBreakdown,
  ensureSubscriptionState,
  ensureUsageRecord,
  ensureUserRecord,
  evaluateAiFeature,
  upsertSubscriptionRecord,
} from "./subscription-domain.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

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
  const usageResult = ensureUsageRecord(
    state,
    userResult.user.id,
    subscriptionResult.subscription
  );
  return {
    user: userResult.user,
    subscription: subscriptionResult.subscription,
    usage: usageResult.usage,
    changed: Boolean(
      userResult.changed || subscriptionResult.changed || usageResult.changed
    ),
  };
};

const withFallbackState = async (config, userClaims, callback) => {
  const state = await loadPlatformState(config);
  const ctx = applyContextFromState(state, userClaims, config, new Date());
  return callback({
    backend: "fallback",
    state,
    ...ctx,
    save: async () => {
      await savePlatformState(config, state);
    },
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
        email: userRow.email,
        name: userRow.name,
      }
    : userClaims;
  const userResult = ensureUserRecord(state, resolvedClaims);
  const userId = userResult.user.id;
  const dbSubscription = await getSubscriptionRecordByUserId(config, userId);
  if (dbSubscription) {
    state.subscriptions[userId] = dbSubscription;
  }
  const subscriptionResult = ensureSubscriptionState(state, userId, config, now);
  const dbUsage = await getUsageRecordForUserPeriod(config, {
    userId,
    periodStart: subscriptionResult.subscription.quotaPeriodStart,
    periodEnd: subscriptionResult.subscription.quotaPeriodEnd,
  });
  if (dbUsage) {
    state.usage[userId] = dbUsage;
  }
  const usageResult = ensureUsageRecord(state, userId, subscriptionResult.subscription);
  const persist = async () => {
    await upsertUserRecord(config, userResult.user);
    await upsertSubscriptionRecordForUser(config, {
      userId,
      ...subscriptionResult.subscription,
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
    subscription: subscriptionResult.subscription,
    usage: usageResult.usage,
    changed: false,
    save: persist,
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
      usage: ctx.usage,
      save: ctx.save,
    };
  }, options);

export const getAiFeatureSnapshot = (subscription, usage, config) =>
  evaluateAiFeature(subscription, usage, config.pricingUrl);

export const getUsageSnapshot = (usage) => ({
  summary: buildQuotaSummary(usage),
  byFeature: buildUsageBreakdown(usage),
});

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
      transient.subscriptions[userId] = ctx.subscription;
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
        return {
          ...(await getUserContext(config, ctx.user, {
            persistInitialState: false,
          })),
          stale: true,
          order: writeResult.current || null,
        };
      }
      if (resetUsage) {
        await deleteUsageRecordsForUser(config, userId);
      }
      return {
        ...(await getUserContext(config, ctx.user, {
          persistInitialState: false,
        })),
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
    ensureSubscriptionState(ctx.state, userId, config, new Date());
    if (resetUsage) {
      delete ctx.state.usage[userId];
    }
    ensureUsageRecord(ctx.state, userId, ctx.state.subscriptions[userId]);
    await ctx.save();
    return {
      ...(await getUserContext(config, ctx.user)),
      stale: false,
      order: ordering || null,
    };
  }, { persistInitialState: !ordering });
