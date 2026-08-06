const assert = require("node:assert/strict");
const test = require("node:test");

const { PlatformAccessService } = require("../electron/services/platform-access.cjs");

const HOSTED_CHECKOUT_RESPONSE = Object.freeze({
  requestId: "contract-request",
  sessionId: "cs_contract_session",
  checkoutUrl: "https://checkout.stripe.com/c/pay/hosted-contract",
  uiMode: "hosted",
  capabilities: { configured: true },
});

test("billing checkout consumer requests and preserves the hosted contract", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "http://127.0.0.1:1/api/v2",
  });
  let request = null;
  service.authorizedRequest = async (pathname, options) => {
    request = { pathname, options };
    return HOSTED_CHECKOUT_RESPONSE;
  };

  const checkout = await service.createBillingCheckout(" pro ");

  assert.deepEqual(request, {
    pathname: "/billing/checkout",
    options: {
      method: "POST",
      body: { plan: "pro", uiMode: "hosted" },
    },
  });
  assert.deepEqual(checkout, {
    sessionId: HOSTED_CHECKOUT_RESPONSE.sessionId,
    checkoutUrl: HOSTED_CHECKOUT_RESPONSE.checkoutUrl,
    uiMode: HOSTED_CHECKOUT_RESPONSE.uiMode,
  });
});

test("billing checkout consumer does not expose an embedded-only response", async () => {
  const service = new PlatformAccessService({
    apiBaseUrl: "http://127.0.0.1:1/api/v2",
  });
  service.authorizedRequest = async () => ({
    sessionId: "cs_embedded_contract",
    checkoutUrl: "",
    clientSecret: "cs_embedded_contract_secret",
    publishableKey: "pk_test_contract",
    uiMode: "embedded",
  });

  const checkout = await service.createBillingCheckout("basic");

  assert.deepEqual(checkout, {
    sessionId: "cs_embedded_contract",
    checkoutUrl: "",
    uiMode: "",
  });
});
