import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { initBillingUi } from "../Resources/web/app/billing-ui.js";
import { initBridgeHandlers } from "../Resources/web/app/bridge-handlers.js";

test("closing hosted Checkout clears the in-app progress state", () => {
  const previousWindow = globalThis.window;
  const status = { textContent: "Checkout in progress…" };
  let usageRefreshes = 0;
  globalThis.window = {
    tex64Billing: {
      checkout: async () => ({ hosted: true }),
      openPortal: async () => ({ ok: true }),
    },
    addEventListener: () => {},
    clearInterval: () => {},
    setInterval: () => 1,
    setTimeout: () => 1,
  };

  try {
    const billing = initBillingUi(
      {
        dom: {
          plansModal: null,
          plansModalClose: null,
          plansHeading: null,
          plansSub: null,
          plansList: null,
          plansStatus: status,
        },
      },
      {
        getCurrentPlan: () => "free",
        onPlanRefresh: () => {},
        refreshUsage: () => {
          usageRefreshes += 1;
        },
      },
    );

    billing.handleCheckoutClosed({ plan: "basic", outcome: "closed" });
    assert.equal(status.textContent, "");
    assert.equal(usageRefreshes, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("AI Plans hides the native webview and restores it with focus on cancel", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLButtonElement = globalThis.HTMLButtonElement;

  let documentRef = null;
  class FakeClassList {
    values = new Set();
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
  }
  class FakeElement {
    constructor() {
      this.attributes = new Map();
      this.children = [];
      this.classList = new FakeClassList();
      this.hidden = false;
      this.isConnected = true;
      this.textContent = "";
    }
    addEventListener() {}
    appendChild(child) { this.children.push(child); }
    contains(target) {
      return target === this || this.children.some((child) => child.contains?.(target));
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { documentRef.activeElement = this; }
    blur() {
      if (documentRef.activeElement === this) documentRef.activeElement = null;
    }
  }
  class FakeButton extends FakeElement {
    disabled = false;
  }

  const modal = new FakeElement();
  modal.setAttribute("aria-hidden", "true");
  const closeButton = new FakeButton();
  const nativeHost = new FakeElement();
  const webview = new FakeElement();
  nativeHost.appendChild(webview);
  const aiTab = new FakeButton();
  aiTab.classList.add("is-active");
  documentRef = {
    activeElement: webview,
    documentElement: { dataset: { appMode: "ai" } },
    getElementById: (id) => id === "ai-mode-webview-host" ? nativeHost : null,
    querySelector: () => aiTab,
  };
  globalThis.document = documentRef;
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLButtonElement = FakeButton;
  globalThis.window = {
    tex64Billing: {
      checkout: async () => ({ hosted: true }),
      openPortal: async () => ({ ok: true }),
    },
    addEventListener: () => {},
    clearInterval: () => {},
    setInterval: () => 1,
    setTimeout: () => 1,
  };

  try {
    const billing = initBillingUi(
      {
        dom: {
          plansModal: modal,
          plansModalClose: closeButton,
          plansHeading: null,
          plansSub: null,
          plansList: null,
          plansStatus: new FakeElement(),
        },
      },
      {
        getCurrentPlan: () => "free",
        onPlanRefresh: () => {},
        refreshUsage: () => {},
      },
    );

    billing.open();
    assert.equal(modal.classList.contains("is-open"), true);
    assert.equal(modal.getAttribute("aria-hidden"), "false");
    assert.equal(nativeHost.hidden, true);
    assert.equal(nativeHost.hasAttribute("inert"), true);
    assert.equal(nativeHost.getAttribute("aria-hidden"), "true");
    assert.equal(documentRef.activeElement, closeButton);

    billing.handleCheckoutClosed({ plan: "basic", outcome: "cancel" });
    assert.equal(modal.classList.contains("is-open"), false);
    assert.equal(modal.getAttribute("aria-hidden"), "true");
    assert.equal(nativeHost.hidden, false);
    assert.equal(nativeHost.hasAttribute("inert"), false);
    assert.equal(nativeHost.hasAttribute("aria-hidden"), false);
    assert.equal(documentRef.activeElement, webview);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLButtonElement = previousHTMLButtonElement;
  }
});

test("the normal host bridge routes Checkout close to billing UI", () => {
  let receive = null;
  let payload = null;
  const bridgeWindow = {
    tex64Bridge: {
      onMessage: (handler) => {
        receive = handler;
      },
    },
  };

  initBridgeHandlers({
    bridgeWindow,
    build: {},
    search: {},
    editorSession: {},
    billing: {
      handleCheckoutClosed: (value) => {
        payload = value;
      },
    },
  });
  assert.equal(typeof receive, "function");
  receive({
    type: "billing:checkoutClosed",
    payload: { plan: "basic", outcome: "cancel" },
  });
  assert.deepEqual(payload, { plan: "basic", outcome: "cancel" });
});

test("a locked Pro model carries its Pro intent into the in-app plans modal", async () => {
  const [nativeControls, nativePlatform, aiMode, mainInit, billingUi] =
    await Promise.all([
      fs.readFile(
        new URL(
          "../services/tex64-ai/src/components/native-platform-controls.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      fs.readFile(
        new URL(
          "../services/tex64-ai/src/lib/client/use-native-platform.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      fs.readFile(new URL("../web-src/app/ai-mode-ui.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../web-src/main-init.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../web-src/app/billing-ui.ts", import.meta.url), "utf8"),
    ]);

  assert.match(nativeControls, /platform\.openPlans\("pro"\)/);
  assert.match(nativePlatform, /send\("billing:open-plans",/);
  assert.match(aiMode, /request\.plan === "basic" \|\| request\.plan === "pro"/);
  assert.match(mainInit, /new CustomEvent\("tex64:open-plans",/);
  assert.match(billingUi, /plan\.key === preferred/);
  assert.match(billingUi, /classList\.add\("is-targeted"\)/);
});

test("main reports child-window closure over the normal renderer bus", async () => {
  const [source, theme] = await Promise.all([
    fs.readFile(new URL("../electron/main.cjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../Resources/web/theme.css", import.meta.url), "utf8"),
  ]);
  assert.match(
    source,
    /sendToRenderer\("billing:checkoutClosed", \{ plan, outcome \}\)/,
  );
  assert.doesNotMatch(source, /tex64:billing:checkout-closed/);
  assert.match(
    theme,
    /\.ai-mode-webview-host\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s,
  );
});
