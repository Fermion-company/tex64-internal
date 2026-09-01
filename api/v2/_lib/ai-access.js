import { requireAuthenticatedUser } from "./auth.js";
import { ApiError } from "./http.js";
import { consumeQuota } from "./subscription-domain.js";
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
  const userClaims = requireAuthenticatedUser(req, config);
  const context = await getUserContext(config, userClaims);
  const aiFeature = getAiFeatureSnapshot(context.subscription, context.usage, config);
  return {
    state: context.state,
    save: context.save,
    user: context.user,
    subscription: context.subscription,
    usage: context.usage,
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
}) => {
  const quota = consumeQuota(usage, featureName, consumedTokens, consumedRequests);
  if (typeof save === "function") {
    await save();
  }
  return quota;
};

export const snapshotQuota = (usage) => getUsageSnapshot(usage).summary;
