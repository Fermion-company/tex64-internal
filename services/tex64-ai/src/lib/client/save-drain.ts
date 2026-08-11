export async function drainPendingSaves<Pending>(input: {
  flushScheduled: () => Promise<boolean | undefined>;
  currentInFlight: () => Promise<boolean> | null;
  clearInFlight: (completed: Promise<boolean>) => void;
  currentPending: () => Pending | null;
  cancelScheduled: () => void;
  persist: (pending: Pending) => Promise<boolean>;
}): Promise<boolean> {
  const scheduled = await input.flushScheduled();
  if (scheduled === false) return false;

  for (;;) {
    let inFlight = input.currentInFlight();
    while (inFlight) {
      if (!(await inFlight)) return false;
      input.clearInFlight(inFlight);
      inFlight = input.currentInFlight();
    }

    const pending = input.currentPending();
    if (!pending) return true;
    input.cancelScheduled();
    if (!(await input.persist(pending))) return false;
  }
}
