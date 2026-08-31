import {
  loadAuthorizedAiContext,
  assertAiFeatureEnabled,
  reconcileQuotaConsumption,
  reserveQuotaConsumption,
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
import {
  maskAxiomResponseModel,
  resolveAxiomModel,
} from "../../../_lib/ai-model-policy.js";
import {
  buildQuotaBoundedChatRequest,
  hasCompleteProviderUsage,
  usageToCostUsd,
  usageToQuotaTokens,
} from "../../../_lib/ai-request-budget.js";

const TURN_REMAINING_TOKENS_HEADER = "x-tex64-turn-remaining-tokens";

const turnRemainingTokenLimit = (req) => {
  const raw = req?.headers?.[TURN_REMAINING_TOKENS_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const costRatesForModel = (publicModel, config) => {
  const pro = publicModel === "Axiom1.0-pro";
  return {
    blendedCostPerTokenUsd: config.blendedCostPerTokenUsd,
    inputUsdPerMillion: pro
      ? config.axiomProInputUsdPerMillion
      : config.axiomStandardInputUsdPerMillion,
    cachedInputUsdPerMillion: pro
      ? config.axiomProCachedInputUsdPerMillion
      : config.axiomStandardCachedInputUsdPerMillion,
    cacheWriteUsdPerMillion: pro
      ? config.axiomProCacheWriteUsdPerMillion
      : config.axiomStandardCacheWriteUsdPerMillion,
    outputUsdPerMillion: pro
      ? config.axiomProOutputUsdPerMillion
      : config.axiomStandardOutputUsdPerMillion,
  };
};

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
    const { publicModel, upstreamModel } = resolveAxiomModel({
      requestedModel: body.model,
      subscription: aiContext.subscription,
      config,
    });

    const openaiApiKey = config.openaiApiKey;
    if (!openaiApiKey) {
      throw new ApiError(
        "LLM_NOT_CONFIGURED",
        "OpenAI API key is not configured on the server.",
        503
      );
    }

    const isStreaming = body.stream === true;
    const costRates = costRatesForModel(publicModel, config);
    const accountRemainingTokens = Math.max(
      0,
      Number(aiContext.feature?.quota?.remainingTokens) || 0,
    );
    const turnRemainingTokens = turnRemainingTokenLimit(req);
    const boundedRequest = buildQuotaBoundedChatRequest({
      body,
      upstreamModel,
      remainingTokens:
        turnRemainingTokens === null
          ? accountRemainingTokens
          : Math.min(accountRemainingTokens, turnRemainingTokens),
      costRates,
    });
    if (!boundedRequest.allowed) {
      throw new ApiError(
        "QUOTA_EXCEEDED",
        "The remaining AI token allowance is too small for this request.",
        429,
      );
    }
    const reservation = await reserveQuotaConsumption({
      usage: aiContext.usage,
      featureName: "ai_chat",
      reservedTokens: boundedRequest.reservedTokens,
      reservedRequests: 1,
      reserveUsage: aiContext.reserveUsage,
    });
    if (!reservation?.reserved) {
      throw new ApiError(
        "QUOTA_EXCEEDED",
        "The AI token allowance was consumed by another request.",
        429,
      );
    }
    const openaiBaseUrl = config.openaiBaseUrl || "https://api.openai.com/v1";
    let upstream;
    try {
      upstream = await fetch(`${openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify(boundedRequest.body),
      });
    } catch (error) {
      // A network failure after POST is ambiguous. Keep the reservation so an
      // unknown paid completion cannot be followed by more spend.
      throw error;
    }

    if (!upstream.ok) {
      // Drain the provider response without returning it. Provider errors can
      // include private model ids or infrastructure details.
      try { await upstream.text(); } catch { /* ignore */ }
      // An explicit provider rejection did not produce a completion. Refund
      // token units while retaining the already-counted request.
      await reconcileQuotaConsumption({
        save: aiContext.save,
        usage: aiContext.usage,
        featureName: "ai_chat",
        reservedTokens: boundedRequest.reservedTokens,
        actualTokens: 0,
        reconcileUsage: aiContext.reconcileUsage,
      });
      throw new ApiError(
        "LLM_UPSTREAM_ERROR",
        `Upstream LLM returned ${upstream.status}.`,
        upstream.status >= 500 ? 502 : upstream.status,
        { details: { upstreamStatus: upstream.status } }
      );
    }

    if (isStreaming) {
      // Pipe SSE stream directly to the client while tee'ing a copy
      // to extract the usage chunk from the final SSE event.
      // The proxy forces `stream_options.include_usage`; if the provider still
      // omits usage, the full preflight reservation remains charged.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let capturedUsage = null;
      let sawDone = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Parse complete SSE lines so the provider model id can never leak
          // through a chunk. This still streams one event at a time.
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) {
              res.write(`${line}\n`);
              continue;
            }
            const payload = trimmed.slice(6);
            if (payload === "[DONE]") {
              sawDone = true;
              continue;
            }
            try {
              const chunk = JSON.parse(payload);
              if (chunk && typeof chunk === "object" && chunk.usage) {
                capturedUsage = chunk.usage;
              }
              res.write(`data: ${JSON.stringify(maskAxiomResponseModel(chunk, publicModel))}\n`);
            } catch {
              // Do not forward malformed provider payloads because they could
              // contain an unmasked provider identifier.
            }
          }
        }
      } catch { /* stream interrupted */ }
      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) {
        const trimmed = sseBuffer.trim();
        if (trimmed === "data: [DONE]") {
          sawDone = true;
        } else if (trimmed.startsWith("data: ")) {
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            if (chunk && typeof chunk === "object" && chunk.usage) {
              capturedUsage = chunk.usage;
            }
            res.write(`data: ${JSON.stringify(maskAxiomResponseModel(chunk, publicModel))}\n`);
          } catch { /* malformed final provider event */ }
        }
      }
      // Commit cost-normalized usage. Missing provider usage is charged at
      // the preflight reservation so an unmetered stream can never be free.
      const measuredUsage = hasCompleteProviderUsage(capturedUsage)
        ? capturedUsage
        : null;
      const consumedTokens = measuredUsage
        ? usageToQuotaTokens(measuredUsage, costRates)
        : boundedRequest.reservedTokens;
      const consumedCostUsd = measuredUsage
        ? usageToCostUsd(measuredUsage, costRates)
        : undefined;
      try {
        await reconcileQuotaConsumption({
          save: aiContext.save,
          usage: aiContext.usage,
          featureName: "ai_chat",
          reservedTokens: boundedRequest.reservedTokens,
          actualTokens: consumedTokens,
          ...(consumedCostUsd === undefined
            ? {}
            : {
                actualCostUsd: consumedCostUsd,
                blendedCostPerTokenUsd: costRates.blendedCostPerTokenUsd,
              }),
          reconcileUsage: aiContext.reconcileUsage,
        });
      } catch (error) {
        console.error("[ai-quota] failed to persist streaming usage:", error);
      } finally {
        // Hold the terminal event until quota persistence settles. A client
        // that advances on [DONE] (without waiting for EOF) therefore cannot
        // race a subsequent admission check against this completed turn.
        if (sawDone) {
          res.write("data: [DONE]\n");
        }
        res.end();
      }
    } else {
      // Non-streaming: parse JSON and track usage
      const data = maskAxiomResponseModel(await upstream.json(), publicModel);

      const usage = data.usage;
      const measuredUsage = hasCompleteProviderUsage(usage) ? usage : null;
      const consumedCostUsd = measuredUsage
        ? usageToCostUsd(measuredUsage, costRates)
        : undefined;
      await reconcileQuotaConsumption({
        save: aiContext.save,
        usage: aiContext.usage,
        featureName: "ai_chat",
        reservedTokens: boundedRequest.reservedTokens,
        actualTokens: measuredUsage
          ? usageToQuotaTokens(measuredUsage, costRates)
          : boundedRequest.reservedTokens,
        ...(consumedCostUsd === undefined
          ? {}
          : {
              actualCostUsd: consumedCostUsd,
              blendedCostPerTokenUsd: costRates.blendedCostPerTokenUsd,
            }),
        reconcileUsage: aiContext.reconcileUsage,
      });

      sendJson(res, 200, data);
    }
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
