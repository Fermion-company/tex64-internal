import { describe, expect, it } from "vitest";
import { drainPendingSaves } from "@/lib/client/save-drain";

describe("save drain", () => {
  it("does not finish navigation until edits created during a save are persisted", async () => {
    let pending: { version: number } | null = { version: 1 };
    const persisted: number[] = [];

    const result = await drainPendingSaves({
      flushScheduled: async () => undefined,
      currentInFlight: () => null,
      clearInFlight: () => undefined,
      currentPending: () => pending,
      cancelScheduled: () => undefined,
      persist: async (save) => {
        persisted.push(save.version);
        if (save.version === 1) {
          pending = { version: 2 };
        } else {
          pending = null;
        }
        return true;
      },
    });

    expect(result).toBe(true);
    expect(persisted).toEqual([1, 2]);
  });

  it("blocks navigation and keeps pending work when a retry fails", async () => {
    const pending = { version: 1 };

    const result = await drainPendingSaves({
      flushScheduled: async () => undefined,
      currentInFlight: () => null,
      clearInFlight: () => undefined,
      currentPending: () => pending,
      cancelScheduled: () => undefined,
      persist: async () => false,
    });

    expect(result).toBe(false);
  });
});
