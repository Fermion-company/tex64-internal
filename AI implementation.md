# AI Agent Implementation Plan for tex180

This document provides a comprehensive technical specification for integrating an agentic AI assistant into tex180, powered by **Gemini 2.5 Flash-Lite**.

---

## 1. Overview

### 1.1 Goal
Integrate an autonomous AI agent capable of:
- Reading and writing files within the user's LaTeX project
- Executing builds and parsing error logs
- Providing intelligent suggestions and automated fixes
- Operating in a tool-use loop (like Codex CLI / Claude Code)

### 1.2 Recommended Model
- **Primary**: `gemini-2.5-flash-lite` ($0.10/1M input, $0.40/1M output)
- **Fallback/Premium**: `gemini-2.5-flash` (for complex reasoning)

---

## 2. Architecture

### 2.1 High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Renderer Process                        │
│  ┌───────────────┐    ┌────────────────────────────────┐    │
│  │  AI Chat UI   │◄──►│  IPC Bridge (tex180:agent:*)   │    │
│  │  (Sidebar)    │    └────────────────────────────────┘    │
│  └───────────────┘                    ▲                      │
└───────────────────────────────────────│──────────────────────┘
                                        │ IPC
┌───────────────────────────────────────▼──────────────────────┐
│                       Main Process                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    AgentService                          │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │ │
│  │  │ Tool Runner │  │ LLM Client  │  │ Conversation    │  │ │
│  │  │             │  │ (Gemini)    │  │ State Manager   │  │ │
│  │  └──────┬──────┘  └──────┬──────┘  └─────────────────┘  │ │
│  │         │                │                               │ │
│  │         ▼                ▼                               │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │              Existing tex180 Services               │ │ │
│  │  │  WorkspaceManager │ BuildService │ FormatterService │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 File Structure

```
electron/
├── main.cjs                    # Add IPC handlers for agent
├── preload.cjs                 # Expose agent API to renderer
└── services/
    ├── agent.cjs               # [NEW] Core agent orchestration
    ├── agent-tools.cjs         # [NEW] Tool definitions
    ├── agent-llm.cjs           # [NEW] Gemini API client
    └── ... (existing services)

web-src/
└── main.ts                     # Add AI tab and chat UI
```

---

## 3. Agent Core (`agent.cjs`)

### 3.1 Agent Loop (ReAct Pattern)

The agent operates in a loop:

```javascript
async function runAgentLoop(userMessage, conversationHistory) {
  const maxIterations = 10;
  let iteration = 0;
  
  while (iteration < maxIterations) {
    iteration++;
    
    // 1. Build prompt with system instructions, history, and available tools
    const prompt = buildPrompt(conversationHistory, TOOLS);
    
    // 2. Call LLM with function calling enabled
    const response = await llmClient.generate(prompt, {
      tools: TOOL_DEFINITIONS,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
    });
    
    // 3. Check response type
    if (response.hasFunctionCall()) {
      // 3a. Execute tool and add result to history
      const toolCall = response.getFunctionCall();
      const toolResult = await executeToolCall(toolCall);
      
      conversationHistory.push({
        role: 'model',
        parts: [{ functionCall: toolCall }]
      });
      conversationHistory.push({
        role: 'function',
        parts: [{ functionResponse: { name: toolCall.name, response: toolResult } }]
      });
      
      // Notify UI of tool execution
      sendToRenderer('agent:toolExecution', { tool: toolCall.name, result: toolResult });
      
    } else {
      // 3b. Final text response - exit loop
      conversationHistory.push({
        role: 'model',
        parts: [{ text: response.getText() }]
      });
      sendToRenderer('agent:response', { text: response.getText() });
      break;
    }
  }
  
  return conversationHistory;
}
```

### 3.2 System Prompt

