import { RUN_STAGES } from "./types";
import type {
  AgentRun,
  ClientError,
  ClientResult,
  CreateDocumentInput,
  DocumentDetail,
  DocumentElement,
  DocumentPatch,
  DocumentSummary,
  RunProgressEvent,
  StartRunInput,
} from "./types";

const REQUEST_TIMEOUT_MS = 5_000;
const RUN_STATUSES: AgentRun["status"][] = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
];
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
    Array.isArray(value["runs"]) &&
    value["runs"].every(isRun) &&
    (value["eyebrow"] === undefined || typeof value["eyebrow"] === "string") &&
    (value["author"] === undefined || typeof value["author"] === "string") &&
    (value["artifactUrl"] === undefined || typeof value["artifactUrl"] === "string") &&
    (value["previewUrl"] === undefined || typeof value["previewUrl"] === "string") &&
    (value["regionsUrl"] === undefined || typeof value["regionsUrl"] === "string")
  );
}

function isRun(value: unknown): value is AgentRun {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.documentId === "string" &&
    typeof value.prompt === "string" &&
    typeof value.stage === "string" &&
    RUN_STAGES.includes(value.stage as AgentRun["stage"]) &&
    typeof value.status === "string" &&
    RUN_STATUSES.includes(value.status as AgentRun["status"]) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.resultNote === undefined || typeof value.resultNote === "string") &&
    (value.inputKind === undefined ||
      value.inputKind === null ||
      value.inputKind === "clarification")
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

export async function startRun(
  documentId: string,
  input: StartRunInput,
  idempotencyKey = window.crypto.randomUUID(),
): Promise<ClientResult<AgentRun>> {
  try {
    const payload = getEnvelopeValue(
      await requestJsonWithRetry(`/api/documents/${encodeURIComponent(documentId)}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ ...input, idempotencyKey }),
      }),
      "run",
    );
    if (!isRun(payload)) throw new InvalidResponseError();
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
    return requestFailure(error);
  }
}

const RUN_STAGE_SET: readonly AgentRun["stage"][] = RUN_STAGES;

function isProgressEvent(value: unknown): value is RunProgressEvent {
  return (
    isRecord(value) &&
    typeof value.stage === "string" &&
    RUN_STAGE_SET.includes(value.stage as AgentRun["stage"]) &&
    typeof value.label === "string" &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.occurredAt === "string" &&
    (value.attempt === undefined || Number.isSafeInteger(value.attempt))
  );
}

export async function listRunEvents(
  documentId: string,
  runId: string,
  after?: number,
): Promise<ClientResult<RunProgressEvent[]>> {
  try {
    const query = after === undefined ? "" : `?after=${after}`;
    const payload = getEnvelopeValue(
      await requestJson(
        `/api/documents/${encodeURIComponent(documentId)}/runs/${encodeURIComponent(runId)}/events${query}`,
      ),
      "events",
    );
    if (!Array.isArray(payload) || !payload.every(isProgressEvent)) {
      throw new InvalidResponseError();
    }
    return { data: payload, source: "remote", ok: true };
  } catch (error) {
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
