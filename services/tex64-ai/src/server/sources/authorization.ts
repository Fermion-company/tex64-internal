import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import {
  canonicalizeSourceLocator,
  type CanonicalizedSourceLocator,
} from "./canonicalize";

const MAX_MESSAGES = 64;
const MAX_PARTS_PER_MESSAGE = 128;
const MAX_TRUSTED_PROMPT_CHARS = 100_000;
const MAX_TEXT_LOCATOR_MATCHES = 256;
const MAX_TOOL_CALLS = 32;
const MAX_TOOL_RESULTS = 32;
const MAX_RESULTS_PER_SEARCH = 20;
const MAX_TOTAL_SEARCH_RESULTS = 100;

export type SourceAuthorizationErrorCode =
  | "invalid_authorization_input"
  | "authorization_scan_limit"
  | "source_locator_unauthorized";

export class SourceAuthorizationError extends Error {
  readonly code: SourceAuthorizationErrorCode;

  constructor(code: SourceAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "SourceAuthorizationError";
    this.code = code;
  }
}

interface PositionedToolCall {
  position: number;
  part: ToolCallPart;
}

interface PositionedToolResult {
  position: number;
  part: ToolResultPart;
}

function scanLimit(message: string): never {
  throw new SourceAuthorizationError("authorization_scan_limit", message);
}

function candidateVariants(rawValue: string): string[] {
  const original = rawValue.trim();
  let trimmed = original.replace(/[.,;!?。、，；：！？]+$/u, "");
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  for (const [opening, closing] of pairs) {
    while (trimmed.endsWith(closing)) {
      const openingCount = [...trimmed].filter((character) => character === opening).length;
      const closingCount = [...trimmed].filter((character) => character === closing).length;
      if (closingCount <= openingCount) break;
      trimmed = trimmed.slice(0, -closing.length);
    }
  }
  trimmed = trimmed.replace(/[」』】》〉]+$/u, "");
  return trimmed && trimmed !== original ? [original, trimmed] : [original];
}

function addCanonicalCandidate(
  candidate: string,
  authorized: Set<string>,
): void {
  try {
    authorized.add(canonicalizeSourceLocator(candidate).canonicalLocator);
  } catch {
    // Invalid or non-HTTPS locators do not grant authorization.
  }
}

function addLocatorsFromText(
  text: string,
  authorized: Set<string>,
  state: { matches: number },
): void {
  const patterns = [
    /https?:\/\/[^\s<>"'`]+/giu,
    /(?:doi\s*:\s*)?10\.\d{4,9}\/[-._;()/:a-z0-9%]+/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      state.matches += 1;
      if (state.matches > MAX_TEXT_LOCATOR_MATCHES) {
        scanLimit("Too many locators were present in authorization text");
      }
      for (const candidate of candidateVariants(match[0])) {
        addCanonicalCandidate(candidate, authorized);
      }
    }
  }
}

