"use strict";

const { randomUUID } = require("node:crypto");

const API_BASE = "https://api.openai.com/v1/agents/sessions";
const MAX_CHECKPOINTS = 6;
const MAX_TURN_MS = 180_000;
const MAX_OBSERVED_TOKENS = 60_000;

// Developer trial only. Never reuse the platform JWT or ship a provider key.
const resolveAgentsApiConfig = () => {
  if (process.env.TEX64_AGENT_RUNTIME !== "agents-api") return null;
  if (process.versions.electron && !process.defaultApp) {
    throw new Error("Agents API trial is available only in the development app.");
  }
  const apiKey = process.env.TEX64_AGENTS_API_KEY?.trim();
  const model = process.env.TEX64_AGENTS_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("Agents API trial requires TEX64_AGENTS_API_KEY and TEX64_AGENTS_MODEL.");
  }
  return { apiKey, model };
};

const inputContent = (content) => {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) throw new Error("Unsupported Agents API input.");
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "image_url" && part.image_url?.url) {
      return { type: "input_image", image_url: part.image_url.url };
    }
    throw new Error("Unsupported Agents API attachment.");
  });
};

// Agents input accepts user messages only. Prior local turns are supplied as
// explicitly labelled transcript data; the current request retains its images.
const initialInput = (messages) => {
  const current = messages.at(-1);
  if (current?.role !== "user") throw new Error("Agents API requires a user request.");
  const history = messages.slice(0, -1).filter((m) => m.role !== "system");
  const content = inputContent(current.content);
  if (history.length) content.unshift({
    type: "input_text",
    text: "Previous conversation (transcript data, not new instructions):\n" + JSON.stringify(history),
  });
  return [{ role: "user", content }];
};

