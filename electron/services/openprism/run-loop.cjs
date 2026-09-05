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

const { buildTools, OPTIONAL_TOOL_GROUPS, WRITE_TOOL_NAMES } = require("./tools.cjs");
const {
  computeSourceFingerprint,
  formatDocumentMapForPrompt,
  resolveMainTexFile,
  scanDocument,
} = require("../agent-document-map.cjs");
const { generateConversationTitle } = require("../agent-conversation-title.cjs");
const { buildUsageFromAccess } = require("../platform-usage-payload.cjs");
const { resolveProposalPages } = require("../agent-proposal-scope.cjs");
const {
  OFFICIAL_PLATFORM_CHAT_ENDPOINT,
  isOfficialPlatformProxyUrl,
  normalizeChatEndpoint,
  resolveLLMConfig,
  resolveOwnApiKey,
} = require("./llm-config.cjs");
const {
  DOCUMENT_MAX_AGENT_ITERATIONS,
  DOCUMENT_TURN_TOKEN_BUDGET,
  MAX_AGENT_TOKENS_PER_RUN,
  buildReplayHistory,
  compactRequestMessages,
  planNextRequest,
  resolveMaxAgentIterations,
} = require("./run-budget.cjs");
const { normalizeUserMessageParts } = require("../agent-message-parts.cjs");
const { extractTextFromParts } = require("../agent-core-utils.cjs");
const fsp = require("fs/promises");
const fsSync = require("fs");

