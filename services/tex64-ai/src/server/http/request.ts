const DEFAULT_JSON_LIMIT_BYTES = 128 * 1024;

export class InvalidRequestBodyError extends Error {
  readonly kind: "content_type" | "invalid_json" | "too_large";

  constructor(kind: InvalidRequestBodyError["kind"]) {
    super("The request body could not be accepted.");
    this.name = "InvalidRequestBodyError";
    this.kind = kind;
  }
}

/**
 * Reads JSON without trusting Content-Length. The streaming byte limit also
 * covers chunked requests before they are passed to Zod route schemas.
 */
export async function readJsonBody(
  request: Request,
  limitBytes = DEFAULT_JSON_LIMIT_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new InvalidRequestBodyError("content_type");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new InvalidRequestBodyError("invalid_json");
    }
    if (declaredBytes > limitBytes) throw new InvalidRequestBodyError("too_large");
  }

  const body = request.body;
  if (!body) throw new InvalidRequestBodyError("invalid_json");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > limitBytes) {
        await reader.cancel();
        throw new InvalidRequestBodyError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InvalidRequestBodyError) throw error;
    throw new InvalidRequestBodyError("invalid_json");
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidRequestBodyError("invalid_json");
  }
}
