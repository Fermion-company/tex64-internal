const fetch = require("node-fetch");
const net = require("net");

const DEFAULT_WEB_TIMEOUT_MS = 12_000;
const MAX_WEB_TIMEOUT_MS = 25_000;
const DEFAULT_WEB_LIMIT = 5;
const MAX_WEB_LIMIT = 10;

const DEFAULT_READ_URL_TIMEOUT_MS = 15_000;
const MAX_READ_URL_TIMEOUT_MS = 30_000;
const DEFAULT_READ_URL_MAX_CHARS = 24_000;
const MAX_READ_URL_MAX_CHARS = 200_000;
const DEFAULT_READ_URL_MAX_BYTES = 1_200_000;
const MAX_READ_URL_MAX_BYTES = 4_000_000;

const clampNumber = (value, fallback, { min, max }) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const decodeHtml = (value) =>
  String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const stripTags = (value) => String(value || "").replace(/<[^>]*>/g, " ");

const normalizeUrl = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }
    // Avoid leaking embedded credentials.
    if (parsed.username || parsed.password) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
};

const parseIpv4 = (value) => {
  const parts = String(value || "")
    .trim()
    .split(".")
    .map((entry) => Number.parseInt(entry, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
};

const isPrivateIpv4 = (value) => {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
};

const isPrivateIpv6 = (value) => {
  const host = String(value || "").trim().toLowerCase();
  if (!host) return false;
  if (host === "::1") return true;
  if (host.startsWith("fe80:")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local
  if (host === "::") return true;
  return false;
};

const isBlockedHostname = (hostname) => {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return isPrivateIpv4(host);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(host);
  }
  return false;
};

const normalizePublicUrl = (value) => {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (isBlockedHostname(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
};

const extractTitleFromHtml = (html) => {
  const source = typeof html === "string" ? html : "";
  if (!source) return "";
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  if (!match) return "";
  const raw = decodeHtml(stripTags(match[1] || ""));
  return raw.replace(/\s+/g, " ").trim();
};

const htmlToText = (html) => {
  const source = typeof html === "string" ? html : "";
  if (!source) return "";
  const withoutScripts = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  const withNewlines = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<\/h\d\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<\/tr\s*>/gi, "\n");
  const stripped = decodeHtml(stripTags(withNewlines));
  return stripped
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

const readResponseTextWithLimit = async (response, maxBytes, controller) => {
  const limit = clampNumber(maxBytes, DEFAULT_READ_URL_MAX_BYTES, {
    min: 8_000,
    max: MAX_READ_URL_MAX_BYTES,
  });
  if (!response?.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    const truncated = bytes > limit;
    return { text: truncated ? text.slice(0, Math.max(0, limit)) : text, bytes, truncated };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buffer.length > limit) {
      const remaining = Math.max(0, limit - total);
      if (remaining > 0) {
        chunks.push(buffer.slice(0, remaining));
        total += remaining;
      }
      truncated = true;
      controller?.abort?.();
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { text, bytes: total, truncated };
};

const parseDuckDuckGoResults = (html, limit) => {
  const source = typeof html === "string" ? html : "";
  if (!source) {
    return [];
  }
  const results = [];
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern =
    /<(?:a|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/i;
  let match = null;
  while ((match = linkPattern.exec(source)) !== null) {
    if (results.length >= limit) {
      break;
    }
    const rawHref = decodeHtml(match[1] || "");
    const title = decodeHtml(stripTags(match[2] || "")).replace(/\s+/g, " ").trim();
    const href = normalizeUrl(rawHref);
    if (!href || !title) {
      continue;
    }
    let snippet = "";
    try {
      const tail = source.slice(linkPattern.lastIndex, linkPattern.lastIndex + 1500);
      const snippetMatch = snippetPattern.exec(tail);
      if (snippetMatch) {
        snippet = decodeHtml(stripTags(snippetMatch[1] || "")).replace(/\s+/g, " ").trim();
      }
    } catch {
      snippet = "";
    }
    results.push({ title, url: href, snippet });
  }
  return results;
};

const handleSearchWeb = async (_service, args) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { error: "query が空です。" };
  }
  const limit = clampNumber(args?.limit, DEFAULT_WEB_LIMIT, { min: 1, max: MAX_WEB_LIMIT });
  const timeoutMs = clampNumber(args?.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, {
    min: 1000,
    max: MAX_WEB_TIMEOUT_MS,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "TeX64-Agent/1.0",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      return { error: `web search failed: ${response.status}` };
    }
    const html = await response.text();
    const results = parseDuckDuckGoResults(html, limit);
    if (results.length === 0) {
      return {
        query,
        results: [],
        warning: "検索結果を解析できませんでした。",
      };
    }
    return { query, results };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { error: "web search timed out" };
    }
    return { error: error?.message ?? "web search failed" };
  } finally {
    clearTimeout(timeout);
  }
};

const handleReadUrl = async (_service, args) => {
  const urlRaw = typeof args?.url === "string" ? args.url.trim() : "";
  if (!urlRaw) {
    return { error: "url が空です。" };
  }
  const url = normalizePublicUrl(urlRaw);
  if (!url) {
    return { error: "url が不正か、取得できないホストです。" };
  }
  const timeoutMs = clampNumber(args?.timeoutMs, DEFAULT_READ_URL_TIMEOUT_MS, {
    min: 1000,
    max: MAX_READ_URL_TIMEOUT_MS,
  });
  const maxChars = clampNumber(args?.maxChars, DEFAULT_READ_URL_MAX_CHARS, {
    min: 500,
    max: MAX_READ_URL_MAX_CHARS,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "TeX64-Agent/1.0",
        accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      return { error: `read_url failed: HTTP ${response.status}` };
    }
    if (contentType && !/^text\/|application\/xhtml\+xml/i.test(contentType)) {
      return { error: `unsupported content-type: ${contentType}` };
    }
    const body = await readResponseTextWithLimit(response, DEFAULT_READ_URL_MAX_BYTES, controller);
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || /<html/i.test(body.text);
    const title = isHtml ? extractTitleFromHtml(body.text) : "";
    const text = isHtml ? htmlToText(body.text) : String(body.text || "").trim();
    const truncatedChars = text.length > maxChars;
    const clippedText = truncatedChars ? text.slice(0, maxChars) : text;
    return {
      url,
      finalUrl: typeof response.url === "string" ? response.url : url,
      status: response.status,
      contentType: contentType || null,
      title: title || null,
      text: clippedText,
      truncated: body.truncated || truncatedChars,
      bytes: body.bytes,
      chars: clippedText.length,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { error: "read_url timed out" };
    }
    return { error: error?.message ?? "read_url failed" };
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {
  handleSearchWeb,
  handleReadUrl,
  // Export helpers for unit tests (no I/O).
  __internal: {
    normalizeUrl,
    normalizePublicUrl,
    isBlockedHostname,
    htmlToText,
  },
};
