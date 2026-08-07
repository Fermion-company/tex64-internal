/**
 * E2E for the in-app billing / upgrade flow.
 *
 * Exercises the FULL app-side wiring without touching production or Stripe:
 *   CTA event → in-app Plans modal → "Upgrade" → real billing IPC → main
 *   process → /api/v2/billing/checkout (a LOCAL stub) → hosted child window →
 *   completion → modal status + plan refresh.
 *
 * Safe by construction:
 *   - The platform API base is pointed at a localhost stub (TEX64_PLATFORM_API_BASE_URL),
 *     so no request reaches tex64.com.
 *   - The main renderer does not load remote Stripe.js. checkout.stripe.com is
 *     fulfilled by Playwright, so no request reaches Stripe and no real card
 *     form is created.
 *     (The real Stripe card form needs test keys + a deployed backend and is
 *     therefore out of scope here — that is the ONLY part of the flow this test
 *     does not cover.)
 *   - A "free" platform session is pre-seeded so the upsell/upgrade buttons render.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/billing-flow.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");

const closeElectronApp = async (app) => {
  if (!app) return;
  const child = typeof app.process === "function" ? app.process() : null;
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) {
    child.kill("SIGKILL");
  }
};

const startStubServer = () =>
  new Promise((resolve) => {
    const calls = [];
    let activePlan = "free";
    let featureDelayMs = 0;
    let featureResponses = 0;
    const periodStart = "2026-08-01T00:00:00.000Z";
    const periodEnd = "2026-09-01T00:00:00.000Z";
    const quotaForPlan = () => {
      const limitTokens =
        activePlan === "pro" ? 10_000_000 : activePlan === "basic" ? 2_000_000 : 200_000;
      const usedTokens = activePlan === "free" ? 1000 : 2000;
      return {
        limitTokens,
        usedTokens,
        remainingTokens: limitTokens - usedTokens,
        usedRequests: 2,
        remainingRequests: 998,
        periodStart,
        periodEnd,
      };
    };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url || "";
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = {};
        }
        calls.push({
          method: req.method,
          url,
          body: parsed,
          auth: req.headers.authorization || "",
        });
        res.setHeader("content-type", "application/json");
        if (url.includes("/billing/checkout")) {
          res.end(
            JSON.stringify({
              requestId: "stub-hosted",
              sessionId: "cs_e2e_hosted_stub",
              checkoutUrl: "https://checkout.stripe.com/c/pay/cs_e2e_hosted_stub",
              capabilities: { configured: true },
            })
          );
        } else if (url.includes("/billing/portal")) {
          res.end(JSON.stringify({ requestId: "stub", portalUrl: "https://stub.local/portal" }));
        } else if (url.includes("/me/features")) {
          const respond = () => {
            featureResponses += 1;
            res.end(JSON.stringify({
              user: {
                id: "e2e-user",
                email: "e2e@example.com",
                name: "E2E User",
                plan: activePlan,
                anonymous: false,
              },
              features: {
                ai: {
                  enabled: true,
                  reason: "active",
                  status: "active",
                  quota: quotaForPlan(),
                  periodStart,
                  periodEnd,
                  graceEndsAt: null,
                },
              },
            }));
          };
          if (featureDelayMs > 0) {
            setTimeout(respond, featureDelayMs);
          } else {
            respond();
          }
        } else if (url.includes("/me/usage/ai")) {
          res.end(
            JSON.stringify({
              plan: activePlan,
              period: "current_month",
              summary: quotaForPlan(),
              byFeature: {},
            })
          );
        } else {
          // Non-critical startup calls (updates manifest, announcements, …).
          res.end(JSON.stringify({}));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        calls,
        baseUrl: `http://127.0.0.1:${server.address().port}/api/v2`,
        setPlan: (plan) => {
          activePlan = plan;
        },
        setFeatureDelay: (delayMs) => {
          featureDelayMs = Math.max(0, Number(delayMs) || 0);
        },
        getFeatureResponseCount: () => featureResponses,
      });
    });
  });

const seedFreeSession = (userDataDir) => {
  const session = {
    accessToken: "e2e-fake-access-token",
    refreshToken: "e2e-fake-refresh-token",
    accessTokenExpiresAt: Date.now() + 3600_000,
    plan: "free",
    user: { id: "e2e-user", email: "e2e@example.com", plan: "free" },
    deviceId: "e2e-device",
  };
  fs.writeFileSync(
    path.join(userDataDir, "tex64-platform-session.json"),
    JSON.stringify({ session, oauthPending: null }, null, 2),
    { mode: 0o600 }
  );
};

const clearOverlays = (page) =>
  page.evaluate(() => {
    document.querySelectorAll(".modal.is-open, #announcement-modal").forEach((m) => {
      m.classList.remove("is-open", "is-visible");
      m.setAttribute("aria-hidden", "true");
      m.style.display = "none";
    });
    document.getElementById("settings-close")?.click();
    for (const id of ["launcher", "ai-login-overlay"]) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove("is-visible", "is-open");
        el.setAttribute("aria-hidden", "true");
        el.style.display = "none";
      }
    }
    document.body.classList.remove("has-launcher");
  });

const planButton = (page, planName) =>
  page.evaluateHandle((name) => {
    const cards = Array.from(document.querySelectorAll("#plans-modal .plan-card"));
    const card = cards.find((c) => (c.querySelector(".plan-card-name")?.textContent || "").trim() === name);
    return card ? card.querySelector(".plan-cta") : null;
  }, planName);

const CHILD_WINDOW_TIMEOUT_MS = 30_000;

const waitForCondition = async (predicate, message, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
};

test("in-app billing flow (hosted Checkout only)", async (t) => {
  const stub = await startStubServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-billing-e2e-"));
  seedFreeSession(userDataDir);

  const { _electron: electron } = require("playwright");
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: userDataDir,
      TEX64_E2E_FORCE_HEADLESS: "1",
      TEX64_E2E_REQUIRE_ENTITLEMENT: "1",
      TEX64_PLATFORM_API_BASE_URL: stub.baseUrl,
      NODE_ENV: "test",
    },
    timeout: 30000,
  });

  const stripeScriptRoutes = [];
  const hostedCheckoutRoutes = [];
  const checkoutReturnRoutes = [];
  await app.context().route("https://js.stripe.com/**", async (route) => {
    stripeScriptRoutes.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });
  await app.context().route("https://checkout.stripe.com/**", async (route) => {
    hostedCheckoutRoutes.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <body>
            <main id="hosted-checkout-stub">
              <p>Local hosted Checkout stub</p>
              <a id="hosted-checkout-success" href="https://tex64.com/account/billing?checkout=success">
                Complete checkout
              </a>
            </main>
          </body>
        </html>`,
    });
  });
  await app
    .context()
    .route(/^https:\/\/(?:www\.)?tex64\.com\/account\/billing(?:[/?#].*)?$/, async (route) => {
      checkoutReturnRoutes.push(route.request().url());
      await route.fulfill({ status: 200, contentType: "text/html", body: "local return stub" });
    });
  await app.context().route("https://stub.local/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "local portal stub" })
  );

  t.after(async () => {
    await closeElectronApp(app);
    stub.server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  const remoteStripeState = await page.evaluate(() => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return {
      scriptCount: document.querySelectorAll('script[src^="https://js.stripe.com"]').length,
      csp: csp?.getAttribute("content") || "",
    };
  });
  assert.equal(stripeScriptRoutes.length, 0, "the main renderer made no Stripe.js request");
  assert.equal(remoteStripeState.scriptCount, 0, "the main renderer has no remote Stripe.js tag");
  assert.equal(
    remoteStripeState.csp.includes("js.stripe.com"),
    false,
    "the main renderer CSP does not allow Stripe.js"
  );
  await clearOverlays(page);

  // 1) The upsell CTA opens the IN-APP Plans modal (never the external browser).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tex64:open-plans")));
  await page.waitForSelector("#plans-modal.is-open .plan-card", { timeout: 8000 });

  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#plans-modal .plan-card")).map((c) => ({
      name: (c.querySelector(".plan-card-name")?.textContent || "").trim(),
      cta: (c.querySelector(".plan-cta")?.textContent || "").trim(),
      current: c.classList.contains("is-current"),
    }))
  );
  assert.equal(cards.length, 3, "three plan cards render");
  const free = cards.find((c) => c.name === "Free");
  const pro = cards.find((c) => c.name === "Pro");
  assert.ok(free?.current, "Free is marked as the current plan (seeded session)");
  assert.equal(pro?.cta, "Start Pro", "Pro shows a Start Pro CTA for a free user");

  // 2) Upgrade → hosted-only API contract → exact allowlisted Stripe URL in a
  //    hardened child window. A rapid double click still creates one session.
  const basicBtn = await planButton(page, "Basic");
  const hostedWindowPromise = app.waitForEvent("window", {
    timeout: CHILD_WINDOW_TIMEOUT_MS,
  });
  await basicBtn.asElement().evaluate((button) => {
    button.click();
    button.click();
  });
  const hostedPage = await hostedWindowPromise;
  await hostedPage.waitForLoadState("domcontentloaded");
  await hostedPage.waitForSelector("#hosted-checkout-stub", { timeout: 8000 });

  assert.notEqual(hostedPage, page, "hosted Checkout opened in a child BrowserWindow");
  assert.equal(hostedCheckoutRoutes.length, 1, "hosted Checkout URL was fulfilled locally once");
  assert.equal(
    hostedCheckoutRoutes[0],
    "https://checkout.stripe.com/c/pay/cs_e2e_hosted_stub",
    "child window loaded the validated Stripe Checkout URL"
  );
  const basicCheckoutCalls = stub.calls.filter(
    (c) => c.url.includes("/billing/checkout") && c.body.plan === "basic"
  );
  assert.equal(
    basicCheckoutCalls.length,
    1,
    "a rapid double click creates only one hosted Checkout session"
  );
  assert.equal(basicCheckoutCalls[0].method, "POST", "checkout is a POST");
  assert.equal(basicCheckoutCalls[0].body.uiMode, "hosted", "checkout explicitly requests hosted mode");
  assert.equal(
    basicCheckoutCalls[0].auth,
    "Bearer e2e-fake-access-token",
    "checkout call carried the bearer token"
  );

  await page.waitForFunction(
    () => {
      const status = (document.getElementById("plans-status")?.textContent || "").trim();
      return status === "Checkout in progress…";
    },
    { timeout: 8000 }
  );
  const hostedState = await page.evaluate(() => ({
    open: document.getElementById("plans-modal").classList.contains("is-open"),
    embeddedSurface: Boolean(document.getElementById("plans-checkout")),
    stripeFactory: typeof window.Stripe,
    status: (document.getElementById("plans-status")?.textContent || "").trim(),
  }));
  assert.ok(hostedState.open, "plans modal stays open while hosted Checkout is active");
  assert.equal(hostedState.embeddedSurface, false, "renderer has no embedded Checkout surface");
  assert.equal(hostedState.stripeFactory, "undefined", "renderer has no window.Stripe dependency");
  assert.equal(hostedState.status, "Checkout in progress…", "hosted Checkout is not shown as an error");

  const hostedClosedPromise = hostedPage.waitForEvent("close", { timeout: 5000 });
  stub.setPlan("basic");
  await hostedPage.evaluate(() => document.getElementById("hosted-checkout-success")?.click());
  await hostedClosedPromise;
  assert.equal(checkoutReturnRoutes.length, 0, "success return was intercepted before production navigation");
  await page.waitForFunction(
    () =>
      (document.getElementById("plans-status")?.textContent || "").trim() ===
      "Payment received — activating your plan…",
    { timeout: 5000 }
  );
  const activationState = await page.evaluate(() => ({
    open: document.getElementById("plans-modal").classList.contains("is-open"),
    status: (document.getElementById("plans-status")?.textContent || "").trim(),
  }));
  assert.ok(activationState.open, "plans modal stays open while the hosted purchase activates");
  assert.ok(
    [
      "Payment received — activating your plan…",
      "Your plan is now active. Enjoy!",
    ].includes(activationState.status),
    "success return stays in activation or advances to the active plan"
  );

  await page.waitForFunction(
    () => {
      const status = (document.getElementById("plans-status")?.textContent || "").trim();
      const basicCard = Array.from(document.querySelectorAll("#plans-modal .plan-card")).find(
        (card) =>
          (card.querySelector(".plan-card-name")?.textContent || "").trim() === "Basic"
      );
      return status === "Your plan is now active. Enjoy!" && basicCard?.classList.contains("is-current");
    },
    { timeout: 10000 }
  );
  assert.ok(
    await page.locator("#plans-modal .plan-card.is-current", { hasText: "Basic" }).count(),
    "webhook-backed refresh marks Basic as the current plan"
  );

  // 3) A portal tier change refreshes both entitlement and usage when the child
  //    closes. Delay the entitlement response past the former 350 ms guess and
  //    require the modal to repaint from the completed native state event.
  const featureCallsBeforePortalClose = stub.calls.filter((c) => c.url.includes("/me/features")).length;
  const usageCallsBeforePortalClose = stub.calls.filter((c) => c.url.includes("/me/usage/ai")).length;
  const featureResponsesBeforePortalClose = stub.getFeatureResponseCount();
  const portalWindowPromise = app.waitForEvent("window", {
    timeout: CHILD_WINDOW_TIMEOUT_MS,
  });
  await page.click("#plans-modal .plans-manage");
  const portalPage = await portalWindowPromise;
  await portalPage.waitForLoadState("domcontentloaded");
  assert.notEqual(portalPage, page, "billing portal opened in a child BrowserWindow");
  const portalCalls = stub.calls.filter((c) => c.url.includes("/billing/portal"));
  assert.equal(portalCalls.length, 1, "exactly one portal request hit the backend");
  assert.equal(portalCalls[0].method, "POST", "portal is a POST");
  assert.equal(portalCalls[0].auth, "Bearer e2e-fake-access-token", "portal call carried the bearer token");

  stub.setPlan("pro");
  stub.setFeatureDelay(900);
  const portalClosedPromise = portalPage.waitForEvent("close", { timeout: 5000 });
  await portalPage.close();
  await portalClosedPromise;
  await waitForCondition(
    () => stub.getFeatureResponseCount() > featureResponsesBeforePortalClose,
    "portal-close entitlement refresh did not complete",
    5000
  );
  await page.waitForFunction(
    () => {
      const proCard = Array.from(document.querySelectorAll("#plans-modal .plan-card")).find(
        (card) => (card.querySelector(".plan-card-name")?.textContent || "").trim() === "Pro"
      );
      return proCard?.classList.contains("is-current");
    },
    { timeout: 750 }
  );
  stub.setFeatureDelay(0);
  await waitForCondition(
    () =>
      stub.calls.filter((c) => c.url.includes("/me/features")).length >
        featureCallsBeforePortalClose &&
      stub.calls.filter((c) => c.url.includes("/me/usage/ai")).length >
        usageCallsBeforePortalClose,
    "portal close did not force entitlement and usage network refreshes"
  );
  assert.ok(
    await page.locator("#plans-modal .plan-card.is-current", { hasText: "Pro" }).count(),
    "portal-close refresh marks Pro as the current plan"
  );

  // 4) Close paths: the close button and Escape both dismiss the modal.
  await page.evaluate(() => {
    if (!document.getElementById("plans-modal").classList.contains("is-open")) {
      window.dispatchEvent(new CustomEvent("tex64:open-plans"));
    }
  });
  await page.waitForSelector("#plans-modal.is-open", { timeout: 5000 });
  await page.click("#plans-modal-close");
  await page.waitForFunction(() => !document.getElementById("plans-modal").classList.contains("is-open"), {
    timeout: 5000,
  });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tex64:open-plans")));
  await page.waitForSelector("#plans-modal.is-open", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("plans-modal").classList.contains("is-open"), {
    timeout: 5000,
  });
  assert.equal(stripeScriptRoutes.length, 0, "no billing path loaded remote Stripe.js");
});
