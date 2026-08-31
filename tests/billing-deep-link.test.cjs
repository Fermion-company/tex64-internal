const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  getCheckoutReturnOutcome,
  parseBillingCompletionDeepLink,
} = require("../electron/services/billing-checkout.cjs");

test("hosted checkout recognizes legacy and current HTTPS return paths", () => {
  assert.equal(
    getCheckoutReturnOutcome(
      "https://tex64.com/account/billing?checkout=success&plan=basic",
    ),
    "success",
  );
  assert.equal(
    getCheckoutReturnOutcome(
      "https://www.tex64.com/account/billing/?checkout=cancel",
    ),
    "cancel",
  );
  assert.equal(
    getCheckoutReturnOutcome(
      "https://tex64.com/checkout/complete?checkout=success&plan=pro",
    ),
    "success",
  );
  assert.equal(
    getCheckoutReturnOutcome(
      "https://www.tex64.com/checkout/complete/?checkout=cancel",
    ),
    "cancel",
  );
  assert.equal(
    getCheckoutReturnOutcome("https://evil.example/checkout/complete?checkout=success"),
    "",
  );
});

test("billing completion deep links accept only the exact success contract", () => {
  assert.deepEqual(
    parseBillingCompletionDeepLink(
      "tex64://billing/complete?checkout=success",
    ),
    { outcome: "success" },
  );
  assert.deepEqual(
    parseBillingCompletionDeepLink(
      "tex64://billing/complete?checkout=success&plan=basic",
    ),
    { outcome: "success", plan: "basic" },
  );
  assert.deepEqual(
    parseBillingCompletionDeepLink(
      "tex64://billing/complete?plan=pro&checkout=success",
    ),
    { outcome: "success", plan: "pro" },
  );
});

test("billing completion deep links reject malformed or broadened URLs", () => {
  const invalid = [
    null,
    "",
    "https://billing/complete?checkout=success&plan=basic",
    "tex64:/billing/complete?checkout=success&plan=basic",
    "tex64://oauth/callback?checkout=success&plan=basic",
    "tex64://billing/other?checkout=success&plan=basic",
    "tex64://billing/complete/?checkout=success&plan=basic",
    "tex64://billing.tex64.com/complete?checkout=success&plan=basic",
    "tex64://user@billing/complete?checkout=success&plan=basic",
    "tex64://user:secret@billing/complete?checkout=success&plan=basic",
    "tex64://billing:8443/complete?checkout=success&plan=basic",
    "tex64://billing/complete?checkout=cancel&plan=basic",
    "tex64://billing/complete?checkout=pending&plan=basic",
    "tex64://billing/complete?checkout=success&plan=free",
    "tex64://billing/complete?checkout=success&plan=BASIC",
    "tex64://billing/complete?plan=basic",
    "tex64://billing/complete?checkout=success&plan=",
    "tex64://billing/complete?checkout=success&plan=basic&source=web",
    "tex64://billing/complete?checkout=success&checkout=success&plan=basic",
    "tex64://billing/complete?checkout=success&plan=basic&plan=basic",
    "tex64://billing/complete?checkout=success&plan=basic#done",
  ];
  for (const value of invalid) {
    assert.equal(
      parseBillingCompletionDeepLink(value),
      null,
      `must reject ${String(value)}`,
    );
  }
});

test("main routes every OS deep-link entry point through the validated queue", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /app\.on\("open-url",[\s\S]*?queueBillingCompletionDeepLink\(url\)[\s\S]*?queueOAuthCallbackUrl\(url\)/,
  );
  assert.match(
    source,
    /app\.on\("second-instance",[\s\S]*?parseBillingCompletionDeepLink\(arg\)[\s\S]*?queueBillingCompletionDeepLink\(arg\)/,
  );
  assert.match(
    source,
    /process\.argv\.forEach\([\s\S]*?queueBillingCompletionDeepLink\(arg\)[\s\S]*?queueOAuthCallbackUrl\(arg\)/,
  );
  assert.match(
    source,
    /"did-finish-load"[\s\S]*?flushPendingBillingCompletionLinks\(\)/,
  );
  assert.match(
    source,
    /sendToRenderer\("billing:checkoutClosed", payload\)/,
  );
  assert.match(source, /looksLikeOAuthCallbackUrl/);
});
