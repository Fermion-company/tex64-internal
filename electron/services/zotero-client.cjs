"use strict";

/**
 * Zotero as a citation source, over whichever door is open:
 *
 *   1. Better BibTeX JSON-RPC  http://127.0.0.1:23119/better-bibtex/json-rpc
 *      (stable citekeys, item.search / item.export / user.groups)
 *   2. Zotero 7 local API      http://127.0.0.1:23119/api/users/0/…
 *      (needs "Allow other applications on this computer to communicate
 *      with Zotero"; also lists and serves group libraries)
 *   3. Zotero Web API          https://api.zotero.org (user API key)
 *
 * Library ids are strings the renderer can store: `bbt:<libraryID>` for the
 * first transport, `users:<id>` / `groups:<id>` for the other two. Every
 * failure is reported as { ok: false, code } so the UI can say which door
 * is closed; nothing here throws for an unreachable server.
 */

const LOCAL_BASE = "http://127.0.0.1:23119";
const WEB_BASE = "https://api.zotero.org";
const LOCAL_TIMEOUT_MS = 4000;
const WEB_TIMEOUT_MS = 15000;
const SEARCH_LIMIT = 25;
const PROBE_TTL_MS = 5000;
const NON_CITABLE_TYPES = new Set(["attachment", "note", "annotation"]);

const failure = (code, status) => ({ ok: false, code, ...(status ? { status } : {}) });