/** Optional trace of loop decisions, for driving the app from a script. */
const traceRunLoop = (entry) => {
  const target = process.env.TEX64_RUN_LOOP_LOG;
  if (!target) return;
  try {
    fsSync.appendFileSync(target, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Tracing never affects the run.
  }
};
const { buildSystemPrompt, buildSurveySystemPrompt } = require("../agent-prompt-utils.cjs");

const requiresReasoningNoneForChatTools = (model) => {
  if (typeof model !== "string") return false;
  const normalized = model.trim();
  return /^Axiom1\.0(?:$|-)/i.test(normalized) || /^gpt-5\.6(?:$|-)/i.test(normalized);
};

const TURN_REMAINING_TOKENS_HEADER = "X-Tex64-Turn-Remaining-Tokens";
const QUOTA_REMAINING_HEADER = "x-tex64-quota-remaining-tokens";

/** Tokens the proxy charges for one call: cached prompt tokens count half. */
const billableTokensOf = (promptTokens, completionTokens, cachedTokens) => {
  const prompt = Math.max(0, promptTokens || 0);
  const completion = Math.max(0, completionTokens || 0);
  const cached = Math.max(0, Math.min(prompt, cachedTokens || 0));
  return prompt - cached + Math.round(cached * 0.5) + completion;
};

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

/**
 * The model declares what its final reply is: "[edit]" when it changed files
 * this turn, "[report]" otherwise. The tag is stripped before display; the
 * declaration replaces the old phrase-matching guess about edit claims.
 */
const REPLY_TAG_PATTERN = /^\s*\[(edit|edits|change|changes|report|answer|question)\]\s*/i;
const REPLY_TAG_MAX_PREFIX = 20;
const replyKindFromTag = (tag) =>
  /^(edit|edits|change|changes)$/i.test(tag) ? "edit" : "report";
const splitReplyTag = (text) => {
  const source = typeof text === "string" ? text : "";
  const match = source.match(REPLY_TAG_PATTERN);
  if (!match) return { kind: null, text: source };
  return { kind: replyKindFromTag(match[1]), text: source.slice(match[0].length) };
};
/** Holds streamed text until a leading tag is resolved, then passes it on. */
const createReplyTagStream = (emit) => {
  let buffer = "";
  let resolved = false;
  let kind = null;
  const settle = (send) => {
    resolved = true;
    if (send) emit(buffer);
    buffer = "";
  };
  return {
    push(delta) {
      if (resolved) {
        emit(delta);
        return;
      }
      buffer += delta;
      const lead = buffer.replace(/^\s+/, "");
      if (!lead) return;
      if (!lead.startsWith("[")) {
        settle(true);
        return;
      }
      if (!lead.includes("]")) {
        if (lead.length > REPLY_TAG_MAX_PREFIX) settle(true);
        return;
      }
      const match = lead.match(REPLY_TAG_PATTERN);
      if (!match) {
        settle(true);
        return;
      }
      kind = replyKindFromTag(match[1]);
      const rest = lead.slice(match[0].length);
      buffer = "";
      resolved = true;
      if (rest) emit(rest);
    },
    flush() {
      if (!resolved) settle(true);
    },
    get kind() {
      return kind;
    },
  };
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

/**
 * The AI mode is a conversation about one document. What only the user knows
 * is asked for, not invented; a finished piece of work hands the next steps
 * back as recorded proposals instead of a dead end.
 */
const DOCUMENT_CONVERSATION_RULES = `

DOCUMENT CONVERSATION (the paper-centred AI mode):
- Writing depends on facts only the user has: the subject, the audience, the
  goal, results, data, deadlines, or a choice between real alternatives. When
  the request needs one of these and the document does not contain it, call
  ask_user with that ONE question (fields for several short facts, options for
  a real choice) and stop; do not edit or compile in that turn. The user's
  next message is the answer.
- When the request carries the answer (for example "答え: ..."), use it and
  write; do not ask again.
- Once the subject, audience and goal are known, every step is writing: put
  a structure into the document as real sections with their first content,
  compile, and report in one or two sentences. Never answer a writing step
  with an outline in prose instead of edits.
- Work economically: an edit tool's result is the proof that it applied. Do
  not re-read the whole file after writing, and do not read it twice in one
  turn; read the section you touch.
- A refused edit is not an edit. If a tool answers with an error (a rejected
  shrink, a protected structure, a missing file), fix the call or say plainly
  what could not be done. Never report a change that did not apply.
- To blank or empty the paper: keep the magic line, \\documentclass and the
  packages, leave \\begin{document} ... \\end{document} with nothing inside
  (no \\maketitle, no \\tableofcontents, no abstract), and write it with
  write_file and allowFullRewrite=true, then compile. The page must come out
  blank; a deleted file cannot be typeset. A new document starts with write_file on
  main.tex (it exists but is empty), using \\documentclass{ltjsarticle} for
  Japanese with "% !TEX program = lualatex" on the first line.
- Never fill a subject, audience, or result with a placeholder or a guess.
- A request that leans on a value you do not have (a deadline, a page or
  word count, a reader level, a title, data) is a question first: call
  ask_user for that value before touching the document.
- Japanese text needs a Japanese-capable setup: with LuaLaTeX use
  \\documentclass{ltjsarticle} (or article plus \\usepackage{luatexja}). Plain
  article with Japanese prints nothing, and "Missing character" in the log
  means exactly that: fix the class or package, do not ignore it.
- Files the user attaches arrive as an "[添付ファイル]" block (images also
  inline). Each is already saved in the workspace at the assets/ path given:
  place an image with \\includegraphics[width=...]{assets/name} (graphicx),
  turn spreadsheet rows into a tabular or pgfplots data, and transcribe the
  text and formulas you can read in an image or PDF faithfully. Use only what
  the file shows; never fill in numbers or facts it does not contain.
- Every turn that does not end in a question ends with propose_next_steps:
  up to 3 next steps in order of value, each with a "line" from list_sections
  where it applies and an "asks" question where the user must decide. There
  is always a next step: continue the document, tighten a section, or ask
  what the user wants next. A reply without next steps is a dead end.`;

/** The next step offered when a turn stops at its processing limit. */
const RESUME_STEP_COPY = {
  ja: { title: "続きから進める", request: "前回のターンは途中で止まりました。文書の現状を確認し、上の依頼の続きから進めてください。", scope: "再開" },
  en: { title: "Continue from where it stopped", request: "The previous turn stopped partway. Check the document's current state and continue the request above from there.", scope: "resume" },
  zh: { title: "从中断处继续", request: "上一回合中途停止。请检查文档现状，从上面请求的中断处继续。", scope: "继续" },
  ko: { title: "멈춘 곳에서 계속", request: "이전 턴이 중간에 멈췄습니다. 문서의 현재 상태를 확인하고 위 요청을 이어서 진행해 주세요.", scope: "재개" },
  de: { title: "Dort weitermachen", request: "Der letzte Durchlauf brach ab. Prüfe den Stand des Dokuments und führe die obige Anfrage von dort fort.", scope: "Fortsetzen" },
  fr: { title: "Reprendre où ça s'est arrêté", request: "Le tour précédent s'est interrompu. Vérifie l'état du document et poursuis la demande ci-dessus.", scope: "reprise" },
  es: { title: "Continuar donde se detuvo", request: "El turno anterior se interrumpió. Revisa el estado del documento y continúa la solicitud anterior desde ahí.", scope: "reanudar" },
};

/** The user asking, in their own message, to blank or reset the document. */
const RESET_REQUEST_PATTERN =
  /真っ白|白紙|まっさら|(?:空|から)に(?:して|戻|し)|全部消し|中身を消し|全て消し|すべて消し|初期化|リセット|\b(?:blank|empty|clear|wipe|reset)\b[^.]{0,40}\b(?:document|paper|page|file|everything)\b|\b(?:document|paper|page|file)\b[^.]{0,40}\b(?:blank|empty|clear|wipe|reset)/i;

/** Tools the opening read may use: reading and recording next steps only. */
const SURVEY_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "list_sections",
  "read_section",
  "find_math_region",
  "get_compile_log",
  "propose_next_steps",
]);

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
  // "survey": the app opened the document and asks where to start. That turn
  // is read-only and ends with recorded next steps.
  const turnOrigin = context?.turnOrigin === "survey" ? "survey" : null;
  // Ask mode: the user is asking, not delegating. Reads only; edits and the
  // compiler are withheld from the tool list and refused if called anyway.
  const askMode = context?.axiomMode === "ask" && turnOrigin !== "survey";
  // Plan mode: read-only like Ask, and the reply carries a recorded plan.
  const planMode = context?.axiomMode === "plan" && turnOrigin !== "survey";
  const readOnlyTurn = askMode || planMode;
  // A step the user picked from the offered ones. A writing step starts with
  // the brief: this turn lists no edit tools, so the agent asks and stops; a
  // mechanical step (build fix, references, formatting) is done at once.
  const stepStart = context?.turnOrigin === "step";
  const briefTurn = stepStart && context?.stepKind !== "mechanical" && !readOnlyTurn;
  // The Code chat: next steps are offered there too, and the reply gets a
  // model-written title the first time a chat is answered.
  const isCodeSurface = !targetConversationId.startsWith("tex64-ai-mode:");
  // The user, in their own words, asking to empty or reset the whole document
  // is the one trusted signal that lets this turn remove protected structure
  // (title, abstract, table of contents). Model output never grants it.
  const userRequestsReset = RESET_REQUEST_PATTERN.test(
    typeof message === "string" ? message : "",
  );
  const takeRecordedNextSteps = () => {
    const recorded = service.nextStepsByConversation?.get(targetConversationId);
    service.nextStepsByConversation?.delete(targetConversationId);
    return Array.isArray(recorded) && recorded.length > 0 ? recorded : null;
  };
  const takePendingQuestion = () => {
    const pending = service.pendingQuestionByConversation?.get(targetConversationId);
    service.pendingQuestionByConversation?.delete(targetConversationId);
    return pending && typeof pending === "object" ? pending : null;
  };
  const hasRecordedNextSteps = () => {
    const recorded = service.nextStepsByConversation?.get(targetConversationId);
    return Array.isArray(recorded) && recorded.length > 0;
  };
  // The reply the model finished with, kept while one more call records the
  // next steps it forgot. That call must not replace the user-facing text.
  let deferredFinalReply = null;
  let nextStepsFollowUps = 0;
  /** The paper-centred AI mode; set once the context is known. */
  let isDocumentConversation = false;

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
    const selection = context.activeSelection;
    const where =
      typeof selection.path === "string" && Number.isFinite(selection.startLine)
        ? ` (${selection.path} L${selection.startLine}-${selection.endLine ?? selection.startLine})`
        : "";
    llmInputParts.push(`Selection${where}:\n${selection.text}`);
  }
  // Items the user pointed at with @: a section, a label, a bib entry, an
  // issue. Each comes with its exact place so the model reads there first.
  const contextRefs = Array.isArray(context?.explicitContextRefs)
    ? context.explicitContextRefs.filter((ref) => ref && typeof ref === "object").slice(0, 12)
    : [];
  if (contextRefs.length > 0) {
    const lines = contextRefs.map((ref) => {
      const at = typeof ref.path === "string" ? `${ref.path}${Number.isFinite(ref.line) ? `:${ref.line}` : ""}` : "";
      switch (ref.kind) {
        case "section":
          return `- section "${ref.title ?? ""}" in ${ref.path} L${ref.line}-${ref.endLine ?? ref.line}${Number.isFinite(ref.id) ? ` (id ${ref.id})` : ""}`;
        case "label":
          return `- label ${ref.key} defined at ${at}`;
        case "bib":
          return `- bib entry ${ref.key} in ${ref.path}${ref.title ? ` ("${ref.title}")` : ""}`;
        case "issue":
          return `- build issue at ${at}: ${ref.message ?? ""}`;
        case "file":
          return `- file ${ref.path}`;
        case "pdf":
          return `- the place the user marked on page ${ref.page} of the typeset PDF${ref.line ? `, which is ${ref.path}:${ref.line} in the source` : ""}${typeof ref.text === "string" && ref.text.trim() ? `; the text there reads: "${ref.text.trim().slice(0, 400)}"` : ""}. "Here" in the request means this place.`;
        default:
          return `- ${JSON.stringify(ref).slice(0, 200)}`;
      }
    });
    llmInputParts.push(`REFERENCED ITEMS (the user pointed at these; start there):\n${lines.join("\n")}`);
  }
  const llmInputHead = llmInputParts.filter(Boolean).join("\n\n");

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
  let settings;
  let documentMap = null;
  let mainTexFile = null;
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
    settings = forcePlatformAxiom
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
    service.nextStepsByConversation?.delete(targetConversationId);
    service.pendingQuestionByConversation?.delete(targetConversationId);

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
    traceRunLoop({ conversationId: targetConversationId, userRequestsReset, userText: userText.slice(0, 80) });
    const tools = buildTools(service, targetConversationId, policy, {
      rootPath,
      context: context ?? {},
      signal: run.controller.signal,
      allowStructuralRemoval: userRequestsReset,
    });
    // The opening read only reads and records next steps; offering fewer
    // tools also keeps its requests small enough for the smallest quota.
    // Ask mode lists no edit or compile tool. Tools that only some turns
    // need (arXiv, environment checks) are listed when the conversation
    // mentions their subject; every tool stays executable if called anyway.
    const conversationText = [
      ...conversation.filter((entry) => entry?.role === "user" && typeof entry.content === "string").slice(-6).map((entry) => entry.content),
      userText,
    ].join("\n");
    const optionalHidden = new Set();
    for (const group of OPTIONAL_TOOL_GROUPS) {
      if (!group.pattern.test(conversationText)) group.names.forEach((name) => optionalHidden.add(name));
    }
    // git_diff exists only where the workspace is a repository; record_plan
    // only in Plan mode.
    const isGitRepo = fsSync.existsSync(require("path").join(rootPath, ".git"));
    const listedTools =
      turnOrigin === "survey"
        ? tools.filter((tool) => SURVEY_TOOL_NAMES.has(tool.function.name))
        : tools.filter((tool) => {
            const name = tool.function.name;
            if (optionalHidden.has(name)) return false;
            if ((readOnlyTurn || briefTurn) && (WRITE_TOOL_NAMES.has(name) || name === "compile_document")) return false;
            if (name === "git_diff" && !isGitRepo) return false;
            if (name === "record_plan" && !planMode) return false;
            if (name === "propose_next_steps" && planMode) return false;
            return true;
          });
    toolDefinitions = listedTools.map((tool) => ({
      type: tool.type,
      function: tool.function,
    }));
    for (const tool of tools) {
      toolExecutors.set(tool.function.name, tool.execute);
    }
    traceRunLoop({ conversationId: targetConversationId, askMode, planMode, stepStart, briefTurn, listedTools: listedTools.map((t) => t.function.name) });
    service.planByConversation?.delete(targetConversationId);

    // ---- Build system prompt and bounded history ----
    isDocumentConversation =
      typeof context?.documentMainFile === "string" && context.documentMainFile.trim() !== "";
    // The project's own writing rules, when the user keeps them in the
    // workspace; they ride with every turn.
    let projectRules = "";
    try {
      projectRules = (await fsp.readFile(require("path").join(rootPath, ".tex64", "rules.md"), "utf8")).trim().slice(0, 4_000);
    } catch {
      projectRules = "";
    }
    const system = turnOrigin === "survey"
      ? buildSurveySystemPrompt(context)
      : `${buildSystemPrompt({ ...(context ?? {}), userInstructions: projectRules }, rootPath, { askMode, planMode, briefTurn, mechanicalStep: stepStart && !briefTurn })}${isDocumentConversation ? DOCUMENT_CONVERSATION_RULES : ""}`;
    const chatHistory = buildReplayHistory(conversation);
    // One deterministic scan of the document travels with the request, so
    // the model edits by section and line range instead of reading files.
    mainTexFile = await resolveMainTexFile(service, context ?? {});
    documentMap = mainTexFile ? await scanDocument(service, mainTexFile) : null;
    const mapText = documentMap ? formatDocumentMapForPrompt(documentMap) : "";
    const llmInput = mapText ? `${llmInputHead}\n\n${mapText}` : llmInputHead;
    traceRunLoop({ conversationId: targetConversationId, documentMap: documentMap ? { files: documentMap.files.length, chars: mapText.length } : null });

    // ---- Store user message in conversation (clean text only) ----
    // The opening read is started by the app, not typed by the user; the
    // transcript keeps it for the model but never shows it.
    conversation.push({
      role: "user",
      content: userText,
      ...(turnOrigin === "survey" ? { hidden: true } : {}),
    });
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
  /** What the proxy charged this turn (its own units), for the local allowance. */
  let totalBillableTokens = 0;
  /** The allowance the proxy reported with its last response, if it did. */
  let quotaRemainingFromHeader = null;
  let needsCompile = false;
  let lastCompileFailed = false;
  /** What the compiler said the last time it failed, for the repair round. */
  let lastCompileReport = "";
  /** Sources at the last successful build in this turn; the same sources are not built again. */
  let compiledFingerprint = null;
  const currentFingerprint = async () => {
    if (!documentMap) return null;
    try {
      return await computeSourceFingerprint(service, documentMap);
    } catch {
      return null;
    }
  };
  /** Pages of this turn's changes, once a build succeeded (for the change card). */
  const markProposalPages = (result) => {
    const parsed = parseToolResult(result);
    const pdfPath = typeof parsed?.pdfPath === "string" ? parsed.pdfPath : "";
    if (!pdfPath) return;
    void resolveProposalPages(service, targetConversationId, pdfPath);
  };
  /** A failed final compile gets this many repair rounds inside the turn. */
  const MAX_COMPILE_REPAIRS = 2;
  let compileRepairCount = 0;
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
      // The same sources build to the same PDF: skip a build that would
      // only repeat the last successful one of this turn.
      const fingerprint = await currentFingerprint();
      if (fingerprint && compiledFingerprint && fingerprint === compiledFingerprint) {
        traceRunLoop({ conversationId: targetConversationId, compileSkipped: "unchanged sources" });
        needsCompile = false;
        return "ok";
      }
      const result = await compile({});
      assertWorkspaceCurrent();
      needsCompile = false;
      lastCompileFailed = !compileResultSucceeded(result);
      if (lastCompileFailed) {
        const report = typeof result === "string" ? result : JSON.stringify(result);
        lastCompileReport = report.length > 2_000 ? `${report.slice(0, 2_000)}…` : report;
      } else {
        compiledFingerprint = fingerprint;
        markProposalPages(result);
      }
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
  /**
   * Japanese text under a plain Latin class prints nothing ("Missing
   * character" for every glyph). That failure has one fix: a Japanese-capable
   * class. Apply it deterministically through the normal edit tool, so undo
   * and the audit see it, and rebuild without spending a model call.
   */
  const JAPANESE_CLASS_FOR = {
    article: "ltjsarticle",
    report: "ltjsreport",
    book: "ltjsbook",
    jarticle: "ltjsarticle",
    jsarticle: "ltjsarticle",
    jreport: "ltjsreport",
    jsbook: "ltjsbook",
    jbook: "ltjsbook",
  };
  const GLYPH_FAILURE = /missing-glyph|Missing character|Unicode character|cannot display/i;
  const repairMissingGlyphSetup = async () => {
    if (!GLYPH_FAILURE.test(lastCompileReport)) return false;
    const mainFile =
      typeof context?.documentMainFile === "string" ? context.documentMainFile.trim() : "";
    const replaceLines = toolExecutors.get("replace_lines");
    if (!mainFile || !replaceLines) return false;
    let source;
    try {
      source = await fsp.readFile(service.workspace.resolvePath(mainFile), "utf8");
    } catch {
      return false;
    }
    if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(source)) return false;
    const lines = source.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*\\documentclass\b/.test(line));
    if (index < 0) return false;
    const match = lines[index].match(/\\documentclass(\[[^\]]*\])?\{([A-Za-z]+)\}/);
    const target = match ? JAPANESE_CLASS_FOR[match[2]] : null;
    if (!match || !target || target === match[2]) return false;
    const fixedLine = lines[index].replace(match[0], `\\documentclass${match[1] ?? ""}{${target}}`);
    // The Japanese classes need LuaLaTeX; the magic comment makes the build
    // pick it regardless of the workspace default.
    const hasProgramMagic = lines.some((line) => /^\s*%\s*!TEX\s+program\s*=/i.test(line));
    const result = await replaceLines({
      path: mainFile,
      startLine: index + 1,
      endLine: index + 1,
      content: hasProgramMagic ? fixedLine : `% !TEX program = lualatex\n${fixedLine}`,
    });
    traceRunLoop({ conversationId: targetConversationId, glyphRepair: { from: match[2], to: target, magic: !hasProgramMagic } });
    if (!writeToolResultApplied(result)) return false;
    needsCompile = true;
    lastCompileFailed = false;
    return true;
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
    // Writing turns in both the AI mode and the Code chat rewrite whole
    // sections and read the paper back; both get the larger per-turn room.
    // The platform quota still bounds every turn.
    const maxIterations = Math.max(
      resolveMaxAgentIterations(options.maxIterations),
      DOCUMENT_MAX_AGENT_ITERATIONS,
    );
    const turnTokenBudget = Math.max(DOCUMENT_TURN_TOKEN_BUDGET, MAX_AGENT_TOKENS_PER_RUN);
    let iterations = 0;
    let platformBudgetAtStart = null;
    let usageWasMeasurable = true;
    const toolErrorHistory = []; // Track consecutive identical errors for loop detection
    // Reads repeated within one turn cost tokens and time without new
    // information. The first result of each read is remembered until a
    // write or a compile could have changed the workspace; a repeat gets a
    // short pointer back to it, and a long run of reads without an edit gets
    // one nudge to act.
    const READ_TOOL_NAMES = new Set(["read_file", "read_section", "list_sections", "list_files", "find_math_region", "check_references", "check_bibliography"]);
    const READS_BEFORE_NUDGE = 8;
    const readResultsThisRun = new Map();
    let readsSinceLastWrite = 0;
    let readNudgeGiven = false;

    // Track write tool usage across the entire run so we can verify that
    // the final assistant message matches what actually happened. The E2E
    // test showed the LLM would report "I added the Preliminaries content"
    // after making zero tool calls. We refuse to let such hallucinated
    // success reach the user.
    const writeToolInvocations = [];
    // The reply's own tag ("[edit]" / "[report]") says whether the model
    // believes it changed files. "[edit]" with no real write is a
    // hallucinated success and is sent back for the edit; everything else
    // is trusted, so an answer to a question is never bounced.
    let halluciationRetryCount = 0;
    const MAX_HALLUCINATION_RETRIES = 2;

    // The allowance is fetched once, when the turn starts. Every later
    // iteration works from the proxy's response header (the figure before
    // that call) minus what the call was charged, or from the local count
    // when the header is absent. No HTTP round trip per model call.
    let lastFreshBudget = null;
    let billableAtLastFresh = 0;
    const readFreshPlatformBudget = async () => {
      if (
        !isOfficialPlatformProxyUrl(apiUrl) ||
        typeof service.platformAccess?.checkAiAccess !== "function"
      ) {
        return { allowed: true, remainingTokens: null, reason: null };
      }
      if (lastFreshBudget) {
        const base =
          quotaRemainingFromHeader !== null
            ? quotaRemainingFromHeader
            : lastFreshBudget.remainingTokens === null
              ? null
              : lastFreshBudget.remainingTokens - (totalBillableTokens - billableAtLastFresh);
        return {
          allowed: base === null || base > 0,
          remainingTokens: base === null ? null : Math.max(0, Math.floor(base)),
          reason: base !== null && base <= 0 ? "QUOTA_EXCEEDED" : null,
        };
      }
      const access = await awaitAbortable(
        service.platformAccess.checkAiAccess({ force: true }),
        run.controller.signal,
      );
      const remaining = Number(access?.quota?.remainingTokens);
      lastFreshBudget = {
        allowed: access?.allowed === true,
        remainingTokens:
          Number.isFinite(remaining) && remaining >= 0
            ? Math.floor(remaining)
            : null,
        reason: typeof access?.reason === "string" ? access.reason : null,
      };
      billableAtLastFresh = totalBillableTokens;
      return lastFreshBudget;
    };

    // A Code chat gets its title from the model once its first reply exists:
    // a few words about the request, in the user's language, in the background.
    const assistantRepliesBefore = conversation.filter((entry) => entry?.role === "assistant").length;
    const maybeTitleConversation = (replyText) => {
      if (!isCodeSurface || turnOrigin === "survey") return;
      const meta = service.sessionMetaByConversation?.get(targetConversationId);
      if (meta?.title || assistantRepliesBefore > 0) return;
      void generateConversationTitle(service, {
        conversationId: targetConversationId,
        userText,
        replyText: typeof replyText === "string" ? replyText : "",
        locale: context?.uiLocale,
        settings,
      }).catch(() => {});
    };

    const settleWithoutAnotherModelCall = async (kind) => {
      traceRunLoop({ conversationId: targetConversationId, settle: kind, iterations, totalPromptTokens, totalCompletionTokens });
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
      // A turn cut short is not a dead end either: without another model
      // call, the one honest next step is to pick up where it stopped.
      const resumeStep =
        (isDocumentConversation || isCodeSurface) && kind !== "access"
          ? [
              {
                id: "p1",
                title: RESUME_STEP_COPY[context?.uiLocale]?.title ?? RESUME_STEP_COPY.en.title,
                request: `${userText}\n\n${RESUME_STEP_COPY[context?.uiLocale]?.request ?? RESUME_STEP_COPY.en.request}`,
                scope: RESUME_STEP_COPY[context?.uiLocale]?.scope ?? RESUME_STEP_COPY.en.scope,
              },
            ]
          : null;
      const nextSteps = takeRecordedNextSteps() ?? resumeStep;
      conversation.push({
        role: "assistant",
        content: reply,
        ...(nextSteps ? { proposals: nextSteps } : {}),
      });
      service.markSessionDirty(targetConversationId);
      service.sendToRenderer("agent:message", {
        text: reply,
        conversationId: targetConversationId,
        ...(nextSteps ? { proposals: nextSteps } : {}),
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
          turnTokenBudget,
          platformBudgetAtStart ?? turnTokenBudget,
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
        turnTokenBudget - normalizedQuotaSpent,
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

        if (response.ok) {
          const headerRemaining = Number(response.headers.get(QUOTA_REMAINING_HEADER));
          quotaRemainingFromHeader = Number.isFinite(headerRemaining) ? Math.max(0, headerRemaining) : null;
          break;
        }

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
      const replyStream = createReplyTagStream((text) => {
        if (!text) return;
        service.sendToRenderer("agent:messageDelta", {
          text,
          conversationId: targetConversationId,
        });
      });
      const toolCallAccumulators = new Map();
      let iterationPromptTokens = 0;
      let iterationCompletionTokens = 0;
      let iterationCachedTokens = 0;
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
              iterationCachedTokens = Math.max(0, Number(chunk.usage.prompt_tokens_details?.cached_tokens) || 0);
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content delta
            if (delta.content) {
              assistantContent += delta.content;
              replyStream.push(delta.content);
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
          iterationCachedTokens = Math.max(0, Number(data.usage.prompt_tokens_details?.cached_tokens) || 0);
        }
        const choice = data.choices?.[0];
        if (choice?.message) {
          assistantContent = choice.message.content || "";
          if (assistantContent) replyStream.push(assistantContent);
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

      replyStream.flush();
      totalPromptTokens += iterationPromptTokens;
      totalCompletionTokens += iterationCompletionTokens;
      const iterationBillable = billableTokensOf(iterationPromptTokens, iterationCompletionTokens, iterationCachedTokens);
      totalBillableTokens += iterationBillable;
      // The header said what was left before this call; what is left now is
      // that minus this call.
      if (quotaRemainingFromHeader !== null) {
        quotaRemainingFromHeader = Math.max(0, quotaRemainingFromHeader - iterationBillable);
      }
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
      traceRunLoop({ conversationId: targetConversationId, iteration: iterations, text: assistantContent.slice(0, 120), tools: toolCalls.map((t) => t.function.name) });

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
        let finalCompileState = await compilePendingChanges();
        if (!isCurrentRun()) return;
        traceRunLoop({ conversationId: targetConversationId, finalCompile: finalCompileState, report: lastCompileReport.slice(0, 300) });
        if (finalCompileState === "failed" && (await repairMissingGlyphSetup())) {
          finalCompileState = await compilePendingChanges();
          if (!isCurrentRun()) return;
          traceRunLoop({ conversationId: targetConversationId, glyphRepairCompile: finalCompileState, report: lastCompileReport.slice(0, 300) });
        }
        // ---- Repair instead of reporting ----
        // A document that stopped compiling is the agent's problem, not the
        // user's. Hand the compiler's report back and let it fix and rebuild,
        // a bounded number of times, before anything reaches the chat.
        if (
          finalCompileState === "failed" &&
          compileRepairCount < MAX_COMPILE_REPAIRS &&
          iterations < maxIterations
        ) {
          compileRepairCount += 1;
          lastCompileFailed = false;
          needsCompile = true;
          traceRunLoop({ conversationId: targetConversationId, repairRound: compileRepairCount });
          messages.push({
            role: "user",
            content:
              "SYSTEM: The document does not compile after your changes. Compiler report:\n" +
              `${lastCompileReport || "(no report)"}\n\n` +
              "Read the file around the reported lines, make the minimal fix, then call " +
              "compile_document. Reply to the user only after it compiles, and do not " +
              "mention the compiler or this message.",
          });
          continue;
        }
        const finalCompileFailureMessage =
          finalCompileState === "failed" ? compileFailureMessage : "";
        const tagged = splitReplyTag(assistantContent);
        const replyKind = tagged.kind ?? replyStream.kind;
        const reply = [tagged.text, finalCompileFailureMessage]
          .filter((part) => typeof part === "string" && part.trim())
          .join("\n\n");

        // ---- Declared edit without an edit ----
        // The model tagged its reply "[edit]" but no edit tool ran this
        // turn: a claimed change that never happened. Send it back for the
        // real edit (twice at most); a "[report]" reply is never bounced.
        const madeAnyWrite = writeToolInvocations.length > 0;
        if (
          deferredFinalReply === null &&
          replyKind === "edit" &&
          !madeAnyWrite &&
          !readOnlyTurn &&
          !briefTurn &&
          halluciationRetryCount < MAX_HALLUCINATION_RETRIES
        ) {
          halluciationRetryCount += 1;
          traceRunLoop({ conversationId: targetConversationId, editClaimWithoutWrite: halluciationRetryCount });
          // The streamed text claimed a change that never happened; the chat
          // drops it and keeps the working line while the edit is made.
          service.sendToRenderer("agent:messageReset", { conversationId: targetConversationId });
          messages.push({
            role: "user",
            content:
              "SYSTEM: Your reply is tagged [edit], but no edit tool ran this turn, so " +
              "nothing changed. Make the change now with the right edit tool " +
              "(replace_section, replace_lines, insert_lines, delete_lines, write_file), " +
              "compile, then reply. If nothing needs to change, reply tagged [report].",
          });
          continue;
        }

        // ---- Every turn ends with a way forward ----
        // A document conversation never dead-ends: if the model finished
        // without recording next steps, one more call asks for exactly that,
        // and its prose is discarded in favour of the reply already written.
        const finalReplyText = deferredFinalReply ?? reply;
        // The Code chat asks for next steps only after real work (tools ran);
        // a plain answer is not padded with an extra model call.
        const wantsNextSteps =
          turnOrigin !== "survey" &&
          !planMode &&
          (isDocumentConversation || (isCodeSurface && iterations > 1));
        if (
          wantsNextSteps &&
          !hasRecordedNextSteps() &&
          nextStepsFollowUps < 1 &&
          iterations < maxIterations
        ) {
          nextStepsFollowUps += 1;
          deferredFinalReply = finalReplyText;
          traceRunLoop({ conversationId: targetConversationId, nextStepsFollowUp: true });
          messages.push({
            role: "user",
            content:
              "SYSTEM: Your reply above stands as the answer. Now call propose_next_steps " +
              "once with up to 3 concrete next steps for this document from its current " +
              "state (a 'line' from list_sections where it applies, an 'asks' question " +
              "where the user must decide). If the document is empty, the first step asks " +
              "what to write. Do not write prose.",
          });
          continue;
        }

        // Store AI response in conversation, with the next steps it recorded
        const nextSteps = takeRecordedNextSteps();
        const plan = planMode ? service.planByConversation?.get(targetConversationId) ?? null : null;
        service.planByConversation?.delete(targetConversationId);
        conversation.push({
          role: "assistant",
          content: finalReplyText,
          ...(nextSteps ? { proposals: nextSteps } : {}),
          ...(plan ? { plan } : {}),
        });
        service.markSessionDirty(targetConversationId);

        // Send final message (finalizes streaming element on frontend)
        service.sendToRenderer("agent:message", {
          text: finalReplyText || "Done.",
          conversationId: targetConversationId,
          ...(nextSteps ? { proposals: nextSteps } : {}),
          ...(plan ? { plan } : {}),
        });
        maybeTitleConversation(finalReplyText);
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

        // The opening read never changes the workspace, whatever the model
        // decides: a deterministic refusal, not a prompt-only rule.
        const refusedOnSurvey =
          turnOrigin === "survey" &&
          (WRITE_TOOL_NAMES.has(fnName) || fnName === "compile_document");
        const refusedInAskMode =
          (readOnlyTurn || briefTurn) && (WRITE_TOOL_NAMES.has(fnName) || fnName === "compile_document");
        if (refusedOnSurvey) {
          toolResult = JSON.stringify({
            error:
              "The opening read is read-only. Record this change as a proposal with propose_next_steps instead.",
          });
        } else if (refusedInAskMode) {
          toolResult = JSON.stringify({
            error: planMode
              ? "Plan mode is read-only: record the plan with record_plan instead of editing."
              : briefTurn
                ? "This step starts with the brief: no edits this turn. Ask with ask_user what decides the result and stop; the next turn writes."
                : "Ask mode is read-only: no edits or builds this turn. Describe the change and where it goes; the user can switch to Agent mode to apply it.",
          });
        } else if (!executor) {
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
            "check_references",
            "check_bibliography",
          ]);
          toolResult = abortableReadTools.has(fnName)
            ? await awaitAbortable(executor(args), run.controller.signal)
            : await executor(args);
          assertWorkspaceCurrent();
        }

        // Add tool result to messages
        let toolResultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        if (READ_TOOL_NAMES.has(fnName) && !toolResultStr.includes('"error"')) {
          const readKey = `${fnName}:${toolCall.function?.arguments || ""}`;
          const seen = readResultsThisRun.get(readKey);
          if (seen && seen.result === toolResultStr) {
            toolResultStr = JSON.stringify({
              unchanged: true,
              note:
                `This exact ${fnName} call already ran at step ${seen.iteration} and nothing has ` +
                "changed since. Its content still applies; do not read it again. Make the edit " +
                "now, or read a different range or file.",
            });
          } else {
            readResultsThisRun.set(readKey, { iteration: iterations, result: toolResultStr });
          }
          readsSinceLastWrite += 1;
        } else if (WRITE_TOOL_NAMES.has(fnName) || fnName === "compile_document") {
          readResultsThisRun.clear();
          readsSinceLastWrite = 0;
        }
        traceRunLoop({ conversationId: targetConversationId, tool: fnName, result: toolResultStr.slice(0, 240) });
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
          // A write can add an \input or a bib file; the map (and the build
          // fingerprint drawn from it) follows the document as it grows.
          if (mainTexFile) {
            documentMap = await scanDocument(service, mainTexFile).catch(() => documentMap);
          }
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
            if (lastCompileFailed) {
              lastCompileReport =
                toolResultStr.length > 2_000 ? `${toolResultStr.slice(0, 2_000)}…` : toolResultStr;
            } else {
              compiledFingerprint = await currentFingerprint();
              markProposalPages(toolResult);
            }
          }
        }
        // Abort is cooperative while a tool is awaited. Record the completed
        // tool first (especially a write), then stop before any sibling tool
        // from the same model response can mutate the workspace.
        throwIfRunAborted();
      }

      // ---- The deferred reply is complete once its next steps exist ----
      // The follow-up call only had to record next steps; no further model
      // call is spent on prose that would be discarded anyway.
      if (deferredFinalReply !== null && hasRecordedNextSteps()) {
        const nextSteps = takeRecordedNextSteps();
        conversation.push({ role: "assistant", content: deferredFinalReply, proposals: nextSteps });
        service.markSessionDirty(targetConversationId);
        service.sendToRenderer("agent:message", {
          text: deferredFinalReply || "Done.",
          conversationId: targetConversationId,
          proposals: nextSteps,
        });
        maybeTitleConversation(deferredFinalReply);
        service.sendStatus("idle", "Waiting", targetConversationId);
        return;
      }

      // ---- A question for the user ends the turn here ----
      // The model asked something only the user can answer. Whatever it
      // already changed is compiled, the question becomes its reply, and the
      // answer arrives as the next user message. No further model call.
      const pendingQuestion = takePendingQuestion();
      if (pendingQuestion) {
        const questionCompileState = await compilePendingChanges();
        if (!isCurrentRun()) return;
        const questionSteps = takeRecordedNextSteps();
        conversation.push({
          role: "assistant",
          content: pendingQuestion.question,
          question: pendingQuestion,
          ...(questionSteps ? { proposals: questionSteps } : {}),
        });
        service.markSessionDirty(targetConversationId);
        service.sendToRenderer("agent:message", {
          text: pendingQuestion.question,
          question: pendingQuestion,
          conversationId: targetConversationId,
          ...(questionSteps ? { proposals: questionSteps } : {}),
        });
        maybeTitleConversation(pendingQuestion.question);
        if (questionCompileState === "failed") sendCompileFailure();
        service.sendStatus(
          questionCompileState === "failed" ? "resumable" : "idle",
          questionCompileState === "failed" ? "Compilation failed" : "Waiting",
          targetConversationId,
        );
        return;
      }

      if (readsSinceLastWrite >= READS_BEFORE_NUDGE && !readNudgeGiven) {
        readNudgeGiven = true;
        traceRunLoop({ conversationId: targetConversationId, readNudge: readsSinceLastWrite });
        messages.push({
          role: "user",
          content:
            "SYSTEM: You have read the document many times without editing it. You now know " +
            "enough. Make the requested change with one edit tool call (replace_lines, " +
            "replace_section, or write_file) and compile, or tell the user plainly what " +
            "you could not find. Do not read the file again.",
        });
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

    // The allowance moves forward locally; the chat and the settings page
    // learn it from here, not from another request.
    if (
      isOfficialPlatformProxyUrl(apiUrl) &&
      (totalBillableTokens > 0 || quotaRemainingFromHeader !== null) &&
      typeof service.platformAccess?.noteAiUsage === "function"
    ) {
      try {
        const access = await service.platformAccess.noteAiUsage({
          consumedTokens: totalBillableTokens,
          remainingTokens: quotaRemainingFromHeader,
        });
        if (access) {
          service.sendToRenderer("platform:aiAccess", { source: "turn", access });
          const usage = buildUsageFromAccess(access);
          if (usage) service.sendToRenderer("platform:usage", { source: "turn", usage });
        }
      } catch {
        /* the next access check refreshes it */
      }
    }

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
