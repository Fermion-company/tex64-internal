import { buildWordCandidates } from "./math-wysiwyg-candidates.js";
import { normalizeLatexKey } from "./math-wysiwyg-keymap.js";
const SLASH_COMMAND_DEFAULT_HINTS = [
    "label",
    "tag",
    "tagstar",
    "notag",
    "nonumber",
    "eqref",
    "ref",
    "pageref",
    "autoref",
    "intertext",
    "shortintertext",
    "aligned",
    "align",
    "alignat",
    "flalign",
    "multline",
    "split",
    "array",
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
    "frac",
    "sqrt",
    "sum",
    "int",
    "lim",
    "text",
    "op",
];
export const SLASH_COMMAND_HINT_SET = new Set(SLASH_COMMAND_DEFAULT_HINTS.map((hint) => hint.toLowerCase()));
const SLASH_COMMAND_ALIAS_MAP = {
    "tag*": "tagstar",
    "align*": "align",
    "alignat*": "alignat",
    "flalign*": "flalign",
    "multline*": "multline",
};
const SLASH_COMMAND_HINT_DISPLAY_MAP = {
    tagstar: "tag*",
    align: "align*",
    alignat: "alignat*",
    flalign: "flalign*",
    multline: "multline*",
};
export const SLASH_COMMAND_CANDIDATE_LIMIT = 24;
export const normalizeSlashCommandToken = (token) => {
    var _a;
    const normalized = token.trim();
    if (!normalized) {
        return "";
    }
    return (_a = SLASH_COMMAND_ALIAS_MAP[normalized.toLowerCase()]) !== null && _a !== void 0 ? _a : normalized;
};
export const applySlashCommandHint = (candidate) => {
    var _a;
    const hintKey = candidate.hint.toLowerCase();
    const displayHint = (_a = SLASH_COMMAND_HINT_DISPLAY_MAP[hintKey]) !== null && _a !== void 0 ? _a : candidate.hint;
    return {
        ...candidate,
        hint: `//${displayHint}`,
    };
};
export const dedupeCandidatesByLatex = (candidates) => {
    const seen = new Set();
    const deduped = [];
    for (const candidate of candidates) {
        const dedupeKey = normalizeLatexKey(candidate.key.latex) || candidate.id;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        deduped.push(candidate);
    }
    return deduped;
};
export const buildSlashCommandFallbackCandidates = () => {
    const candidates = [];
    for (const hint of SLASH_COMMAND_DEFAULT_HINTS) {
        const words = buildWordCandidates(hint, {
            allowContains: false,
            allowContainsMinLength: Number.MAX_SAFE_INTEGER,
            dedupeByLatex: true,
        });
        const exact = words.find((candidate) => candidate.hint.toLowerCase() === hint.toLowerCase());
        if (exact) {
            candidates.push(exact);
        }
    }
    return dedupeCandidatesByLatex(candidates).map(applySlashCommandHint);
};
