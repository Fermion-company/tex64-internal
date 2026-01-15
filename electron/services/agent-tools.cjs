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
    description: "Run LaTeX build for verification (no automatic apply).",
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
    description: "Run a shell command in the workspace and return stdout/stderr.",
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
          additionalProperties: { type: "string" },
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
    name: "get_app_settings",
    description: "Get application settings (compile engine, editor options, format settings).",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional keys to filter (compileEngine, autoSynctexOnBuild, pdfViewerMode, alignEnv, formatSettings)",
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
          additionalProperties: true,
        },
      },
      required: ["settings"],
    },
  },
  {
    name: "propose_write",
    description:
      "Propose writing content to a file. This never applies changes automatically.",
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
      "Propose partial edits using search and replace (supports multiple edits and files).",
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
    description: "Propose deleting a file. Requires user confirmation.",
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
    description: "Propose renaming or moving a file. Requires user confirmation.",
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
    description: "Propose creating a new directory. Requires user confirmation.",
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
