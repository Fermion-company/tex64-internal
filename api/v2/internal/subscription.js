import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  readJsonBody,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../_lib/http.js";
import { getRuntimeConfig } from "../_lib/runtime-config.js";
import {
  isSubscriptionEventProcessed,
  markSubscriptionEventProcessed,
  withSubscriptionUserLock,
} from "../_lib/subscription-event-store.js";
import {
  TEX64_COMMERCE_NAMESPACE,
  TEX64_COMMERCE_SCHEMA_VERSION,
  classifySubscriptionBridgeCommerce,
  classifySubscriptionBridgeOrdering,
  isTex64SubscriptionStatus,
} from "../_lib/subscription-bridge-routing.js";
import {
  applySubscriptionPatch,
  getUsageSnapshot,
} from "../_lib/user-context.js";

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const WEBHOOK_TOKEN_REGEX = /^[A-Za-z0-9._:-]+$/;
const STRIPE_EVENT_ID_REGEX = /^evt_[A-Za-z0-9]+$/;
const FORBIDDEN_COMMERCE_FIELDS = Object.freeze([
  "quotaLimitTokens",
  "quotaLimitRequests",
  "resetUsage",
]);

const sanitizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readHeaderString = (req, headerName) => {
  const value = req?.headers?.[headerName];
  if (Array.isArray(value)) {
    return sanitizeString(value[0]);
  }
  return sanitizeString(value);
};

const sanitizeWebhookToken = (value, maxLength) => {
  const token = sanitizeString(value);
  if (!token) {
    return null;
  }
  if (token.length > maxLength || !WEBHOOK_TOKEN_REGEX.test(token)) {
    return null;
  }
  return token;
};

const asEmail = (value) => {
  const email = sanitizeString(value)?.toLowerCase() ?? null;
  if (!email) {
    return null;
  }
  if (!email.includes("@")) {
    return null;
  }
  return email;
};

const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const invalidCommerceEnvelope = (reason, details = {}) =>
  new ApiError(
    "COMMERCE_ROUTING_INVALID",
    "TeX64 subscription commerce routing is invalid.",
    500,
    { details: { reason, ...details } }
  );

const uniqueProvidedValues = (values) => [
  ...new Set(values.map(sanitizeString).filter(Boolean)),
];

const resolveConsistentToken = ({ values, maxLength, label }) => {
  const provided = uniqueProvidedValues(values);
  if (provided.length > 1) {
    throw invalidCommerceEnvelope(`${label}_CONFLICT`);
  }
  const raw = provided[0] || null;
  const token = sanitizeWebhookToken(raw, maxLength);
  if (!token) {
    throw invalidCommerceEnvelope(`${label}_INVALID`);
  }
  return token;
};

const parseOptionalDate = (value, fieldName) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = sanitizeString(value);
  const timestamp = normalized ? Date.parse(normalized) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw invalidCommerceEnvelope(`${fieldName.toUpperCase()}_INVALID`);
  }
  return new Date(timestamp).toISOString();
};

