import type {
  ChatMessage,
  ClientError,
  ClientResult,
  CreateDocumentInput,
  DocumentDetail,
  DocumentElement,
  DocumentPatch,
  DocumentSummary,
  TurnFrame,
} from "./types";

const REQUEST_TIMEOUT_MS = 5_000;
const DOCUMENT_KINDS: DocumentDetail["kind"][] = ["proposal", "report", "paper", "memo"];
const DOCUMENT_STATUSES: DocumentDetail["status"][] = ["draft", "working", "ready"];

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with ${status}`);
  }
}

class InvalidResponseError extends Error {}

function requestFailure(error: unknown): {
  data: null;
  source: "remote";
  ok: false;
  error: ClientError;
} {
  return {
    data: null,
    source: "remote",
    ok: false,
    error:
      error instanceof HttpError && error.status === 409
        ? "conflict"
        : error instanceof InvalidResponseError
          ? "invalid_response"
          : "unavailable",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new HttpError(response.status);
    }

    return (await response.json()) as unknown;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requestJsonWithRetry(path: string, init: RequestInit): Promise<unknown> {
  try {
    return await requestJson(path, init);
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) throw error;
    return requestJson(path, init);
  }
}

function getEnvelopeValue(payload: unknown, key: string): unknown {
  if (!isRecord(payload)) return payload;
  if (payload[key] !== undefined) return payload[key];
  const data = payload["data"];
  if (isRecord(data) && data[key] !== undefined) return data[key];
  return data ?? payload;
}

function isSummary(value: unknown): value is DocumentSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.preview === "string" &&
    DOCUMENT_KINDS.includes(value.kind as DocumentDetail["kind"]) &&
    DOCUMENT_STATUSES.includes(value.status as DocumentDetail["status"])
  );
}

function isBlock(value: unknown): value is DocumentDetail["blocks"][number] {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "heading":
      return (
        (value.level === 1 || value.level === 2) && typeof value.text === "string"
      );
    case "paragraph":
      return typeof value.text === "string";
    case "quote":
      return (
        typeof value.text === "string" &&
        (value.attribution === undefined || typeof value.attribution === "string")
      );
    case "list":
      return Array.isArray(value.items) && value.items.every((item) => typeof item === "string");
    case "equation":
      return (
        typeof value.expression === "string" &&
        (value.caption === undefined || typeof value.caption === "string")
      );
    default:
      return false;
  }
}

function isVersion(value: unknown): value is DocumentDetail["versions"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.revision) &&
    typeof value.label === "string" &&
    typeof value.createdAt === "string" &&
    (value.source === "agent" || value.source === "manual")
  );
}

const ELEMENT_KINDS: readonly DocumentElement["kind"][] = [
  "section",
  "heading",
  "paragraph",
  "list",
  "equation",
  "quote",
  "figure",
  "table",
  "theorem",
  "proof",
  "algorithm",
  "code",
  "appendix",
  "bibliography",
];

function isElement(value: unknown): value is DocumentElement {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ELEMENT_KINDS.includes(value.kind as DocumentElement["kind"]) &&
    typeof value.label === "string" &&
    typeof value.editable === "boolean"
  );
}

function isDetail(value: unknown): value is DocumentDetail {
  return (
    isRecord(value) &&
    isSummary(value) &&
    Number.isSafeInteger(value["revision"]) &&
    Number(value["revision"]) >= 1 &&
    Array.isArray(value["blocks"]) &&
    value["blocks"].every(isBlock) &&
    Array.isArray(value["elements"]) &&
    value["elements"].every(isElement) &&
    Array.isArray(value["versions"]) &&
    value["versions"].every(isVersion) &&
    Array.isArray(value["messages"]) &&
    value["messages"].every(isChatMessage) &&
    (value["eyebrow"] === undefined || typeof value["eyebrow"] === "string") &&
    (value["author"] === undefined || typeof value["author"] === "string") &&
    (value["artifactUrl"] === undefined || typeof value["artifactUrl"] === "string") &&
    (value["previewUrl"] === undefined || typeof value["previewUrl"] === "string") &&
    (value["regionsUrl"] === undefined || typeof value["regionsUrl"] === "string")
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string"
  );
}

export async function listDocuments(): Promise<ClientResult<DocumentSummary[]>> {
  try {
    const payload = getEnvelopeValue(await requestJson("/api/documents"), "documents");
    if (!Array.isArray(payload) || !payload.every(isSummary)) {
      throw new InvalidResponseError();
    }
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function getDocument(id: string): Promise<ClientResult<DocumentDetail>> {
  try {
    const payload = getEnvelopeValue(
      await requestJson(`/api/documents/${encodeURIComponent(id)}`),
      "document",
    );
    if (!isDetail(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function createDocument(
  input: CreateDocumentInput,
  idempotencyKey = window.crypto.randomUUID(),
): Promise<ClientResult<DocumentDetail>> {
  try {
    const payload = getEnvelopeValue(
      await requestJsonWithRetry("/api/documents", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      }),
      "document",
    );
    if (!isDetail(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function patchDocument(
  id: string,
  patch: DocumentPatch,
): Promise<ClientResult<DocumentDetail>> {
  try {
    const payload = getEnvelopeValue(
      await requestJson(`/api/documents/${encodeURIComponent(id)}/patch`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
      "document",
    );

    if (!isDetail(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

function isTurnFrame(value: unknown): value is TurnFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.delta === "string";
    case "tool":
      return (
        typeof value.name === "string" &&
        (value.state === "start" || value.state === "ok" || value.state === "error")
      );
    case "revision":
      return Number.isSafeInteger(value.revision);
    case "compiled":
      return (
        Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.pageCount)
      );
    case "error":
      return typeof value.message === "string";
    case "done":
      return (
        value.status === "completed" ||
        value.status === "aborted" ||
        value.status === "failed"
      );
    default:
      return false;
  }
}

/**
 * Sends one message and reports the agent's reply as it arrives. Aborting the
 * signal interrupts the turn server-side; whatever was already written stays
 * in the conversation.
 */
export async function sendMessage(
  documentId: string,
  input: { prompt: string; targetNodeId?: string },
  onFrame: (frame: TurnFrame) => void,
  signal: AbortSignal,
): Promise<ClientResult<null>> {
  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      },
    );
    if (!response.ok || !response.body) throw new HttpError(response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const parsed: unknown = JSON.parse(line);
          if (isTurnFrame(parsed)) onFrame(parsed);
        }
        newline = buffer.indexOf("\n");
      }
    }
    return { data: null, source: "remote", ok: true };
  } catch (error) {
    if (signal.aborted) return { data: null, source: "remote", ok: true };
    return requestFailure(error);
  }
}

/** Typesetting runs 45s locally and up to 120s in the sandbox. */
const COMPILE_TIMEOUT_MS = 180_000;
const RESTORE_TIMEOUT_MS = 30_000;

export async function compileDocument(
  documentId: string,
): Promise<ClientResult<DocumentDetail>> {
  try {
    const payload = getEnvelopeValue(
      await requestJson(
        `/api/documents/${encodeURIComponent(documentId)}/compile`,
        { method: "POST", body: JSON.stringify({}) },
        COMPILE_TIMEOUT_MS,
      ),
      "document",
    );
    if (!isDetail(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function restoreDocument(
  documentId: string,
  revision: number,
  idempotencyKey = window.crypto.randomUUID(),
): Promise<ClientResult<DocumentDetail>> {
  try {
    const payload = getEnvelopeValue(
      await requestJson(
        `/api/documents/${encodeURIComponent(documentId)}/restore`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ revision }),
        },
        RESTORE_TIMEOUT_MS,
      ),
      "document",
    );
    if (!isDetail(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}
