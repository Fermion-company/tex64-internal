const {
  buildUsageFromQuota,
  extractUsageMetadata,
  resolveResponseModel,
  buildAiBlockedMessage,
  extractInlineText,
} = require("./misc-platform-utils.cjs");

const createApiGhostCompletionHandler = ({
  platformService,
  emitPlatformAiAccess,
  ensureUserSettings,
  apiUsageService,
  sendToRenderer,
  ghostCompletionDisabled = true,
}) => {
  return async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) {
      return;
    }
    if (ghostCompletionDisabled) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: true,
        text: "",
      });
      return;
    }
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
    const timeoutMs =
      typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : 3500;
    const maxOutputTokens =
      typeof payload.maxOutputTokens === "number" && Number.isFinite(payload.maxOutputTokens)
        ? payload.maxOutputTokens
        : 40;
    const temperature =
      typeof payload.temperature === "number" && Number.isFinite(payload.temperature)
        ? payload.temperature
        : 0.2;
    const topP =
      typeof payload.topP === "number" && Number.isFinite(payload.topP) ? payload.topP : 0.9;
    const topK =
      typeof payload.topK === "number" && Number.isFinite(payload.topK) ? payload.topK : 40;
    const agentSettings = await ensureUserSettings().getAgentSettings().catch(() => null);
    const chatModel =
      typeof agentSettings?.model === "string" && agentSettings.model.trim()
        ? agentSettings.model.trim()
        : "gpt-4o-mini";
    const inlineModel =
      typeof agentSettings?.inlineModel === "string" && agentSettings.inlineModel.trim()
        ? agentSettings.inlineModel.trim()
        : chatModel;

    if (platformService) {
      const access = await emitPlatformAiAccess(false, "completion");
      if (!access?.allowed) {
        sendToRenderer("api:completionResult", {
          requestId,
          ok: false,
          error: buildAiBlockedMessage(access),
        });
        return;
      }
    }

    if (!prompt.trim()) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: "empty prompt",
      });
      return;
    }

    if (!platformService || typeof platformService.requestAiCompletion !== "function") {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: "AI補完バックエンドが利用できません。",
      });
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(800, timeoutMs));
    try {
      const completion = await platformService.requestAiCompletion(
        {
          model: inlineModel,
          prompt,
          prefix,
          maxOutputTokens,
          temperature,
          topP,
          topK,
          timeoutMs,
        },
        { signal: controller.signal }
      );
      const response =
        completion?.raw && typeof completion.raw === "object"
          ? {
              ...completion.raw,
              ...(completion?.resolvedModel ? { resolvedModel: completion.resolvedModel } : {}),
            }
          : completion?.raw ?? null;
      const rawText = typeof completion?.text === "string" ? completion.text : "";
      const platformUsage = buildUsageFromQuota(
        completion?.quota ?? null,
        completion?.plan ?? null,
        "completion"
      );
      if (platformUsage) {
        sendToRenderer("platform:usage", platformUsage);
      }
      const text = extractInlineText(rawText, prefix);

      let usageSnapshot = null;
      const usage = extractUsageMetadata(response);
      if (apiUsageService && usage) {
        usageSnapshot = await apiUsageService.recordUsage({
          model: resolveResponseModel(response) || "unknown",
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: "inline",
        });
        if (usageSnapshot) {
          sendToRenderer("api:usage", { snapshot: usageSnapshot });
        }
      }

      sendToRenderer("api:completionResult", {
        requestId,
        ok: true,
        text,
        usageSnapshot: usageSnapshot ?? undefined,
      });
    } catch (error) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: error?.message ?? "api error",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
};

module.exports = {
  createApiGhostCompletionHandler,
};
