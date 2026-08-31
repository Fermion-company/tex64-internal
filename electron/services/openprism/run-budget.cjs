"use strict";

/**
 * A platform Axiom turn is a sequence of paid proxy calls, not one paid call.
 * These bounds therefore apply to the whole sequence. They are deliberately
 * internal: the product only shows the account's token allowance, never cost
 * or provider pricing.
 */
const HARD_MAX_AGENT_ITERATIONS = 24;
const MAX_AGENT_TOKENS_PER_RUN = 100_000;
const MAX_COMPLETION_TOKENS_PER_CALL = 32_000;
const MIN_COMPLETION_TOKENS_PER_CALL = 256;

const MAX_REPLAYED_HISTORY_CHARS = 48_000;
const MAX_STALE_TOOL_ARGUMENT_CHARS = 1_024;
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

const compactToolArguments = (raw) => {
  if (typeof raw !== "string" || raw.length <= MAX_STALE_TOOL_ARGUMENT_CHARS) {
    return raw;
  }
  return JSON.stringify({
    _omitted: "Completed earlier in this turn; large arguments were compacted.",
  });
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
    if (message.role === "tool" && index < latestToolCallIndex) {
      return {
        ...message,
        content: JSON.stringify({
          status: "completed",
          detail: "Previous tool result omitted after it was consumed by the model.",
        }),
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

/**
 * A tokenizer-independent upper bound: a text token cannot represent fewer
 * than one UTF-8 byte. The fixed reserve covers provider chat/tool framing;
 * image payload bytes are replaced by a conservative vision-token reserve.
 */
const estimateRequestInputTokenUpperBound = (messages, tools) => {
  const state = { images: 0 };
  const sanitized = sanitizeForTokenEstimate({ messages, tools }, state);
  return (
    Buffer.byteLength(JSON.stringify(sanitized), "utf8") +
    REQUEST_TOKEN_OVERHEAD +
    state.images * IMAGE_TOKEN_RESERVE
  );
};

const planNextRequest = ({ remainingTokens, messages, tools }) => {
  const remaining = asFiniteNonNegativeInteger(remainingTokens);
  if (remaining === null || remaining < 1) {
    return {
      allowed: false,
      inputTokenUpperBound: 0,
      maxCompletionTokens: 0,
      reason: "quota_exhausted",
    };
  }
  const inputTokenUpperBound = estimateRequestInputTokenUpperBound(messages, tools);
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
