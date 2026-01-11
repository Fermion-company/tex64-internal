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
    description: "Read a text file from the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_files",
    description: "Read multiple text files at once. More efficient than multiple read_file calls.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of relative file paths from workspace root",
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
      "Propose a partial edit to a file using search and replace. More efficient than rewriting the entire file.",
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
        summary: {
          type: "string",
          description: "Short summary for the user",
        },
      },
      required: ["path", "search", "replace"],
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

