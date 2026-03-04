const {
  DEFAULT_CHAT_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  REQUEST_HISTORY_MAX_CHARS,
  REQUEST_HISTORY_MAX_MESSAGES,
  clipText,
  extractTextFromParts,
} = require("./agent-core-utils.cjs");
const { clampNumber } = require("./agent-policy.cjs");

const resolveChatModel = (settings) => {
  const configured = typeof settings?.model === "string" ? settings.model.trim() : "";
  return configured || DEFAULT_CHAT_MODEL;
};

const resolveMaxOutputTokens = (settings) => {
  return clampNumber(
    settings?.maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
    { min: 64, max: 4096 }
  );
};

const estimateRequestPartSize = (part) => {
  if (!part || typeof part !== "object") {
    return 0;
  }
  if (typeof part.text === "string") {
    return part.text.length;
  }
  if (part.inlineData && typeof part.inlineData === "object") {
    const data = typeof part.inlineData.data === "string" ? part.inlineData.data : "";
    // base64 payloads dominate cost; approximate bytes for budgeting.
    return Math.round(data.length * 0.75);
  }
  if (part.functionCall && typeof part.functionCall === "object") {
    return JSON.stringify(part.functionCall).length;
  }
  if (part.functionResponse && typeof part.functionResponse === "object") {
    return JSON.stringify(part.functionResponse).length;
  }
  return 0;
};

const estimateRequestMessageSize = (message) => {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.reduce((sum, part) => sum + estimateRequestPartSize(part), 0);
};

const sanitizeMessageForRequest = (message, { includeInlineData = false } = {}) => {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role =
    typeof message.role === "string" && message.role.trim()
      ? message.role.trim()
      : "user";
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const normalizedParts = [];
  parts.forEach((part) => {
    if (!part || typeof part !== "object") {
      return;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      normalizedParts.push({ text: part.text });
      return;
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const callPart = { functionCall: part.functionCall };
      if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
        callPart.thoughtSignature = part.thoughtSignature;
      }
      if (part.thought === true) {
        callPart.thought = true;
      }
      normalizedParts.push(callPart);
      return;
    }
    if (part.functionResponse && typeof part.functionResponse === "object") {
      normalizedParts.push({ functionResponse: part.functionResponse });
      return;
    }
    if (includeInlineData && part.inlineData && typeof part.inlineData === "object") {
      const mimeType =
        typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "";
      const data = typeof part.inlineData.data === "string" ? part.inlineData.data : "";
      if (mimeType && data) {
        normalizedParts.push({ inlineData: { mimeType, data } });
      }
    }
  });
  if (normalizedParts.length === 0) {
    return null;
  }
  return { role, parts: normalizedParts };
};

const buildRequestContents = (conversation, iteration, settings) => {
  const source = Array.isArray(conversation) ? conversation : [];
  if (source.length === 0) {
    return [];
  }
  const maxMessages = clampNumber(
    settings?.maxConversationMessages,
    REQUEST_HISTORY_MAX_MESSAGES,
    { min: 6, max: 80 }
  );
  const maxChars = clampNumber(
    settings?.maxConversationChars,
    REQUEST_HISTORY_MAX_CHARS,
    { min: 8_000, max: 200_000 }
  );
  const startIndex = Math.max(0, source.length - maxMessages);
  const windowed = source.slice(startIndex);
  const latestIndex = windowed.length - 1;
  const shouldKeepInlineData = iteration === 0;
  const entries = [];
  let totalChars = 0;
  let droppedCount = startIndex;
  windowed.forEach((message, index) => {
    const includeInlineData =
      shouldKeepInlineData && index === latestIndex && message?.role === "user";
    const normalized = sanitizeMessageForRequest(message, { includeInlineData });
    if (!normalized) {
      return;
    }
    const size = estimateRequestMessageSize(normalized);
    entries.push({ message: normalized, size });
    totalChars += size;
  });
  while (entries.length > 1 && totalChars > maxChars) {
    const removed = entries.shift();
    totalChars -= removed?.size ?? 0;
    droppedCount += 1;
  }
  while (entries.length > 1 && entries[0]?.message?.role === "tool") {
    const removed = entries.shift();
    totalChars -= removed?.size ?? 0;
    droppedCount += 1;
  }

  const messages = entries.map((entry) => entry.message);
  if (droppedCount > 0) {
    let firstUserText = "";
    for (const entry of source) {
      if (entry?.role !== "user") {
        continue;
      }
      const text = extractTextFromParts(entry?.parts);
      if (text && text.trim()) {
        firstUserText = text.trim();
        break;
      }
    }
    let lastUserText = "";
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const entry = source[index];
      if (entry?.role !== "user") {
        continue;
      }
      const text = extractTextFromParts(entry?.parts);
      if (text && text.trim()) {
        lastUserText = text.trim();
        break;
      }
    }

    const summaryMessage = {
      role: "user",
      parts: [
        {
          text: [
            `Context truncated due to budget (${droppedCount} earlier messages omitted).`,
            firstUserText ? `- Initial request (truncated): ${clipText(firstUserText, 220)}` : "",
            lastUserText ? `- Latest request (truncated): ${clipText(lastUserText, 220)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
    const summarySize = estimateRequestMessageSize(summaryMessage);
    while (messages.length > 1 && totalChars + summarySize > maxChars) {
      const removed = messages.shift();
      totalChars -= estimateRequestMessageSize(removed);
    }
    messages.unshift(summaryMessage);
  }

  return messages;
};

module.exports = {
  resolveChatModel,
  resolveMaxOutputTokens,
  estimateRequestPartSize,
  estimateRequestMessageSize,
  sanitizeMessageForRequest,
  buildRequestContents,
};
