"use strict";

/**
 * A platform Axiom turn is a sequence of paid proxy calls, not one paid call.
 * These bounds therefore apply to the whole sequence. They are deliberately
 * internal: the product only shows the account's token allowance, never cost
 * or provider pricing.
 */
const HARD_MAX_AGENT_ITERATIONS = 24;
const MAX_AGENT_TOKENS_PER_RUN = 100_000;
// A document conversation writes whole sections in one turn and reads the
// paper back between edits. It gets room for that; the hard iteration cap
// and the platform quota still bound it.
const DOCUMENT_MAX_AGENT_ITERATIONS = 40;
const DOCUMENT_TURN_TOKEN_BUDGET = 300_000;
const MAX_COMPLETION_TOKENS_PER_CALL = 32_000;
const MIN_COMPLETION_TOKENS_PER_CALL = 256;

const MAX_REPLAYED_HISTORY_CHARS = 48_000;
const MAX_STALE_TOOL_ARGUMENT_CHARS = 1_024;
// A tool result the model already saw stays in the request, because the
// final reply is often written from it (a diff to review, a section to
// answer about). Only a large one is cut to its head.
const MAX_STALE_TOOL_RESULT_CHARS = 6_000;
const STALE_TOOL_RESULT_HEAD_CHARS = 4_000;
const REQUEST_TOKEN_OVERHEAD = 2_048;
const IMAGE_TOKEN_RESERVE = 32_000;

const asFiniteNonNegativeInteger = (value) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

const resolveMaxAgentIterations = (configured) => {
  const parsed = asFiniteNonNegativeInteger(configured);
  if (parsed === null || parsed < 1) return HARD_MAX_AGENT_ITERATIONS;
  return Math.min(parsed, HARD_MAX_AGENT_ITERATIONS);
};

const clipUtf8Tail = (value, maximumBytes) => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const tail = value.slice(value.length - candidate);
    if (Buffer.byteLength(tail, "utf8") <= maximumBytes) low = candidate;
    else high = candidate - 1;
  }
  return value.slice(value.length - low);
};

/**
 * Keep the most recent plain conversation messages within a byte-like char
 * budget. Tool history is not persisted here; current-turn tool protocol is
 * compacted separately below.
 */
const buildReplayHistory = (conversation) => {
  const source = Array.isArray(conversation) ? conversation : [];
  const replayed = [];
  let remaining = MAX_REPLAYED_HISTORY_CHARS;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    const content = message.content;
    const size = Buffer.byteLength(content, "utf8");
    if (size > remaining && replayed.length > 0) break;
    if (size > remaining) {
      // A single giant reply should not crowd out the current instruction.
      const clipped = clipUtf8Tail(content, remaining);
      replayed.unshift({ role: message.role, content: clipped });
      break;
    }
    replayed.unshift({ role: message.role, content });
    remaining -= size;
  }
  // Chat providers reject histories that begin with an assistant message in
  // some tool-enabled configurations. It is also meaningless without the
  // user turn it answered.
  while (replayed[0]?.role === "assistant") replayed.shift();
  return replayed;
};

/**
 * Arguments of a tool call the model already saw the result of. A big edit
 * keeps its shape (which file, which range, how many lines, the first line)
 * so the model still knows what it did, without re-sending the content.
 */
const compactToolArguments = (raw) => {
  if (typeof raw !== "string" || raw.length <= MAX_STALE_TOOL_ARGUMENT_CHARS) {
    return raw;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({
      _omitted: "Completed earlier in this turn; large arguments were compacted.",
    });
  }
  const compact = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.length > 160) {
      const lines = value.split(/\r?\n/);
      const firstLine = lines.find((line) => line.trim()) ?? "";
      compact[key] = `<${lines.length} lines, ${value.length} chars; first: ${firstLine.trim().slice(0, 80)}>`;
    } else {
      compact[key] = value;
    }
  }
  compact._note = "Completed earlier in this turn; long text arguments summarized.";
  return JSON.stringify(compact);
};

/**
 * The model has already consumed every tool result before the latest tool-call
 * group. Re-sending old full-file reads and large patch arguments on every
 * later iteration only bills the same payload again. Keep the tool-call/result
 * protocol intact, but collapse payloads that have become stale.
 */
