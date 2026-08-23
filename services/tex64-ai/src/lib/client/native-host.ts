"use client";

/**
 * The desktop host, when the AI mode runs inside TeX64 rather than a browser.
 *
 * `electron/ai-web-preload.cjs` injects this, and the embedder allowlists both
 * directions, so what is reachable here is exactly the workspace surface Code
 * mode uses: its files, its build, SyncTeX, and its agent.
 */
/**
 * The host bus is an envelope: everything the message carries is in `payload`.
 */
export type HostMessage = { type: string; payload?: Record<string, unknown> };

export function hostMessageBody(message: HostMessage): Record<string, unknown> {
  const body = message.payload;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

type NativeHost = {
  send: (type: string, payload?: Record<string, unknown>) => void;
  onMessage: (handler: (message: HostMessage) => void) => () => void;
};

type NativeWindow = Window & {
  tex64Native?: { platform?: string; host?: NativeHost };
};

export function getNativeHost(): NativeHost | null {
  if (typeof window === "undefined") return null;
  return (window as NativeWindow).tex64Native?.host ?? null;
}

let requestCounter = 0;

/**
 * One request/response round trip over the host bus, which is otherwise a
 * one-way message stream: the request carries an id and the matching reply
 * carries it back.
 *
 * Resolves with the reply's *body* — the letter, not the envelope. The
 * payload is already unwrapped here; unwrapping it again yields `{}` and
 * makes every reply look like a failure.
 */
export function requestFromHost(
  host: NativeHost,
  input: {
    type: string;
    resultType: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  requestCounter += 1;
  const requestId = `ai-${Date.now().toString(36)}-${requestCounter}`;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Host did not answer ${input.type}.`));
    }, input.timeoutMs ?? 12_000);
    const unsubscribe = host.onMessage((message) => {
      if (message.type !== input.resultType) return;
      const body = hostMessageBody(message);
      if (body.requestId !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(body);
    });
    host.send(input.type, { ...input.payload, requestId });
  });
}
