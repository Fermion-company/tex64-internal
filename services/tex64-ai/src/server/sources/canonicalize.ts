import { SourceResolutionError } from "./errors";
import type { CanonicalSourceLocator, SourceKind } from "./schema";

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
const DOI_HOSTS = new Set(["doi.org", "www.doi.org", "dx.doi.org"]);

export interface CanonicalizedSourceLocator {
  kind: SourceKind;
  canonicalLocator: CanonicalSourceLocator;
  doi?: string;
}

function decodeDoiPath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

export function normalizeDoi(value: string): string | undefined {
  let candidate = value.trim();
  candidate = candidate.replace(/^doi:\s*/i, "");

  try {
    const parsed = new URL(candidate);
    if (!DOI_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
    candidate = decodeDoiPath(parsed.pathname) ?? "";
  } catch {
    // A bare DOI is expected not to parse as an absolute URL.
  }

  candidate = candidate.trim().normalize("NFC").toLowerCase();
  if (candidate.length > 500 || !DOI_PATTERN.test(candidate)) return undefined;
  if (/\p{Cc}|\p{Z}/u.test(candidate)) return undefined;
  return candidate;
}

function encodeDoiPath(doi: string): string {
  return doi
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function canonicalDoiLocator(doi: string): CanonicalSourceLocator {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    throw new SourceResolutionError("invalid_locator", "The DOI is not valid");
  }
  return `https://doi.org/${encodeDoiPath(normalized)}`;
}

export function canonicalizeHttpsUrl(value: string | URL): CanonicalSourceLocator {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value.trim());
  } catch {
    throw new SourceResolutionError("invalid_locator", "The source URL is not valid");
  }
  if (url.protocol !== "https:") {
    throw new SourceResolutionError("unsupported_protocol", "Only HTTPS sources are supported");
  }
  if (url.port && url.port !== "443") {
    throw new SourceResolutionError("unsupported_protocol", "HTTPS sources must use port 443");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.href;
}

export function canonicalizeSourceLocator(value: string): CanonicalizedSourceLocator {
  const doi = normalizeDoi(value);
  if (doi) {
    return { kind: "doi", canonicalLocator: canonicalDoiLocator(doi), doi };
  }
  try {
    const parsed = new URL(value.trim());
    if (DOI_HOSTS.has(parsed.hostname.toLowerCase().replace(/\.$/, ""))) {
      throw new SourceResolutionError("invalid_locator", "The doi.org locator has no valid DOI");
    }
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
  }
  return { kind: "https", canonicalLocator: canonicalizeHttpsUrl(value) };
}