const compactRequestMessages = (messages) => {
  const source = Array.isArray(messages) ? messages : [];
  let latestToolCallIndex = -1;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      latestToolCallIndex = index;
      break;
    }
  }

  return source.map((message, index) => {
    if (!message || typeof message !== "object") return message;
    if (message.role === "user" && index < latestToolCallIndex && Array.isArray(message.content) &&
        message.content.some((part) => part.type === "text" && part.text?.startsWith("Rendered "))) {
      return { ...message, content: message.content.filter((part) => part.type === "text") };
    }
    if (message.role === "tool" && index < latestToolCallIndex) {
      const content = typeof message.content === "string" ? message.content : "";
      if (content.length <= MAX_STALE_TOOL_RESULT_CHARS) return message;
      return {
        ...message,
        content:
          `${content.slice(0, STALE_TOOL_RESULT_HEAD_CHARS)}\n…(${content.length - STALE_TOOL_RESULT_HEAD_CHARS} more characters of this earlier result were dropped; call the tool again if you need them)`,
      };
    }
    if (
      message.role === "assistant" &&
      index < latestToolCallIndex &&
      Array.isArray(message.tool_calls)
    ) {
      return {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          function:
            call?.function && typeof call.function === "object"
              ? {
                  ...call.function,
                  arguments: compactToolArguments(call.function.arguments),
                }
              : call?.function,
        })),
      };
    }
    return message;
  });
};

const sanitizeForTokenEstimate = (value, state) => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForTokenEstimate(entry, state));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^data:image\//i.test(value)) {
      state.images += 1;
      return "[image data]";
    }
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sanitizeForTokenEstimate(entry, state);
  }
  return result;
};

let openAiEncoding;
/** Known OpenAI families use their tokenizer plus a framing reserve. Unknown
 * providers retain the UTF-8 byte bound. Never count base64 as text tokens. */
const estimateRequestInputTokenUpperBound = (messages, tools, model = "") => {
  const state = { images: 0 };
  const sanitized = sanitizeForTokenEstimate({ messages, tools }, state);
  const text = JSON.stringify(sanitized);
  let textTokens = Buffer.byteLength(text, "utf8");
  // Mapping maintained by OpenAI: https://github.com/openai/tiktoken/blob/main/tiktoken/model.py
  if (/^(?:Axiom1\.0(?:$|-)|gpt-5|gpt-4o|gpt-4\.1|o[134](?:$|-))/i.test(model)) {
    try {
      openAiEncoding ??= require("js-tiktoken").getEncoding("o200k_base");
      textTokens = Math.ceil(openAiEncoding.encode(text, [], []).length * 1.1);
    } catch { /* Retain the byte bound if the bundled tokenizer is unavailable. */ }
  }
  return (
    textTokens +
    REQUEST_TOKEN_OVERHEAD +
    state.images * IMAGE_TOKEN_RESERVE
  );
};

const planNextRequest = ({ remainingTokens, messages, tools, model }) => {
  const remaining = asFiniteNonNegativeInteger(remainingTokens);
  if (remaining === null || remaining < 1) {
    return {
      allowed: false,
      inputTokenUpperBound: 0,
      maxCompletionTokens: 0,
      reason: "quota_exhausted",
    };
  }
  const inputTokenUpperBound = estimateRequestInputTokenUpperBound(messages, tools, model);
  const availableForCompletion = remaining - inputTokenUpperBound;
  if (availableForCompletion < MIN_COMPLETION_TOKENS_PER_CALL) {
    return {
      allowed: false,
      inputTokenUpperBound,
      maxCompletionTokens: 0,
      reason: "insufficient_request_budget",
    };
  }
  return {
    allowed: true,
    inputTokenUpperBound,
    maxCompletionTokens: Math.min(
      MAX_COMPLETION_TOKENS_PER_CALL,
      availableForCompletion,
    ),
    reason: null,
  };
};

module.exports = {
  DOCUMENT_MAX_AGENT_ITERATIONS,
  DOCUMENT_TURN_TOKEN_BUDGET,
  HARD_MAX_AGENT_ITERATIONS,
  MAX_AGENT_TOKENS_PER_RUN,
  MAX_COMPLETION_TOKENS_PER_CALL,
  MIN_COMPLETION_TOKENS_PER_CALL,
  buildReplayHistory,
  compactRequestMessages,
  estimateRequestInputTokenUpperBound,
  planNextRequest,
  resolveMaxAgentIterations,
};
