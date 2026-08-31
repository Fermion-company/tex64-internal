import {
  getOptionalAuthenticatedUser,
} from "./auth.js";
import {
  createAnonymousAiUsageGuard,
  loadAdmittedAnonymousAppUser,
} from "./anonymous-abuse.js";
import { ApiError } from "./http.js";
import {
  consumeQuota,
  reconcileQuotaReservation,
  tryReserveQuota,
} from "./subscription-domain.js";
import {
  getAiFeatureSnapshot,
  getUsageSnapshot,
  getUserContext,
} from "./user-context.js";

const featureErrorFromReason = (reason) => {
  if (reason === "QUOTA_EXCEEDED") {
    return new ApiError("QUOTA_EXCEEDED", "AI monthly token quota exceeded.", 429);
  }
  if (reason === "PAYMENT_PAST_DUE") {
    return new ApiError(
      "PAYMENT_PAST_DUE",
      "Your subscription is past due. Please update billing.",
      402
    );
  }
  if (reason === "PLAN_REQUIRED") {
    return new ApiError("PLAN_REQUIRED", "A paid plan is required to use AI.", 403);
  }
  if (reason === "FEATURE_NOT_ENABLED") {
    return new ApiError("FEATURE_NOT_ENABLED", "AI feature is not enabled.", 403);
  }
  return new ApiError("FEATURE_NOT_ENABLED", "AI feature is not available.", 403);
};

export const loadAuthorizedAiContext = async (req, config) => {
  let userClaims = getOptionalAuthenticatedUser(req, config);
  let anonymousUsageGuard = null;
  if (!userClaims) {
    const anonymous = await loadAdmittedAnonymousAppUser(req, config);
    userClaims = anonymous.user;
    anonymousUsageGuard = createAnonymousAiUsageGuard({
      config,
      networkHash: anonymous.networkHash,
    });
  }
  const context = await getUserContext(config, userClaims);
  const aiFeature = getAiFeatureSnapshot(context.subscription, context.usage, config);
  const reserveUsage = anonymousUsageGuard
    ? async (reservation) => {
        await anonymousUsageGuard.reserve(reservation);
        try {
          const result = await context.reserveUsage(reservation);
          if (!result?.reserved) {
            await anonymousUsageGuard.reconcile({
              reservedTokens: reservation.reservedTokens,
              actualTokens: 0,
            });
          }
          return result;
        } catch (error) {
          await anonymousUsageGuard
            .reconcile({
              reservedTokens: reservation.reservedTokens,
              actualTokens: 0,
            })
            .catch(() => null);
          throw error;
        }
      }
    : context.reserveUsage;
  const reconcileUsage = anonymousUsageGuard
    ? async (reconciliation) => {
        let accountResult = null;
        let accountError = null;
        try {
          accountResult = await context.reconcileUsage(reconciliation);
        } catch (error) {
          accountError = error;
        }
        await anonymousUsageGuard.reconcile(reconciliation);
        if (accountError) throw accountError;
        return accountResult;
      }
    : context.reconcileUsage;
  return {
    state: context.state,
    save: context.save,
    user: context.user,
    subscription: context.subscription,
    usage: context.usage,
    consumeUsage: context.consumeUsage,
    reserveUsage,
    reconcileUsage,
    anonymous: userClaims.anonymous === true,
    feature: aiFeature,
  };
};

export const assertAiFeatureEnabled = (feature) => {
  if (feature.enabled) {
    return;
  }
  throw featureErrorFromReason(feature.reason);
};

export const commitQuotaConsumption = async ({
  save,
  usage,
  featureName,
  consumedTokens,
  consumedRequests,
  consumeUsage,
}) => {
  if (typeof consumeUsage === "function") {
    const result = await consumeUsage({
      featureName,
      consumedTokens,
      consumedRequests,
    });
    return result?.quota || snapshotQuota(result?.usage || usage);
  }
  const quota = consumeQuota(usage, featureName, consumedTokens, consumedRequests);
  if (typeof save === "function") {
    await save();
  }
  return quota;
};

export const reserveQuotaConsumption = async ({
  usage,
  featureName,
  reservedTokens,
  reservedRequests = 1,
  reserveUsage,
}) => {
  if (typeof reserveUsage === "function") {
    return reserveUsage({
      featureName,
      reservedTokens,
      reservedRequests,
    });
  }
  const quota = tryReserveQuota(
    usage,
    featureName,
    reservedTokens,
    reservedRequests,
  );
  return {
    reserved: Boolean(quota),
    usage,
    quota: quota || snapshotQuota(usage),
  };
};

export const reconcileQuotaConsumption = async ({
  usage,
  featureName,
  reservedTokens,
  actualTokens,
  actualCostUsd,
  blendedCostPerTokenUsd,
  reconcileUsage,
  save,
}) => {
  if (typeof reconcileUsage === "function") {
    return reconcileUsage({
      featureName,
      reservedTokens,
      actualTokens,
      ...(actualCostUsd === undefined
        ? {}
        : { actualCostUsd, blendedCostPerTokenUsd }),
    });
  }
  const quota = reconcileQuotaReservation(
    usage,
    featureName,
    reservedTokens,
    actualTokens,
    actualCostUsd === undefined
      ? {}
      : { actualCostUsd, blendedCostPerTokenUsd },
  );
  if (typeof save === "function") await save();
  return { usage, quota };
};

export const snapshotQuota = (usage) => getUsageSnapshot(usage).summary;
