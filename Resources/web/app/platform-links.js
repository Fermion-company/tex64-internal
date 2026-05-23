export const TEX64_WEB_BASE_URL = "https://tex64.com";
// tex64.com serves these path prefixes in every UI language under /{locale}
// (de, es, fr, ja, ko, zh). Everything else (e.g. /pricing, /releases,
// /feedback) exists only at the root and is served in English.
const LOCALIZED_PREFIXES = ["/terms", "/privacy", "/legal", "/download", "/docs"];
const isLocalizablePath = (path) => LOCALIZED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
// Build an absolute tex64.com URL, routing to the localized variant when the
// site has one for the given locale; otherwise the root (English) path.
export const tex64Url = (path, locale = "en") => {
    const clean = path.startsWith("/") ? path : `/${path}`;
    const localePrefix = locale && locale !== "en" && isLocalizablePath(clean) ? `/${locale}` : "";
    return `${TEX64_WEB_BASE_URL}${localePrefix}${clean}`;
};
export const TEX64_LINKS = {
    pricing: tex64Url("/pricing"),
    download: tex64Url("/download"),
    docsTexDistribution: tex64Url("/docs/tex-distribution"),
};
