import type { SettingsUiRuntime } from "./runtime.js";
import type { FeedbackCategory, FeedbackQueueItem } from "./types.js";

export type SettingsFeedbackOps = {
  handlePlatformFeedback: (payload: {
    ok: boolean;
    feedbackId?: string | null;
    error?: { code?: string; message?: string };
  }) => void;
  loadStartupFeedbackState: () => void;
  initFeedbackUi: () => void;
};

export const createSettingsFeedbackOps = (runtime: SettingsUiRuntime): SettingsFeedbackOps => {
  const {
    settingsFeedbackCategory,
    settingsFeedbackMessage,
    settingsFeedbackEmail,
    settingsFeedbackIncludeDiagnostics,
    settingsFeedbackSend,
    settingsFeedbackStatus,
    settingsErrorReportingEnabled,
  } = runtime.context.dom;

  const setFeedbackStatus = (message: string, tone: "neutral" | "success" | "error" = "neutral") => {
    if (!(settingsFeedbackStatus instanceof HTMLElement)) {
      return;
    }
    settingsFeedbackStatus.textContent = message;
    settingsFeedbackStatus.classList.toggle("is-hidden", message.trim().length === 0);
    settingsFeedbackStatus.classList.toggle("is-success", tone === "success");
    settingsFeedbackStatus.classList.toggle("is-error", tone === "error");
  };

  const updateFeedbackSendState = () => {
    if (!(settingsFeedbackSend instanceof HTMLButtonElement)) {
      return;
    }
    settingsFeedbackSend.disabled = runtime.state.feedbackPending;
    settingsFeedbackSend.textContent = runtime.state.feedbackPending ? "送信中..." : "送信";
  };

  const saveFeedbackQueue = () => {
    try {
      localStorage.setItem(runtime.keys.feedbackQueueKey, JSON.stringify(runtime.state.feedbackQueue));
    } catch {
      // ignore storage failures
    }
  };

  const normalizeFeedbackQueueItem = (value: unknown): FeedbackQueueItem | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const record = value as Record<string, unknown>;
    const id =
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const rawCategory =
      typeof record.category === "string" && record.category.trim() ? record.category.trim() : "other";
    const category: FeedbackCategory =
      rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other" || rawCategory === "general"
        ? rawCategory
        : "other";
    const message =
      typeof record.message === "string" && record.message.trim() ? record.message.trim() : "";
    if (!message) {
      return null;
    }
    const contactEmail =
      typeof record.contactEmail === "string" && record.contactEmail.trim()
        ? record.contactEmail.trim()
        : undefined;
    const diagnostics =
      record.diagnostics && typeof record.diagnostics === "object"
        ? (record.diagnostics as Record<string, unknown>)
        : undefined;
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
    const attempts =
      typeof record.attempts === "number" && Number.isFinite(record.attempts) ? Math.max(0, Math.round(record.attempts)) : 0;
    const nextRetryAt =
      typeof record.nextRetryAt === "number" && Number.isFinite(record.nextRetryAt)
        ? Math.max(0, Math.round(record.nextRetryAt))
        : 0;
    return {
      id,
      category,
      message,
      contactEmail,
      diagnostics,
      createdAt,
      attempts,
      nextRetryAt,
    };
  };

  const loadFeedbackQueue = () => {
    const raw = localStorage.getItem(runtime.keys.feedbackQueueKey);
    if (!raw) {
      runtime.state.feedbackQueue = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        runtime.state.feedbackQueue = [];
        return;
      }
      runtime.state.feedbackQueue = parsed
        .map((entry) => normalizeFeedbackQueueItem(entry))
        .filter((entry): entry is FeedbackQueueItem => Boolean(entry));
      saveFeedbackQueue();
    } catch {
      runtime.state.feedbackQueue = [];
    }
  };

  const readFeedbackIncludeDiagnosticsState = () => {
    try {
      const stored = localStorage.getItem(runtime.keys.feedbackIncludeDiagnosticsKey);
      return stored === "true";
    } catch {
      return false;
    }
  };

  const saveFeedbackIncludeDiagnosticsState = () => {
    try {
      localStorage.setItem(
        runtime.keys.feedbackIncludeDiagnosticsKey,
        runtime.state.feedbackIncludeDiagnostics ? "true" : "false"
      );
    } catch {
      // ignore storage failures
    }
  };

  const updateFeedbackIncludeDiagnosticsUi = () => {
    if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
      settingsFeedbackIncludeDiagnostics.checked = runtime.state.feedbackIncludeDiagnostics;
    }
  };

  const readErrorReportingEnabledState = () => {
    try {
      const stored = localStorage.getItem(runtime.keys.errorReportingEnabledKey);
      if (stored === null) {
        return true;
      }
      return stored !== "false";
    } catch {
      return true;
    }
  };

  const saveErrorReportingEnabledState = () => {
    try {
      localStorage.setItem(
        runtime.keys.errorReportingEnabledKey,
        runtime.state.errorReportingEnabled ? "true" : "false"
      );
    } catch {
      // ignore storage failures
    }
  };

  const updateErrorReportingUi = () => {
    if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
      settingsErrorReportingEnabled.checked = runtime.state.errorReportingEnabled;
    }
  };

  const syncErrorReportingEnabled = () => {
    runtime.deps.postToNative(
      {
        type: "error:reporting:set",
        enabled: runtime.state.errorReportingEnabled,
      },
      true
    );
  };

  const buildFeedbackDiagnostics = () => {
    if (!runtime.state.feedbackIncludeDiagnostics) {
      return undefined;
    }
    const diagnostics: Record<string, unknown> = {
      source: "settings-feedback-form",
      sentAt: new Date().toISOString(),
      appUrl: typeof window.location?.href === "string" ? window.location.href : "",
      online: typeof navigator?.onLine === "boolean" ? navigator.onLine : undefined,
      language: typeof navigator?.language === "string" ? navigator.language : undefined,
      userAgent: typeof navigator?.userAgent === "string" ? navigator.userAgent : undefined,
    };
    if (Array.isArray(navigator?.languages) && navigator.languages.length > 0) {
      diagnostics.languages = navigator.languages.slice(0, 8);
    }
    return diagnostics;
  };

  const computeFeedbackRetryDelayMs = (attempts: number) => {
    const safeAttempts = Math.max(1, Math.round(attempts));
    const baseMs = 5000;
    return Math.min(1000 * 60 * 5, baseMs * 2 ** Math.min(7, safeAttempts - 1));
  };

  const scheduleFeedbackFlush = (delayMs = 0) => {
    if (runtime.state.feedbackFlushTimer !== null) {
      window.clearTimeout(runtime.state.feedbackFlushTimer);
      runtime.state.feedbackFlushTimer = null;
    }
    runtime.state.feedbackFlushTimer = window.setTimeout(() => {
      runtime.state.feedbackFlushTimer = null;
      flushFeedbackQueue();
    }, Math.max(0, Math.round(delayMs)));
  };

  const removeFeedbackQueueItem = (itemId: string | null) => {
    if (!itemId) {
      return null;
    }
    const index = runtime.state.feedbackQueue.findIndex((entry) => entry.id === itemId);
    if (index < 0) {
      return null;
    }
    const [removed] = runtime.state.feedbackQueue.splice(index, 1);
    saveFeedbackQueue();
    return removed ?? null;
  };

  const markFeedbackRetry = (item: FeedbackQueueItem, baseMessage?: string) => {
    item.attempts = Math.max(0, item.attempts) + 1;
    const delayMs = computeFeedbackRetryDelayMs(item.attempts);
    item.nextRetryAt = Date.now() + delayMs;
    saveFeedbackQueue();
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    const prefix =
      typeof baseMessage === "string" && baseMessage.trim()
        ? baseMessage.trim()
        : "フィードバック送信に失敗しました。再送します。";
    setFeedbackStatus(`${prefix} (${seconds}秒後に再試行)`, "error");
    scheduleFeedbackFlush(delayMs + 60);
  };

  const flushFeedbackQueue = () => {
    if (runtime.state.feedbackPending) {
      return;
    }
    if (runtime.state.feedbackQueue.length === 0) {
      return;
    }
    const now = Date.now();
    let nextItem: FeedbackQueueItem | null = null;
    for (const entry of runtime.state.feedbackQueue) {
      if (entry.nextRetryAt <= now) {
        nextItem = entry;
        break;
      }
    }
    if (!nextItem) {
      const nextRetryAt = runtime.state.feedbackQueue.reduce((min, entry) => {
        if (!Number.isFinite(entry.nextRetryAt) || entry.nextRetryAt <= 0) {
          return min;
        }
        return Math.min(min, entry.nextRetryAt);
      }, Number.POSITIVE_INFINITY);
      if (Number.isFinite(nextRetryAt)) {
        scheduleFeedbackFlush(Math.max(250, nextRetryAt - now));
      }
      return;
    }
    runtime.state.feedbackPending = true;
    runtime.state.feedbackInFlightId = nextItem.id;
    updateFeedbackSendState();
    setFeedbackStatus("フィードバックを送信しています...");
    const posted = runtime.deps.postToNative(
      {
        type: "feedback:send",
        category: nextItem.category,
        message: nextItem.message,
        contactEmail: nextItem.contactEmail || undefined,
        diagnostics: nextItem.diagnostics || undefined,
      },
      true
    );
    if (!posted) {
      runtime.state.feedbackPending = false;
      runtime.state.feedbackInFlightId = null;
      updateFeedbackSendState();
      markFeedbackRetry(nextItem, "フィードバック送信を開始できませんでした。");
    }
  };

  const sendFeedback = () => {
    if (!(settingsFeedbackMessage instanceof HTMLTextAreaElement)) {
      return;
    }
    const message = settingsFeedbackMessage.value.trim();
    if (!message) {
      setFeedbackStatus("フィードバック内容を入力してください。", "error");
      settingsFeedbackMessage.focus();
      return;
    }
    const rawCategory =
      settingsFeedbackCategory instanceof HTMLSelectElement ? settingsFeedbackCategory.value : "";
    const category: FeedbackCategory =
      rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other" ? rawCategory : "other";
    const contactEmail =
      settingsFeedbackEmail instanceof HTMLInputElement ? settingsFeedbackEmail.value.trim() : "";
    if (contactEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(contactEmail)) {
      setFeedbackStatus("連絡先メールアドレスの形式を確認してください。", "error");
      settingsFeedbackEmail.focus();
      return;
    }
    const item: FeedbackQueueItem = {
      id: `fb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      category,
      message,
      contactEmail: contactEmail || undefined,
      diagnostics: buildFeedbackDiagnostics(),
      createdAt: Date.now(),
      attempts: 0,
      nextRetryAt: 0,
    };
    runtime.state.feedbackQueue.push(item);
    saveFeedbackQueue();
    setFeedbackStatus("送信キューに追加しました。");
    flushFeedbackQueue();
  };

  const handlePlatformFeedback = (payload: {
    ok: boolean;
    feedbackId?: string | null;
    error?: { code?: string; message?: string };
  }) => {
    const inFlightId = runtime.state.feedbackInFlightId;
    const inFlightItem =
      inFlightId !== null
        ? runtime.state.feedbackQueue.find((entry) => entry.id === inFlightId) ?? null
        : null;
    runtime.state.feedbackPending = false;
    runtime.state.feedbackInFlightId = null;
    updateFeedbackSendState();
    if (payload?.ok) {
      const removed = removeFeedbackQueueItem(inFlightId);
      if (
        removed &&
        settingsFeedbackMessage instanceof HTMLTextAreaElement &&
        settingsFeedbackMessage.value.trim() === removed.message
      ) {
        settingsFeedbackMessage.value = "";
      }
      const suffix = payload.feedbackId ? ` (ID: ${payload.feedbackId})` : "";
      const remainCount = runtime.state.feedbackQueue.length;
      const remainLabel = remainCount > 0 ? ` 残り${remainCount}件を再送待ちです。` : "";
      setFeedbackStatus(`フィードバックを送信しました${suffix}${remainLabel}`, "success");
      scheduleFeedbackFlush(40);
      return;
    }
    const message =
      payload?.error?.message && payload.error.message.trim()
        ? payload.error.message.trim()
        : "フィードバック送信に失敗しました。";
    if (inFlightItem) {
      markFeedbackRetry(inFlightItem, `${message} 再送キューに保存しました。`);
      return;
    }
    setFeedbackStatus(message, "error");
  };

  const loadStartupFeedbackState = () => {
    loadFeedbackQueue();
    runtime.state.feedbackIncludeDiagnostics = readFeedbackIncludeDiagnosticsState();
    updateFeedbackIncludeDiagnosticsUi();
    runtime.state.errorReportingEnabled = readErrorReportingEnabledState();
    updateErrorReportingUi();
    syncErrorReportingEnabled();
    if (runtime.state.feedbackQueue.length > 0) {
      scheduleFeedbackFlush(200);
    }
  };

  const initFeedbackUi = () => {
    updateFeedbackSendState();
    setFeedbackStatus("");
    updateFeedbackIncludeDiagnosticsUi();
    updateErrorReportingUi();
  };

  if (settingsFeedbackSend instanceof HTMLButtonElement) {
    settingsFeedbackSend.addEventListener("click", () => {
      sendFeedback();
    });
  }

  if (settingsFeedbackMessage instanceof HTMLTextAreaElement) {
    settingsFeedbackMessage.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendFeedback();
      }
    });
  }

  if (settingsFeedbackIncludeDiagnostics instanceof HTMLInputElement) {
    settingsFeedbackIncludeDiagnostics.addEventListener("change", () => {
      runtime.state.feedbackIncludeDiagnostics = settingsFeedbackIncludeDiagnostics.checked;
      saveFeedbackIncludeDiagnosticsState();
      updateFeedbackIncludeDiagnosticsUi();
    });
  }

  if (settingsErrorReportingEnabled instanceof HTMLInputElement) {
    settingsErrorReportingEnabled.addEventListener("change", () => {
      runtime.state.errorReportingEnabled = settingsErrorReportingEnabled.checked;
      saveErrorReportingEnabledState();
      updateErrorReportingUi();
      syncErrorReportingEnabled();
    });
  }

  window.addEventListener("online", () => {
    scheduleFeedbackFlush(120);
  });

  return {
    handlePlatformFeedback,
    loadStartupFeedbackState,
    initFeedbackUi,
  };
};

