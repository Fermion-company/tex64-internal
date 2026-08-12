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
export const registerTexLanguages = (monaco) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.register) === null || _b === void 0 ? void 0 : _b.call(_a, { id: "latex" });
    (_d = (_c = monaco.languages) === null || _c === void 0 ? void 0 : _c.register) === null || _d === void 0 ? void 0 : _d.call(_c, { id: "bibtex" });
    (_f = (_e = monaco.languages) === null || _e === void 0 ? void 0 : _e.setLanguageConfiguration) === null || _f === void 0 ? void 0 : _f.call(_e, "latex", {
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
    (_h = (_g = monaco.languages) === null || _g === void 0 ? void 0 : _g.setLanguageConfiguration) === null || _h === void 0 ? void 0 : _h.call(_g, "bibtex", {
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
    (_k = (_j = monaco.languages) === null || _j === void 0 ? void 0 : _j.setMonarchTokensProvider) === null || _k === void 0 ? void 0 : _k.call(_j, "latex", LATEX_MONARCH);
    (_m = (_l = monaco.languages) === null || _l === void 0 ? void 0 : _l.setMonarchTokensProvider) === null || _m === void 0 ? void 0 : _m.call(_l, "bibtex", BIBTEX_MONARCH);
};
