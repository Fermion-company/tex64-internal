import { mathKeyboardFixedKeys, mathKeyboardSets } from "../../app/math-keyboard-data.js";
export const normalizeLatexKey = (value) => (value !== null && value !== void 0 ? value : "").trim();
const EXCLUDED_COMMANDS = new Set([
    "left",
    "right",
    "begin",
    "end",
    "mathrm",
    "mathbf",
    "mathbb",
    "mathcal",
    "mathfrak",
    "mathit",
    "mathsf",
    "mathtt",
    "operatorname",
    "overline",
    "underline",
    "hat",
    "tilde",
    "vec",
    "bar",
    "dot",
    "ddot",
    "widehat",
    "widetilde",
    "text",
    "color",
    "bbox",
    "mbox",
    "phantom",
]);
export const extractCommand = (latex) => {
    const trimmed = latex.trim();
    const match = trimmed.match(/^\\([A-Za-z]+)(?![A-Za-z])/);
    if (!match) {
        return null;
    }
    const command = match[1];
    if (!command) {
        return null;
    }
    if (EXCLUDED_COMMANDS.has(command)) {
        return null;
    }
    return command;
};
const resolveShiftKey = (key) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const hasShift = key.shiftLabel ||
        key.shiftLatex ||
        key.shiftFallback ||
        key.shiftDisplayLatex ||
        key.shiftScriptKind ||
        key.shiftScriptValue !== undefined ||
        key.shiftScriptBase ||
        key.shiftScriptSubValue !== undefined ||
        key.shiftScriptSupValue !== undefined ||
        key.shiftTemplateKind ||
        key.shiftTemplateTarget !== undefined ||
        key.shiftTemplateSeparator !== undefined ||
        key.shiftTemplateScope !== undefined;
    if (!hasShift) {
        return null;
    }
    return {
        label: (_a = key.shiftLabel) !== null && _a !== void 0 ? _a : key.label,
        latex: (_b = key.shiftLatex) !== null && _b !== void 0 ? _b : key.latex,
        fallback: (_c = key.shiftFallback) !== null && _c !== void 0 ? _c : key.fallback,
        displayLatex: (_d = key.shiftDisplayLatex) !== null && _d !== void 0 ? _d : key.displayLatex,
        scriptKind: (_e = key.shiftScriptKind) !== null && _e !== void 0 ? _e : key.scriptKind,
        scriptValue: key.shiftScriptValue !== undefined ? key.shiftScriptValue : key.scriptValue,
        scriptBase: (_f = key.shiftScriptBase) !== null && _f !== void 0 ? _f : key.scriptBase,
        scriptSubValue: key.shiftScriptSubValue !== undefined
            ? key.shiftScriptSubValue
            : key.scriptSubValue,
        scriptSupValue: key.shiftScriptSupValue !== undefined
            ? key.shiftScriptSupValue
            : key.scriptSupValue,
        templateKind: (_g = key.shiftTemplateKind) !== null && _g !== void 0 ? _g : key.templateKind,
        templateTarget: key.shiftTemplateTarget !== undefined
            ? key.shiftTemplateTarget
            : key.templateTarget,
        templateSeparator: key.shiftTemplateSeparator !== undefined
            ? key.shiftTemplateSeparator
            : key.templateSeparator,
        templateScope: key.shiftTemplateScope !== undefined
            ? key.shiftTemplateScope
            : key.templateScope,
    };
};
const buildSimpleVariant = (key, latex, displayLatex) => {
    var _a;
    return ({
        label: (_a = key.label) !== null && _a !== void 0 ? _a : latex,
        latex,
        displayLatex,
        fallback: key.fallback,
    });
};
const expandScriptVariants = (key) => {
    var _a, _b;
    const baseLatex = (_a = key.latex) === null || _a === void 0 ? void 0 : _a.trim();
    if (!baseLatex) {
        return [key];
    }
    if (baseLatex.includes("#?")) {
        return [key];
    }
    const commandMatch = baseLatex.match(/^\\([A-Za-z]+)$/);
    if (!commandMatch) {
        return [key];
    }
    const command = commandMatch[1];
    if (!command || EXCLUDED_COMMANDS.has(command)) {
        return [key];
    }
    const baseDisplay = ((_b = key.displayLatex) !== null && _b !== void 0 ? _b : baseLatex).trim();
    const subDisplay = `${baseDisplay}_{i}`;
    const supDisplay = `${baseDisplay}^{2}`;
    const subSupDisplay = `${baseDisplay}_{i}^{n}`;
    return [
        key,
        buildSimpleVariant(key, `${baseLatex}_{#?}`, subDisplay),
        buildSimpleVariant(key, `${baseLatex}^{#?}`, supDisplay),
        buildSimpleVariant(key, `${baseLatex}_{#?}^{#?}`, subSupDisplay),
    ];
};
export const collectKeyVariants = () => {
    const variants = [];
    const allKeys = [
        ...mathKeyboardFixedKeys,
        ...Object.values(mathKeyboardSets).flat(),
    ];
    allKeys.forEach((key) => {
        const expanded = expandScriptVariants(key);
        expanded.forEach((entry) => variants.push(entry));
        const shifted = resolveShiftKey(key);
        if (shifted) {
            expandScriptVariants(shifted).forEach((entry) => variants.push(entry));
        }
    });
    return variants;
};
const buildKeyMap = () => {
    const map = new Map();
    const variants = collectKeyVariants();
    variants.forEach((key) => {
        const normalized = normalizeLatexKey(key.latex);
        if (!normalized) {
            return;
        }
        if (!map.has(normalized)) {
            map.set(normalized, key);
        }
    });
    return map;
};
const KEY_BY_LATEX = buildKeyMap();
export const getKeyByLatex = (latex, label, displayLatex) => {
    const normalized = normalizeLatexKey(latex);
    const existing = KEY_BY_LATEX.get(normalized);
    if (existing) {
        return existing;
    }
    return {
        label,
        latex,
        displayLatex: displayLatex !== null && displayLatex !== void 0 ? displayLatex : latex,
    };
};
