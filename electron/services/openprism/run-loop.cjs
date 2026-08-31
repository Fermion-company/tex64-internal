/**
 * Agent Run Loop — Direct OpenAI-compatible API (no LangChain).
 *
 * Architecture:
 *   1. Direct fetch to OpenAI-compatible /chat/completions endpoint
 *   2. tool_choice defaults to "auto" — LLM freely decides text vs tools
 *   3. Simple loop: call API → if tool_calls, execute → loop; if text → done
 *   4. Workspace-bound tools for LaTeX editing, including compile_document
 *      through TeX64's build service (never a raw latexmk shell invocation)
 *   5. Simple system prompt (matching OpenPrism)
 *
 * API transport: fetch → tex64.com proxy → OpenAI-compatible LLM
 * Auth: JWT from platformAccess when signed in, otherwise a stable device ID
 * for the anonymous one-time allowance. TEX64_LLM_API_KEY remains an env var
 * fallback for local/private endpoints.
 */

"use strict";

const { buildTools } = require("./tools.cjs");
const {
  OFFICIAL_PLATFORM_CHAT_ENDPOINT,
  isOfficialPlatformProxyUrl,
  normalizeChatEndpoint,
  resolveLLMConfig,
  resolveOwnApiKey,
} = require("./llm-config.cjs");
const {
  MAX_AGENT_TOKENS_PER_RUN,
  buildReplayHistory,
  compactRequestMessages,
  planNextRequest,
  resolveMaxAgentIterations,
} = require("./run-budget.cjs");
const { normalizeUserMessageParts } = require("../agent-message-parts.cjs");
const { extractTextFromParts } = require("../agent-core-utils.cjs");
const { buildSystemPrompt } = require("../agent-prompt-utils.cjs");

const requiresReasoningNoneForChatTools = (model) => {
  if (typeof model !== "string") return false;
  const normalized = model.trim();
  return /^Axiom1\.0(?:$|-)/i.test(normalized) || /^gpt-5\.6(?:$|-)/i.test(normalized);
};

const TURN_REMAINING_TOKENS_HEADER = "X-Tex64-Turn-Remaining-Tokens";

const parseToolResult = (value) => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const compileResultSucceeded = (value) => {
  const parsed = parseToolResult(value);
  return parsed?.status === "success" && typeof parsed?.error !== "string";
};

const writeToolResultApplied = (value) => {
  const parsed = parseToolResult(value);
  if (!parsed) return false;
  if (parsed.writeApplied === true || parsed.status === "applied") return true;
  return (
    parsed.status === "partially_applied" &&
    Array.isArray(parsed.files) &&
    parsed.files.some((entry) => entry?.ok === true)
  );
};

const COMPILE_FAILURE_SUFFIXES = Object.freeze({
  en: " Changes made so far were saved, but a compilation error remains.",
  ja: "ここまでの変更は保存しましたが、組版エラーが残っています。",
  zh: " 已保存目前的更改，但仍有编译错误。",
  ko: " 지금까지의 변경 사항은 저장했지만 컴파일 오류가 남아 있습니다.",
  fr: " Les modifications ont été enregistrées, mais une erreur de compilation subsiste.",
  de: " Die bisherigen Änderungen wurden gespeichert, aber ein Kompilierungsfehler bleibt bestehen.",
  es: " Los cambios se guardaron, pero aún queda un error de compilación.",
});

const localizedCompileFailureSuffix = (locale) =>
  COMPILE_FAILURE_SUFFIXES[locale] || COMPILE_FAILURE_SUFFIXES.en;

const abortError = () => {
  const error = new Error("The Axiom turn was aborted.");
  error.name = "AbortError";
  return error;
};

const awaitAbortable = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

const abortableDelay = (delayMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("The Axiom turn was aborted.");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("The Axiom turn was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const buildChatRequestBody = ({
  model,
  messages,
  tools,
  temperature,
  maxCompletionTokens,
}) => ({
  model,
  messages,
  tools,
  ...(requiresReasoningNoneForChatTools(model)
    ? { reasoning_effort: "none" }
    : {}),
  stream: true,
  stream_options: { include_usage: true },
  ...(Number.isInteger(maxCompletionTokens) && maxCompletionTokens > 0
    ? { max_completion_tokens: maxCompletionTokens }
    : {}),
  ...(typeof temperature === "number" ? { temperature } : {}),
});

