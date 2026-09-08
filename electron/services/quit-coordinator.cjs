"use strict";

const DEFAULT_QUIT_PREPARE_TIMEOUT_MS = 15_000;
const DEFAULT_QUIT_FORCE_EXIT_TIMEOUT_MS = 1_000;

const PREPARE_TIMEOUT_CODE = "renderer-prepare-timeout";
const PREPARE_FAILED_CODE = "renderer-prepare-failed";

const isExplicitFailure = (value) =>
  value === false ||
  (value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "ok") &&
    value.ok !== true);

/**
 * Coordinate Electron's re-entrant quit lifecycle without importing Electron.
 *
 * The first before-quit event is stopped while the live renderer saves dirty
 * buffers and the agent drains. A renderer-save failure is deliberately
 * fail-closed: the application remains open so another quit attempt can retry.
 * Once both stages finish, the graceful app.quit() retry is issued on the next
 * event-loop turn. A watchdog is armed only for that final retry.
 */
const createQuitCoordinator = ({
  prepareRenderer = async () => true,
  flushAgent = async () => true,
  teardown = () => {},
  requestQuit = () => {},
  forceExit = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  scheduleImmediate = setImmediate,
  prepareTimeoutMs = DEFAULT_QUIT_PREPARE_TIMEOUT_MS,
  forceExitTimeoutMs = DEFAULT_QUIT_FORCE_EXIT_TIMEOUT_MS,
  onError = () => {},
  onPhaseChange = () => {},
} = {}) => {
  let phase = "idle";
  let attemptId = 0;
  let pendingAttempt = null;
  let prepareTimer = null;
  let forceExitTimer = null;
  let finalQuitScheduled = false;
  let teardownComplete = false;

  const reportError = (error, stage) => {
    try {
      onError(error, stage);
    } catch {
      // Diagnostics must never become another quit blocker.
    }
  };

  const transition = (nextPhase) => {
    if (phase === nextPhase) return;
    const previousPhase = phase;
    phase = nextPhase;
    try {
      onPhaseChange(nextPhase, previousPhase);
    } catch {
      // Observability hooks must not change lifecycle behavior.
    }
  };

  const clearPrepareTimer = () => {
    if (prepareTimer === null) return;
    clearTimer(prepareTimer);
    prepareTimer = null;
  };

  const clearForceExitTimer = () => {
    if (forceExitTimer === null) return;
    clearTimer(forceExitTimer);
    forceExitTimer = null;
  };

  const runTeardownOnce = () => {
    if (teardownComplete) return;
    teardownComplete = true;
    try {
      teardown();
    } catch (error) {
      // The caller should isolate failures between individual services. Keep
      // the final quit live even if the aggregate callback still throws.
      reportError(error, "teardown");
    }
  };

  const armForceExitWatchdog = () => {
    if (forceExitTimer !== null || phase === "forced") return;
    forceExitTimer = setTimer(() => {
      forceExitTimer = null;
      if (phase === "forced") return;
      transition("forced");
      try {
        forceExit(0);
      } catch (error) {
        reportError(error, "force-exit");
      }
    }, Math.max(1, Number(forceExitTimeoutMs) || 1));
    forceExitTimer?.unref?.();
  };

  const scheduleFinalQuit = () => {
    if (finalQuitScheduled || phase === "forced") return;
    finalQuitScheduled = true;
    transition("relaunching");
    runTeardownOnce();
    armForceExitWatchdog();
    scheduleImmediate(() => {
      try {
        requestQuit();
      } catch (error) {
        // The armed watchdog remains the terminal fallback.
        reportError(error, "request-quit");
      }
    });
  };

  const prepareRendererWithDeadline = async () => {
    const preparation = Promise.resolve().then(() => prepareRenderer());
    if (prepareTimeoutMs === null || prepareTimeoutMs === false) {
      const result = await preparation;
      if (isExplicitFailure(result)) {
        const error = new Error("The renderer could not save its dirty state for quit.");
        error.code = PREPARE_FAILED_CODE;
        throw error;
      }
      return true;
    }

    const milliseconds = Math.max(1, Number(prepareTimeoutMs) || 1);
    const timeout = new Promise((_, reject) => {
      prepareTimer = setTimer(() => {
        prepareTimer = null;
        const error = new Error("Timed out while saving renderer state for quit.");
        error.code = PREPARE_TIMEOUT_CODE;
        reject(error);
      }, milliseconds);
    });
    try {
      const result = await Promise.race([preparation, timeout]);
      if (isExplicitFailure(result)) {
        const error = new Error("The renderer could not save its dirty state for quit.");
        error.code = PREPARE_FAILED_CODE;
        throw error;
      }
      return true;
    } finally {
      clearPrepareTimer();
    }
  };

  const startAttempt = () => {
    const currentAttemptId = ++attemptId;
    transition("flushing");
    const attempt = (async () => {
      try {
        await prepareRendererWithDeadline();
      } catch (error) {
        reportError(error, "prepare-renderer");
        if (attemptId === currentAttemptId && phase === "flushing") {
          transition("idle");
        }
        return { ok: false, stage: "prepare-renderer" };
      }

      try {
        await flushAgent();
      } catch (error) {
        // Agent persistence already has its own hard deadline. Unlike dirty
        // renderer buffers, an agent flush failure must not trap the process.
        reportError(error, "flush-agent");
      }

      if (attemptId === currentAttemptId && phase === "flushing") {
        scheduleFinalQuit();
      }
      return { ok: true };
    })();
    pendingAttempt = attempt.finally(() => {
      if (pendingAttempt === attempt || attemptId === currentAttemptId) {
        pendingAttempt = null;
      }
    });
    return pendingAttempt;
  };

  const handleBeforeQuit = (event) => {
    if (phase === "relaunching") {
      transition("exiting");
      return null;
    }
    if (phase === "exiting" || phase === "forced") {
      return null;
    }

    event?.preventDefault?.();
    if (phase === "flushing") {
      return pendingAttempt;
    }
    return startAttempt();
  };

  const handleWillQuit = () => {
    clearForceExitTimer();
    if (phase !== "forced") transition("exiting");
  };

  const handleQuit = () => {
    clearPrepareTimer();
    clearForceExitTimer();
    if (phase !== "forced") transition("exiting");
  };

  return {
    getPhase: () => phase,
    handleBeforeQuit,
    handleQuit,
    handleWillQuit,
  };
};

module.exports = {
  DEFAULT_QUIT_FORCE_EXIT_TIMEOUT_MS,
  DEFAULT_QUIT_PREPARE_TIMEOUT_MS,
  PREPARE_FAILED_CODE,
  PREPARE_TIMEOUT_CODE,
  createQuitCoordinator,
};
