const assert = require("node:assert/strict");
const test = require("node:test");

const { PlatformAccessService } = require("../electron/services/platform-access.cjs");

const EMBEDDED_CHECKOUT_RESPONSE = Object.freeze({
  requestId: "contract-request",
  sessionId: "cs_contract_session",
  checkoutUrl: "",
  clientSecret: "cs_contract_session_secret_contract",
  publishableKey: "pk_test_contract",
  uiMode: "embedded",
  capabilities: { configured: true },
});

test("billing checkout consumer requests and preserves the embedded contract", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "http://127.0.0.1:1/api/v2",
  });
  let request = null;
  service.authorizedRequest = async (pathname, options) => {
    request = { pathname, options };
    return EMBEDDED_CHECKOUT_RESPONSE;
  };

  const checkout = await service.createBillingCheckout(" pro ");

  assert.deepEqual(request, {
    pathname: "/billing/checkout",
    options: {
      method: "POST",
      body: { plan: "pro", uiMode: "embedded" },
    },
  });
  assert.deepEqual(checkout, {
    clientSecret: EMBEDDED_CHECKOUT_RESPONSE.clientSecret,
    publishableKey: EMBEDDED_CHECKOUT_RESPONSE.publishableKey,
    sessionId: EMBEDDED_CHECKOUT_RESPONSE.sessionId,
    checkoutUrl: EMBEDDED_CHECKOUT_RESPONSE.checkoutUrl,
    uiMode: EMBEDDED_CHECKOUT_RESPONSE.uiMode,
  });
});

test("billing checkout consumer preserves the hosted fallback contract", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "http://127.0.0.1:1/api/v2",
  });
  service.authorizedRequest = async () => ({
    sessionId: "cs_hosted_contract",
    checkoutUrl: "https://checkout.stripe.com/c/pay/hosted-contract",
    uiMode: "hosted",
  });

  const checkout = await service.createBillingCheckout("basic");

  assert.deepEqual(checkout, {
    clientSecret: "",
    publishableKey: "",
    sessionId: "cs_hosted_contract",
    checkoutUrl: "https://checkout.stripe.com/c/pay/hosted-contract",
    uiMode: "hosted",
  });
});
