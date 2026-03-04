const fetch = require("node-fetch");

const DEFAULT_WEB_TIMEOUT_MS = 12_000;
const MAX_WEB_TIMEOUT_MS = 25_000;
const DEFAULT_WEB_LIMIT = 5;
const MAX_WEB_LIMIT = 10;

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
    return parsed.toString();
  } catch {
    return "";
  }
};

const parseDuckDuckGoResults = (html, limit) => {
  const source = typeof html === "string" ? html : "";
  if (!source) {
    return [];
  }
  const results = [];
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
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
    results.push({ title, url: href, snippet: "" });
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

module.exports = {
  handleSearchWeb,
};
