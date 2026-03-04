const DEFAULT_DEDUP_WINDOW_MS = 30_000;
const DEFAULT_DEDUP_LIMIT = 200;

const clampMainErrorText = (value, maxLength = 4000) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
};

const toMainErrorMessage = (value) => {
  if (value instanceof Error) {
    const message = clampMainErrorText(value.message);
    if (message) {
      return message;
    }
  }
  if (typeof value === "string") {
    return clampMainErrorText(value);
  }
  if (value == null) {
    return "Unknown error";
  }
  try {
    return clampMainErrorText(JSON.stringify(value));
  } catch {
    return clampMainErrorText(String(value));
  }
};

const toMainErrorStack = (value) => {
  if (value instanceof Error) {
    const stack = clampMainErrorText(value.stack, 16000);
    if (stack) {
      return stack;
    }
  }
  return null;
};

const createMainErrorReporter = ({
  isEnabled = () => true,
  sendReport,
  dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS,
  dedupLimit = DEFAULT_DEDUP_LIMIT,
}) => {
  const fingerprintMap = new Map();

  const shouldReport = (fingerprint) => {
    const now = Date.now();
    for (const [key, at] of fingerprintMap) {
      if (!Number.isFinite(at) || now - at > dedupWindowMs) {
        fingerprintMap.delete(key);
      }
    }
    if (!fingerprint) {
      return true;
    }
    const seenAt = fingerprintMap.get(fingerprint);
    if (Number.isFinite(seenAt) && now - seenAt <= dedupWindowMs) {
      return false;
    }
    fingerprintMap.set(fingerprint, now);
    if (fingerprintMap.size > dedupLimit) {
      const first = fingerprintMap.keys().next();
      if (first && !first.done) {
        fingerprintMap.delete(first.value);
      }
    }
    return true;
  };

  const report = (kind, value, diagnostics = {}) => {
    if (!isEnabled()) {
      return;
    }
    const message = toMainErrorMessage(value);
    if (!message) {
      return;
    }
    const stack = toMainErrorStack(value);
    const fingerprint = `${kind}::${message}::${stack || ""}`;
    if (!shouldReport(fingerprint)) {
      return;
    }
    Promise.resolve(
      sendReport({
        kind,
        source: "app-main",
        message,
        stack: stack || undefined,
        diagnostics,
      })
    ).catch(() => {});
  };

  return {
    report,
  };
};

module.exports = {
  createMainErrorReporter,
};
