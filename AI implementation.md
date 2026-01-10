# AI Agent Implementation Plan for tex64

This document specifies the **MVP** for integrating an agentic AI assistant into tex64, powered by the lowest-cost Gemini model from the current pricing page.

---

## 1. Goal (MVP)

- Add a sidebar **AI chat** (VSCode-like).
- The agent can **read files**, **search**, and **propose edits**.
- **Edits are never applied automatically**: all changes go through the diff modal and require user confirmation.
- **Build is never executed by the agent** (user can run build with the existing button).

---

## 2. Model Choice (Cost-Minimal)

From the Gemini Developer API pricing page, the lowest cost text model is:

- **Model**: `gemini-2.0-flash-lite`
- **Price**: **$0.075 / 1M input tokens**, **$0.30 / 1M output tokens** (paid tier)

This model is fixed in code for the MVP (no UI toggle), and enforced by the proxy.

---

## 3. Architecture (MVP)

```
Renderer (web)
  ├─ AI Chat UI (sidebar tab)
  ├─ Diff modal (existing)
  └─ Bridge → IPC (tex64)

Main (electron)
  ├─ AgentService (LLM loop + tool execution)
  ├─ Agent tool definitions
  ├─ UserSettings (temperature / maxOutputTokens)
  ├─ AI Proxy URL (default `https://tex64.vercel.app/api/ai-chat`, override via env)
  └─ Workspace / Search services

Server (Vercel)
  └─ `/api/ai-chat` (Gemini proxy with server-side key)
```

---

## 4. IPC Contract

Renderer → Main
- `agent:run` (message, context)
- `agent:abort`
- `agent:apply` (proposalId)
- `agent:clear`

Main → Renderer
- `agent:status` (idle / running / error)
- `agent:message` (assistant reply)
- `agent:tool` (tool execution log)
- `agent:proposal` (proposed file change)
- `agent:applyResult`
- `agent:error`

---

## 5. Agent Loop (Gemini Function Calling)

1. Build system prompt with workspace context (root path, active file).
2. Call Gemini with `tools` enabled.
3. If function calls are returned:
   - Execute each tool.
   - Send `functionResponse` back to Gemini.
   - Repeat until the model returns text.
4. Return final assistant message to UI.

MVP constraints:
- Max iterations: 6
- No build execution
- No automatic write

---

## 6. Tools (MVP)

**Read/inspect**
- `list_files(directory?)`
- `read_file(path)`
- `search_files(query)`

**Write (proposal only)**
- `propose_write(path, content, summary?)`
  - Stores proposal in memory
  - Sends proposal to UI
  - Requires user confirmation in diff modal

---

## 7. Safety Rules

- Always `read_file` before proposing edits.
- Writing is **proposal-only**.
- Ignore / block paths:
  - `.tex64/`
  - `node_modules/`
  - `Resources/`
- Only allow text files (tex, bib, md, txt, json, etc.).

---

## 8. UI (MVP)

**Sidebar tab**: “AI”
- Chat log (user + assistant)
- Tool log (small system rows)
- Proposal list with “差分を確認 → 適用”
- Input box + send button
- “履歴をクリア” button
- 複数チャット（会話ごとの履歴/提案を分離）

Diff modal is reused for preview + apply.

---

## 9. API Key / Model

- **API key** is stored on Vercel as `GEMINI_API_KEY`.
- **Model** is fixed to `gemini-2.0-flash-lite` on the proxy (override via `GEMINI_MODEL` if needed).
- App connects to the proxy via the built-in default (override with `TEX64_AI_PROXY_URL`).
- Optional runtime tuning (`temperature`, `maxOutputTokens`) stays in `tex64-user-settings.json`.

## 10. Vercel Setup (MVP)

1. Deploy this repo to Vercel.
2. Set Environment Variables:
   - `GEMINI_API_KEY` (required)
   - `GEMINI_MODEL` (optional, defaults to `gemini-2.0-flash-lite`)
3. (Optional) In the app runtime, override the proxy URL:
   - `TEX64_AI_PROXY_URL=https://<your-vercel-domain>/api/ai-chat`

---

## 11. File Layout (MVP)

```
electron/
  handlers/agent.cjs        # IPC handlers
  services/agent.cjs         # Core loop + tool execution
  services/agent-llm.cjs     # Gemini HTTP client
  services/agent-tools.cjs   # Tool definitions

api/
  ai-chat.js                 # Vercel serverless proxy

vercel.json                 # Vercel build/output config

web-src/
  app/ai-chat-ui.ts          # AI sidebar UI
  app/diff-modal.ts          # add AI apply context
  app/ui-events.ts           # apply AI changes via diff modal
```

---

## 12. Non-Goals (MVP)

- Streaming responses
- Multi-agent workflows
- Auto-build / auto-commit
- Advanced context embedding / indexing

---

## 13. Next Phase (After MVP)

- Streaming UI
- Multi-file apply queue
- Template pack generation
- Richer toolset (rename/move/delete)
- Agent memory per workspace
