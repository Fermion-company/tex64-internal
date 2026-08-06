const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getCheckoutReturnOutcome,
  normalizeStripeCheckoutUrl,
} = require("../electron/services/billing-checkout.cjs");

test("hosted checkout accepts only Stripe HTTPS URLs", () => {
  const valid = "https://checkout.stripe.com/c/pay/cs_test_contract#fragment";
  assert.equal(normalizeStripeCheckoutUrl(valid), valid);

  for (const invalid of [
    "http://checkout.stripe.com/c/pay/cs_test_contract",
    "https://checkout.stripe.com.evil.example/c/pay/cs_test_contract",
    "https://evil.example/?next=https://checkout.stripe.com",
    "https://user@checkout.stripe.com/c/pay/cs_test_contract",
    "javascript:alert(1)",
  ]) {
    assert.equal(normalizeStripeCheckoutUrl(invalid), "", invalid);
  }
});

test("checkout completion accepts only the TeX64 billing return", () => {
  assert.equal(
    getCheckoutReturnOutcome("https://tex64.com/account/billing?checkout=success"),
    "success"
  );
  assert.equal(
    getCheckoutReturnOutcome("https://www.tex64.com/account/billing/?plan=pro&checkout=cancel"),
    "cancel"
  );

  for (const invalid of [
    "http://tex64.com/account/billing?checkout=success",
    "https://tex64.com.evil.example/account/billing?checkout=success",
    "https://tex64.com/account/profile?checkout=success",
    "https://tex64.com/account/billing?checkout=pending",
    "https://user@tex64.com/account/billing?checkout=success",
  ]) {
    assert.equal(getCheckoutReturnOutcome(invalid), "", invalid);
  }
});
