const SCRIPT_SELECTOR = "script[data-vercel-analytics]";
export function installVercelAnalytics() {
    if (window.location.protocol !== "https:")
        return;
    if (document.querySelector(SCRIPT_SELECTOR))
        return;
    const script = document.createElement("script");
    script.defer = true;
    script.src = "/_vercel/insights/script.js";
    script.dataset.vercelAnalytics = "true";
    document.head.append(script);
}