const resolveRequestIdentity = async (service, apiUrl, settings = {}, signal) => {
  if (!isOfficialPlatformProxyUrl(apiUrl)) {
    const ownApiKey = resolveOwnApiKey(settings);
    if (!ownApiKey) {
      const error = new Error(
        "A custom AI endpoint requires its own API key (agent apiKey or TEX64_LLM_API_KEY)."
      );
      error.code = "CUSTOM_LLM_API_KEY_REQUIRED";
      throw error;
    }
    return { accessToken: ownApiKey, deviceId: null };
  }

  let accessToken = null;
  let deviceId = null;
  if (service.platformAccess) {
    try {
      accessToken = await awaitAbortable(
        service.platformAccess.refreshAccessToken(false),
        signal,
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
    try {
      deviceId = await awaitAbortable(service.platformAccess.ensureDeviceId(), signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
  }
  if (!accessToken && !deviceId) throw new Error("Axiom requires either login or a local app identity. Please restart TeX64 and try again.");
  return { accessToken, deviceId };
};

const completeSingleChat = async (service, { system, user }) => {
  if (typeof system !== "string" || typeof user !== "string" || !user.trim()) throw new Error("AI edit input is empty.");
  const settings = await service.ensureUserSettings().getAgentSettings();
  const llmConfig = resolveLLMConfig(settings);
  const apiUrl = normalizeChatEndpoint(llmConfig.endpoint);
  const { accessToken, deviceId } = await resolveRequestIdentity(service, apiUrl, settings);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}),
      ...(deviceId ? { "X-Tex64-Device-Id": deviceId } : {}),
      ...(isOfficialPlatformProxyUrl(apiUrl)
        ? { [TURN_REMAINING_TOKENS_HEADER]: String(MAX_AGENT_TOKENS_PER_RUN) }
        : {}),
    },
    body: JSON.stringify({
      model: llmConfig.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(requiresReasoningNoneForChatTools(llmConfig.model) ? { reasoning_effort: "none" } : {}),
      stream: false,
      ...(typeof llmConfig.temperature === "number" ? { temperature: llmConfig.temperature } : {}),
    }),
  });
  if (!response.ok) throw new Error(`API error ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Axiom returned an empty response.");
  if (data.usage && service.apiUsageService?.recordUsage) {
    await service.apiUsageService.recordUsage({ model: llmConfig.model, promptTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0, totalTokens: data.usage.total_tokens || 0, source: "stash" }).catch(() => {});
  }
  return text;
};

const runAgentConversation = async (
  service,
  {
    message,
    parts,
    context,
    conversationId = "default",
    forcePlatformAxiom = false,
  },
  prestartedRun = null,
) => {
  const targetConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : "default";

  // ---- Validate workspace ----
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    service.sendToRenderer("agent:error", {
      message: "No workspace is selected.",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "No workspace is selected.", targetConversationId);
    return;
  }

  // ---- Parse user input ----
  const userParts = normalizeUserMessageParts(message, parts);
  if (!userParts) {
    service.sendToRenderer("agent:error", {
      message: "Input is empty.",
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "Input is empty.", targetConversationId);
    return;
  }
  const userText = extractTextFromParts(userParts);
  const userImages = userParts
    .filter((p) => p?.inlineData?.mimeType?.startsWith("image/") && p?.inlineData?.data)
    .map((p) => ({
      type: "image_url",
      image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
    }));

  // ---- Build LLM input with context (sent to model, NOT stored in history) ----
  const llmInputParts = [];
  if (context?.activeFilePath) {
    llmInputParts.push(`Active file: ${context.activeFilePath}`);
  }
  llmInputParts.push(`User prompt: ${userText}`);
  if (
    context?.activeSelection &&
    typeof context.activeSelection.text === "string" &&
    context.activeSelection.text.trim()
  ) {
    llmInputParts.push(`Selection:\n${context.activeSelection.text}`);
  }
  const llmInput = llmInputParts.filter(Boolean).join("\n\n");

  // Register before the first awaited preflight operation. Stop, window
  // reattach, and workspace transitions must be able to address this turn
  // even while settings or platform identity are still loading.
  const run = prestartedRun ?? service.startConversationRun(targetConversationId);
  const isCurrentRun = () =>
    service.isRunCurrent(targetConversationId, run.token);
  const throwIfRunAborted = () => {
    if (!run.controller.signal.aborted) return;
    const error = new Error("The Axiom turn was aborted.");
    error.name = "AbortError";
    throw error;
  };
  const assertWorkspaceCurrent = () => {
    if (service.workspace.getRootPath() !== rootPath) {
      const error = new Error(
        "The workspace changed during this Axiom turn. The turn was stopped; retry in the current workspace."
      );
      error.code = "AGENT_WORKSPACE_CHANGED";
      throw error;
    }
  };

  let options;
  let conversation;
  let llmConfig;
  let apiUrl;
  let accessToken;
  let deviceId;
  let toolDefinitions;
  let messages;
  const toolExecutors = new Map();

  try {
    // ---- Resolve settings & policy ----
    if (!prestartedRun) {
      service.sendStatus("running", "Preparing...", targetConversationId);
    }
    throwIfRunAborted();
    const persistedSettings = await awaitAbortable(
      service.ensureUserSettings().getAgentSettings(),
      run.controller.signal,
    );
    throwIfRunAborted();
    assertWorkspaceCurrent();
    const persistedModel =
      persistedSettings?.model === "Axiom1.0-pro" ? "Axiom1.0-pro" : "Axiom1.0";
    const settings = forcePlatformAxiom
      ? {
          ...persistedSettings,
          model: persistedModel,
          endpoint: OFFICIAL_PLATFORM_CHAT_ENDPOINT,
          apiKey: "",
        }
      : persistedSettings;
    const policy = service.resolveAgentPolicy(settings);
    options = service.resolveAgentOptions(settings);
    service.contextByConversation.set(targetConversationId, context ?? {});

    // ---- Build conversation history ----
    conversation = service.buildConversation(targetConversationId);
    service.workspaceRootByConversation.set(targetConversationId, rootPath);

    // ---- Resolve LLM config and platform identity ----
    llmConfig = resolveLLMConfig(settings);
    apiUrl = normalizeChatEndpoint(llmConfig.endpoint);
    ({ accessToken, deviceId } = await resolveRequestIdentity(
      service,
      apiUrl,
      settings,
      run.controller.signal,
    ));
    throwIfRunAborted();
    assertWorkspaceCurrent();

    // ---- Build tools ----
    const tools = buildTools(service, targetConversationId, policy, {
      rootPath,
      context: context ?? {},
      signal: run.controller.signal,
    });
    toolDefinitions = tools.map((tool) => ({
      type: tool.type,
      function: tool.function,
    }));
    for (const tool of tools) {
      toolExecutors.set(tool.function.name, tool.execute);
    }

    // ---- Build system prompt and bounded history ----
    const system = `${buildSystemPrompt(context, rootPath)}

COMPILATION (MANDATORY):
- Compile LaTeX only with compile_document. General shell execution is not
  available to the product agent.
- compile_document without arguments builds this turn's active document,
  including a document nested inside the workspace, and returns real compiler
  issues and a useful log excerpt. Use those results for the autonomous
  build-error fix cycle.`;
    const chatHistory = buildReplayHistory(conversation);

    // ---- Store user message in conversation (clean text only) ----
    conversation.push({ role: "user", content: userText });
    service.markSessionDirty(targetConversationId);

    const userContent = userImages.length > 0
      ? [{ type: "text", text: llmInput }, ...userImages]
      : llmInput;
    messages = [
      { role: "system", content: system },
      ...chatHistory,
      { role: "user", content: userContent },
    ];
    service.sendStatus("running", "Thinking...", targetConversationId);
  } catch (error) {
    if (isCurrentRun()) {
      if (error?.name === "AbortError" || run.controller.signal.aborted) {
        service.sendStatus("idle", "Aborted.", targetConversationId);
      } else {
        const errorMessage =
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Axiom could not start. Please restart TeX64 and try again.";
        service.sendToRenderer("agent:error", {
          message: errorMessage,
          conversationId: targetConversationId,
        });
        service.sendStatus("error", errorMessage, targetConversationId);
      }
    }
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);
    return;
  }

  // Token totals are read in the finally block below, so they must be
  // declared OUTSIDE the try: declaring them inside made the finally throw
  // ReferenceError and silently skip local usage recording on every run.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let needsCompile = false;
  let lastCompileFailed = false;
  const compileFailureMessage = localizedCompileFailureSuffix(
    context?.uiLocale,
  ).trim();
  const sendCompileFailure = () => {
    service.sendToRenderer("agent:error", {
      message: compileFailureMessage,
      conversationId: targetConversationId,
    });
  };
  const compilePendingChanges = async () => {
    if (lastCompileFailed) return "failed";
    if (!needsCompile) return "unchanged";
    const compile = toolExecutors.get("compile_document");
    if (!compile) {
      needsCompile = false;
      lastCompileFailed = true;
      return "failed";
    }
    try {
      assertWorkspaceCurrent();
      const result = await compile({});
      assertWorkspaceCurrent();
      needsCompile = false;
      lastCompileFailed = !compileResultSucceeded(result);
      return lastCompileFailed ? "failed" : "ok";
    } catch (error) {
      // A terminal handler may call this helper again after the exception.
      // Record the failed attempt first so it cannot compile the same source
      // twice while preserving the original error for the caller.
      needsCompile = false;
      lastCompileFailed = true;
      throw error;
    }
  };
  const settlePendingChangesAfterInterruption = async () => {
    try {
      return await compilePendingChanges();
    } catch {
      return "failed";
    }
  };

  try {
    // ---- Agent loop ----
    const maxIterations = resolveMaxAgentIterations(options.maxIterations);
    let iterations = 0;
    let platformBudgetAtStart = null;
    let usageWasMeasurable = true;
    const toolErrorHistory = []; // Track consecutive identical errors for loop detection

    // Track write tool usage across the entire run so we can verify that
    // the final assistant message matches what actually happened. The E2E
    // test showed the LLM would report "I added the Preliminaries content"
    // after making zero tool calls. We refuse to let such hallucinated
    // success reach the user.
    const WRITE_TOOL_NAMES = new Set([
      "write_file",
      "create_file",
      "apply_patch",
      "replace_lines",
      "insert_lines",
      "delete_lines",
      "replace_section",
      "append_to_section",
    ]);
    const writeToolInvocations = [];
    // Regexes matching "modification claim" phrasing in the final assistant
    // message. If we see one of these but the run made ZERO write tool
    // calls, we treat the turn as a hallucination and loop the agent back
    // with a corrective system message.
    const MODIFICATION_CLAIM_PATTERNS = [
      // English
      /\b(?:I(?:'ve| have)?|I'll|let me|i just)\s+(?:added|inserted|updated|modified|changed|created|wrote|filled(?:\s+in)?|replaced|removed|deleted|fixed|refactored|renamed|rewrote|expanded|appended)\b/i,
      /\b(?:added|inserted|updated|modified|changed|created|wrote|filled(?:\s+in)?|replaced|removed|deleted|fixed|rewrote|expanded|appended)\s+(?:the|a|an)\b/i,
      /\b(?:has been|have been)\s+(?:added|inserted|updated|modified|changed|created|written|filled(?:\s+in)?|replaced|removed|deleted|fixed|rewrote|expanded|appended)\b/i,
      // Japanese — requires an edit verb before the past-tense ending. (A
      // bare /(?:しました|…)\b/ pattern used to sit here, but \b after kana
      // only matches when an ASCII word char follows, so it was dead code —
      // and its intended broad form would flag ANY polite past sentence.)
      /(?:追加|挿入|更新|変更|作成|書[きい]|記述|修正|置換|削除|リファクタ|名称?変更|書き換え|書き加え|埋め)(?:しました|されました|ました|した)/,
      // Chinese (Simplified) — past-tense action confirmations: 已 + verb, 完成
      /已(?:添加|新增|插入|更新|修改|更改|创建|写入|编写|替换|移除|删除|修复|重构|重命名|改名|重写|扩展|追加|应用|完成)/,
      /(?:添加|新增|插入|更新|修改|更改|创建|写入|编写|替换|移除|删除|修复|重构|重命名|改名|重写|扩展|追加|应用)了/,
      // Korean — completed-action endings on common edit verbs
      /(?:추가|삽입|갱신|업데이트|수정|변경|생성|작성|기록|교체|치환|제거|삭제|수정|리팩터링|이름\s?변경|개명|재작성|확장|추가\s?작성|적용|완료)(?:했(?:습니다|어요|다)|됐(?:습니다|어요|다)|되었(?:습니다|어요|다)|했음|함)/,
      // German — Ich habe ... ge<verb>; X wurde/wurden ge<verb>
      /\bIch\s+(?:habe|hab)\b[\s\S]{0,80}?\b(?:hinzugefügt|eingefügt|aktualisiert|geändert|modifiziert|erstellt|geschrieben|ersetzt|entfernt|gelöscht|behoben|umbenannt|umgeschrieben|erweitert|angehängt|angewendet)\b/i,
      /\b(?:wurde|wurden|ist|sind)\s+(?:hinzugefügt|eingefügt|aktualisiert|geändert|modifiziert|erstellt|geschrieben|ersetzt|entfernt|gelöscht|behoben|umbenannt|umgeschrieben|erweitert|angehängt|angewendet)\b/i,
      // French — J'ai ... <verbe>; X a été <verbe>
      // (Trailing \b dropped: most past participles end in `é` which is not in
      // ASCII \w, so \b fails. Using \p{L} lookahead with the `u` flag instead.)
      /\bJ['’]ai\b[\s\S]{0,80}?(?:ajouté|inséré|mis\s+à\s+jour|modifié|changé|créé|écrit|rempli|remplacé|retiré|supprimé|corrigé|refactorisé|renommé|réécrit|étendu|appliqué)(?!\p{L})/iu,
      /\b(?:a|ont)\s+été\s+(?:ajouté|inséré|mis\s+à\s+jour|modifié|changé|créé|écrit|rempli|remplacé|retiré|supprimé|corrigé|refactorisé|renommé|réécrit|étendu|appliqué)e?s?(?!\p{L})/iu,
      // Spanish — He ... <verbo>; X ha sido / se ha <verbo>
      /\bHe\b[\s\S]{0,80}?\b(?:añadido|agregado|insertado|actualizado|modificado|cambiado|creado|escrito|rellenado|reemplazado|eliminado|borrado|corregido|refactorizado|renombrado|reescrito|ampliado|aplicado)\b/i,
      /\b(?:ha\s+sido|han\s+sido|se\s+ha|se\s+han)\s+(?:añadido|agregado|insertado|actualizado|modificado|cambiado|creado|escrito|rellenado|reemplazado|eliminado|borrado|corregido|refactorizado|renombrado|reescrito|ampliado|aplicado)s?\b/i,
    ];
    let halluciationRetryCount = 0;
    const MAX_HALLUCINATION_RETRIES = 2;

    const readFreshPlatformBudget = async () => {
      if (
        !isOfficialPlatformProxyUrl(apiUrl) ||
        typeof service.platformAccess?.checkAiAccess !== "function"
      ) {
        return { allowed: true, remainingTokens: null, reason: null };
      }
      const access = await awaitAbortable(
        service.platformAccess.checkAiAccess({ force: true }),
        run.controller.signal,
      );
      const remaining = Number(access?.quota?.remainingTokens);
      return {
        allowed: access?.allowed === true,
        remainingTokens:
          Number.isFinite(remaining) && remaining >= 0
            ? Math.floor(remaining)
            : null,
        reason: typeof access?.reason === "string" ? access.reason : null,
      };
    };

    const settleWithoutAnotherModelCall = async (kind) => {
      const compileState = await compilePendingChanges();
      if (!isCurrentRun()) return;

      const copy = {
        en: {
          iterations: `Reached the processing limit (${iterations} iterations), so Axiom stopped here.`,
          quota: "Axiom stopped before another AI call because the available token limit was reached.",
          access: "Axiom became unavailable and stopped before another AI call.",
          turn_budget: "Axiom stopped before another AI call at this turn's processing limit.",
          compiled: " Changes made so far were saved and compiled.",
        },
        ja: {
          iterations: `処理の上限（${iterations}回）に達したため、ここで区切りました。`,
          quota: "利用可能なトークン上限に達したため、次のAI呼び出し前に停止しました。",
          access: "Axiomを利用できない状態になったため、次のAI呼び出し前に停止しました。",
          turn_budget: "このターンの処理上限に達したため、次のAI呼び出し前に停止しました。",
          compiled: "ここまでの変更は保存し、組版結果まで反映しました。",
        },
        zh: {
          iterations: `已达到处理上限（${iterations} 次），Axiom 已在此停止。`,
          quota: "可用 token 已达到上限，Axiom 在下一次 AI 调用前停止。",
          access: "Axiom 当前不可用，已在下一次 AI 调用前停止。",
          turn_budget: "本轮处理已达到上限，Axiom 在下一次 AI 调用前停止。",
          compiled: " 已保存目前的更改并完成编译。",
        },
        ko: {
          iterations: `처리 한도(${iterations}회)에 도달해 여기서 중지했습니다.`,
          quota: "사용 가능한 토큰 한도에 도달해 다음 AI 호출 전에 중지했습니다.",
          access: "Axiom을 사용할 수 없어 다음 AI 호출 전에 중지했습니다.",
          turn_budget: "이번 턴의 처리 한도에 도달해 다음 AI 호출 전에 중지했습니다.",
          compiled: " 지금까지의 변경 사항을 저장하고 컴파일했습니다.",
        },
        fr: {
          iterations: `Limite de traitement atteinte (${iterations} itérations) ; Axiom s’est arrêté ici.`,
          quota: "La limite de tokens disponible est atteinte ; Axiom s’est arrêté avant un nouvel appel IA.",
          access: "Axiom est devenu indisponible et s’est arrêté avant un nouvel appel IA.",
          turn_budget: "La limite de ce tour est atteinte ; Axiom s’est arrêté avant un nouvel appel IA.",
          compiled: " Les modifications effectuées ont été enregistrées et compilées.",
        },
        de: {
          iterations: `Verarbeitungslimit erreicht (${iterations} Durchläufe); Axiom wurde hier beendet.`,
          quota: "Das verfügbare Token-Limit ist erreicht; Axiom wurde vor einem weiteren KI-Aufruf beendet.",
          access: "Axiom ist nicht mehr verfügbar und wurde vor einem weiteren KI-Aufruf beendet.",
          turn_budget: "Das Verarbeitungslimit dieses Durchlaufs ist erreicht; Axiom wurde vor einem weiteren KI-Aufruf beendet.",
          compiled: " Die bisherigen Änderungen wurden gespeichert und kompiliert.",
        },
        es: {
          iterations: `Se alcanzó el límite de procesamiento (${iterations} iteraciones); Axiom se detuvo aquí.`,
          quota: "Se alcanzó el límite de tokens disponible; Axiom se detuvo antes de otra llamada de IA.",
          access: "Axiom dejó de estar disponible y se detuvo antes de otra llamada de IA.",
          turn_budget: "Se alcanzó el límite de esta ejecución; Axiom se detuvo antes de otra llamada de IA.",
          compiled: " Los cambios realizados se guardaron y compilaron.",
        },
      };
      const localized = copy[context?.uiLocale] || copy.en;
      const base = localized[kind] || localized.turn_budget;
      const suffix =
        compileState === "ok"
          ? localized.compiled
          : compileState === "failed"
            ? localizedCompileFailureSuffix(context?.uiLocale)
            : "";
      const reply = `${base}${suffix}`;
      conversation.push({ role: "assistant", content: reply });
      service.markSessionDirty(targetConversationId);
      service.sendToRenderer("agent:message", {
        text: reply,
        conversationId: targetConversationId,
      });
      if (compileState === "failed") {
        sendCompileFailure();
      }
      service.sendStatus(
        kind === "quota" || kind === "access" ? "error" : "resumable",
        kind === "quota"
          ? "Token limit reached"
          : kind === "access"
            ? "Axiom unavailable"
            : "Paused",
        targetConversationId,
      );
    };

    while (iterations < maxIterations) {
      if (!isCurrentRun()) return;
      throwIfRunAborted();
      assertWorkspaceCurrent();

      const platformBudget = await readFreshPlatformBudget();
      if (!platformBudget.allowed) {
        await settleWithoutAnotherModelCall(
          platformBudget.reason === "QUOTA_EXCEEDED" ? "quota" : "access",
        );
        return;
      }
      if (
        platformBudgetAtStart === null &&
        platformBudget.remainingTokens !== null
      ) {
        platformBudgetAtStart = platformBudget.remainingTokens;
      }
      const localRemaining = Math.max(
        0,
        Math.min(
          MAX_AGENT_TOKENS_PER_RUN,
          platformBudgetAtStart ?? MAX_AGENT_TOKENS_PER_RUN,
        ) -
          totalPromptTokens -
          totalCompletionTokens,
      );
      // Provider token counts are not cost-equivalent across input/output or
      // Axiom tiers. The server quota is already normalized from actual
      // provider cost into the token units shown to users, so its per-run
      // delta is the authoritative cost boundary for official proxy calls.
      const normalizedQuotaSpent =
        platformBudgetAtStart !== null &&
        platformBudget.remainingTokens !== null
          ? Math.max(
              0,
              platformBudgetAtStart - platformBudget.remainingTokens,
            )
          : 0;
      const normalizedTurnRemaining = Math.max(
        0,
        MAX_AGENT_TOKENS_PER_RUN - normalizedQuotaSpent,
      );
      const effectiveRemaining = Math.min(
        localRemaining,
        normalizedTurnRemaining,
        platformBudget.remainingTokens ?? Number.POSITIVE_INFINITY,
      );
      const requestMessages = compactRequestMessages(messages);
      const requestPlan = usageWasMeasurable
        ? planNextRequest({
            remainingTokens: effectiveRemaining,
            messages: requestMessages,
            tools: toolDefinitions,
          })
        : {
            allowed: false,
            reason: "unmeasured_usage",
            maxCompletionTokens: 0,
          };
      if (!requestPlan.allowed) {
        const exhaustedPlatformQuota =
          platformBudget.remainingTokens !== null &&
          platformBudget.remainingTokens <= localRemaining;
        await settleWithoutAnotherModelCall(
          exhaustedPlatformQuota ? "quota" : "turn_budget",
        );
        return;
      }

      iterations += 1;

      // ---- Call OpenAI-compatible API (streaming, with retry for transient errors) ----
      let response;
      // A failed paid POST can be ambiguous: retrying it may buy the same
      // completion twice. Only custom endpoints retain transient retries.
      const maxRetries = isOfficialPlatformProxyUrl(apiUrl) ? 1 : 3;
      const MAX_RETRY_AFTER_SEC = 60; // Give up if server asks to wait longer than this
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (!isCurrentRun()) return;
        throwIfRunAborted();
        assertWorkspaceCurrent();
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}),
            ...(deviceId ? { "X-Tex64-Device-Id": deviceId } : {}),
            ...(isOfficialPlatformProxyUrl(apiUrl)
              ? {
                  [TURN_REMAINING_TOKENS_HEADER]: String(
                    Math.max(0, Math.floor(effectiveRemaining)),
                  ),
                }
              : {}),
          },
          body: JSON.stringify(buildChatRequestBody({
            model: llmConfig.model,
            messages: requestMessages,
            tools: toolDefinitions,
            temperature: llmConfig.temperature,
            maxCompletionTokens: requestPlan.maxCompletionTokens,
          })),
          signal: run.controller.signal,
        });

        if (response.ok) break;

        const errorText = await response.text().catch(() => "");
        const status = response.status;
        console.error(`[run-loop] API error ${status} (attempt ${attempt}/${maxRetries}): ${errorText.slice(0, 500)}`);

        // Parse server-provided Retry-After (header or JSON body's retryAfterSec)
        let retryAfterSec = null;
        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
          const parsed = Number(retryAfterHeader);
          if (Number.isFinite(parsed) && parsed >= 0) {
            retryAfterSec = parsed;
          }
        }
        if (retryAfterSec === null && errorText) {
          try {
            const body = JSON.parse(errorText);
            const bodyRetry = body?.error?.retryAfterSec ?? body?.retryAfterSec;
            if (Number.isFinite(bodyRetry) && bodyRetry >= 0) {
              retryAfterSec = bodyRetry;
            }
          } catch { /* not JSON, ignore */ }
        }

        // If server asks to wait too long (e.g. monthly quota reset), don't retry — surface clearly
        if (status === 429 && retryAfterSec !== null && retryAfterSec > MAX_RETRY_AFTER_SEC) {
          const hours = Math.ceil(retryAfterSec / 3600);
          throw new Error(
            `Rate limit / quota exhausted. Retry after ~${hours}h. ` +
            `Server response: ${errorText.slice(0, 300)}`
          );
        }

        // Retry on 429 (rate limit) or 5xx (server error), but not on 4xx client errors
        if ((status === 429 || status >= 500) && attempt < maxRetries) {
          // Prefer server-provided Retry-After, else fall back to linear backoff
          const fallbackMs = status === 429 ? 5000 * attempt : 2000 * attempt;
          const backoffMs =
            retryAfterSec !== null ? Math.max(1000, retryAfterSec * 1000) : fallbackMs;
          console.log(`[run-loop] Retrying in ${backoffMs}ms (Retry-After=${retryAfterSec ?? "none"})...`);
          await abortableDelay(backoffMs, run.controller.signal);
          continue;
        }

        throw new Error(`API error ${status}: ${errorText.slice(0, 500)}`);
      }

      // ---- Parse response (SSE stream or JSON fallback) ----
      let assistantContent = "";
      const toolCallAccumulators = new Map();
      let iterationPromptTokens = 0;
      let iterationCompletionTokens = 0;
      let iterationUsageSeen = false;

      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE) {
        // ---- SSE streaming path ----
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          if (!isCurrentRun()) return;
          assertWorkspaceCurrent();
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            let chunk;
            try {
              chunk = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            // Capture usage from final SSE chunk (stream_options: include_usage)
            if (chunk.usage) {
              iterationUsageSeen = true;
              iterationPromptTokens = Math.max(
                0,
                Number(chunk.usage.prompt_tokens) || 0,
              );
              iterationCompletionTokens = Math.max(
                0,
                Number(chunk.usage.completion_tokens) || 0,
              );
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content delta
            if (delta.content) {
              assistantContent += delta.content;
              service.sendToRenderer("agent:messageDelta", {
                text: delta.content,
                conversationId: targetConversationId,
              });
            }

            // Tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAccumulators.has(idx)) {
                  toolCallAccumulators.set(idx, {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                  });
                } else {
                  const acc = toolCallAccumulators.get(idx);
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name += tc.function.name;
                  if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                }
              }
            }
          }
        }
      } else {
        // ---- JSON fallback (non-streaming response) ----
        const data = await response.json();
        if (data.usage) {
          iterationUsageSeen = true;
          iterationPromptTokens = Math.max(
            0,
            Number(data.usage.prompt_tokens) || 0,
          );
          iterationCompletionTokens = Math.max(
            0,
            Number(data.usage.completion_tokens) || 0,
          );
        }
        const choice = data.choices?.[0];
        if (choice?.message) {
          assistantContent = choice.message.content || "";
          if (assistantContent) {
            service.sendToRenderer("agent:messageDelta", {
              text: assistantContent,
              conversationId: targetConversationId,
            });
          }
          if (choice.message.tool_calls) {
            for (let i = 0; i < choice.message.tool_calls.length; i++) {
              const tc = choice.message.tool_calls[i];
              toolCallAccumulators.set(i, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }
      }

      totalPromptTokens += iterationPromptTokens;
      totalCompletionTokens += iterationCompletionTokens;
      // Missing usage makes a second paid call unknowable. Complete any tools
      // already returned, then stop before another model request.
      usageWasMeasurable = iterationUsageSeen;

      // ---- Assemble complete assistant message ----
      assertWorkspaceCurrent();
      const toolCalls = [];
      for (const [, acc] of [...toolCallAccumulators.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({
          id: acc.id,
          type: "function",
          function: { name: acc.name, arguments: acc.arguments },
        });
      }
      console.log(`[run-loop] iteration=${iterations} text=${assistantContent.length}chars toolCalls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map(t => t.function.name).join(",")}]` : ""}`);

      const assistantMessage = { role: "assistant", content: assistantContent || null };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      messages.push(assistantMessage);

      // ---- If no tool calls, we're done ----
      if (toolCalls.length === 0) {
        // A successful edit must always reach the real PDF even when the model
        // finishes with prose and forgets to call compile_document. This is a
        // deterministic build only: it never spends another model request.
        // A successful model-triggered compile clears needsCompile, so this
        // path cannot build the same final edit twice.
        const finalCompileState = await compilePendingChanges();
        if (!isCurrentRun()) return;
        const finalCompileFailureMessage =
          finalCompileState === "failed" ? compileFailureMessage : "";
        const reply = [assistantContent, finalCompileFailureMessage]
          .filter((part) => typeof part === "string" && part.trim())
          .join("\n\n");

        // ---- Claim verification ----
        // If the assistant's final message claims a modification but the
        // agent made zero write tool calls during the ENTIRE run, this is
        // a hallucinated success. Reject it and loop back with a corrective
        // system reminder (up to MAX_HALLUCINATION_RETRIES times).
        const claimsModification = MODIFICATION_CLAIM_PATTERNS.some((re) => re.test(reply));
        const madeAnyWrite = writeToolInvocations.length > 0;
        if (
          claimsModification &&
          !madeAnyWrite &&
          halluciationRetryCount < MAX_HALLUCINATION_RETRIES
        ) {
          halluciationRetryCount += 1;
          console.warn(
            `[run-loop] Hallucination detected — message claims a modification but zero write tools were called. ` +
              `Injecting corrective reminder (retry ${halluciationRetryCount}/${MAX_HALLUCINATION_RETRIES}).`
          );
          messages.push({
            role: "user",
            content:
              "SYSTEM: Your last response claims you made a change, but you did not " +
              "actually call any file-editing tool (write_file, replace_lines, " +
              "insert_lines, delete_lines, replace_section, append_to_section, " +
              "apply_patch, or create_file). You MUST call the appropriate tool to " +
              "make the change, then verify by re-reading the file. Do not claim " +
              "success without a real tool call. Retry the user's request now.",
          });
          // Reset streaming buffers and fall through to next iteration
          continue;
        }

        // Store AI response in conversation
        conversation.push({ role: "assistant", content: reply });
        service.markSessionDirty(targetConversationId);

        // Send final message (finalizes streaming element on frontend)
        service.sendToRenderer("agent:message", {
          text: reply || "Done.",
          conversationId: targetConversationId,
        });
        if (finalCompileFailureMessage) {
          // The persisted assistant reply explains the incomplete result after
          // reopen; the error event also makes the live native turn terminally
          // failed so the UI cannot mistake it for a completed build.
          sendCompileFailure();
        }
        service.sendStatus(
          finalCompileState === "failed" ? "resumable" : "idle",
          finalCompileState === "failed" ? "Compilation failed" : "Waiting",
          targetConversationId,
        );
        return;
      }

      // ---- Execute tool calls ----
      for (const toolCall of toolCalls) {
        if (!isCurrentRun()) return;
        throwIfRunAborted();
        assertWorkspaceCurrent();

        const fnName = toolCall.function?.name;
        const executor = toolExecutors.get(fnName);
        let toolResult;

        if (!executor) {
          toolResult = JSON.stringify({ error: `Unknown tool: ${fnName}` });
        } else {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            args = {};
          }
          const abortableReadTools = new Set([
            "read_file",
            "list_files",
            "list_sections",
            "read_section",
            "find_math_region",
            "get_compile_log",
            "arxiv_search",
            "arxiv_bibtex",
            "check_environment",
          ]);
          toolResult = abortableReadTools.has(fnName)
            ? await awaitAbortable(executor(args), run.controller.signal)
            : await executor(args);
          assertWorkspaceCurrent();
        }

        // Add tool result to messages
        const toolResultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResultStr,
        });

        // Track errors for repeated-failure detection
        const isError =
          toolResultStr.includes('"error"') ||
          (fnName === "compile_document" && !compileResultSucceeded(toolResult));
        if (isError) {
          const errorKey = `${fnName}:${toolResultStr}`;
          toolErrorHistory.push(errorKey);
        } else {
          toolErrorHistory.length = 0; // Reset on success
        }

        // A multi-file edit or post-write verification can report an error
        // after bytes were already committed. Compile those partial bytes at
        // the terminal boundary too; the generic `"error"` detector is only
        // about model recovery, not whether the workspace changed.
        const writeApplied =
          WRITE_TOOL_NAMES.has(fnName) && writeToolResultApplied(toolResult);
        if (writeApplied) {
          writeToolInvocations.push({ name: fnName });
          needsCompile = true;
          lastCompileFailed = false;
        }
        if (fnName === "compile_document") {
          const parsedCompileResult = parseToolResult(toolResult);
          const buildWasAttempted =
            parsedCompileResult?.status === "success" ||
            parsedCompileResult?.status === "failure" ||
            parsedCompileResult?.status === "cancelled";
          if (buildWasAttempted) {
            needsCompile = false;
            lastCompileFailed = !compileResultSucceeded(toolResult);
          }
        }
        // Abort is cooperative while a tool is awaited. Record the completed
        // tool first (especially a write), then stop before any sibling tool
        // from the same model response can mutate the workspace.
        throwIfRunAborted();
      }

      // Detect repeated identical tool failures (same tool, same error 3+ times)
      if (toolErrorHistory.length >= 3) {
        const last3 = toolErrorHistory.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          console.warn(`[run-loop] Detected repeated tool failure (3x identical). Injecting recovery hint.`);
          messages.push({
            role: "user",
            content: "SYSTEM: The same tool call has failed 3 times with the same error. " +
              "You MUST try a different approach. If apply_patch keeps failing, use write_file instead " +
              "with the full desired file content. Do NOT retry the same failing tool call.",
          });
          toolErrorHistory.length = 0; // Reset to avoid re-triggering
        }
      }

      // Loop continues — next iteration will call API again with tool results
    }

    // ---- Max iterations reached ----
    // No extra model call is needed to close the turn. If edits are pending,
    // compile them deterministically so the paper still reflects real state.
    await settleWithoutAnotherModelCall("iterations");
  } catch (error) {
    if (error?.name === "AbortError" || run.controller.signal.aborted) {
      if (isCurrentRun()) {
        // A stop can arrive after a write, during the next provider call, or
        // while this window is reattaching. The host remains the single owner
        // of the definitive build attempt, so no UI path has to guess whether
        // a partial edit exists or whether a build already ran.
        const compileState = await settlePendingChangesAfterInterruption();
        if (!isCurrentRun()) return;
        if (compileState === "failed") sendCompileFailure();
        service.sendStatus(
          compileState === "failed" ? "resumable" : "idle",
          compileState === "failed" ? "Compilation failed" : "Aborted.",
          targetConversationId,
        );
      }
      return;
    }
    const errMsg = error?.message ?? "Failed to get response.";
    const compileState = await settlePendingChangesAfterInterruption();
    if (!isCurrentRun()) return;
    service.sendToRenderer("agent:error", {
      message:
        compileState === "failed"
          ? `${errMsg}\n\n${compileFailureMessage}`
          : errMsg,
      conversationId: targetConversationId,
    });
    service.sendStatus("error", "An error has occurred", targetConversationId);
  } finally {
    service.finishConversationRun(targetConversationId, run.token);
    service.markSessionDirty(targetConversationId);

    // Record local usage tracking
    if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
      try {
        if (service.apiUsageService && typeof service.apiUsageService.recordUsage === "function") {
          await service.apiUsageService.recordUsage({
            model: llmConfig.model,
            promptTokens: totalPromptTokens,
            outputTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
            source: "agent",
          });
        }
      } catch { /* usage tracking is best-effort */ }
    }
  }
};

module.exports = {
  buildChatRequestBody,
  completeSingleChat,
  requiresReasoningNoneForChatTools,
  resolveRequestIdentity,
  runAgentConversation,
  writeToolResultApplied,
};
