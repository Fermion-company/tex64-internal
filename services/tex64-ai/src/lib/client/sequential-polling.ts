export function startSequentialPolling(
  operation: () => Promise<void>,
  intervalMs: number,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error("Polling interval must be a non-negative finite number.");
  }

  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const poll = async (): Promise<void> => {
    try {
      await operation();
    } catch {
      // A transient request failure should not permanently stop live updates.
    } finally {
      if (!stopped) timeout = setTimeout(() => void poll(), intervalMs);
    }
  };

  timeout = setTimeout(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    if (timeout !== null) clearTimeout(timeout);
  };
}
