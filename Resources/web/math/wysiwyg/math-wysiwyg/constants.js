export const AUTO_WORD_MIN_LENGTH = 3;
export const AUTO_COMMAND_MIN_LENGTH = 2;
export const AUTO_WORD_ALLOWLIST = new Set([
    "bb",
    "bf",
    "bm",
    "ds",
    "ge",
    "gg",
    "in",
    "ip",
    "it",
    "le",
    "ll",
    "ln",
    "mp",
    "mu",
    "ne",
    "ni",
    "nu",
    "op",
    "or",
    "pi",
    "pm",
    "rm",
    "sf",
    "to",
    "tr",
    "tt",
    "xi",
]);
export const AUTO_CONTAINS_MIN_LENGTH = 4;
export const EXPLICIT_WORD_MIN_LENGTH = 1;
export const EXPLICIT_SUFFIX_MIN_LENGTH = 6;
export const DEFAULT_MRU_STORAGE_KEY = "tex64.math-wysiwyg.mru";
export const MAX_MRU_ENTRIES = 200;
export const PLACEHOLDER_TOKEN_REGEX = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;
export const INTERTEXT_TEMPLATE_RE = /^\\(?:intertext|shortintertext)\{#\?\}$/;
export const AUX_COMMAND_TEMPLATE_RE = /^\\(?:label|tag\*?|eqref|ref|pageref|autoref|intertext|shortintertext)\{#\?\}$/;
export const AUX_COMMAND_BARE_RE = /^\\(?:notag|nonumber)$/;
export const MATRIX_LIKE_ENV_NAMES = new Set([
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "smallmatrix",
    "cases",
    "dcases",
    "rcases",
    "aligned",
]);
export const AUX_COMMAND_BLOCKED_ENV_NAMES = new Set([
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "smallmatrix",
    "cases",
    "dcases",
    "rcases",
    "array",
]);
