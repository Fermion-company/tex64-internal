const { MAX_FALLBACK_IMAGE_CANDIDATES } = require("./constants.cjs");
const { clamp } = require("./sampling.cjs");

const isSimpleFormula = (value) => /^[A-Za-z0-9=+\-*/()^_{}]+$/.test(value) && value.length <= 24;

const looksLikeGarbage = (value) => {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length > 300) return true;
  if ((trimmed.match(/\\pi/g) ?? []).length > 8) return true;
  if (trimmed.includes("\\begin{array}")) return true;
  if ((trimmed.match(/[A-Za-z0-9]/g) ?? []).length === 0) return true;
  return false;
};

const countUnbalanced = (text, openChar, closeChar) => {
  let balance = 0;
  let penalty = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openChar) {
      balance += 1;
    } else if (ch === closeChar) {
      if (balance > 0) {
        balance -= 1;
      } else {
        penalty += 1;
      }
    }
  }
  return penalty + balance;
};

const hasMismatchedEnvironments = (value) => {
  if (!value) return false;
  const beginMatches = value.match(/\\begin\{([^}]+)\}/g) ?? [];
  const endMatches = value.match(/\\end\{([^}]+)\}/g) ?? [];
  if (beginMatches.length !== endMatches.length) {
    return true;
  }
  const balance = new Map();
  const beginReg = /\\begin\{([^}]+)\}/g;
  const endReg = /\\end\{([^}]+)\}/g;
  for (const match of value.matchAll(beginReg)) {
    const key = match[1];
    balance.set(key, (balance.get(key) ?? 0) + 1);
  }
  for (const match of value.matchAll(endReg)) {
    const key = match[1];
    balance.set(key, (balance.get(key) ?? 0) - 1);
  }
  for (const count of balance.values()) {
    if (count !== 0) {
      return true;
    }
  }
  return false;
};

const isLikelyInvalidLatex = (value) => {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (looksLikeGarbage(trimmed)) return true;
  if (/\\frac\{[^{}]+\}\{\s*\}/.test(trimmed)) return true;
  if (/\\frac\{\s*\}\{[^{}]+\}/.test(trimmed)) return true;
  if (countUnbalanced(trimmed, "{", "}") > 0) return true;
  if (countUnbalanced(trimmed, "(", ")") > 2) return true;
  const leftCount = (trimmed.match(/\\left/g) ?? []).length;
  const rightCount = (trimmed.match(/\\right/g) ?? []).length;
  if (Math.abs(leftCount - rightCount) > 0) return true;
  if (hasMismatchedEnvironments(trimmed)) return true;
  return false;
};

const scoreLatexCandidate = (value) => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return -1000;
  let score = 100;
  if ((trimmed.match(/[A-Za-z0-9]/g) ?? []).length === 0) score -= 60;
  if (trimmed.length < 2) score -= 40;
  if (trimmed.length > 260) score -= 80;
  if ((trimmed.match(/\\pi/g) ?? []).length > 8) score -= 30;
  if (trimmed.includes("\\begin{array}")) score -= 30;
  if (/\\frac\{[^{}]+\}\{\s*\}/.test(trimmed)) score -= 34;
  if (/\\frac\{\s*\}\{[^{}]+\}/.test(trimmed)) score -= 34;
  if (trimmed.includes("<unk>") || trimmed.includes("�")) score -= 60;
  score -= countUnbalanced(trimmed, "{", "}") * 14;
  score -= countUnbalanced(trimmed, "(", ")") * 8;
  const leftCount = (trimmed.match(/\\left/g) ?? []).length;
  const rightCount = (trimmed.match(/\\right/g) ?? []).length;
  score -= Math.abs(leftCount - rightCount) * 10;
  if (hasMismatchedEnvironments(trimmed)) score -= 18;
  if (/[\\](?:frac|sqrt|sum|int|lim|alpha|beta|gamma|theta|sin|cos|tan)\b/.test(trimmed)) {
    score += 8;
  }
  return score;
};

const normalizeFallbackImageCandidates = (primaryImageDataUrl, extraCandidates) => {
  const seen = new Set();
  const result = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed.startsWith("data:image/")) return;
    if (trimmed.length < 64) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  push(primaryImageDataUrl);
  if (Array.isArray(extraCandidates)) {
    for (const candidate of extraCandidates) {
      push(candidate);
      if (result.length >= MAX_FALLBACK_IMAGE_CANDIDATES) {
        break;
      }
    }
  }
  return result.slice(0, MAX_FALLBACK_IMAGE_CANDIDATES);
};

const scoreFallbackCandidate = (text, confidence) => {
  if (!text) return -1000;
  let score = typeof confidence === "number" ? confidence : 0;
  if (!isSimpleFormula(text)) score -= 35;
  if (text.length > 24) score -= 24;
  if (text.length < 2) score -= 22;
  if (text.includes("=")) score += 7;
  if (text.includes("^")) score += 6;
  if (text.includes("_")) score += 4;
  score += clamp(scoreLatexCandidate(text) * 0.28, -30, 34);
  return score;
};

const decodeImageDataUrl = (value) => {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!match) return null;
  return Buffer.from(match[1], "base64");
};

module.exports = {
  isSimpleFormula,
  looksLikeGarbage,
  isLikelyInvalidLatex,
  scoreLatexCandidate,
  normalizeFallbackImageCandidates,
  scoreFallbackCandidate,
  decodeImageDataUrl,
};