```markdown
You are an AI assistant integrated into tex180, a LaTeX IDE for macOS.
You help the user write, edit, and build LaTeX documents.

## Capabilities
You have access to the following tools:
- `read_file`: Read the contents of a file in the workspace.
- `write_file`: Write content to a file (creates or overwrites).
- `list_files`: List all files in the workspace.
- `build_project`: Trigger a LaTeX build using latexmk.
- `get_build_log`: Get the last build log (stdout/stderr).
- `search_files`: Search for text within project files.

## Guidelines
1. Always read a file before modifying it.
2. When fixing errors, read the build log first, then the relevant source file.
3. Explain your reasoning briefly before taking action.
4. If a task requires multiple steps, complete them all in sequence.
5. Always confirm destructive actions (like overwriting files) with the user.

## Current Workspace
- Root: {{WORKSPACE_ROOT}}
- Active File: {{ACTIVE_FILE}}
```

---

## 4. Tool Definitions (`agent-tools.cjs`)

### 4.1 Tool Schema (Gemini Function Calling Format)

```javascript
const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Returns the file content as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from workspace root (e.g., "main.tex" or "chapters/intro.tex")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace. Creates the file if it does not exist, or overwrites if it does.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from workspace root'
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List all files in the workspace. Returns an array of relative file paths.',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Optional subdirectory to list (defaults to workspace root)'
        }
      },
      required: []
    }
  },
  {
    name: 'build_project',
    description: 'Trigger a LaTeX build using latexmk. Returns success/failure status.',
    parameters: {
      type: 'object',
      properties: {
        mainFile: {
          type: 'string',
          description: 'Optional main .tex file to build (defaults to project root file)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_build_log',
    description: 'Get the log output from the last build. Useful for diagnosing errors.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern in all .tex and .bib files. Returns matching lines with file paths.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text pattern to search for (case-insensitive)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'create_file',
    description: 'Create a new empty file at the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path for the new file'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace. USE WITH CAUTION.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to delete'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: {
          type: 'string',
          description: 'Current relative path of the file'
        },
        newPath: {
          type: 'string',
          description: 'New relative path for the file'
        }
      },
      required: ['oldPath', 'newPath']
    }
  },
  {
    name: 'insert_at_line',
    description: 'Insert content at a specific line number in a file. Does not overwrite existing content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        line: {
          type: 'integer',
          description: 'Line number to insert at (1-indexed)'
        },
        content: {
          type: 'string',
          description: 'Content to insert'
        }
      },
      required: ['path', 'line', 'content']
    }
  },
  {
    name: 'replace_lines',
    description: 'Replace a range of lines in a file with new content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file'
        },
        startLine: {
          type: 'integer',
          description: 'First line to replace (1-indexed, inclusive)'
        },
        endLine: {
          type: 'integer',
          description: 'Last line to replace (1-indexed, inclusive)'
        },
        content: {
          type: 'string',
          description: 'Replacement content'
        }
      },
      required: ['path', 'startLine', 'endLine', 'content']
    }
  }
];
```

### 4.2 Tool Implementations

Each tool wraps existing tex180 services:

```javascript
async function executeToolCall(toolCall) {
  const { name, args } = toolCall;
  
  switch (name) {
    case 'read_file':
      return await workspace.readFile(args.path);
      
    case 'write_file':
      await workspace.writeFile(args.path, args.content);
      return { success: true, message: `Wrote ${args.content.length} bytes to ${args.path}` };
      
    case 'list_files':
      return await workspace.listFiles(args.directory || '');
      
    case 'build_project':
      const result = await buildService.build(workspace.getRootPath(), args.mainFile);
      return { kind: result.kind, summary: result.summary };
      
    case 'get_build_log':
      return buildService.getLastLog();
      
    case 'search_files':
      return await searchService.search(args.query);
      
    case 'create_file':
      await workspace.createFile(args.path);
      return { success: true };
      
    case 'delete_file':
      await workspace.deleteItem(args.path);
      return { success: true };
      
    case 'rename_file':
      await workspace.renameItem(args.oldPath, args.newPath);
      return { success: true };
      
    case 'insert_at_line':
      const content = await workspace.readFile(args.path);
      const lines = content.split('\n');
      lines.splice(args.line - 1, 0, args.content);
      await workspace.writeFile(args.path, lines.join('\n'));
      return { success: true };
      
    case 'replace_lines':
      const fileContent = await workspace.readFile(args.path);
      const fileLines = fileContent.split('\n');
      fileLines.splice(args.startLine - 1, args.endLine - args.startLine + 1, args.content);
      await workspace.writeFile(args.path, fileLines.join('\n'));
      return { success: true };
      
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
```

