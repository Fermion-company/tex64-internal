import { requireAuthenticatedUser } from "../_lib/auth.js";
import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  parseUrl,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../_lib/http.js";
import { getRuntimeConfig } from "../_lib/runtime-config.js";
import { getAiFeatureSnapshot, getUserContext } from "../_lib/user-context.js";

const hasAiName = (url) => {
  const names = url.searchParams.get("names");
  if (!names) {
    return true;
  }
  return names
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes("ai");
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "GET") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const config = getRuntimeConfig();
    const userClaims = requireAuthenticatedUser(req, config);
    const url = parseUrl(req);
    const includeAi = hasAiName(url);
    const context = await getUserContext(config, userClaims);
    const aiFeature = getAiFeatureSnapshot(
      context.subscription,
      context.usage,
      config
    );

    sendJson(res, 200, {
      requestId,
      user: {
        id: context.user.id,
        email: context.user.email,
        name: context.user.name,
        plan: context.subscription.plan,
      },
      features: includeAi
        ? {
            ai: {
              enabled: aiFeature.enabled,
              reason: aiFeature.reason,
              status: aiFeature.status,
              graceEndsAt: aiFeature.graceEndsAt,
              periodStart: aiFeature.periodStart,
              periodEnd: aiFeature.periodEnd,
              quota: aiFeature.quota,
            },
          }
        : {},
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
