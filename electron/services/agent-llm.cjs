const assertFetch = () => {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }
};

const requestGemini = async ({
  proxyUrl,
  contents,
  systemInstruction,
  tools,
  toolConfig,
  generationConfig,
  signal,
}) => {
  if (!proxyUrl) {
    throw new Error("AI proxy URL is missing.");
  }
  assertFetch();
  const body = {
    contents,
    systemInstruction,
    tools,
    toolConfig,
    generationConfig,
  };
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
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
  return json;
};

module.exports = {
  requestGemini,
};
