const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Development binds one loopback name (localhost) while tools and the
// desktop embed may reach it through another (127.0.0.1). Treat loopback
// aliases on the same protocol and port as one origin outside production.
function isDevelopmentLoopbackAlias(originHeader: string, requestUrl: URL): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const origin = new URL(originHeader);
    return (
      LOOPBACK_HOSTNAMES.has(origin.hostname) &&
      LOOPBACK_HOSTNAMES.has(requestUrl.hostname) &&
      origin.protocol === requestUrl.protocol &&
      origin.port === requestUrl.port
    );
  } catch {
    return false;
  }
}

export function assertSameOrigin(request: Request): void {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (
    origin &&
    origin !== requestUrl.origin &&
    !isDevelopmentLoopbackAlias(origin, requestUrl)
  ) {
    throw new InvalidOriginError();
  }
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw new InvalidOriginError();
  if (process.env.NODE_ENV === "production" && !origin && !fetchSite) throw new InvalidOriginError();
}

export class InvalidOriginError extends Error {
  constructor() {
    super("Cross-origin mutation rejected.");
    this.name = "InvalidOriginError";
  }
}
