export const TEX64_COMMERCE_NAMESPACE = "tex64";
export const TEX64_COMMERCE_SCHEMA_VERSION = "1";

export const TEX64_COMMERCE_PRODUCT_IDS = Object.freeze(["basic", "pro"]);
export const TEX64_SUBSCRIPTION_STATUSES = Object.freeze([
  "active",
  "grace",
  "past_due",
  "canceled",
]);

const PRODUCT_ID_SET = new Set(TEX64_COMMERCE_PRODUCT_IDS);
const STATUS_SET = new Set(TEX64_SUBSCRIPTION_STATUSES);
const STRIPE_EVENT_TYPE_SET = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.finalized",
]);

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const normalizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const isPositiveInteger = (value) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const invalid = (reason, details = {}) => ({
  action: "invalid",
  reason,
  namespace: details.namespace || null,
  productId: details.productId || null,
  legacy: details.legacy === true,
});

/**
 * Classify the authenticated app-platform subscription envelope before any
 * user, subscription, usage, or idempotency storage is touched.
 */
export const classifySubscriptionBridgeCommerce = (body) => {
  if (!isObject(body)) {
    return invalid("PAYLOAD_INVALID");
  }

  const namespacePresent = hasOwn(body, "commerce_namespace");
  const schemaPresent = hasOwn(body, "commerce_schema_version");
  const productPresent = hasOwn(body, "product_id");
  const namespace = normalizeString(body.commerce_namespace).toLowerCase();
  const productId = normalizeString(body.product_id).toLowerCase();
  const plan = normalizeString(body.plan).toLowerCase();

  // An explicit non-TeX64 namespace always wins. This prevents legacy fields
  // such as plan/userId from accidentally claiming another product's event.
  if (namespace && namespace !== TEX64_COMMERCE_NAMESPACE) {
    return {
      action: "ignore",
      reason: "FOREIGN_NAMESPACE",
      namespace,
      productId: productId || null,
      legacy: false,
    };
  }

  if (namespacePresent) {
    if (namespace !== TEX64_COMMERCE_NAMESPACE) {
      return invalid("NAMESPACE_INVALID", { namespace, productId });
    }
    const schemaVersion = normalizeString(body.commerce_schema_version);
    if (schemaVersion !== TEX64_COMMERCE_SCHEMA_VERSION) {
      return invalid("SCHEMA_VERSION_INVALID", { namespace, productId });
    }
    if (!PRODUCT_ID_SET.has(productId)) {
      return invalid("PRODUCT_ID_INVALID", { namespace, productId });
    }
    if (plan !== productId) {
      return invalid("PRODUCT_PLAN_MISMATCH", { namespace, productId });
    }
    return {
      action: "process",
      reason: "TEX64_COMMERCE_VALID",
      namespace,
      schemaVersion,
      productId,
      legacy: false,
    };
  }

  // A partially populated canonical envelope is never legacy-compatible.
  if (schemaPresent || productPresent) {
    return invalid("NAMESPACE_MISSING", { productId });
  }

  // Pre-contract TeX64 bridge payloads carried plan but no commerce fields.
  // Additional legacy ownership checks (source, event ID, and user ID) happen
  // in the authenticated route before this classification can be processed.
  if (!PRODUCT_ID_SET.has(plan)) {
    return invalid("LEGACY_PRODUCT_UNVERIFIED", { productId: plan, legacy: true });
  }
  return {
    action: "process",
    reason: "LEGACY_TEX64_PLAN",
    namespace: null,
    schemaVersion: null,
    productId: plan,
    legacy: true,
  };
};

export const isTex64SubscriptionStatus = (value) =>
  STATUS_SET.has(normalizeString(value).toLowerCase());

export const stripeEventRankForSubscriptionStatus = (value) => {
  const status = normalizeString(value).toLowerCase();
  if (status === "canceled") return 30;
  if (status === "grace" || status === "past_due") return 20;
  if (status === "active") return 10;
  return 0;
};

export const classifySubscriptionBridgeOrdering = (
  body,
  { legacy = false, eventId = "" } = {}
) => {
  const hasOrderingField = [
    "stripeEventType",
    "stripeEventCreated",
    "stripeEventRank",
  ].some((key) => hasOwn(body, key));
  if (legacy) {
    if (hasOrderingField) {
      return invalid("LEGACY_ORDERING_FIELDS_FORBIDDEN", { legacy: true });
    }
    return {
      action: "process",
      reason: "LEGACY_ORDER_BASELINE",
      legacy: true,
      eventId: normalizeString(eventId),
      eventType: "legacy.subscription.bridge",
      eventCreated: 0,
      eventRank: stripeEventRankForSubscriptionStatus(body?.status),
    };
  }

  const eventType = normalizeString(body?.stripeEventType);
  const eventCreated = body?.stripeEventCreated;
  const eventRank = body?.stripeEventRank;
  const expectedRank = stripeEventRankForSubscriptionStatus(body?.status);
  if (!STRIPE_EVENT_TYPE_SET.has(eventType)) {
    return invalid("STRIPE_EVENT_TYPE_INVALID");
  }
  if (!isPositiveInteger(eventCreated)) {
    return invalid("STRIPE_EVENT_CREATED_INVALID");
  }
  if (!isPositiveInteger(eventRank) || !expectedRank || eventRank !== expectedRank) {
    return invalid("STRIPE_EVENT_RANK_INVALID");
  }
  return {
    action: "process",
    reason: "STRIPE_EVENT_ORDER_VALID",
    legacy: false,
    eventId: normalizeString(eventId),
    eventType,
    eventCreated,
    eventRank,
  };
};

export const isSubscriptionBridgeOrderStale = (current, incoming) => {
  if (!current || typeof current !== "object") {
    return false;
  }
  if (normalizeString(current.eventId) === normalizeString(incoming?.eventId)) {
    return true;
  }
  if (incoming?.legacy === true) {
    if (Number(current.eventCreated || 0) > 0 || current.legacy !== true) {
      return true;
    }
    const currentRank = Number(current.eventRank || 0);
    const incomingRank = Number(incoming.eventRank || 0);
    if (incomingRank < currentRank) return true;
    if (incomingRank > currentRank) return false;
    return normalizeString(incoming.eventId) <= normalizeString(current.eventId);
  }
  const currentCreated = Number(current.eventCreated || 0);
  const incomingCreated = Number(incoming?.eventCreated || 0);
  if (incomingCreated < currentCreated) return true;
  if (incomingCreated > currentCreated) return false;
  const currentRank = Number(current.eventRank || 0);
  const incomingRank = Number(incoming?.eventRank || 0);
  if (incomingRank < currentRank) return true;
  if (incomingRank > currentRank) return false;
  return normalizeString(incoming?.eventId) <= normalizeString(current.eventId);
};