---

## 5. LLM Client (`agent-llm.cjs`)

### 5.1 Gemini API Integration

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiClient {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      }
    });
  }
  
  async generate(contents, options = {}) {
    const request = {
      contents,
      tools: options.tools ? [{ functionDeclarations: options.tools }] : undefined,
      toolConfig: options.toolConfig,
    };
    
    const result = await this.model.generateContent(request);
    const response = result.response;
    
    return {
      hasFunctionCall: () => {
        const part = response.candidates?.[0]?.content?.parts?.[0];
        return !!part?.functionCall;
      },
      getFunctionCall: () => {
        const part = response.candidates?.[0]?.content?.parts?.[0];
        return part?.functionCall;
      },
      getText: () => {
        const part = response.candidates?.[0]?.content?.parts?.[0];
        return part?.text || '';
      },
      getUsage: () => response.usageMetadata
    };
  }
}

module.exports = { GeminiClient };
```

---

## 6. IPC Interface

### 6.1 Main Process Handlers (`main.cjs` additions)

```javascript
const { AgentService } = require('./services/agent.cjs');

let agentService = null;

ipcMain.handle('agent:init', async (event, { apiKey }) => {
  agentService = new AgentService(apiKey, workspace, buildService, searchService);
  return { success: true };
});

ipcMain.handle('agent:chat', async (event, { message }) => {
  if (!agentService) {
    return { error: 'Agent not initialized' };
  }
  // This triggers the agent loop and sends updates via sendToRenderer
  await agentService.processMessage(message);
  return { success: true };
});

ipcMain.handle('agent:cancel', async () => {
  if (agentService) {
    agentService.cancel();
  }
  return { success: true };
});

ipcMain.handle('agent:clear', async () => {
  if (agentService) {
    agentService.clearHistory();
  }
  return { success: true };
});
```

### 6.2 Preload Exposure (`preload.cjs` additions)

```javascript
contextBridge.exposeInMainWorld('tex180Agent', {
  init: (apiKey) => ipcRenderer.invoke('agent:init', { apiKey }),
  chat: (message) => ipcRenderer.invoke('agent:chat', { message }),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  clear: () => ipcRenderer.invoke('agent:clear'),
  onToolExecution: (callback) => {
    ipcRenderer.on('agent:toolExecution', (event, data) => callback(data));
  },
  onResponse: (callback) => {
    ipcRenderer.on('agent:response', (event, data) => callback(data));
  },
  onThinking: (callback) => {
    ipcRenderer.on('agent:thinking', (event, data) => callback(data));
  }
});
```

---

## 7. Frontend UI (`web-src/main.ts` additions)

### 7.1 New Tab: AI Assistant

Add to `tabConfig`:

```typescript
ai: {
  label: 'AI',
  outline: 'AIアシスタント',
  title: 'AIアシスタント',
  desc: 'Gemini AIがLaTeX執筆をサポートします。',
  hint: 'メッセージを入力してください。',
}
```

### 7.2 Chat UI Structure

```html
<div id="ai-panel" class="panel" data-panel="ai">
  <div class="ai-header">
    <div class="ai-title">AI Assistant</div>
    <button id="ai-clear" class="panel-button ghost">クリア</button>
  </div>
  
  <div id="ai-messages" class="ai-messages">
    <!-- Messages rendered here -->
  </div>
  
  <div class="ai-input-area">
    <textarea id="ai-input" placeholder="質問やタスクを入力..."></textarea>
    <button id="ai-send" class="panel-button primary">送信</button>
  </div>
