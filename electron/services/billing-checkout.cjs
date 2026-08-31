const normalizeStripeCheckoutUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "checkout.stripe.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
};

const getCheckoutReturnOutcome = (value) => {
  try {
    const parsed = new URL(value);
    const isTex64Host = parsed.hostname === "tex64.com" || parsed.hostname === "www.tex64.com";
    const isBillingPath = [
      "/account/billing",
      "/account/billing/",
      "/checkout/complete",
      "/checkout/complete/",
    ].includes(parsed.pathname);
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !isTex64Host ||
      !isBillingPath
    ) {
      return "";
    }
    const outcome = parsed.searchParams.get("checkout");
    return outcome === "success" || outcome === "cancel" ? outcome : "";
  } catch {
    return "";
  }
};

const parseBillingCompletionDeepLink = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "tex64:" ||
      parsed.hostname !== "billing" ||
      parsed.pathname !== "/complete" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    const entries = Array.from(parsed.searchParams.entries());
    const checkoutValues = parsed.searchParams.getAll("checkout");
    const planValues = parsed.searchParams.getAll("plan");
    if (
      checkoutValues.length !== 1 ||
      planValues.length > 1 ||
      entries.length !== 1 + planValues.length ||
      entries.some(([key]) => key !== "checkout" && key !== "plan")
    ) {
      return null;
    }
    const outcome = checkoutValues[0];
    if (outcome !== "success") {
      return null;
    }
    if (planValues.length === 0) {
      return { outcome };
    }
    const plan = planValues[0];
    return plan === "basic" || plan === "pro" ? { outcome, plan } : null;
  } catch {
    return null;
  }
};

module.exports = {
  getCheckoutReturnOutcome,
  normalizeStripeCheckoutUrl,
  parseBillingCompletionDeepLink,
};
