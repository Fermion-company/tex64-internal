import { collectKeyVariants, extractCommand, getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import { MANUAL_TRIGGERS } from "./math-wysiwyg-triggers-data.js";
const isWordToken = (value) => /^[A-Za-z]+$/.test(value);
// Auto-generated script variants (\alpha_{#?}, \alpha^{#?}, \alpha_{#?}^{#?})
// from expandScriptVariants. These flood the suggestion list with near-identical
// entries that are rarely picked — users type the base symbol then add a script.
// Curated limit-forms for big operators (\sum_{}^{}, \int_{}^{}, \lim_{x→a}) live
// in the manual trigger data and are unaffected by this filter.
const isAutoScriptVariant = (latex) => {
    const trimmed = latex.trim();
    return /^\\[A-Za-z]+(?:_\{#\?\})?(?:\^\{#\?\})?$/.test(trimmed) && /[_^]\{#\?\}/.test(trimmed);
};
const buildMathKeyDisplayLatex = (key) => {
    var _a, _b;
    const source = (_b = (_a = key.displayLatex) !== null && _a !== void 0 ? _a : key.latex) !== null && _b !== void 0 ? _b : key.fallback;
    if (!source) {
        return null;
    }
    const placeholders = ["x", "y", "z", "a", "b", "c"];
    let index = 0;
    return source.replace(/#\?/g, () => {
        var _a;
        const value = (_a = placeholders[index]) !== null && _a !== void 0 ? _a : "x";
        index += 1;
        return value;
    });
};
export const makeCandidate = (trigger, key, priority, labelOverride, displayLatexOverride) => {
    var _a, _b;
    const label = (_a = labelOverride !== null && labelOverride !== void 0 ? labelOverride : key.label) !== null && _a !== void 0 ? _a : trigger;
    const displayLatex = (_b = displayLatexOverride !== null && displayLatexOverride !== void 0 ? displayLatexOverride : buildMathKeyDisplayLatex(key)) !== null && _b !== void 0 ? _b : undefined;
    const id = `${normalizeLatexKey(key.latex)}|${label}`;
    return {
        id,
        key,
        label,
        hint: trigger,
        displayLatex,
        priority,
    };
};
export const buildTriggerMap = () => {
    const map = new Map();
    const candidateIdsByTrigger = new Map();
    const ensureGroup = (trigger, groupPriority) => {
        const normalizedTrigger = trigger.toLowerCase();
        let group = map.get(normalizedTrigger);
        if (!group) {
            group = {
                trigger: normalizedTrigger,
                candidates: [],
                priority: groupPriority !== null && groupPriority !== void 0 ? groupPriority : 0,
            };
            map.set(normalizedTrigger, group);
            candidateIdsByTrigger.set(normalizedTrigger, new Set());
        }
        else if (groupPriority !== undefined) {
            group.priority = Math.max(group.priority, groupPriority);
        }
        return group;
    };
    const addCandidate = (trigger, key, priority, labelOverride, displayLatexOverride, groupPriority) => {
        const normalizedTrigger = trigger.toLowerCase();
        const candidate = makeCandidate(normalizedTrigger, key, priority, labelOverride, displayLatexOverride);
        const group = ensureGroup(normalizedTrigger, groupPriority);
        const seenIds = candidateIdsByTrigger.get(normalizedTrigger);
        if (!seenIds) {
            return;
        }
        if (!seenIds.has(candidate.id)) {
            group.candidates.push(candidate);
            seenIds.add(candidate.id);
        }
    };
    MANUAL_TRIGGERS.forEach((entry) => {
        entry.candidates.forEach((candidate, index) => {
            const key = getKeyByLatex(candidate.latex, candidate.label, candidate.displayLatex);
            addCandidate(entry.trigger, key, entry.priority - index * 2, candidate.label, candidate.displayLatex, entry.priority);
        });
    });
    const variants = collectKeyVariants();
    variants.forEach((key) => {
        if (isAutoScriptVariant(key.latex)) {
            return;
        }
        const command = extractCommand(key.latex);
        if (command) {
            addCandidate(command, key, 30);
        }
        if (isWordToken(key.label)) {
            addCandidate(key.label, key, 20);
        }
    });
    return map;
};
