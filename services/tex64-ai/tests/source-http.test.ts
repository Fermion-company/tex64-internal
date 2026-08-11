import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SourceResolutionError,
  nodePinnedFetch,
  safeFetchHttps,
  type HttpsRequestFactory,
  type PinnedFetchInput,
  type PinnedFetchResponse,
  type SourceDnsLookup,
} from "@/server/sources";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "text/plain" },
): PinnedFetchResponse {
  return { status, headers, body: Buffer.from(body) };
}

function mockIncoming(
  body: string,
  headers: Record<string, string> = { "content-type": "text/plain" },
): IncomingMessage {
  const incoming = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  Object.assign(incoming, { statusCode: 200, headers });
  return incoming;
}

describe("safe HTTPS source fetch", () => {
  it("rejects a hostname when any DNS answer is non-public", async () => {
    const pinnedFetch = vi.fn();
    await expect(
      safeFetchHttps("https://papers.example.com/article", {
        dnsLookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        pinnedFetch,
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("rejects private literal addresses without consulting DNS or transport", async () => {
    const dnsLookup = vi.fn();
    const pinnedFetch = vi.fn();
    await expect(
      safeFetchHttps("https://169.254.169.254/latest/meta-data", {
        dnsLookup,
        pinnedFetch,
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("revalidates and repins every redirect after removing credentials and fragments", async () => {
    const resolvedHosts: string[] = [];
    const dnsLookup: SourceDnsLookup = async (hostname) => {
      resolvedHosts.push(hostname);
      return [
        {
          address: hostname === "first.example.com" ? "93.184.216.34" : "142.250.72.14",
          family: 4,
        },
      ];
    };
    const requests: PinnedFetchInput[] = [];
    const result = await safeFetchHttps(
      "https://first.example.com/start#ignored",
      {
        dnsLookup,
        pinnedFetch: async (input) => {
          requests.push(input);
          return requests.length === 1
            ? response(302, "", {
                location: "https://reader:secret@second.example.net/final#private",
              })
            : response(200, "ok");
        },
      },
    );

    expect(resolvedHosts).toEqual(["first.example.com", "second.example.net"]);
    expect(requests.map((request) => request.address)).toEqual([
      "93.184.216.34",
      "142.250.72.14",
    ]);
    expect(result.finalUrl).toBe("https://second.example.net/final");
    expect(result.redirects).toEqual(["https://second.example.net/final"]);
  });

  it("blocks a redirect whose newly resolved destination is private", async () => {
    const pinnedFetch = vi
      .fn()
      .mockResolvedValueOnce(response(302, "", { location: "https://private.example.net/data" }));
    await expect(
      safeFetchHttps("https://public.example.com/start", {
        dnsLookup: async (hostname) => [
          hostname === "public.example.com"
            ? { address: "93.184.216.34", family: 4 }
            : { address: "10.0.0.8", family: 4 },
        ],
        pinnedFetch,
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });

  it("stops redirect loops before issuing a repeated request", async () => {
    const pinnedFetch = vi.fn(async () =>
      response(302, "", { location: "https://papers.example.com/start" }),
    );
    await expect(
      safeFetchHttps("https://papers.example.com/start", {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetch,
      }),
    ).rejects.toMatchObject({ code: "redirect_loop" });
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });

  it("pins the socket lookup to the already-validated address despite later DNS rebinding", async () => {
    let dnsCalls = 0;
    let dnsWouldNowReturnPrivate = false;
    let capturedOptions: RequestOptions | undefined;
    let socketAddress: string | undefined;
    let socketFamily: number | undefined;
    const dnsLookup: SourceDnsLookup = async () => {
      dnsCalls += 1;
      return [
        dnsWouldNowReturnPrivate
          ? { address: "127.0.0.1", family: 4 }
          : { address: "93.184.216.34", family: 4 },
      ];
    };
    const requestFactory: HttpsRequestFactory = (options, callback) => {
      capturedOptions = options;
      dnsWouldNowReturnPrivate = true;
      const pinnedLookup = options.lookup as unknown as (
        hostname: string,
        options: object,
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void;
      pinnedLookup("papers.example.com", {}, (_error, address, family) => {
        socketAddress = address;
        socketFamily = family;
      });

      const emitter = new EventEmitter();
      const request = emitter as unknown as ClientRequest;
      request.setTimeout = vi.fn(() => request);
      request.destroy = vi.fn(() => request);
      request.end = vi.fn(() => {
        queueMicrotask(() => callback(mockIncoming("verified")));
        return request;
      }) as ClientRequest["end"];
      return request;
    };

    const result = await safeFetchHttps("https://papers.example.com/article", {
      dnsLookup,
      request: requestFactory,
    });

    expect(result.body.toString()).toBe("verified");
    expect(dnsCalls).toBe(1);
    expect(dnsWouldNowReturnPrivate).toBe(true);
    expect(socketAddress).toBe("93.184.216.34");
    expect(socketFamily).toBe(4);
    expect(capturedOptions?.servername).toBe("papers.example.com");
    expect(capturedOptions?.rejectUnauthorized).toBe(true);
    expect(capturedOptions?.headers).toMatchObject({
      Host: "papers.example.com",
      "Accept-Encoding": "identity",
    });
  });

  it("fails closed when DNS never resolves", async () => {
    await expect(
      safeFetchHttps(
        "https://papers.example.com/article",
        { dnsLookup: () => new Promise(() => undefined), pinnedFetch: vi.fn() },
        { timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("enforces an absolute deadline even while response data keeps arriving", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const requestFactory: HttpsRequestFactory = (_options, callback) => {
      const emitter = new EventEmitter();
      const request = emitter as unknown as ClientRequest;
      const incoming = new Readable({ read() {} }) as unknown as IncomingMessage;
      Object.assign(incoming, { statusCode: 200, headers: { "content-type": "text/plain" } });
      request.setTimeout = vi.fn(() => request);
      request.destroy = vi.fn((error?: Error) => {
        if (interval) clearInterval(interval);
        if (error) queueMicrotask(() => emitter.emit("error", error));
        return request;
      });
      request.end = vi.fn(() => {
        callback(incoming);
        interval = setInterval(() => incoming.push(Buffer.from("x")), 3);
        return request;
      }) as ClientRequest["end"];
      return request;
    };
    const input: PinnedFetchInput = {
      url: new URL("https://papers.example.com/article"),
      address: "93.184.216.34",
      family: 4,
      timeoutMs: 25,
      maxBytes: 1024,
      accept: "text/plain",
      userAgent: "test",
    };

    await expect(nodePinnedFetch(input, requestFactory)).rejects.toMatchObject({
      code: "request_timeout",
    });
    if (interval) clearInterval(interval);
  });

  it("rejects encoded and oversized responses even from an injected transport", async () => {
    const dnsLookup: SourceDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(
      safeFetchHttps("https://papers.example.com/article", {
        dnsLookup,
        pinnedFetch: async () => response(200, "compressed", { "content-encoding": "gzip" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      safeFetchHttps(
        "https://papers.example.com/article",
        {
          dnsLookup,
          pinnedFetch: async () => response(200, "tiny", { "content-length": "999" }),
        },
        { maxBytes: 10 },
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await expect(
      safeFetchHttps(
        "https://papers.example.com/article",
        {
          dnsLookup,
          pinnedFetch: async () => response(200, "body exceeds limit"),
        },
        { maxBytes: 10 },
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("uses typed errors for transport policy failures", () => {
    const error = new SourceResolutionError("blocked_address", "blocked");
    expect(error).toMatchObject({ name: "SourceResolutionError", code: "blocked_address" });
  });
});
