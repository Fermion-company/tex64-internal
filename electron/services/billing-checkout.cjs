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
    const isBillingPath =
      parsed.pathname === "/account/billing" || parsed.pathname === "/account/billing/";
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

module.exports = {
  getCheckoutReturnOutcome,
  normalizeStripeCheckoutUrl,
};
