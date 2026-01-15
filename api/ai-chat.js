const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const readJsonBody = async (req) => {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const handler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const apiKey = typeof process.env.GEMINI_API_KEY === "string"
    ? process.env.GEMINI_API_KEY.trim()
    : "";
  if (!apiKey) {
    sendJson(res, 500, { error: "GEMINI_API_KEY is not set" });
    return;
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const {
    contents,
    systemInstruction,
    tools,
    toolConfig,
    generationConfig,
    stream,
  } = body;

  if (!Array.isArray(contents)) {
    sendJson(res, 400, { error: "contents is required" });
    return;
  }

  const model = typeof process.env.GEMINI_MODEL === "string"
    ? process.env.GEMINI_MODEL.trim()
    : "gemini-3-flash-preview";

  const acceptHeader = typeof req.headers?.accept === "string" ? req.headers.accept : "";
  const wantsStream = Boolean(stream) || acceptHeader.includes("text/event-stream");
  const endpointAction = wantsStream ? "streamGenerateContent" : "generateContent";
  const upstreamUrl = `${GEMINI_ENDPOINT}/${encodeURIComponent(
    model
  )}:${endpointAction}?key=${apiKey}${wantsStream ? "&alt=sse" : ""}`;
  const upstreamBody = {
    contents,
    systemInstruction,
    tools,
    toolConfig,
    generationConfig,
  };

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });
    if (wantsStream) {
      res.statusCode = upstream.status;
      const contentType = upstream.headers.get("content-type") || "";
      if (!upstream.ok) {
        const raw = await upstream.text();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(raw || "{}");
        return;
      }
      if (contentType.includes("text/event-stream")) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
      } else {
        res.setHeader(
          "Content-Type",
          contentType || "application/json; charset=utf-8"
        );
      }
      if (!upstream.body) {
        res.end();
        return;
      }
      req.on("close", () => {
        upstream.body?.cancel?.();
      });
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    const raw = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(raw || "{}");
  } catch (error) {
    sendJson(res, 500, { error: error?.message ?? "Upstream error" });
  }
};

export default handler;
