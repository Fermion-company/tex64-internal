"use strict";

const DEFAULT_QUIT_FLUSH_TIMEOUT_MS = 2_500;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 1_000;

/**
 * Abort an active turn and flush debounced session state, but never keep the
 * Electron quit lifecycle open indefinitely. Returns false only when the hard
 * deadline wins; a late write remains observed by Promise.race and cannot
 * become an unhandled rejection.
 */
const flushAgentSessionsForQuit = async (
  agentService,
  {
    timeoutMs = DEFAULT_QUIT_FLUSH_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  } = {},
) => {
  agentService?.abort?.();
  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
  });
  const flush = (async () => {
    if (typeof agentService?.waitForIdle === "function") {
      await agentService.waitForIdle(Math.max(1, idleTimeoutMs)).catch(() => false);
    }
    if (typeof agentService?.flushPendingSessions === "function") {
      await agentService.flushPendingSessions();
    }
    return true;
  })();
  try {
    return await Promise.race([flush, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
};

module.exports = {
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_QUIT_FLUSH_TIMEOUT_MS,
  flushAgentSessionsForQuit,
};
