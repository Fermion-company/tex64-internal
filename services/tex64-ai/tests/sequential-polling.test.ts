import { afterEach, describe, expect, it, vi } from "vitest";

import { startSequentialPolling } from "@/lib/client/sequential-polling";

afterEach(() => {
  vi.useRealTimers();
});

describe("sequential polling", () => {
  it("does not start another tick while the previous request is unresolved", async () => {
    vi.useFakeTimers();
    const resolvers: Array<() => void> = [];
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const stop = startSequentialPolling(operation, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(operation).toHaveBeenCalledTimes(1);

    resolvers.shift()?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);

    stop();
    resolvers.shift()?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("can be stopped before its first request", async () => {
    vi.useFakeTimers();
    const operation = vi.fn(async () => undefined);
    const stop = startSequentialPolling(operation, 2_000);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(operation).not.toHaveBeenCalled();
  });

  it("continues after a transient request failure", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const stop = startSequentialPolling(operation, 2_000);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(operation).toHaveBeenCalledTimes(2);
    stop();
  });
});
