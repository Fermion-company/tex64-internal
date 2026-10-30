"use strict";

// IPC "tex64:zotero": search a Zotero library, append the BibTeX of a chosen
// item to the project's .bib, and refresh existing entries. The Web API key
// lives only in the main process (safeStorage ciphertext in user settings).

const { createZoteroClient } = require("../services/zotero-client.cjs");
const {
  resolveBibTarget,
  appendEntry,
  replaceEntries,
  parseBibEntries,
  extractBibKey,
  renameBibKey,
} = require("../services/bib-append.cjs");

const MAX_SYNC_ENTRIES = 300;

const registerZoteroHandlers = ({ ipcMain, workspace, state, safeStorage, ensureUserSettings, afterBibWrite }) => {
  let apiKey = "";
  let apiKeyLoaded = false;

  const canEncrypt = () => Boolean(safeStorage && safeStorage.isEncryptionAvailable());

  const loadApiKey = async () => {
    if (apiKeyLoaded) return apiKey;
    apiKeyLoaded = true;
    const settings = await ensureUserSettings().getZoteroSettings();
    if (settings.apiKeyEncrypted && canEncrypt()) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(settings.apiKeyEncrypted, "base64"));
      } catch {
        apiKey = "";
      }
    }
    return apiKey;
  };

  const client = createZoteroClient({ getApiKey: () => apiKey });

  const mainFileFor = async (payload) => {
    const info = await workspace.rootInfo().catch(() => null);
    if (info && typeof info.path === "string" && info.path.toLowerCase().endsWith(".tex")) return info.path;
    const active = typeof payload?.activeFilePath === "string" ? payload.activeFilePath : "";
    if (active.toLowerCase().endsWith(".tex")) return active;
    throw Object.assign(new Error("No main document."), { code: "NO_MAIN_FILE" });
  };

  const status = async ({ force = false } = {}) => {
    await loadApiKey();
    const settings = await ensureUserSettings().getZoteroSettings();
    const probe = await client.probe({ force });
    const list = probe.transport ? await client.libraries(probe) : { ok: false, code: "no-transport" };
    const libraries = list.ok ? list.libraries : [];
    const library = libraries.some((entry) => entry.id === settings.library)
      ? settings.library
      : libraries[0]?.id || "";
    return {
      transport: probe.transport,
      probe: { bbt: probe.bbt, local: probe.local, web: probe.web },
      libraries,
      library,
      hasApiKey: Boolean(apiKey),
      encryptionAvailable: canEncrypt(),
    };
  };

  const effectiveLibrary = async () => (await status()).library;

  const actions = {
    // Opening the dialog or the settings page always knocks again: Zotero
    // may have been started or closed since the last call.
    status: () => status({ force: true }),

    settings: async (payload) => {
      await loadApiKey();
      const patch = {};
      if (typeof payload?.apiKey === "string") {
        const trimmed = payload.apiKey.trim();
        if (trimmed && !canEncrypt()) {
          throw Object.assign(new Error("Secure storage is unavailable."), { code: "NO_SAFE_STORAGE" });
        }
        apiKey = trimmed;
        patch.apiKeyEncrypted = trimmed ? safeStorage.encryptString(trimmed).toString("base64") : "";
      }
      if (typeof payload?.library === "string") patch.library = payload.library;
      await ensureUserSettings().updateZoteroSettings(patch);
      return status({ force: Object.prototype.hasOwnProperty.call(patch, "apiKeyEncrypted") });
    },

    search: async (payload) => {
      const library = await effectiveLibrary();
      const result = await client.search({ query: payload?.query, library });
      if (!result.ok) throw Object.assign(new Error("Zotero search failed."), { code: result.code, detail: result.message });
      return { transport: result.transport, library, items: result.items };
    },

    cite: async (payload) => {
      const item = payload?.item;
      if (!item || typeof item !== "object") throw new Error("No item.");
      const mainFile = await mainFileFor(payload);
      const fetched = await client.bibtexFor(item);
      if (!fetched.ok) throw Object.assign(new Error("Zotero export failed."), { code: fetched.code });
      const bibtex = String(fetched.bibtex).trim();
      const key = extractBibKey(bibtex);
      if (!key) throw Object.assign(new Error("No BibTeX entry."), { code: "NO_BIBTEX" });
      const target = await resolveBibTarget({ workspace, mainFile });
      const result = await appendEntry({ workspace, bibPath: target.relativePath, bibtex, zoteroRef: fetched.zoteroRef });
      if (result.appended) await afterBibWrite?.().catch(() => {});
      return { key, bibPath: target.relativePath, named: target.named, created: result.created, appended: result.appended };
    },

    sync: async (payload) => {
      const mainFile = await mainFileFor(payload);
      const target = await resolveBibTarget({ workspace, mainFile });
      if (!target.exists) return { bibPath: target.relativePath, total: 0, updated: 0, unchanged: 0, notFound: 0, skipped: 0 };
      const content = await workspace.readFile(target.relativePath);
      const entries = parseBibEntries(content).slice(0, MAX_SYNC_ENTRIES);
      const library = await effectiveLibrary();
      const refreshed = await client.refresh(entries, library);
      if (!refreshed.ok) throw Object.assign(new Error("Zotero sync failed."), { code: refreshed.code });
      const fresh = new Map();
      for (const found of refreshed.found) {
        const body = String(found.bibtex).trim();
        if (extractBibKey(body)) fresh.set(found.key, renameBibKey(body, found.key));
      }
      const replaced = await replaceEntries({ workspace, bibPath: target.relativePath, fresh });
      if (replaced.updated > 0) await afterBibWrite?.().catch(() => {});
      return {
        bibPath: target.relativePath,
        total: entries.length,
        updated: replaced.updated,
        unchanged: replaced.unchanged,
        notFound: refreshed.notFound,
        skipped: refreshed.skipped,
      };
    },
  };

  ipcMain.handle("tex64:zotero", async (event, action, payload = {}) => {
    if (event.sender !== state.mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, code: "INVALID_OWNER", error: "Invalid Zotero owner." };
    }
    try {
      if (typeof action !== "string" || !actions[action]) throw new Error("Unknown Zotero action.");
      if (payload && JSON.stringify(payload).length > 1024 * 1024) throw new Error("Zotero request is too large.");
      const result = await actions[action](payload || {});
      return { ok: true, ...(result || {}) };
    } catch (error) {
      return { ok: false, code: error?.code || "ZOTERO_ERROR", error: error?.message || String(error) };
    }
  });
};

module.exports = { registerZoteroHandlers };