const buildSubscriptionPatch = (body, productId) => {
  const status = sanitizeString(body.status)?.toLowerCase() || "";
  if (!isTex64SubscriptionStatus(status)) {
    throw invalidCommerceEnvelope("STATUS_INVALID");
  }
  for (const fieldName of FORBIDDEN_COMMERCE_FIELDS) {
    if (hasOwn(body, fieldName)) {
      throw invalidCommerceEnvelope("ENTITLEMENT_OVERRIDE_FORBIDDEN", {
        field: fieldName,
      });
    }
  }

  const billingPeriodStart = parseOptionalDate(
    body.billingPeriodStart,
    "billing_period_start"
  );
  const billingPeriodEnd = parseOptionalDate(
    body.billingPeriodEnd,
    "billing_period_end"
  );
  if (Boolean(billingPeriodStart) !== Boolean(billingPeriodEnd)) {
    throw invalidCommerceEnvelope("BILLING_PERIOD_INCOMPLETE");
  }
  if (
    billingPeriodStart &&
    billingPeriodEnd &&
    Date.parse(billingPeriodEnd) <= Date.parse(billingPeriodStart)
  ) {
    throw invalidCommerceEnvelope("BILLING_PERIOD_INVALID");
  }
  const graceEndsAt = parseOptionalDate(body.graceEndsAt, "grace_ends_at");
  if (status === "grace" && !graceEndsAt) {
    throw invalidCommerceEnvelope("GRACE_END_MISSING");
  }

  return {
    plan: productId,
    status,
    ...(billingPeriodStart ? { billingPeriodStart } : {}),
    ...(billingPeriodEnd ? { billingPeriodEnd } : {}),
    ...(graceEndsAt ? { graceEndsAt } : {}),
  };
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "POST") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const config = getRuntimeConfig();
    if (!config.adminSecret) {
      throw new ApiError(
        "INTERNAL_ERROR",
        "TEX64_PLATFORM_ADMIN_SECRET is not configured.",
        500
      );
    }
    const providedSecret = sanitizeString(req.headers?.["x-tex64-admin-secret"]);
    if (!providedSecret || providedSecret !== config.adminSecret) {
      throw new ApiError("AUTH_REQUIRED", "Admin authentication failed.", 401);
    }
    const body = await readJsonBody(req);
    if (!isObject(body)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body is required.", 400);
    }
    const commerce = classifySubscriptionBridgeCommerce(body);
    if (commerce.action === "ignore") {
      sendJson(res, 200, {
        requestId,
        received: true,
        ignored: true,
        reason: commerce.reason,
        commerceNamespace: commerce.namespace,
      });
      return;
    }
    if (commerce.action !== "process") {
      throw invalidCommerceEnvelope(commerce.reason, {
        commerceNamespace: commerce.namespace,
        productId: commerce.productId,
      });
    }

    const email = asEmail(body.email);
    const explicitUserId = sanitizeString(body.userId);
    if (!explicitUserId) {
      throw invalidCommerceEnvelope("USER_ID_MISSING");
    }
    const source = resolveConsistentToken({
      values: [
        body.source,
        readHeaderString(req, "x-tex64-webhook-source"),
        readHeaderString(req, "x-tex64-source"),
      ],
      maxLength: 64,
      label: "SOURCE",
    });
    if (source !== config.subscriptionBridgeSource) {
      throw invalidCommerceEnvelope("SOURCE_NOT_OWNED", { source });
    }
    const eventId = resolveConsistentToken({
      values: [
        body.eventId,
        readHeaderString(req, "x-tex64-event-id"),
        readHeaderString(req, "idempotency-key"),
      ],
      maxLength: 180,
      label: "EVENT_ID",
    });
    if (commerce.legacy && !STRIPE_EVENT_ID_REGEX.test(eventId)) {
      throw invalidCommerceEnvelope("LEGACY_EVENT_ID_UNVERIFIED");
    }

    const userClaims = {
      id: explicitUserId,
      email,
      name: sanitizeString(body.name),
    };
    const patch = buildSubscriptionPatch(body, commerce.productId);
    const ordering = classifySubscriptionBridgeOrdering(body, {
      legacy: commerce.legacy,
      eventId,
    });
    if (ordering.action !== "process") {
      throw invalidCommerceEnvelope(ordering.reason);
    }
    const durableOrdering = { ...ordering, source };
    const pruneMaxAgeMs =
      Math.max(3600, Math.round(config.subscriptionEventTtlSec || 90 * 24 * 60 * 60)) *
      1000;
    await withSubscriptionUserLock(source, explicitUserId, async () => {
      const alreadyProcessed = await isSubscriptionEventProcessed(
        config,
        source,
        eventId,
        { pruneMaxAgeMs }
      );
      if (alreadyProcessed) {
        sendJson(res, 200, {
          requestId,
          received: true,
          duplicate: true,
          source,
          eventId,
        });
        return;
      }
      const context = await applySubscriptionPatch({
        config,
        userClaims,
        patch,
        resetUsage: false,
        ordering: durableOrdering,
      });
      const tracking = await markSubscriptionEventProcessed(
        config,
        {
          source,
          eventId,
          userId: context.user.id,
          payload: {
            commerce_namespace: TEX64_COMMERCE_NAMESPACE,
            commerce_schema_version: commerce.legacy
              ? null
              : TEX64_COMMERCE_SCHEMA_VERSION,
            product_id: commerce.productId,
            legacy: commerce.legacy,
            stripeEventType: ordering.eventType,
            stripeEventCreated: ordering.eventCreated,
            stripeEventRank: ordering.eventRank,
            stale: context.stale === true,
            ...patch,
          },
        },
        { pruneMaxAgeMs }
      );
      const duplicate = tracking?.duplicate === true;
      const usage = getUsageSnapshot(context.usage);

      sendJson(res, 200, {
        requestId,
        duplicate,
        ignored: context.stale === true,
        ...(context.stale ? { reason: "STALE_EVENT" } : {}),
        source,
        eventId,
        commerce: {
          namespace: TEX64_COMMERCE_NAMESPACE,
          schemaVersion: commerce.legacy
            ? null
            : TEX64_COMMERCE_SCHEMA_VERSION,
          productId: commerce.productId,
          legacy: commerce.legacy,
        },
        user: {
          id: context.user.id,
          email: context.user.email,
          name: context.user.name,
        },
        // Preserve the stored Stripe state for bridge callers and ordering
        // diagnostics, while making the entitlement actually exposed to users
        // explicit. For a terminal paid cancellation these intentionally differ.
        subscription: context.rawSubscription || context.subscription,
        effectiveSubscription: context.subscription,
        summary: usage.summary,
        byFeature: usage.byFeature,
      });
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
