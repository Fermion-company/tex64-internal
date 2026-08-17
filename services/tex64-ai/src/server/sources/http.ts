import { lookup as nodeLookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { canonicalizeHttpsUrl } from "./canonicalize";
import { SourceResolutionError } from "./errors";
import {
  isForbiddenSourceHostname,
  isPublicIpAddress,
  normalizeIpAddress,
} from "./ip-policy";
import type { CanonicalSourceLocator } from "./schema";

export interface DnsAnswer {
  address: string;
  family: 4 | 6;
}

export type SourceDnsLookup = (hostname: string) => Promise<readonly DnsAnswer[]>;

export interface PinnedFetchInput {
  url: URL;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  accept: string;
  userAgent: string;
}

export interface PinnedFetchResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

export type PinnedFetch = (input: PinnedFetchInput) => Promise<PinnedFetchResponse>;
export type HttpsRequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface SafeFetchDependencies {
  dnsLookup?: SourceDnsLookup;
  pinnedFetch?: PinnedFetch;
  request?: HttpsRequestFactory;
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  userAgent?: string;
}

export interface SafeFetchResult extends PinnedFetchResponse {
  finalUrl: CanonicalSourceLocator;
  redirects: readonly CanonicalSourceLocator[];
}

const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCEPT = "text/html, application/xhtml+xml, text/plain;q=0.9";
const DEFAULT_USER_AGENT = "TeX64-SourceResolver/1.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultDnsLookup: SourceDnsLookup = async (hostname) => {
  try {
    const answers = await nodeLookup(hostname, { all: true, verbatim: true });
    return answers.flatMap((answer) =>
      answer.family === 4 || answer.family === 6
        ? [{ address: answer.address, family: answer.family }]
        : [],
    );
  } catch {
    throw new SourceResolutionError("dns_failed", "The source host could not be resolved");
  }
};

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

async function resolvePublicAddress(url: URL, dnsLookup: SourceDnsLookup): Promise<DnsAnswer> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new SourceResolutionError("blocked_address", "The source address is not public");
    }
    return { address: normalizeIpAddress(hostname)!, family: literalFamily as 4 | 6 };
  }
  if (isForbiddenSourceHostname(hostname)) {
    throw new SourceResolutionError("blocked_host", "The source hostname is not allowed");
  }

  let answers: readonly DnsAnswer[];
  try {
    answers = await dnsLookup(hostname);
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    throw new SourceResolutionError("dns_failed", "The source host could not be resolved");
  }
  if (answers.length === 0) {
    throw new SourceResolutionError("dns_failed", "The source host has no usable address");
  }

  const normalized = answers.map((answer) => ({
    address: normalizeIpAddress(answer.address),
    family: answer.family,
  }));
  if (
    normalized.some(
      (answer) =>
        !answer.address ||
        (answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family ||
        !isPublicIpAddress(answer.address),
    )
  ) {
    throw new SourceResolutionError(
      "blocked_address",
      "Every address returned for the source host must be public",
    );
  }

  const first = normalized[0]!;
  return { address: first.address!, family: first.family };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function buildPinnedRequestOptions(input: PinnedFetchInput): RequestOptions {
  const originalHostname = normalizedHostname(input.url);
  const hostHeader = input.url.port ? `${input.url.hostname}:${input.url.port}` : input.url.hostname;
  // Node 22's family autoselection (Happy Eyeballs) calls lookup with
  // {all: true} and expects an address ARRAY; the legacy signature expects
  // (address, family). Serving only one convention makes every request fail
  // with "Invalid IP address: undefined" on the other.
  const lookup = (
    _hostname: string,
    options: unknown,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantsAll) {
      callback(null, [{ address: input.address, family: input.family }]);
    } else {
      callback(null, input.address, input.family);
    }
  };

  return {
    protocol: "https:",
    hostname: originalHostname,
    port: 443,
    method: "GET",
    path: `${input.url.pathname}${input.url.search}`,
    servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
    rejectUnauthorized: true,
    lookup: lookup as RequestOptions["lookup"],
    headers: {
      Host: hostHeader,
      Accept: input.accept,
      "Accept-Encoding": "identity",
      "User-Agent": input.userAgent,
    },
  };
}

