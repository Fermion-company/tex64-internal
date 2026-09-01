import {
  loadAuthorizedAiContext,
  assertAiFeatureEnabled,
  commitQuotaConsumption,
} from "../../../_lib/ai-access.js";
import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  readJsonBody,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../../../_lib/http.js";
import { getRuntimeConfig } from "../../../_lib/runtime-config.js";

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "POST") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const config = getRuntimeConfig();
    const aiContext = await loadAuthorizedAiContext(req, config);
    assertAiFeatureEnabled(aiContext.feature);

    const body = await readJsonBody(req);
    if (!body) {
      throw new ApiError("VALIDATION_ERROR", "Request body is required.", 400);
    }

    const openaiApiKey = config.openaiApiKey;
    if (!openaiApiKey) {
      throw new ApiError(
        "LLM_NOT_CONFIGURED",
        "OpenAI API key is not configured on the server.",
        503
      );
    }

    const isStreaming = body.stream === true;
    const openaiBaseUrl = config.openaiBaseUrl || "https://api.openai.com/v1";
    const upstream = await fetch(`${openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      let detail = "";
      try {
        detail = await upstream.text();
      } catch { /* ignore */ }
      throw new ApiError(
        "LLM_UPSTREAM_ERROR",
        `Upstream LLM returned ${upstream.status}.`,
        upstream.status >= 500 ? 502 : upstream.status,
        { details: { upstreamStatus: upstream.status, body: detail.slice(0, 500) } }
      );
    }

    if (isStreaming) {
      // Pipe SSE stream directly to the client while tee'ing a copy
      // to extract the usage chunk from the final SSE event.
      // Clients must send `stream_options: { include_usage: true }` for usage
      // to appear in the stream; otherwise we fall back to 0-token accounting.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let capturedUsage = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Forward raw bytes to the client immediately (no buffering)
          res.write(value);
          // Also decode a copy to parse out the usage chunk
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const payload = trimmed.slice(6);
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              if (chunk && typeof chunk === "object" && chunk.usage) {
                capturedUsage = chunk.usage;
              }
            } catch { /* non-JSON SSE event, ignore */ }
          }
        }
      } catch { /* stream interrupted */ }
      res.end();

      // Commit actual token consumption (or fall back to 0 if usage chunk missing)
      const consumedTokens = capturedUsage
        ? (capturedUsage.prompt_tokens || 0) + (capturedUsage.completion_tokens || 0)
        : 0;
      try {
        await commitQuotaConsumption({
          save: aiContext.save,
          usage: aiContext.usage,
          featureName: "ai_chat",
          consumedTokens,
          consumedRequests: 1,
        });
      } catch { /* best-effort */ }
    } else {
      // Non-streaming: parse JSON and track usage
      const data = await upstream.json();

      const usage = data.usage;
      if (usage) {
        try {
          await commitQuotaConsumption({
            save: aiContext.save,
            usage: aiContext.usage,
            featureName: "ai_chat",
            consumedTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            consumedRequests: 1,
          });
        } catch { /* quota commit is best-effort */ }
      }

      sendJson(res, 200, data);
    }
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
