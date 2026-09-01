"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

// The AI mode embeds the standalone tex64-ai web app (services/tex64-ai) so the
// same codebase serves both the public web deployment and the native app.
// Resolution order for the embed URL:
//   1. user settings `aiWeb.url` (tex64-user-settings.json)
//   2. env TEX64_AI_WEB_URL
//   3. packaged builds: the hosted deployment; dev: the local Next dev server.
// next dev binds localhost; using the same name keeps the app's Origin
// header aligned with the server's own origin for mutation requests.
const DEFAULT_DEV_URL = "http://localhost:3100";
const DEFAULT_HOSTED_URL = "https://ai.tex64.com";
const LOCAL_APP_DIR = path.join("services", "tex64-ai");

const isHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

class AiWebService {
  constructor({ app, ensureUserSettings }) {
    this.app = app;
    this.ensureUserSettings = ensureUserSettings;
  }

  async resolveUrl() {
    const settings = await this.ensureUserSettings()
      .load()
      .catch(() => null);
    const configured = settings?.aiWeb?.url;
    if (isHttpUrl(configured)) return configured.trim();
    if (isHttpUrl(process.env.TEX64_AI_WEB_URL)) {
      return process.env.TEX64_AI_WEB_URL.trim();
    }
    return this.app.isPackaged ? DEFAULT_HOSTED_URL : DEFAULT_DEV_URL;
  }

  // Absolute repo path of the local tex64-ai checkout when running from
  // source; packaged builds return null (the checkout is not shipped).
  resolveLocalAppDir() {
    if (this.app.isPackaged) return null;
    return path.join(this.app.getAppPath(), LOCAL_APP_DIR);
  }

  async getConfig() {
    const url = await this.resolveUrl();
    return {
      ok: true,
      url,
      preloadFileUrl: pathToFileURL(
        path.join(__dirname, "..", "ai-web-preload.cjs")
      ).toString(),
      packaged: this.app.isPackaged === true,
      localAppDir: this.resolveLocalAppDir(),
    };
  }
}

module.exports = { AiWebService, DEFAULT_DEV_URL, DEFAULT_HOSTED_URL, isHttpUrl };