const timedFetch = async (fetchImpl, url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const classify = (error) => {
  if (error?.name === "AbortError") return "timeout";
  const code = error?.cause?.code || error?.code || "";
  if (["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "unreachable";
  return "unreachable";
};

const yearOf = (value) => {
  const match = String(value || "").match(/\b(\d{4})\b/);
  return match ? match[1] : "";
};

const creatorLabel = (creators) => {
  if (!Array.isArray(creators) || creators.length === 0) return "";
  const preferred =
    creators.find((creator) => !creator?.creatorType || creator.creatorType === "author") || creators[0];
  if (!preferred) return "";
  if (typeof preferred.lastName === "string" && preferred.lastName) return preferred.lastName;
  if (typeof preferred.family === "string" && preferred.family) return preferred.family;
  if (typeof preferred.name === "string" && preferred.name) return preferred.name;
  if (typeof preferred.literal === "string" && preferred.literal) return preferred.literal;
  return "";
};

const cslYear = (issued) => {
  const parts = issued?.["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0][0]) return String(parts[0][0]);
  return yearOf(issued?.raw || issued?.literal || "");
};

const parseLibraryId = (library) => {
  const match = String(library || "").match(/^(users|groups|bbt):(\d+)$/);
  return match ? { kind: match[1], id: match[2] } : null;
};

const createZoteroClient = ({ getApiKey, fetchImpl = globalThis.fetch, localBase = LOCAL_BASE, webBase = WEB_BASE } = {}) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for the Zotero client.");
  let probeCache = null;

  // ---- Better BibTeX -------------------------------------------------------

  let rpcId = 0;
  const bbtCall = async (method, params = []) => {
    try {
      const response = await timedFetch(
        fetchImpl,
        `${localBase}/better-bibtex/json-rpc`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: (rpcId += 1) }),
        },
        LOCAL_TIMEOUT_MS
      );
      if (!response.ok) return failure(`http-${response.status}`, response.status);
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") return failure("bad-response");
      if (payload.error) return { ok: false, code: "rpc-error", message: payload.error.message || String(payload.error) };
      return { ok: true, result: payload.result };
    } catch (error) {
      return failure(classify(error));
    }
  };

  const bbtLibraries = async () => {
    const groups = await bbtCall("user.groups");
    if (!groups.ok) return groups;
    const list = Array.isArray(groups.result) ? groups.result : [];
    const libraries = [];
    const seen = new Set();
    const push = (id, name, kind) => {
      const key = `bbt:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      libraries.push({ id: key, kind, name });
    };
    push(1, "My Library", "user");
    for (const group of list) {
      const id = Number(group?.id ?? group?.libraryID);
      if (!Number.isFinite(id)) continue;
      push(id, String(group?.name || `Group ${id}`), id === 1 ? "user" : "group");
    }
    return { ok: true, libraries };
  };

  const bbtItem = (raw, libraryName) => {
    const citekey = raw?.citationKey || raw?.citekey || raw?.citeKey || "";
    const libraryId = Number(raw?.libraryID ?? raw?.libraryId ?? 1);
    const creators = Array.isArray(raw?.creators) ? raw.creators : Array.isArray(raw?.author) ? raw.author : [];
    return {
      transport: "bbt",
      key: typeof raw?.key === "string" ? raw.key : "",
      citekey,
      title: String(raw?.title || "").trim(),
      creator: creatorLabel(creators),
      year: yearOf(raw?.date) || cslYear(raw?.issued),
      library: `bbt:${Number.isFinite(libraryId) ? libraryId : 1}`,
      libraryName: libraryName || "",
      itemType: raw?.itemType || raw?.type || "",
    };
  };

  const bbtSearch = async ({ query, library, libraryName }) => {
    const parsed = parseLibraryId(library);
    const libraryID = parsed?.kind === "bbt" ? Number(parsed.id) : undefined;
    const response = await bbtCall("item.search", libraryID ? [query, libraryID] : [query]);
    if (!response.ok) return response;
    const items = (Array.isArray(response.result) ? response.result : [])
      .map((raw) => bbtItem(raw, libraryName))
      .filter((item) => item.citekey && !NON_CITABLE_TYPES.has(item.itemType))
      .filter((item) => !libraryID || item.library === `bbt:${libraryID}`)
      .slice(0, SEARCH_LIMIT);
    return { ok: true, items };
  };

  const bbtExport = async (citekeys, library) => {
    const parsed = parseLibraryId(library);
    const params = [citekeys, "Better BibTeX"];
    if (parsed?.kind === "bbt") params.push(Number(parsed.id));
    const response = await bbtCall("item.export", params);
    if (!response.ok) return response;
    const result = response.result;
    const body = typeof result === "string" ? result : Array.isArray(result) ? String(result[2] ?? result[0] ?? "") : "";
    if (!body.trim()) return failure("not-found");
    return { ok: true, bibtex: body };
  };

  // ---- Zotero API (local and web share the shape) --------------------------

  const apiRequest = async (base, pathname, { apiKey, accept = "application/json", timeoutMs }) => {
    try {
      const headers = { Accept: accept, "Zotero-API-Version": "3" };
      if (apiKey) headers["Zotero-API-Key"] = apiKey;
      const response = await timedFetch(fetchImpl, `${base}${pathname}`, { headers }, timeoutMs);
      if (!response.ok) {
        if (response.status === 403 || response.status === 401) return failure("forbidden", response.status);
        if (response.status === 404) return failure("not-found", 404);
        return failure(`http-${response.status}`, response.status);
      }
      return { ok: true, response };
    } catch (error) {
      return failure(classify(error));
    }
  };

  const apiJson = async (base, pathname, options) => {
    const result = await apiRequest(base, pathname, options);
    if (!result.ok) return result;
    const json = await result.response.json().catch(() => null);
    return json === null ? failure("bad-response") : { ok: true, json };
  };

  const apiText = async (base, pathname, options) => {
    const result = await apiRequest(base, pathname, { ...options, accept: "text/plain, */*" });
    if (!result.ok) return result;
    return { ok: true, text: await result.response.text() };
  };

  const apiItem = (raw, transport, fallbackLibrary, libraryName) => {
    const data = raw?.data && typeof raw.data === "object" ? raw.data : raw || {};
    const libraryType = raw?.library?.type === "group" ? "groups" : "users";
    const library = raw?.library?.id !== undefined ? `${libraryType}:${raw.library.id}` : fallbackLibrary;
    const extra = typeof data.extra === "string" ? data.extra : "";
    const extraKey = extra.match(/^\s*Citation Key:\s*(\S+)/mi);
    return {
      transport,
      key: String(raw?.key || data.key || ""),
      citekey: String(data.citationKey || (extraKey ? extraKey[1] : "")),
      title: String(data.title || "").trim(),
      creator: creatorLabel(data.creators),
      year: yearOf(data.date),
      library,
      libraryName: raw?.library?.name || libraryName || "",
      itemType: data.itemType || "",
    };
  };

  const apiLibraryPath = (library, userId) => {
    const parsed = parseLibraryId(library);
    if (!parsed || parsed.kind === "bbt") return `/users/${userId}`;
    if (parsed.kind === "groups") return `/groups/${parsed.id}`;
    return `/users/${userId}`;
  };

  const apiSearch = async ({ base, apiKey, timeoutMs, transport, query, library, userId, libraryName }) => {
    const prefix = apiLibraryPath(library, userId);
    const params = new URLSearchParams({
      q: query,
      qmode: "titleCreatorYear",
      limit: String(SEARCH_LIMIT),
      format: "json",
      itemType: "-attachment || note || annotation",
    });
    const result = await apiJson(base, `${prefix}/items?${params.toString()}`, { apiKey, timeoutMs });
    if (!result.ok) return result;
    const fallbackLibrary = prefix.startsWith("/groups/") ? `groups:${prefix.split("/")[2]}` : `users:${userId}`;
    const items = (Array.isArray(result.json) ? result.json : [])
      .map((raw) => apiItem(raw, transport, fallbackLibrary, libraryName))
      .filter((item) => item.key && !NON_CITABLE_TYPES.has(item.itemType));
    return { ok: true, items };
  };

  const apiBibtex = async ({ base, apiKey, timeoutMs, library, key, userId }) => {
    const prefix = apiLibraryPath(library, userId);
    const result = await apiText(base, `${prefix}/items/${encodeURIComponent(key)}?format=bibtex`, { apiKey, timeoutMs });
    if (!result.ok) return result;
    if (!result.text.trim()) return failure("not-found");
    return { ok: true, bibtex: result.text };
  };

  const apiGroups = async ({ base, apiKey, timeoutMs, userId, userName }) => {
    const result = await apiJson(base, `/users/${userId}/groups?format=json`, { apiKey, timeoutMs });
    const libraries = [{ id: `users:${userId}`, kind: "user", name: userName || "My Library" }];
    if (result.ok && Array.isArray(result.json)) {
      for (const group of result.json) {
        const id = group?.id ?? group?.data?.id;
        if (id === undefined || id === null) continue;
        libraries.push({ id: `groups:${id}`, kind: "group", name: String(group?.data?.name || group?.name || `Group ${id}`) });
      }
    }
    return { ok: true, libraries };
  };

  const localContext = () => ({ base: `${localBase}/api`, apiKey: "", timeoutMs: LOCAL_TIMEOUT_MS, transport: "local", userId: "0" });

  const webContext = (probe) => ({
    base: webBase,
    apiKey: getApiKey?.() || "",
    timeoutMs: WEB_TIMEOUT_MS,
    transport: "web",
    userId: String(probe?.web?.userId || ""),
  });

  // ---- Probing and transport choice ----------------------------------------

  const probeLocal = async () => {
    const result = await apiRequest(`${localBase}/api`, "/users/0/items?limit=1&format=json", { timeoutMs: LOCAL_TIMEOUT_MS });
    if (!result.ok) return result;
    result.response.body?.cancel?.();
    return { ok: true };
  };

  const probeWeb = async () => {
    const apiKey = getApiKey?.() || "";
    if (!apiKey) return failure("no-key");
    const result = await apiJson(webBase, "/keys/current", { apiKey, timeoutMs: WEB_TIMEOUT_MS });
    if (!result.ok) return result;
    const userId = result.json?.userID;
    if (userId === undefined || userId === null) return failure("bad-response");
    return { ok: true, userId: String(userId), username: String(result.json?.username || "") };
  };

  const probe = async ({ force = false } = {}) => {
    if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;
    const bbt = await bbtCall("user.groups");
    const local = await probeLocal();
    const web = await probeWeb();
    const value = {
      bbt: bbt.ok ? { ok: true } : bbt,
      local: local.ok ? { ok: true } : local,
      web,
      transport: bbt.ok ? "bbt" : local.ok ? "local" : web.ok ? "web" : null,
    };
    probeCache = { at: Date.now(), value };
    return value;
  };

  const libraries = async (status) => {
    const current = status || (await probe());
    if (current.transport === "bbt") return bbtLibraries();
    if (current.transport === "local") return apiGroups({ ...localContext(), userName: "My Library" });
    if (current.transport === "web") return apiGroups({ ...webContext(current), userName: current.web.username });
    return failure("no-transport");
  };

  const libraryName = async (status, library) => {
    const list = await libraries(status);
    if (!list.ok) return "";
    return list.libraries.find((entry) => entry.id === library)?.name || "";
  };

  const search = async ({ query, library }) => {
    const status = await probe();
    const term = String(query || "").trim();
    if (!status.transport) return failure("no-transport");
    if (!term) return { ok: true, transport: status.transport, items: [] };
    const name = await libraryName(status, library);
    if (status.transport === "bbt") {
      const result = await bbtSearch({ query: term, library, libraryName: name });
      return result.ok ? { ...result, transport: "bbt" } : result;
    }
    const context = status.transport === "local" ? localContext() : webContext(status);
    const result = await apiSearch({ ...context, query: term, library, libraryName: name });
    return result.ok ? { ...result, transport: status.transport } : result;
  };

  /** BibTeX for one search result, keyed the way the library keys it. */
  const bibtexFor = async (item) => {
    const status = await probe();
    if (!status.transport) return failure("no-transport");
    if (item?.transport === "bbt" || status.transport === "bbt") {
      if (!item?.citekey) return failure("not-found");
      const result = await bbtExport([item.citekey], item.library);
      return result.ok ? { ok: true, bibtex: result.bibtex, zoteroRef: null } : result;
    }
    const context = status.transport === "local" ? localContext() : webContext(status);
    const result = await apiBibtex({ ...context, library: item.library, key: item.key });
    return result.ok ? { ok: true, bibtex: result.bibtex, zoteroRef: `${item.library}/${item.key}` } : result;
  };

  /**
   * Fresh BibTeX for existing .bib entries: by citekey through Better BibTeX,
   * else by the `% zotero: <library>/<key>` note. Returns the entries found.
   */
  const refresh = async (entries, library) => {
    const status = await probe();
    if (!status.transport) return failure("no-transport");
    const found = [];
    let notFound = 0;
    let skipped = 0;
    if (status.transport === "bbt") {
      for (const entry of entries) {
        const result = await bbtExport([entry.key], library);
        if (result.ok) found.push({ key: entry.key, bibtex: result.bibtex });
        else if (result.code === "not-found" || result.code === "rpc-error") notFound += 1;
        else return result;
      }
      return { ok: true, transport: "bbt", found, notFound, skipped };
    }
    const context = status.transport === "local" ? localContext() : webContext(status);
    for (const entry of entries) {
      const ref = String(entry.zoteroRef || "").match(/^((?:users|groups):\d+)\/([A-Za-z0-9]+)$/);
      if (!ref) {
        skipped += 1;
        continue;
      }
      const result = await apiBibtex({ ...context, library: ref[1], key: ref[2] });
      if (result.ok) found.push({ key: entry.key, bibtex: result.bibtex });
      else if (result.code === "not-found") notFound += 1;
      else return result;
    }
    return { ok: true, transport: status.transport, found, notFound, skipped };
  };

  return { probe, libraries, search, bibtexFor, refresh };
};

module.exports = { createZoteroClient, parseLibraryId, LOCAL_BASE, WEB_BASE };