</div>
```

### 7.3 Message Rendering

```typescript
interface AiMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  isThinking?: boolean;
}

function renderMessage(msg: AiMessage): HTMLElement {
  const el = document.createElement('div');
  el.className = `ai-message ai-message-${msg.role}`;
  
  if (msg.role === 'tool') {
    el.innerHTML = `
      <div class="ai-tool-badge">${msg.toolName}</div>
      <pre class="ai-tool-output">${escapeHtml(msg.content)}</pre>
    `;
  } else if (msg.isThinking) {
    el.innerHTML = `<div class="ai-thinking"><span class="spinner"></span> 考え中...</div>`;
  } else {
    el.innerHTML = marked.parse(msg.content); // Markdown rendering
  }
  
  return el;
}
```

---

## 8. API Key Management

### 8.1 Storage
- Store API key in `electron-store` or OS keychain (via `keytar`)
- Never expose in renderer process directly
- Prompt user on first use

### 8.2 Settings UI

Add to Settings panel:

```html
<div class="settings-row">
  <label>Gemini API Key</label>
  <input type="password" id="settings-api-key" placeholder="sk-..." />
  <button id="settings-save-key">保存</button>
</div>
```

---

## 9. Error Handling

### 9.1 Tool Execution Errors
- Wrap all tool executions in try/catch
- Return error message to LLM so it can self-correct
- Show user-friendly error in UI

### 9.2 LLM Errors
- Handle rate limits with exponential backoff
- Timeout after 60 seconds per request
- Display error state in UI

### 9.3 Safety
- Confirm before destructive operations (delete, overwrite)
- Log all file modifications
- Implement undo for file operations (via workspace history)

---

## 10. Example Agent Flows

### 10.1 Fix Build Error

**User**: "ビルドが失敗した。直して。"

**Agent Flow**:
1. `build_project()` → Returns `{ kind: 'failure' }`
2. `get_build_log()` → Returns log showing "Undefined control sequence \newcommad"
3. `read_file('main.tex')` → Gets source
4. Identifies typo: `\newcommad` should be `\newcommand`
5. `replace_lines('main.tex', 5, 5, '\\newcommand{\\myvec}[1]{\\vec{#1}}')` → Fixes typo
6. `build_project()` → Returns `{ kind: 'success' }`
7. Responds: "main.texの5行目にタイポ(\\newcommad → \\newcommand)がありました。修正してビルドが成功しました。"

### 10.2 Create New Chapter

**User**: "量子力学について新しい章を作って"

**Agent Flow**:
1. `list_files()` → See existing structure
2. `read_file('main.tex')` → Check current \include structure
3. `write_file('chapters/quantum.tex', '...')` → Create new chapter
4. `replace_lines('main.tex', 15, 15, '\\include{chapters/quantum}')` → Add to main
5. Responds: "chapters/quantum.tex に新しい章を作成し、main.texに追加しました。"

---

## 11. Dependencies

```json
{
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "electron-store": "^8.1.0"
  }
}
```

---

## 12. Implementation Phases

### Phase 1: Core Agent (Week 1)
- [ ] Create `agent.cjs`, `agent-tools.cjs`, `agent-llm.cjs`
- [ ] Implement basic tools: `read_file`, `write_file`, `list_files`
- [ ] Set up IPC handlers
- [ ] Basic chat UI

### Phase 2: Build Integration (Week 2)
- [ ] Add `build_project`, `get_build_log` tools
- [ ] Implement error parsing and auto-fix flow
- [ ] UI for tool execution visibility

### Phase 3: Advanced Features (Week 3)
- [ ] Add `search_files`, `replace_lines`, `insert_at_line`
- [ ] Implement confirmation dialogs for destructive actions
- [ ] API key management and settings

### Phase 4: Polish (Week 4)
- [ ] Streaming responses
- [ ] Conversation history persistence
- [ ] Error handling and recovery
- [ ] Documentation and testing
