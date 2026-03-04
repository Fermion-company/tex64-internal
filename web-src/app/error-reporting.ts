import type { PostToNative } from "./bridge-sender.js";

const MAX_ERROR_REPORT_MESSAGE = 2000;
const ERROR_REPORT_DEDUPE_WINDOW_MS = 30_000;
const ERROR_REPORTING_ENABLED_KEY = "tex64.errorReporting.enabled.v1";

const clampErrorReportText = (value: unknown, maxLength = MAX_ERROR_REPORT_MESSAGE) => {
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

const buildUnhandledRejectionMessage = (reason: unknown) => {
  if (reason instanceof Error) {
    return {
      message: clampErrorReportText(reason.message),
      stack: clampErrorReportText(reason.stack ?? "", 16_000),
    };
  }
  if (typeof reason === "string") {
    return {
      message: clampErrorReportText(reason),
      stack: "",
    };
  }
  if (reason && typeof reason === "object") {
    const maybeMessage =
      typeof (reason as { message?: unknown }).message === "string"
        ? (reason as { message: string }).message
        : "";
    const maybeStack =
      typeof (reason as { stack?: unknown }).stack === "string"
        ? (reason as { stack: string }).stack
        : "";
    if (maybeMessage.trim()) {
      return {
        message: clampErrorReportText(maybeMessage),
        stack: clampErrorReportText(maybeStack, 16_000),
      };
    }
    try {
      return {
        message: clampErrorReportText(JSON.stringify(reason)),
        stack: "",
      };
    } catch {
      return { message: "Unhandled promise rejection", stack: "" };
    }
  }
  return { message: "Unhandled promise rejection", stack: "" };
};

export const readErrorReportingEnabledFromStorage = () => {
  try {
    const stored = localStorage.getItem(ERROR_REPORTING_ENABLED_KEY);
    if (stored === null) {
      return true;
    }
    return stored !== "false";
  } catch {
    return true;
  }
};

export const initGlobalErrorReporting = (
  postToNative: PostToNative,
  isEnabled: () => boolean = () => true
) => {
  const sentMap = new Map<string, number>();

  const report = (payload: {
    kind: string;
    message: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
  }) => {
    const message = clampErrorReportText(payload.message);
    if (!message) {
      return;
    }
    if (!isEnabled()) {
      return;
    }
    const stack = clampErrorReportText(payload.stack ?? "", 16_000);
    const source = clampErrorReportText(payload.source ?? "", 256);
    const url =
      typeof window.location?.href === "string"
        ? clampErrorReportText(window.location.href, 2000)
        : "";
    const fingerprint = [
      payload.kind,
      message,
      stack ? stack.slice(0, 240) : "",
      source,
      String(payload.line ?? 0),
      String(payload.column ?? 0),
    ].join("|");
    const now = Date.now();
    const previous = sentMap.get(fingerprint);
    if (typeof previous === "number" && now - previous < ERROR_REPORT_DEDUPE_WINDOW_MS) {
      return;
    }
    sentMap.set(fingerprint, now);
    if (sentMap.size > 200) {
      for (const [key, timestamp] of sentMap.entries()) {
        if (now - timestamp > ERROR_REPORT_DEDUPE_WINDOW_MS) {
          sentMap.delete(key);
        }
        if (sentMap.size <= 120) {
          break;
        }
      }
    }
    postToNative(
      {
        type: "error:report",
        report: {
          kind: payload.kind,
          message,
          stack: stack || undefined,
          source: source || undefined,
          line:
            typeof payload.line === "number" && Number.isFinite(payload.line)
              ? Math.max(0, Math.round(payload.line))
              : undefined,
          column:
            typeof payload.column === "number" && Number.isFinite(payload.column)
              ? Math.max(0, Math.round(payload.column))
              : undefined,
          url: url || undefined,
          userAgent:
            typeof navigator?.userAgent === "string"
              ? clampErrorReportText(navigator.userAgent, 2000)
              : undefined,
        },
      },
      true
    );
  };

  window.addEventListener("error", (event) => {
    const error = event.error;
    const message =
      error instanceof Error
        ? clampErrorReportText(error.message)
        : clampErrorReportText(event.message);
    if (!message) {
      return;
    }
    report({
      kind: "window_error",
      message,
      stack: error instanceof Error ? error.stack ?? "" : "",
      source: typeof event.filename === "string" ? event.filename : "",
      line:
        typeof event.lineno === "number" && Number.isFinite(event.lineno)
          ? event.lineno
          : undefined,
      column:
        typeof event.colno === "number" && Number.isFinite(event.colno)
          ? event.colno
          : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const payload = buildUnhandledRejectionMessage(event.reason);
    report({
      kind: "unhandled_rejection",
      message: payload.message,
      stack: payload.stack,
    });
  });
};
