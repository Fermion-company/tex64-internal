const fs = require("fs");
const path = require("path");

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".tex64",
  "node_modules",
  "Resources",
  "dist",
  "tmp",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizePath = (targetPath) => {
  if (!targetPath || typeof targetPath !== "string") {
    return null;
  }
  const resolved = path.resolve(targetPath);
  try {
    if (fs.realpathSync.native) {
      return fs.realpathSync.native(resolved);
    }
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const pathsEqual = (a, b) => {
  const normA = normalizePath(a);
  const normB = normalizePath(b);
  if (!normA || !normB) {
    return false;
  }
  if (process.platform === "win32") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
};

const isRetryableSynctexError = (error) =>
  typeof error === "string" &&
  (error.includes("位置情報") || error.includes("解析に失敗"));

const getForwardTargetDiff = (forwardResult, expectedLine) => {
  if (!forwardResult || forwardResult.ok !== true || !Number.isFinite(expectedLine)) {
    return Number.POSITIVE_INFINITY;
  }
  if (forwardResult.roundtripSameSourcePath === false) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    forwardResult.roundtripSameSourcePath === true &&
    Number.isFinite(forwardResult.roundtripLine)
  ) {
    return Math.abs(forwardResult.roundtripLine - expectedLine);
  }
  if (forwardResult.sameSourcePath === true && Number.isFinite(forwardResult.matchedLine)) {
    return Math.abs(forwardResult.matchedLine - expectedLine);
  }
  return Number.POSITIVE_INFINITY;
};

const isLowQualityForwardResult = (forwardResult, expectedLine = null) => {
  if (!forwardResult || forwardResult.ok !== true) {
    return false;
  }
  const targetDiff = getForwardTargetDiff(forwardResult, expectedLine);
  if (Number.isFinite(targetDiff)) {
    return targetDiff > 1;
  }
  if (forwardResult.roundtripSameSourcePath === false) {
    return true;
  }
  if (Number.isFinite(forwardResult.roundtripDiff)) {
    return forwardResult.roundtripDiff > 1;
  }
  if (forwardResult.sameSourcePath === false) {
    return true;
  }
  if (Number.isFinite(forwardResult.matchDiff)) {
    return forwardResult.matchDiff > 1;
  }
  return false;
};

const isSkippableLine = (lineText) => {
  if (typeof lineText !== "string") {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.startsWith("%");
};

const findColumn = (lineText) => {
  if (typeof lineText !== "string" || lineText.length === 0) {
    return 1;
  }
  const index = lineText.search(/\S/);
  return index >= 0 ? index + 1 : 1;
};

module.exports = {
  DEFAULT_IGNORED_DIRS,
  sleep,
  normalizePath,
  pathsEqual,
  isRetryableSynctexError,
  getForwardTargetDiff,
  isLowQualityForwardResult,
  isSkippableLine,
  findColumn,
};

