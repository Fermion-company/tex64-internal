/**
 * Chat titles written by the model.
 *
 * The first reply of a Code chat triggers one small, non-streaming request:
 * a few words naming what the chat is about, in the user's language. The
 * title lands in the session metadata, is persisted with the session, and is
 * pushed to the renderer as `agent:title`. A failure leaves the client-side
 * fallback (the first words of the request) in place.
 */

"use strict";

const {
  isOfficialPlatformProxyUrl,
  normalizeChatEndpoint,
  resolveLLMConfig,
} = require("./openprism/llm-config.cjs");
// run-loop requires this module; load it lazily to keep the cycle harmless.
const runLoop = () => require("./openprism/run-loop.cjs");

const TITLE_MAX_CHARS = 40;
const TITLE_MAX_COMPLETION_TOKENS = 24;
const TITLE_LANGUAGE_HINT = {
  ja: "日本語で",
  en: "in English",
  zh: "用简体中文",
  ko: "한국어로",
  de: "auf Deutsch",
  fr: "en français",
  es: "en español",
};

const cleanTitle = (raw) => {
  const text = String(raw ?? "")
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:title\s*[:：]\s*)/i, "")
    .replace(/^["'「『“”]+|["'」』“”.。]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
};

const setConversationTitle = (service, conversationId, title) => {
  const now = Date.now();
  const meta = service.sessionMetaByConversation.get(conversationId) ?? { createdAt: now, updatedAt: now };
  meta.title = title;
  service.sessionMetaByConversation.set(conversationId, meta);
  service.markSessionDirty(conversationId);
  service.sendToRenderer("agent:title", { conversationId, title });
};

const generateConversationTitle = async (
  service,
  { conversationId, userText, replyText, locale, settings },
) => {
  const request = String(userText ?? "").trim().slice(0, 1_200);
  if (!request) return null;
  const reply = String(replyText ?? "").trim().slice(0, 600);
  const llmConfig = resolveLLMConfig(settings ?? (await service.ensureUserSettings().getAgentSettings()));
  const apiUrl = normalizeChatEndpoint(llmConfig.endpoint);
  const { requiresReasoningNoneForChatTools, resolveRequestIdentity } = runLoop();
  const { accessToken, deviceId } = await resolveRequestIdentity(service, apiUrl, settings ?? {});
  const language = TITLE_LANGUAGE_HINT[locale] ?? "in the language of the request";
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(deviceId ? { "X-Tex64-Device-Id": deviceId } : {}),
      ...(isOfficialPlatformProxyUrl(apiUrl) ? { "X-Tex64-Turn-Remaining-Tokens": "4000" } : {}),
    },
    body: JSON.stringify({
      model: llmConfig.model,
      messages: [
        {
          role: "system",
          content:
            `Write a title for a chat between a user and a LaTeX writing assistant: 3 to 6 words ${language}, ` +
            "naming the subject of the request (the section, problem, or task). No quotes, no trailing period, no explanation. Output the title only.",
        },
        {
          role: "user",
          content: `Request:\n${request}${reply ? `\n\nAssistant's reply (excerpt):\n${reply}` : ""}`,
        },
      ],
      ...(requiresReasoningNoneForChatTools(llmConfig.model) ? { reasoning_effort: "none" } : {}),
      stream: false,
      max_completion_tokens: TITLE_MAX_COMPLETION_TOKENS,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const title = cleanTitle(data?.choices?.[0]?.message?.content);
  if (!title) return null;
  if (data?.usage && service.apiUsageService?.recordUsage) {
    service.apiUsageService
      .recordUsage({
        model: llmConfig.model,
        promptTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
        source: "title",
      })
      .catch(() => {});
  }
  // The chat may have been deleted while the title was on its way.
  if (service.deletedConversations?.has(conversationId)) return null;
  setConversationTitle(service, conversationId, title);
  return title;
};

module.exports = { generateConversationTitle, setConversationTitle, cleanTitle };
