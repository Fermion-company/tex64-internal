import {
  getOptionalAuthenticatedUser,
} from "../../_lib/auth.js";
import { loadAdmittedAnonymousAppUser } from "../../_lib/anonymous-abuse.js";
import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  parseUrl,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../../_lib/http.js";
import { getRuntimeConfig } from "../../_lib/runtime-config.js";
import {
  ANONYMOUS_AI_PERIOD,
  getUsageSnapshot,
  getUserContext,
} from "../../_lib/user-context.js";

const resolvePeriodLabel = (periodStartIso) => {
  if (typeof periodStartIso !== "string" || !periodStartIso.trim()) {
    return null;
  }
  const date = new Date(periodStartIso);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
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
    let userClaims = getOptionalAuthenticatedUser(req, config);
    if (!userClaims) {
      const anonymous = await loadAdmittedAnonymousAppUser(req, config);
      userClaims = anonymous.user;
    }
    const url = parseUrl(req);
    const period = url.searchParams.get("period");
    if (period && period !== "current_month") {
      throw new ApiError("VALIDATION_ERROR", "Only period=current_month is supported.", 400);
    }
    const context = await getUserContext(config, userClaims);
    const usage = getUsageSnapshot(context.usage);
    const summary = usage.summary;

    sendJson(res, 200, {
      requestId,
      period:
        userClaims.anonymous === true
          ? ANONYMOUS_AI_PERIOD.key
          : resolvePeriodLabel(summary.periodStart) || "current_month",
      plan: context.subscription.plan,
      summary,
      byFeature: usage.byFeature,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
