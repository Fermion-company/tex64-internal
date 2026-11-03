"use strict";

// IPC "tex64:zotero": search a Zotero library, append the BibTeX of a chosen
// item to the project's .bib, and refresh existing entries. The Web API key
// lives only in the main process (safeStorage ciphertext in user settings).

const { createZoteroClient } = require("../services/zotero-client.cjs");
const {
  resolveBibTarget,
  resolveCitationDocument,
  createWorkspaceGuard,
  appendEntry,
  replaceEntries,
  parseBibEntries,
  extractBibKey,
  renameBibKey,
} = require("../services/bib-append.cjs");

const MAX_SYNC_ENTRIES = 300;

const registerZoteroHandlers = ({
  ipcMain,
  workspace,
  state,
  safeStorage,
  ensureUserSettings,
  afterBibWrite,
  withWorkspaceMutation,
  createClient = createZoteroClient,
}) => {
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

  const client = createClient({ getApiKey: () => apiKey });
  const guard = createWorkspaceGuard({ workspace, state, withWorkspaceMutation });

  // The .bib of the document the active file belongs to (as Build decides
  // it), or of the document the renderer names for that file.
  const bibTargetFor = async (payload) => {
    const text = (value) => (typeof value === "string" ? value : "");
    const mainFile = await resolveCitationDocument(
      workspace,
      { documentMainFile: text(payload?.documentMainFile), activeFilePath: text(payload?.activeFilePath) },
      async (candidate) => (await resolveBibTarget({ workspace, mainFile: candidate })).relativePath
    );
    return resolveBibTarget({ workspace, mainFile });
  };

  // The chosen library is remembered by id, kind and name, so it survives a
  // change of door (Better BibTeX ids differ from Zotero's). When the new
  // door cannot see it, the personal library is used and the UI says so.
  const resolveLibrary = (libraries, chosen) => {
    if (!libraries.length) return { library: "", notice: null };
    const wanted = chosen && typeof chosen === "object" ? chosen : { id: "", name: "", kind: "" };
    const byId = libraries.find((entry) => entry.id === wanted.id);
    if (byId) return { library: byId.id, notice: null };
    const byName = wanted.name && libraries.find((entry) => entry.kind === wanted.kind && entry.name === wanted.name);
    if (byName) return { library: byName.id, notice: null };
    const fallback = libraries.find((entry) => entry.kind === "user") || libraries[0];
    return { library: fallback.id, notice: wanted.id && wanted.kind === "group" ? { missingLibrary: wanted.name || wanted.id } : null };
  };

  const status = async ({ force = false } = {}) => {
    await loadApiKey();
    const settings = await ensureUserSettings().getZoteroSettings();
    const probe = await client.probe({ force });
    const list = probe.transport ? await client.libraries(probe) : { ok: false, code: "no-transport" };
    const libraries = list.ok ? list.libraries : [];
    const chosen = { id: settings.library, name: settings.libraryName, kind: settings.libraryKind };
    const resolved = resolveLibrary(libraries, chosen);
    return {
      transport: probe.transport,
      probe: { bbt: probe.bbt, local: probe.local, web: probe.web },
      libraries,
      library: resolved.library,
      missingLibrary: resolved.notice?.missingLibrary || "",
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
      if (typeof payload?.library === "string") {
        const current = await status();
        const picked = current.libraries.find((entry) => entry.id === payload.library);
        patch.library = payload.library;
        patch.libraryName = picked?.name || "";
        patch.libraryKind = picked?.kind || "";
      }
      await ensureUserSettings().updateZoteroSettings(patch);
      return status({ force: Object.prototype.hasOwnProperty.call(patch, "apiKeyEncrypted") });
    },

    search: async (payload) => {
      const library = await effectiveLibrary();
      const result = await client.search({ query: payload?.query, library });
      if (!result.ok) throw Object.assign(new Error("Zotero search failed."), { code: result.code, detail: result.message });
      return { transport: result.transport, library, items: result.items };
    },

    // The target is decided before Zotero is asked; the append runs only if
    // the same workspace session is still open when the answer arrives.
    cite: async (payload) => {
      const item = payload?.item;
      if (!item || typeof item !== "object") throw new Error("No item.");
      const session = guard.capture();
      const target = await bibTargetFor(payload);
      const fetched = await client.bibtexFor(item);
      if (!fetched.ok) throw Object.assign(new Error("Zotero export failed."), { code: fetched.code });
      const exported = String(fetched.bibtex).trim();
      if (!extractBibKey(exported)) throw Object.assign(new Error("No BibTeX entry."), { code: "NO_BIBTEX" });
      const bibtex = renameBibKey(exported, fetched.key);
      const result = await guard.commit(session, () =>
        appendEntry({ workspace, bibPath: target.relativePath, bibtex, zoteroRef: fetched.zoteroRef })
      );
      if (result.appended) await afterBibWrite?.().catch(() => {});
      return {
        key: result.key,
        bibPath: target.relativePath,
        named: target.named,
        style: target.style,
        created: result.created,
        appended: result.appended,
      };
    },

    sync: async (payload) => {
      const session = guard.capture();
      const target = await bibTargetFor(payload);
      if (!target.exists) return { bibPath: target.relativePath, total: 0, updated: 0, unchanged: 0, notFound: 0 };
      const content = await workspace.readFile(target.relativePath);
      guard.assertCurrent(session);
      const entries = parseBibEntries(content).slice(0, MAX_SYNC_ENTRIES);
      const library = await effectiveLibrary();
      const refreshed = await client.refresh(entries, library);
      if (!refreshed.ok) throw Object.assign(new Error("Zotero sync failed."), { code: refreshed.code });
      const fresh = new Map();
      for (const found of refreshed.found) {
        const body = String(found.bibtex).trim();
        if (extractBibKey(body)) fresh.set(found.key, renameBibKey(body, found.key));
      }
      const replaced = await guard.commit(session, () => replaceEntries({ workspace, bibPath: target.relativePath, fresh }));
      if (replaced.updated > 0) await afterBibWrite?.().catch(() => {});
      return {
        bibPath: target.relativePath,
        total: entries.length,
        updated: replaced.updated,
        unchanged: replaced.unchanged,
        notFound: refreshed.notFound,
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