function modelMessageParts(message: ModelMessage): readonly unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function collectMessageEvidence(
  messages: readonly ModelMessage[],
  authorized: Set<string>,
  searchToolName: string,
): void {
  if (messages.length > MAX_MESSAGES) scanLimit("Too many messages were supplied for authorization");

  let position = 0;
  const calls: PositionedToolCall[] = [];
  const results: PositionedToolResult[] = [];
  for (const message of messages) {
    const parts = modelMessageParts(message);
    if (parts.length > MAX_PARTS_PER_MESSAGE) {
      scanLimit("A message contains too many parts for source authorization");
    }
    if (message.role === "user") {
      // This workflow may wrap earlier model output inside a user-role JSON
      // prompt. Only the separately trusted StoredAgentRun prompts authorize
      // direct locators; user-role ModelMessage text is therefore ignored.
      position += 1;
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") {
      position += 1;
      continue;
    }
    if (typeof message.content === "string") {
      // Assistant prose is deliberately outside the authorization surface.
      position += 1;
      continue;
    }
    for (const part of message.content) {
      position += 1;
      if (part.type === "tool-call") {
        calls.push({ position, part });
        if (calls.length > MAX_TOOL_CALLS) scanLimit("Too many tool calls were scanned");
      } else if (part.type === "tool-result") {
        results.push({ position, part });
        if (results.length > MAX_TOOL_RESULTS) scanLimit("Too many tool results were scanned");
      }
    }
    position += 1;
  }

  const callsById = new Map<string, PositionedToolCall[]>();
  for (const call of calls) {
    const existing = callsById.get(call.part.toolCallId) ?? [];
    existing.push(call);
    callsById.set(call.part.toolCallId, existing);
  }
  const resultsById = new Map<string, PositionedToolResult[]>();
  for (const result of results) {
    const existing = resultsById.get(result.part.toolCallId) ?? [];
    existing.push(result);
    resultsById.set(result.part.toolCallId, existing);
  }

  let totalSearchResults = 0;
  for (const [toolCallId, callsForId] of callsById) {
    if (callsForId.length !== 1) continue;
    const call = callsForId[0]!;
    if (call.part.toolName !== searchToolName || call.part.providerExecuted !== true) continue;
    const resultsForId = resultsById.get(toolCallId) ?? [];
    if (resultsForId.length !== 1) continue;
    const result = resultsForId[0]!;
    if (result.position <= call.position || result.part.toolName !== searchToolName) continue;
    const output = result.part.output;
    if (output.type !== "json" || !output.value || typeof output.value !== "object") continue;
    const value = output.value as Record<string, unknown>;
    if (!Array.isArray(value.results)) continue;
    if (value.results.length > MAX_RESULTS_PER_SEARCH) {
      scanLimit("A source search returned too many results");
    }
    totalSearchResults += value.results.length;
    if (totalSearchResults > MAX_TOTAL_SEARCH_RESULTS) {
      scanLimit("Too many source search results were scanned");
    }
    for (const item of value.results) {
      if (!item || typeof item !== "object") continue;
      const url = (item as Record<string, unknown>).url;
      if (typeof url !== "string" || url.length > 4_096) continue;
      addCanonicalCandidate(url, authorized);
    }
  }
}

/**
 * Authorizes a locator only when it is in the separately trusted prompt set or
 * returned by the provider-executed `search_sources` call/result pair.
 * ModelMessage prose and unmatched/fabricated tool results never grant access.
 */
export function authorizedSourceLocator(input: {
  locator: string;
  trustedPrompt: string;
  messages: readonly ModelMessage[];
  searchToolName?: string;
}): CanonicalizedSourceLocator {
  if (
    typeof input.locator !== "string" ||
    typeof input.trustedPrompt !== "string" ||
    !Array.isArray(input.messages)
  ) {
    throw new SourceAuthorizationError(
      "invalid_authorization_input",
      "Source authorization input is invalid",
    );
  }
  if (input.trustedPrompt.length > MAX_TRUSTED_PROMPT_CHARS) {
    scanLimit("The trusted prompt is too large for source authorization");
  }
  const searchToolName = input.searchToolName ?? "search_sources";
  if (!/^[-_A-Za-z0-9]{1,100}$/.test(searchToolName)) {
    throw new SourceAuthorizationError(
      "invalid_authorization_input",
      "The source search tool name is invalid",
    );
  }

  let requested: CanonicalizedSourceLocator;
  try {
    requested = canonicalizeSourceLocator(input.locator);
  } catch {
    throw new SourceAuthorizationError(
      "invalid_authorization_input",
      "The requested source locator is invalid",
    );
  }

  const authorized = new Set<string>();
  const textState = { matches: 0 };
  addLocatorsFromText(input.trustedPrompt, authorized, textState);
  collectMessageEvidence(input.messages, authorized, searchToolName);
  if (!authorized.has(requested.canonicalLocator)) {
    throw new SourceAuthorizationError(
      "source_locator_unauthorized",
      "The source locator was not provided by the user or verified search results",
    );
  }
  return requested;
}