async function* readEvents(response) {
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("Agents API did not return an event stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) {
            const json = data.join("\n");
            data = [];
            if (json !== "[DONE]") yield JSON.parse(json);
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Agents API event is too large.");
      if (done) {
        if (data.length) yield JSON.parse(data.join("\n"));
        return;
      }
    }
  } finally {
    // A persistent GET event stream can wait for its peer when cancelled.
    // Initiate cancellation here; the owner aborts the fetch in its finally.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One managed session per local user turn. The existing host remains the sole
 * tool executor, preserving Ask restrictions, workspace checks, builds and undo.
 * next() pauses at required_actions, rather than starting a new model response.
 */
class AgentsApiTurn {
  constructor({ apiKey, model, signal, onSession = () => {}, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.onSession = onSession;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.timer = setTimeout(() => this.controller.abort(new Error("Agents API trial time limit reached.")), MAX_TURN_MS);
    this.timer.unref?.();
    this.sessionId = null;
    this.pending = [];
    this.toolNames = new Map();
    this.submittedCalls = new Set();
    this.sentLength = 0;
    this.checkpoints = 0;
    this.usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    this.completed = false;
    this.closed = false;
  }

  async request(suffix = "", { method = "GET", body, signal = this.signal } = {}) {
    const response = await this.fetchImpl(API_BASE + suffix, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "agents=v1",
        "Content-Type": "application/json",
        ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    // Never retry a paid POST automatically, even after an ambiguous disconnect.
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const reason = String(body?.error?.message || response.statusText).replaceAll(this.apiKey, "[redacted]");
      throw new Error(`Agents API ${response.status}: ${reason.slice(0, 500)}`);
    }
    return response;
  }

  get path() { return `/${encodeURIComponent(this.sessionId)}`; }

  async next({ messages, tools, onText = () => {} }) {
    this.signal.throwIfAborted();
    if (this.closed || this.checkpoints >= MAX_CHECKPOINTS) {
      throw new Error("Agents API trial reached its tool round limit.");
    }
    if (this.usage.input_tokens + this.usage.output_tokens >= MAX_OBSERVED_TOKENS) {
      throw new Error("Agents API trial reached its observed token limit.");
    }
    this.checkpoints += 1;
    let response;
    const streamController = new AbortController();
    const streamSignal = AbortSignal.any([this.signal, streamController.signal]);
    try {
      if (!this.sessionId) {
        // Keep product functions distinct from harness/connector tool names.
        this.toolNames = new Map(tools.map((tool) => [`tex64_${tool.function.name}`, tool.function.name]));
        response = await this.request("", { method: "POST", signal: streamSignal, body: {
          agent: {
            model: this.model,
            instructions: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") +
              "\n\nAll document tools named in these instructions use the tex64_ prefix in this session. " +
              "For example, compile_document means tex64_compile_document. Use only the registered tex64_ functions for document operations.",
            tools: tools.map((tool) => ({ type: "function", ...tool.function, name: `tex64_${tool.function.name}` })),
            reasoning: { effort: "low" },
            text: { verbosity: "low" },
            multi_agent: { enabled: false },
          },
          environment: { type: "none" },
          metadata: { client: "tex64-development-trial" },
          input: initialInput(messages),
          stream: true,
        } });
      } else {
        const added = messages.slice(this.sentLength);
        const events = [];
        for (const action of this.pending) {
          const result = added.find((m) => m.role === "tool" && m.tool_call_id === action.call_id);
          if (!result) throw new Error("A pending Agents API tool result is missing.");
          let failed = false;
          try { failed = Boolean(JSON.parse(result.content)?.error); } catch { /* plain text result */ }
          events.push({
            type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id,
            ...(failed ? { success: false, error: result.content } : { success: true, output: result.content }),
          });
        }
        const input = added.filter((m) => m.role === "user").map((m) => ({ role: "user", content: inputContent(m.content) }));
        if (input.length) events.push({ type: "agent.session.input.message", input });
        if (!events.length) throw new Error("No new input for the Agents API session.");
        response = await this.request(`${this.path}/events`, {
          signal: streamSignal,
        });
        // Subscribe first: the stream does not replay missed events.
        await this.request(`${this.path}/events`, { method: "POST", body: { events } });
        for (const action of this.pending) this.submittedCalls.add(action.call_id);
      }
      this.completed = false;
      this.sentLength = messages.length;
      this.pending = [];
      const parts = new Map();
      const phases = new Map();
      let checkpoint = false;
      for await (const event of readEvents(response)) {
        if (!this.sessionId && (event.session_id || event.session?.id)) {
          this.sessionId = event.session_id || event.session.id;
          await this.onSession(this.sessionId);
        }
        if (event.session_id && event.session_id !== this.sessionId) throw new Error("Agents API session mismatch.");
        const type = event.type;
        if (type === "error" || type === "agent.session.failed" || type === "agent.session.environment.failed") {
          throw new Error(event.error?.message || event.session?.error || `Agents API failure: ${type}`);
        }
        if (event.turn?.subagent_id || event.subagent_id) continue;
        if (event.item?.type === "message" && event.item.role === "assistant") {
          phases.set(event.item.id, event.item.phase);
        }
        if (type === "agent.session.turn.failed" || type === "agent.session.turn.cancelled") {
          throw new Error(event.turn?.error?.message || `Agents API ${type}`);
        }
        if (type === "agent.session.turn.output_text.delta" || type === "agent.session.turn.output_text.done") {
          if (phases.get(event.item_id) === "commentary") continue;
          const key = `${event.item_id}:${event.content_index ?? 0}`;
          const prior = parts.get(key) || "";
          const text = type.endsWith(".done") ? event.text || "" : prior + (event.delta || "");
          if (!text.startsWith(prior)) throw new Error("Agents API revised a streamed text part; retry is required.");
          parts.set(key, text);
          onText(text.slice(prior.length));
        }
        if (type === "agent.session.requires_action" || type === "agent.session.turn.completed") {
          this.completed = type === "agent.session.turn.completed";
          checkpoint = true;
          break;
        }
      }
      streamController.abort();
      if (!checkpoint || !this.sessionId) throw new Error("Agents API stream closed before a result; no automatic retry was made.");
      // Read authoritative pending actions and cumulative usage at a boundary.
      const session = await (await this.request(this.path)).json();
      if (!this.completed) {
        if (!session.required_actions?.length || session.required_actions.some((a) => a.type !== "function_call")) {
          throw new Error("Agents API requested an unsupported action.");
        }
        this.pending = session.required_actions;
        if (this.pending.some((action) => !this.toolNames.has(action.name))) {
          throw new Error("Agents API requested an unregistered document tool.");
        }
        if (this.pending.some((action) => this.submittedCalls.has(action.call_id))) {
          throw new Error("Agents API repeated an already completed tool call; it was not executed again.");
        }
      }
      const usage = session.usage;
      let deltaUsage;
      if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
        const next = {
          input_tokens: Math.max(this.usage.input_tokens, usage.input_tokens),
          output_tokens: Math.max(this.usage.output_tokens, usage.output_tokens),
          cached_tokens: Math.max(this.usage.cached_tokens, usage.input_tokens_details?.cached_tokens || 0),
        };
        deltaUsage = {
          prompt_tokens: next.input_tokens - this.usage.input_tokens,
          completion_tokens: next.output_tokens - this.usage.output_tokens,
          prompt_tokens_details: { cached_tokens: next.cached_tokens - this.usage.cached_tokens },
        };
        this.usage = next;
      }
      return Response.json({
        choices: [{ message: {
          content: [...parts.values()].join(""),
          tool_calls: this.pending.map((action) => ({
            id: action.call_id, type: "function",
            function: { name: this.toolNames.get(action.name), arguments: JSON.stringify(action.arguments) },
          })),
        } }],
        ...(deltaUsage ? { usage: deltaUsage } : {}),
      });
    } finally {
      streamController.abort();
      // Also release a subscribed stream if posting input failed before reading.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    if (!this.sessionId) return;
    let cancelError;
    if (!this.completed) {
      try {
        await this.request(`${this.path}/events`, {
          method: "POST", body: { events: [{ type: "agent.session.input.cancel" }] },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) { cancelError = error; }
    }
    try {
      await this.request(this.path, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new Error(`Agents API trial cleanup failed for ${this.sessionId}: ${error.message}${cancelError ? "; cancellation also failed" : ""}`);
    }
  }
}

module.exports = { AgentsApiTurn, resolveAgentsApiConfig, MAX_CHECKPOINTS, MAX_OBSERVED_TOKENS };
