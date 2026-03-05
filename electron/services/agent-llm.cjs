const assertFetch = () => {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }
};

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

const normalizeModelName = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^models\//i, "");
};

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

const fetchWithRetry = async (url, options, signal) => {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    try {
      const response = await fetch(url, options);
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("retry-after");
        const delayMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000 || INITIAL_RETRY_DELAY_MS, 30000)
          : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs, signal);
        continue;
      }
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs, signal);
        continue;
      }
      return response;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw err;
      }
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs, signal);
        continue;
      }
    }
  }
  throw lastError ?? new Error("Request failed after retries.");
};

const requestGemini = async ({
  proxyUrl,
  model,
  contents,
  systemInstruction,
  tools,
  toolConfig,
  generationConfig,
  signal,
  onDelta,
}) => {
  if (!proxyUrl) {
    throw new Error("AI proxy URL is missing.");
  }
  assertFetch();
  const resolvedModel =
    normalizeModelName(model) ||
    normalizeModelName(process.env.GEMINI_MODEL) ||
    DEFAULT_GEMINI_MODEL;
  const body = {
    model: resolvedModel,
    contents,
    systemInstruction,
    tools,
    toolConfig,
    generationConfig,
    stream: Boolean(onDelta),
  };
  const response = await fetchWithRetry(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: onDelta ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
    signal,
  }, signal);
  const contentType = response.headers.get("content-type") || "";
  const resolvedModelHeader = response.headers.get("x-tex64-resolved-model") || "";
  const isSse = contentType.includes("text/event-stream");
  if (onDelta && isSse && response.body) {
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      const message = json?.error?.message ?? json?.error ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textBuffer = "";
    const collectedParts = [];
    let usageMetadata = null;
    const flushText = () => {
      if (textBuffer) {
        collectedParts.push({ text: textBuffer });
        textBuffer = "";
      }
    };
    const handleData = (data) => {
      if (!data || data === "[DONE]") {
        return;
      }
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      if (json?.usageMetadata) {
        usageMetadata = json.usageMetadata;
      }
      parts.forEach((part) => {
        if (part?.functionCall) {
          flushText();
          const functionCallPart = { functionCall: part.functionCall };
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
            functionCallPart.thoughtSignature = part.thoughtSignature;
          }
          if (part.thought === true) {
            functionCallPart.thought = true;
          }
          collectedParts.push(functionCallPart);
          return;
        }
        if (typeof part?.text === "string" && part.text.length > 0) {
          textBuffer += part.text;
          onDelta(part.text);
        }
      });
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const findSeparatorIndex = (value) => {
        const lfIndex = value.indexOf("\n\n");
        const crlfIndex = value.indexOf("\r\n\r\n");
        if (lfIndex === -1) {
          return crlfIndex;
        }
        if (crlfIndex === -1) {
          return lfIndex;
        }
        return Math.min(lfIndex, crlfIndex);
      };
      const separatorLength = (value, index) =>
        value.startsWith("\r\n\r\n", index) ? 4 : 2;
      let index = findSeparatorIndex(buffer);
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + separatorLength(buffer, index));
        chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .forEach((line) => {
            const data = line.replace(/^data:\s*/, "");
            handleData(data);
          });
        index = findSeparatorIndex(buffer);
      }
    }
    flushText();
    if (collectedParts.length === 0) {
      throw new Error("Empty response from AI proxy.");
    }
    const payload = { candidates: [{ content: { parts: collectedParts } }] };
    if (usageMetadata) {
      payload.usageMetadata = usageMetadata;
    }
    if (resolvedModelHeader) {
      payload.resolvedModel = resolvedModelHeader;
    }
    return payload;
  }

  const raw = await response.text().catch(() => "");
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const message = json?.error?.message ?? json?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!json) {
    throw new Error("Empty response from AI proxy.");
  }
  if (resolvedModelHeader && typeof json === "object" && json !== null) {
    if (typeof json.resolvedModel !== "string" || !json.resolvedModel.trim()) {
      json.resolvedModel = resolvedModelHeader;
    }
  }
  return json;
};

module.exports = {
  DEFAULT_GEMINI_MODEL,
  requestGemini,
  fetchWithRetry,
  MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS,
};
