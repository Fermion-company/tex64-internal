import { describe, expect, it } from "vitest";

import { hostMessageBody, requestFromHost } from "@/lib/client/native-host";

type Sent = { type: string; payload?: Record<string, unknown> };

/**
 * A host whose replies arrive the way the desktop bus really sends them:
 * one envelope, `{ type, payload }`, with every field inside `payload`.
 */
function makeHost(reply: (sent: Sent) => Sent | null) {
  const listeners = new Set<(message: Sent) => void>();
  return {
    send: (type: string, payload?: Record<string, unknown>) => {
      const answer = reply({ type, payload });
      if (!answer) return;
      queueMicrotask(() => {
        listeners.forEach((listener) => listener(answer));
      });
    },
    onMessage: (handler: (message: Sent) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

describe("requestFromHost", () => {
  it("resolves with the reply's body, already unwrapped", async () => {
    // The regression this guards: unwrapping the resolved value again reads
    // `.payload` off the body, gets `{}`, and every reply — success or
    // failure — looks like a failure with no reason.
    const host = makeHost((sent) => ({
      type: "synctex:reverseResult",
      payload: {
        requestId: sent.payload?.requestId,
        ok: true,
        path: "main.tex",
        line: 25,
      },
    }));
    const found = await requestFromHost(host, {
      type: "synctex:reverse",
      resultType: "synctex:reverseResult",
      payload: { page: 1, x: 270, y: 253 },
    });
    expect(found.ok).toBe(true);
    expect(found.path).toBe("main.tex");
    expect(found.line).toBe(25);
    // The body is the letter, not another envelope.
    expect(hostMessageBody(found as { type: string })).toEqual({});
  });

  it("ignores replies carrying someone else's requestId", async () => {
    const host = makeHost(() => ({
      type: "file:excerptResult",
      payload: { requestId: "someone-else", ok: true },
    }));
    await expect(
      requestFromHost(host, {
        type: "file:excerpt",
        resultType: "file:excerptResult",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Host did not answer");
  });
});
