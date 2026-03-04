const {
  PRODUCTION_PLATFORM_API_BASE_URL,
  PRODUCTION_PLATFORM_WEB_BASE_URL,
  PRODUCTION_PLATFORM_OAUTH_REDIRECT_URI,
  sanitizeBaseUrl,
  PlatformApiError,
} = require("./platform-access-shared.cjs");
const { coreMethods } = require("./platform-access-core-methods.cjs");
const { aiMethods } = require("./platform-access-ai-methods.cjs");
const { featureMethods } = require("./platform-access-feature-methods.cjs");

class PlatformAccessService {
  constructor(options = {}) {
    this.strictProduction = options.strictProduction === true;
    this.filePath = require("path").join(
      options.userDataPath || ".",
      "tex64-platform-session.json"
    );
    this.state = null;
    this.apiBaseUrl = sanitizeBaseUrl(
      this.strictProduction
        ? PRODUCTION_PLATFORM_API_BASE_URL
        : options.apiBaseUrl ||
            process.env.TEX64_PLATFORM_API_BASE_URL ||
            PRODUCTION_PLATFORM_API_BASE_URL,
      PRODUCTION_PLATFORM_API_BASE_URL
    );
    this.webBaseUrl = sanitizeBaseUrl(
      this.strictProduction
        ? PRODUCTION_PLATFORM_WEB_BASE_URL
        : options.webBaseUrl ||
            process.env.TEX64_PLATFORM_WEB_BASE_URL ||
            PRODUCTION_PLATFORM_WEB_BASE_URL,
      PRODUCTION_PLATFORM_WEB_BASE_URL
    );
    this.redirectUri = this.strictProduction
      ? PRODUCTION_PLATFORM_OAUTH_REDIRECT_URI
      : options.redirectUri ||
        process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI ||
        PRODUCTION_PLATFORM_OAUTH_REDIRECT_URI;
    this.allowDirectOAuthCallbackAuthUrl =
      options.allowDirectOAuthCallbackAuthUrl === true && !this.strictProduction;
    const legacyProxyFallback = this.strictProduction
      ? ""
      : "https://tex64.vercel.app/api/ai-chat";
    this.legacyProxyUrl = this.strictProduction
      ? ""
      : sanitizeBaseUrl(
          options.legacyProxyUrl ||
            process.env.TEX64_AI_PROXY_URL ||
            legacyProxyFallback,
          legacyProxyFallback
        );
    this.encryptString =
      typeof options.encryptString === "function" ? options.encryptString : null;
    this.decryptString =
      typeof options.decryptString === "function" ? options.decryptString : null;
    this.isEncryptionAvailable =
      typeof options.isEncryptionAvailable === "function"
        ? options.isEncryptionAvailable
        : null;
    const requestedBypass =
      options.bypassEntitlement === true ||
      process.env.TEX64_AI_BYPASS_ENTITLEMENT === "1" ||
      process.env.TEX64_E2E_HEADLESS === "1" ||
      (typeof process.env.TEX64_E2E_USERDATA === "string" &&
        process.env.TEX64_E2E_USERDATA.trim().length > 0);
    this.bypassEntitlement = this.strictProduction ? false : requestedBypass;
  }
}

Object.assign(
  PlatformAccessService.prototype,
  coreMethods,
  aiMethods,
  featureMethods
);

module.exports = {
  PlatformAccessService,
  PlatformApiError,
};
