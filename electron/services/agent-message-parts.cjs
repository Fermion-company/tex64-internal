const {
  BASE64_DATA_PATTERN,
  MAX_USER_INLINE_DATA_BYTES,
  MAX_USER_INLINE_DATA_TOTAL_BYTES,
} = require("./agent-core-utils.cjs");

const decodeBase64Strict = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (normalized.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_DATA_PATTERN.test(normalized)) {
    return null;
  }
  const buffer = Buffer.from(normalized, "base64");
  const noPadNormalized = normalized.replace(/=+$/g, "");
  const noPadEncoded = buffer.toString("base64").replace(/=+$/g, "");
  if (noPadNormalized !== noPadEncoded) {
    return null;
  }
  return { normalized, byteLength: buffer.length };
};

const normalizeUserMessageParts = (message, parts) => {
  const normalized = [];
  let hasTextPart = false;
  let totalInlineBytes = 0;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const text = typeof part?.text === "string" ? part.text : "";
      if (text.trim()) {
        normalized.push({ text });
        hasTextPart = true;
      }
      const mimeType =
        typeof part?.inlineData?.mimeType === "string" ? part.inlineData.mimeType.trim() : "";
      const dataRaw = typeof part?.inlineData?.data === "string" ? part.inlineData.data : "";
      const decoded = decodeBase64Strict(dataRaw);
      if (!decoded) {
        continue;
      }
      if (decoded.byteLength > MAX_USER_INLINE_DATA_BYTES) {
        continue;
      }
      if (totalInlineBytes + decoded.byteLength > MAX_USER_INLINE_DATA_TOTAL_BYTES) {
        continue;
      }
      if (mimeType.startsWith("image/")) {
        totalInlineBytes += decoded.byteLength;
        normalized.push({
          inlineData: {
            mimeType,
            data: decoded.normalized,
          },
        });
      }
    }
  }
  const normalizedMessage = typeof message === "string" ? message : "";
  if (!hasTextPart && normalizedMessage.trim()) {
    normalized.unshift({ text: normalizedMessage });
  }
  return normalized.length > 0 ? normalized : null;
};

module.exports = {
  decodeBase64Strict,
  normalizeUserMessageParts,
};
