export function assertSameOrigin(request: Request): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (origin && origin !== requestOrigin) throw new InvalidOriginError();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw new InvalidOriginError();
  if (process.env.NODE_ENV === "production" && !origin && !fetchSite) throw new InvalidOriginError();
}

export class InvalidOriginError extends Error {
  constructor() {
    super("Cross-origin mutation rejected.");
    this.name = "InvalidOriginError";
  }
}
