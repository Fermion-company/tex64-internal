type MonacoLanguageApi = {
  languages?: {
    register?: (config: { id: string }) => void;
    setLanguageConfiguration?: (
      languageId: string,
      configuration: {
        comments?: { lineComment?: string };
        brackets?: string[][];
        autoClosingPairs?: Array<{ open: string; close: string; notIn?: string[] }>;
        surroundingPairs?: Array<{ open: string; close: string }>;
      }
    ) => void;
    setMonarchTokensProvider?: (
      languageId: string,
      languageDef: unknown
    ) => void;
  };
};

export const EXPL3_COMMAND_PATTERN = /\\(?:[A-Za-z@][A-Za-z0-9@]*|__[A-Za-z0-9@]+)(?:_[A-Za-z0-9@]+)+:[NnTFpcexofDVvw]*(?![A-Za-z])/;
export const EXPL3_VARIABLE_PATTERN = /\\[lgc]_(?:[A-Za-z0-9]+_)*[A-Za-z0-9]+_(?:tl|seq|int|dim|bool|str|clist|prop|fp|box|coffin|ior|iow|skip|muskip|token|regex|quark)\b/;

export const LATEX_MONARCH = {
  defaultToken: "",
  tokenPostfix: ".tex",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [
        /(\\begin)(\s*)(\{)(luacode\*?)(\})/,
        [
          "keyword",
          "white",
          "delimiter",
          "type",
          { token: "delimiter", next: "@luaCode", nextEmbedded: "lua" },
        ],
      ],
      [
        /(\\directlua)(\s*)(\{)/,
        [
          "keyword",
          "white",
          { token: "delimiter", next: "@directLua", nextEmbedded: "lua" },
        ],
      ],
      [
        /(\\(?:begin|end))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [/(\\(?:begin|end))(\s*)(\{)([^}]*)$/, ["keyword", "white", "delimiter", "type"]],
      [
        /(\\(?:documentclass|usepackage))(\s*)(\[)([^\]]*)(\])(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "string", "delimiter", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:documentclass|usepackage))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:newcommand|renewcommand|providecommand)\*?)(\s*)(\{)(\\[a-zA-Z@]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:label|ref|eqref|autoref|cref|Cref))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:bibliography|bibliographystyle))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:input|include|includegraphics|graphicspath))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "string", "delimiter"],
      ],
      [EXPL3_COMMAND_PATTERN, "support.function.expl3"],
      [EXPL3_VARIABLE_PATTERN, "variable.expl3"],
      [/\\[a-zA-Z@]+/, "variable"],
      [/\\./, "variable"],
      [/#\d+/, "number"],
      [/[a-zA-Z@][\w:-]*(?=\s*=)/, "variable"],
      [/=/, "operator"],
      [/\$\$|\$|\\\(|\\\)|\\\[|\\\]/, "string"],
      [/[{}[\]()]/, "delimiter"],
      [/[&^_~]/, "operator"],
      [/\d+(\.\d+)?/, "number"],
    ],
    directLua: [
      [/[^{}]+/, ""],
      [/\{/, { token: "delimiter", next: "@directLuaNested" }],
      [/\}/, { token: "delimiter", next: "@pop", nextEmbedded: "@pop" }],
    ],
    directLuaNested: [
      [/[^{}]+/, ""],
      [/\{/, { token: "delimiter", next: "@push" }],
      [/\}/, { token: "delimiter", next: "@pop" }],
    ],
    luaCode: [
      [
        /(\\end)(\s*)(\{)(luacode\*?)(\})/,
        [
          "keyword",
          "white",
          "delimiter",
          "type",
          { token: "delimiter", next: "@pop", nextEmbedded: "@pop" },
        ],
      ],
      [/[^\\]+/, ""],
      [/\\/, ""],
    ],
  },
};

const BIBTEX_MONARCH = {
  defaultToken: "",
  tokenPostfix: ".bib",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/(@)([a-zA-Z_]+)/, ["operator", "keyword"]],
      [/([a-zA-Z_][\w:-]*)(\s*)(=)/, ["variable", "white", "operator"]],
      [/(\{)([^,\s]+)(,)/, ["delimiter", "type", "delimiter"]],
      [/"[^"]*"/, "string"],
      [/[{}()]/, "delimiter"],
      [/#/, "operator"],
      [/\d+/, "number"],
      [/[a-zA-Z_][\w-]*/, "identifier"],
    ],
  },
};

export const registerTexLanguages = (monaco: MonacoLanguageApi) => {
  monaco.languages?.register?.({ id: "latex" });
  monaco.languages?.register?.({ id: "bibtex" });

  monaco.languages?.setLanguageConfiguration?.("latex", {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
  });

  monaco.languages?.setLanguageConfiguration?.("bibtex", {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  });

  monaco.languages?.setMonarchTokensProvider?.("latex", LATEX_MONARCH);
  monaco.languages?.setMonarchTokensProvider?.("bibtex", BIBTEX_MONARCH);
};
