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
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
