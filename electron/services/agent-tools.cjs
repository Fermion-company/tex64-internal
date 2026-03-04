const AGENT_TOOL_DECLARATIONS = [
  {
    name: "list_files",
    description: "List files in the workspace (optionally under a directory).",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Relative directory path from workspace root",
        },
      },
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace (supports base64 for binary).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        encoding: {
          type: "string",
          description: "Optional encoding: utf8 (default) or base64 for binary",
        },
        binary: {
          type: "boolean",
          description: "Shortcut to request base64 output for binary files",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_files",
    description:
      "Read multiple files at once. More efficient than multiple read_file calls.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of relative file paths from workspace root",
        },
        encoding: {
          type: "string",
          description: "Optional encoding: utf8 (default) or base64 for binary",
        },
        binary: {
          type: "boolean",
          description: "Shortcut to request base64 output for binary files",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "search_files",
    description: "Search for a text query in the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_project_structure",
    description: "Get the project structure as a tree. Useful for understanding the codebase.",
    parameters: {
      type: "object",
      properties: {
        maxDepth: {
          type: "number",
          description: "Maximum depth to traverse (default: 3)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_index",
    description: "Get LaTeX project index (labels, references, citations, sections, figures, tables, todos).",
    parameters: {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Filter kinds (labels, references, citations, sections, figures, tables, todos)",
        },
        query: {
          type: "string",
          description: "Optional filter keyword for keys/titles",
        },
        limit: {
          type: "number",
          description: "Max entries per kind (default: 200)",
        },
      },
      required: [],
    },
  },
  {
    name: "rename_latex_symbol",
    description:
      "Rename LaTeX label/citation keys across the workspace (updates \\label/\\ref/\\cite and .bib entries).",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Existing symbol key to rename",
        },
        to: {
          type: "string",
          description: "New symbol key",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Kinds to rename: label, ref, cite (default: label + cite)",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional file extensions to scan (default: tex,bib,sty,cls,ltx,dtx)",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "run_build",
    description: "Run LaTeX build for verification.",
    parameters: {
      type: "object",
      properties: {
        mainFile: {
          type: "string",
          description: "Main .tex file path (relative). Defaults to root file or main.tex.",
        },
        engine: {
          type: "string",
          description: "Engine: lualatex, pdflatex, xelatex, uplatex (optional).",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description:
      "Run an allowed verification command in the workspace and return stdout/stderr (only when allowRunCommand=true).",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
        cwd: {
          type: "string",
          description: "Optional working directory (relative to workspace root)",
        },
        env: {
          type: "object",
          description: "Optional environment variables",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds",
        },
        maxOutputBytes: {
          type: "number",
          description: "Optional max output bytes (0 or negative for unlimited)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "open_terminal_session",
    description: "Open a persistent shell session bound to the workspace.",
    parameters: {
      type: "object",
      properties: {
        shell: {
          type: "string",
          description: "Optional shell path (default: user's SHELL or /bin/zsh)",
        },
        cwd: {
          type: "string",
          description: "Optional working directory (relative to workspace root)",
        },
      },
      required: [],
    },
  },
  {
    name: "execute_bash_command",
    description:
      "Execute any shell command inside a persistent terminal session. Creates a session when sessionId is omitted.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command text to execute",
        },
        sessionId: {
          type: "string",
          description: "Existing terminal session ID (optional)",
        },
        shell: {
          type: "string",
          description: "Shell path used only when creating a new session",
        },
        cwd: {
          type: "string",
          description: "Working directory used only when creating a new session",
        },
        timeoutMs: {
          type: "number",
          description: "Command timeout in milliseconds",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "send_terminal_input",
    description: "Send raw input to a running terminal session (for interactive commands).",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Terminal session ID",
        },
        chars: {
          type: "string",
          description: "Raw characters to send (e.g. newline or Ctrl-C)",
        },
      },
      required: ["sessionId", "chars"],
    },
  },
  {
    name: "read_terminal_output",
    description: "Read incremental output from a terminal session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Terminal session ID",
        },
        since: {
          type: "number",
          description: "Offset returned by previous read_terminal_output call",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "kill_terminal",
    description: "Terminate a terminal session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Terminal session ID",
        },
        signal: {
          type: "string",
          description: "Optional process signal (default: SIGTERM)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for external information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        limit: {
          type: "number",
          description: "Maximum number of results",
        },
        timeoutMs: {
          type: "number",
          description: "Request timeout in milliseconds",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_app_settings",
    description: "Get application settings (compile engine, editor options, format settings).",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional keys to filter (compileEngine, autoSynctexOnBuild, reverseSynctexEnabled, pdfViewerMode, ghostCompletionEnabled, alignEnv, formatSettings)",
        },
      },
      required: [],
    },
  },
  {
    name: "set_app_settings",
    description: "Update application settings and return the updated snapshot.",
    parameters: {
      type: "object",
      properties: {
        settings: {
          type: "object",
          description: "Partial settings to update",
        },
      },
      required: ["settings"],
    },
  },
  {
    name: "read_scratchpad",
    description: "Read the agent scratchpad memo for this conversation.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "write_scratchpad",
    description: "Write or append to the agent scratchpad memo.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Scratchpad content",
        },
        mode: {
          type: "string",
          description: "replace (default), append, or clear",
        },
      },
      required: [],
    },
  },
  {
    name: "write_file",
    description: "Directly write content to a file (auto-applied with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        content: {
          type: "string",
          description: "Full content to write",
        },
        encoding: {
          type: "string",
          description: "Optional encoding: utf8 (default) or base64 for binary",
        },
        summary: {
          type: "string",
          description: "Short summary for the user",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch_file",
    description: "Directly apply partial edits using search/replace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        search: {
          type: "string",
          description: "Exact text to search for in the file",
        },
        replace: {
          type: "string",
          description: "Text to replace the search text with",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences (default: false)",
        },
        edits: {
          type: "array",
          description: "Batch edits across one or more files",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative file path from workspace root",
              },
              search: {
                type: "string",
                description: "Exact text to search for in the file",
              },
              replace: {
                type: "string",
                description: "Text to replace the search text with",
              },
              replaceAll: {
                type: "boolean",
                description: "Replace all occurrences (default: false)",
              },
            },
            required: ["path", "search", "replace"],
          },
        },
        summary: {
          type: "string",
          description: "Short summary for the user",
        },
      },
      required: [],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file (auto-applied with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        summary: {
          type: "string",
          description: "Reason for deletion",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file (auto-applied with undo support).",
    parameters: {
      type: "object",
      properties: {
        oldPath: {
          type: "string",
          description: "Current relative file path",
        },
        newPath: {
          type: "string",
          description: "New relative file path",
        },
        summary: {
          type: "string",
          description: "Reason for rename/move",
        },
      },
      required: ["oldPath", "newPath"],
    },
  },
  {
    name: "create_directory",
    description: "Create a new directory (auto-applied with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative directory path to create",
        },
        summary: {
          type: "string",
          description: "Reason for creating directory",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_write",
    description:
      "Write content to a file (auto-applied by default, with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        content: {
          type: "string",
          description: "Full content to write",
        },
        encoding: {
          type: "string",
          description: "Optional encoding: utf8 (default) or base64 for binary",
        },
        summary: {
          type: "string",
          description: "Short summary for the user",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "propose_patch",
    description:
      "Apply partial edits using search and replace (supports multiple edits and files).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        search: {
          type: "string",
          description: "Exact text to search for in the file",
        },
        replace: {
          type: "string",
          description: "Text to replace the search text with",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences (default: false)",
        },
        edits: {
          type: "array",
          description: "Batch edits across one or more files",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative file path from workspace root",
              },
              search: {
                type: "string",
                description: "Exact text to search for in the file",
              },
              replace: {
                type: "string",
                description: "Text to replace the search text with",
              },
              replaceAll: {
                type: "boolean",
                description: "Replace all occurrences (default: false)",
              },
            },
            required: ["path", "search", "replace"],
          },
        },
        summary: {
          type: "string",
          description: "Short summary for the user",
        },
      },
      required: [],
    },
  },
  {
    name: "propose_delete",
    description: "Delete a file (auto-applied by default, with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
        summary: {
          type: "string",
          description: "Reason for deletion",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_rename",
    description: "Rename or move a file (auto-applied by default, with undo support).",
    parameters: {
      type: "object",
      properties: {
        oldPath: {
          type: "string",
          description: "Current relative file path",
        },
        newPath: {
          type: "string",
          description: "New relative file path",
        },
        summary: {
          type: "string",
          description: "Reason for rename/move",
        },
      },
      required: ["oldPath", "newPath"],
    },
  },
  {
    name: "propose_create_directory",
    description: "Create a new directory (auto-applied by default, with undo support).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative directory path to create",
        },
        summary: {
          type: "string",
          description: "Reason for creating directory",
        },
      },
      required: ["path"],
    },
  },
];

module.exports = {
  AGENT_TOOL_DECLARATIONS,
};
