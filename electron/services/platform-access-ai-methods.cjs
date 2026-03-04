const { requestGemini } = require("./agent-llm.cjs");
const {
  parseNumber,
  parseInteger,
  resolveModelLabel,
  PlatformApiError,
} = require("./platform-access-shared.cjs");

const aiMethods = {
  buildTextOnlyCandidate(text) {
    if (typeof text !== "string" || !text.trim()) {
      return null;
    }
    return {
      role: "model",
      parts: [{ text }],
    };
  },

  extractTextFromOpenAiContent(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.input_text === "string") {
            return part.input_text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  },

  convertFunctionDeclarationsToOpenAiTools(tools) {
    if (!Array.isArray(tools)) {
      return [];
    }
    const declarations = [];
    tools.forEach((entry) => {
      if (Array.isArray(entry?.functionDeclarations)) {
        declarations.push(...entry.functionDeclarations);
      }
    });
    return declarations
      .filter((declaration) => declaration && typeof declaration.name === "string")
      .map((declaration) => ({
        type: "function",
        function: {
          name: declaration.name,
          description:
            typeof declaration.description === "string" ? declaration.description : "",
          parameters:
            declaration.parameters && typeof declaration.parameters === "object"
              ? declaration.parameters
              : { type: "object", properties: {} },
        },
      }));
  },

  mapGeminiToolModeToOpenAiChoice(toolConfig) {
    const mode = toolConfig?.functionCallingConfig?.mode;
    if (mode === "AUTO") {
      return "auto";
    }
    if (mode === "NONE") {
      return "none";
    }
    if (mode === "ANY") {
      return "required";
    }
    return undefined;
  },

  buildOpenAiMessagesFromGeminiContents(contents, systemInstruction) {
    const messages = [];
    const systemText = this.extractTextFromOpenAiContent(systemInstruction?.parts ?? []);
    if (systemText.trim()) {
      messages.push({ role: "system", content: systemText });
    }
    if (!Array.isArray(contents)) {
      return messages;
    }
    const pendingToolCalls = [];
    const nextToolCallId = (name, index) =>
      `call_${name || "tool"}_${index}_${Math.random().toString(16).slice(2, 8)}`;
    contents.forEach((entry, contentIndex) => {
      const role = typeof entry?.role === "string" ? entry.role : "user";
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      if (role === "user") {
        const text = this.extractTextFromOpenAiContent(parts);
        if (text.trim()) {
          messages.push({ role: "user", content: text });
        }
        return;
      }
      if (role === "model") {
        const text = this.extractTextFromOpenAiContent(parts);
        const toolCalls = parts
          .filter((part) => part?.functionCall)
          .map((part, idx) => {
            const call = part.functionCall;
            const callId =
              typeof call?.id === "string" && call.id
                ? call.id
                : nextToolCallId(call?.name, contentIndex * 10 + idx);
            pendingToolCalls.push({
              id: callId,
              name: typeof call?.name === "string" ? call.name : "",
            });
            const args =
              call && typeof call.args === "object" ? JSON.stringify(call.args) : "{}";
            return {
              id: callId,
              type: "function",
              function: {
                name: typeof call?.name === "string" ? call.name : "",
                arguments: args,
              },
            };
          });
        if (text.trim() || toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: text || "",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        return;
      }
      if (role === "tool") {
        parts
          .filter((part) => part?.functionResponse)
          .forEach((part, idx) => {
            const response = part.functionResponse;
            const responseName = typeof response?.name === "string" ? response.name : "";
            let toolCallId = null;
            const queueIndex = pendingToolCalls.findIndex(
              (entry) => entry.name === responseName
            );
            if (queueIndex >= 0) {
              toolCallId = pendingToolCalls[queueIndex].id;
              pendingToolCalls.splice(queueIndex, 1);
            } else {
              toolCallId = nextToolCallId(responseName, contentIndex * 10 + idx);
            }
            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              name: responseName || undefined,
              content: JSON.stringify(
                response?.response && typeof response.response === "object"
                  ? response.response
                  : response?.response ?? {}
              ),
            });
          });
      }
    });
    return messages;
  },

  buildChatRequestBody(payload) {
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    body.stream = false;
    const openAiTools = this.convertFunctionDeclarationsToOpenAiTools(body.tools);
    const openAiMessages = this.buildOpenAiMessagesFromGeminiContents(
      body.contents,
      body.systemInstruction
    );
    body.messages = openAiMessages;
    if (openAiTools.length > 0) {
      body.openaiTools = openAiTools;
      body.toolsOpenAI = openAiTools;
      body.tools_openai = openAiTools;
    }
    const openAiToolChoice = this.mapGeminiToolModeToOpenAiChoice(body.toolConfig);
    if (openAiToolChoice) {
      body.openaiToolChoice = openAiToolChoice;
      body.toolChoiceOpenAI = openAiToolChoice;
      body.tool_choice = openAiToolChoice;
    }
    if (body.generationConfig && typeof body.generationConfig === "object") {
      const generationConfig = body.generationConfig;
      const temperature = parseNumber(generationConfig.temperature, undefined);
      const topP = parseNumber(generationConfig.topP, undefined);
      const topK = parseInteger(generationConfig.topK, undefined);
      const maxOutputTokens = parseInteger(generationConfig.maxOutputTokens, undefined);
      if (typeof temperature === "number" && Number.isFinite(temperature)) {
        body.temperature = temperature;
      }
      if (typeof topP === "number" && Number.isFinite(topP)) {
        body.topP = topP;
      }
      if (typeof topK === "number" && Number.isFinite(topK)) {
        body.topK = topK;
      }
      if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
        body.maxOutputTokens = maxOutputTokens;
        body.max_tokens = maxOutputTokens;
      }
    }
    return body;
  },

  normalizeOpenAiChoiceToCandidate(choice) {
    const message = choice?.message;
    if (!message || typeof message !== "object") {
      return null;
    }
    const parts = [];
    const text = this.extractTextFromOpenAiContent(message.content);
    if (text.trim()) {
      parts.push({ text });
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    toolCalls.forEach((toolCall) => {
      const name = toolCall?.function?.name;
      if (typeof name !== "string" || !name.trim()) {
        return;
      }
      const rawArgs = toolCall?.function?.arguments;
      let args = {};
      if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs;
      }
      parts.push({
        functionCall: {
          id: typeof toolCall?.id === "string" && toolCall.id ? toolCall.id : undefined,
          name,
          args,
        },
      });
    });
    if (parts.length === 0) {
      return null;
    }
    return {
      content: {
        role: "model",
        parts,
      },
    };
  },

  normalizeCustomToolCalls(response) {
    const calls = Array.isArray(response?.toolCalls)
      ? response.toolCalls
      : Array.isArray(response?.output?.toolCalls)
      ? response.output.toolCalls
      : null;
    if (!calls || calls.length === 0) {
      return [];
    }
    return calls
      .map((call) => {
        const name = typeof call?.name === "string" ? call.name : "";
        if (!name) {
          return null;
        }
        return {
          functionCall: {
            id: typeof call?.id === "string" ? call.id : undefined,
            name,
            args: call?.args && typeof call.args === "object" ? call.args : {},
          },
        };
      })
      .filter(Boolean);
  },

  normalizeModelResponse(payload) {
    const response = payload && typeof payload === "object" ? payload : {};
    const resolvedModel = resolveModelLabel(response);
    const usageMetadata = this.normalizeUsageMetadata(
      response.usageMetadata ??
        response.usage ??
        response.usage_metadata ??
        response.token_usage ??
        null
    );
    const quota = this.buildQuotaSnapshot(
      response.quota ??
        response.summary ??
        response.usage?.quota ??
        response.output?.quota ??
        response.usage?.summary ??
        null
    );
    let candidates = Array.isArray(response.candidates) ? response.candidates : null;
    if ((!candidates || candidates.length === 0) && Array.isArray(response.choices)) {
      candidates = response.choices
        .map((choice) => this.normalizeOpenAiChoiceToCandidate(choice))
        .filter(Boolean);
    }
    if (!candidates || candidates.length === 0) {
      const output = response.output && typeof response.output === "object" ? response.output : {};
      const outputParts = Array.isArray(output.parts) ? output.parts : null;
      const outputText =
        typeof output.text === "string"
          ? output.text
          : typeof response.text === "string"
          ? response.text
          : typeof response.output_text === "string"
          ? response.output_text
          : null;
      if (outputParts && outputParts.length > 0) {
        candidates = [{ content: { role: "model", parts: outputParts } }];
      } else {
        const customToolParts = this.normalizeCustomToolCalls(response);
        if (customToolParts.length > 0) {
          candidates = [{ content: { role: "model", parts: customToolParts } }];
        }
        const candidate = this.buildTextOnlyCandidate(outputText);
        if (candidate && (!candidates || candidates.length === 0)) {
          candidates = [{ content: candidate }];
        }
      }
    }
    return {
      ...response,
      candidates: candidates ?? [],
      resolvedModel: resolvedModel || null,
      usageMetadata: usageMetadata ?? response.usageMetadata ?? null,
      quota,
      plan:
        typeof response.plan === "string"
          ? response.plan
          : typeof this.state?.session?.plan === "string"
          ? this.state.session.plan
          : null,
    };
  },

  async requestAiChat(payload, options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement && !state.session?.accessToken) {
      if (!this.legacyProxyUrl) {
        throw new PlatformApiError(
          "AI_PROXY_DISABLED",
          "Legacy AI proxy is disabled in strict production mode."
        );
      }
      const response = await requestGemini({
        proxyUrl: this.legacyProxyUrl,
        model: payload?.model,
        contents: payload?.contents,
        systemInstruction: payload?.systemInstruction,
        tools: payload?.tools,
        toolConfig: payload?.toolConfig,
        generationConfig: payload?.generationConfig,
        signal: options.signal,
        onDelta: options.onDelta,
      });
      return this.normalizeModelResponse(response);
    }
    const body = this.buildChatRequestBody(payload);
    const response = await this.authorizedRequest("/ai/chat", {
      method: "POST",
      body,
      signal: options.signal,
    });
    return this.normalizeModelResponse(response);
  },

  async requestAiCompletion(payload, options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement && !state.session?.accessToken) {
      if (!this.legacyProxyUrl) {
        throw new PlatformApiError(
          "AI_PROXY_DISABLED",
          "Legacy AI proxy is disabled in strict production mode."
        );
      }
      const response = await requestGemini({
        proxyUrl: this.legacyProxyUrl,
        model: payload?.model,
        contents: [
          {
            role: "user",
            parts: [{ text: typeof payload?.prompt === "string" ? payload.prompt : "" }],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: [
                "You are a high-precision LaTeX inline copilot.",
                "Return ONLY the continuation text to insert at <CURSOR>.",
                "Do not repeat the prefix already typed by the user.",
                "Prefer useful, immediately actionable continuation over generic phrases.",
                "Keep LaTeX syntax coherent and compile-safe.",
                "Stay concise (typically one line). If confidence is low, return empty.",
              ].join(" "),
            },
          ],
        },
        generationConfig: {
          maxOutputTokens: parseInteger(payload?.maxOutputTokens, 40),
          temperature: parseNumber(payload?.temperature, 0.2),
          topP: parseNumber(payload?.topP, 0.9),
          topK: parseInteger(payload?.topK, 40),
          stopSequences: ["\n"],
        },
        signal: options.signal,
      });
      const normalized = this.normalizeModelResponse(response);
      const text = normalized.candidates
        .flatMap((candidate) => candidate?.content?.parts ?? [])
        .map((part) => part?.text)
        .filter((entry) => typeof entry === "string")
        .join("");
      return {
        raw: response,
        text: text || null,
        resolvedModel: normalized.resolvedModel || resolveModelLabel(response) || null,
        usageMetadata: normalized.usageMetadata ?? null,
        quota: normalized.quota ?? null,
        plan: typeof state.session?.plan === "string" ? state.session.plan : null,
      };
    }
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!Array.isArray(body.messages) && prompt.trim()) {
      body.messages = [{ role: "user", content: prompt }];
    }
    const maxOutputTokens = parseInteger(body.maxOutputTokens, undefined);
    if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
      body.max_tokens = maxOutputTokens;
    }
    const temperature = parseNumber(body.temperature, undefined);
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      body.temperature = temperature;
    }
    const topP = parseNumber(body.topP, undefined);
    if (typeof topP === "number" && Number.isFinite(topP)) {
      body.top_p = topP;
    }
    const response = await this.authorizedRequest("/ai/completion", {
      method: "POST",
      body,
      signal: options.signal,
    });
    const usageMetadata = this.normalizeUsageMetadata(
      response.usageMetadata ??
        response.usage ??
        response.usage_metadata ??
        response.token_usage ??
        null
    );
    const quota = this.buildQuotaSnapshot(
      response.quota ?? response.summary ?? response.output?.quota ?? response.usage?.quota ?? null
    );
    let text = null;
    if (typeof response?.output?.text === "string") {
      text = response.output.text;
    } else if (typeof response?.text === "string") {
      text = response.text;
    } else if (typeof response?.output_text === "string") {
      text = response.output_text;
    } else if (Array.isArray(response?.choices)) {
      text = response.choices
        .map((choice) => {
          if (typeof choice?.text === "string") {
            return choice.text;
          }
          return this.extractTextFromOpenAiContent(choice?.message?.content);
        })
        .filter((entry) => typeof entry === "string" && entry.trim())
        .join("");
    } else if (Array.isArray(response?.candidates)) {
      text = response.candidates
        .flatMap((candidate) => candidate?.content?.parts ?? [])
        .map((part) => part?.text)
        .filter((entry) => typeof entry === "string")
        .join("");
    }
    return {
      raw: response,
      text: typeof text === "string" ? text : null,
      resolvedModel: resolveModelLabel(response) || null,
      usageMetadata,
      quota,
      plan:
        typeof response?.plan === "string"
          ? response.plan
          : typeof this.state?.session?.plan === "string"
          ? this.state.session.plan
          : null,
    };
  },
};

module.exports = {
  aiMethods,
};