export function nodePinnedFetch(
  input: PinnedFetchInput,
  requestFactory: HttpsRequestFactory = nodeHttpsRequest as HttpsRequestFactory,
): Promise<PinnedFetchResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (hardDeadline) clearTimeout(hardDeadline);
      hardDeadline = undefined;
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };

    let request: ClientRequest;
    try {
      request = requestFactory(buildPinnedRequestOptions(input), (response) => {
        const encoding = headerValue(response.headers, "content-encoding")?.trim().toLowerCase();
        if (encoding && encoding !== "identity") {
          const error = new SourceResolutionError(
            "invalid_response",
            "Encoded source responses are not accepted",
          );
          finishReject(error);
          response.destroy();
          return;
        }

        const declaredLength = headerValue(response.headers, "content-length");
        if (declaredLength && /^\d+$/.test(declaredLength)) {
          const length = Number(declaredLength);
          if (!Number.isSafeInteger(length) || length > input.maxBytes) {
            const error = new SourceResolutionError(
              "response_too_large",
              "The source response exceeds the byte limit",
            );
            finishReject(error);
            response.destroy();
            return;
          }
        }

        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.byteLength;
          if (byteLength > input.maxBytes) {
            const error = new SourceResolutionError(
              "response_too_large",
              "The source response exceeds the byte limit",
            );
            finishReject(error);
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once("aborted", () =>
          finishReject(new SourceResolutionError("request_failed", "The source response ended early")),
        );
        response.once("error", () =>
          finishReject(new SourceResolutionError("request_failed", "The source response failed")),
        );
        response.once("end", () => {
          if (settled) return;
          settled = true;
          clearDeadline();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, byteLength),
          });
        });
      });
    } catch {
      finishReject(new SourceResolutionError("request_failed", "The source request could not start"));
      return;
    }

    request.once("error", (error) => {
      if (error instanceof SourceResolutionError) finishReject(error);
      else finishReject(new SourceResolutionError("request_failed", "The source request failed"));
    });
    request.setTimeout(input.timeoutMs, () => {
      const error = new SourceResolutionError("request_timeout", "The source request timed out");
      finishReject(error);
      request.destroy(error);
    });
    hardDeadline = setTimeout(() => {
      const error = new SourceResolutionError(
        "request_timeout",
        "The source request exceeded its deadline",
      );
      finishReject(error);
      request.destroy(error);
    }, input.timeoutMs);
    request.end();
  });
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new SourceResolutionError("invalid_response", "The source request limit is invalid");
  }
  return value;
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new SourceResolutionError("request_timeout", "The source request exceeded its deadline");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SourceResolutionError(
                "request_timeout",
                "The source request exceeded its deadline",
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function safeFetchHttps(
  locator: string | URL,
  dependencies: SafeFetchDependencies = {},
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = normalizeLimit(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 10);
  const timeoutMs = normalizeLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000);
  const maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES, 8 * 1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  const dnsLookup = dependencies.dnsLookup ?? defaultDnsLookup;
  const pinnedFetch =
    dependencies.pinnedFetch ??
    ((input: PinnedFetchInput) => nodePinnedFetch(input, dependencies.request));
  const redirects: CanonicalSourceLocator[] = [];
  const seen = new Set<string>();
  let current = canonicalizeHttpsUrl(locator);

  for (let hop = 0; ; hop += 1) {
    if (seen.has(current)) {
      throw new SourceResolutionError("redirect_loop", "The source redirect chain contains a loop");
    }
    seen.add(current);
    const url = new URL(current);
    const pinned = await withinDeadline(resolvePublicAddress(url, dnsLookup), deadline);
    const remaining = deadline - Date.now();
    const response = await withinDeadline(
      pinnedFetch({
        url,
        address: pinned.address,
        family: pinned.family,
        timeoutMs: Math.max(1, remaining),
        maxBytes,
        accept: options.accept ?? DEFAULT_ACCEPT,
        userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      }),
      deadline,
    );
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new SourceResolutionError("invalid_response", "The source status code is invalid");
    }
    const encoding = headerValue(response.headers, "content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      throw new SourceResolutionError(
        "invalid_response",
        "Encoded source responses are not accepted",
      );
    }
    const declaredLength = headerValue(response.headers, "content-length");
    if (declaredLength && /^\d+$/.test(declaredLength)) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length > maxBytes) {
        throw new SourceResolutionError(
          "response_too_large",
          "The source response exceeds the byte limit",
        );
      }
    }
    if (response.body.byteLength > maxBytes) {
      throw new SourceResolutionError(
        "response_too_large",
        "The source response exceeds the byte limit",
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop >= maxRedirects) {
        throw new SourceResolutionError("too_many_redirects", "The source redirected too many times");
      }
      const location = headerValue(response.headers, "location");
      if (!location) {
        throw new SourceResolutionError("invalid_response", "The redirect has no destination");
      }
      let destination: URL;
      try {
        destination = new URL(location, url);
      } catch {
        throw new SourceResolutionError("invalid_response", "The redirect destination is invalid");
      }
      current = canonicalizeHttpsUrl(destination);
      redirects.push(current);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SourceResolutionError("http_error", "The source returned an error response", {
        status: response.status,
      });
    }
    return { ...response, finalUrl: current, redirects };
  }
}
