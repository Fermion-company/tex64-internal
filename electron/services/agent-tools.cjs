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
];

module.exports = {
  AGENT_TOOL_DECLARATIONS,
};
