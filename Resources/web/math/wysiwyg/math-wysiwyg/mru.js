import { buildWordCandidates } from "../math-wysiwyg-candidates.js";
import { getKeyByLatex, normalizeLatexKey } from "../math-wysiwyg-keymap.js";
import { DEFAULT_MRU_STORAGE_KEY, MAX_MRU_ENTRIES } from "./constants.js";
const saveMru = (state, key) => {
    if (typeof localStorage === "undefined") {
        return;
    }
    try {
        const payload = {};
        state.mru.forEach((entry, id) => {
            payload[id] = entry;
        });
        localStorage.setItem(key, JSON.stringify(payload));
    }
    catch {
        // ignore storage errors
    }
};
const scheduleMruSave = (state) => {
    if (typeof localStorage === "undefined") {
        return;
    }
    if (state.mruSaveTimer !== null) {
        return;
    }
    state.mruSaveKey = state.mruStorageKey;
    state.mruSaveTimer = window.setTimeout(() => {
        var _a;
        const keyToSave = (_a = state.mruSaveKey) !== null && _a !== void 0 ? _a : state.mruStorageKey;
        state.mruSaveTimer = null;
        state.mruSaveKey = null;
        saveMru(state, keyToSave);
    }, 150);
};
export const createMathWysiwygMruOps = (state) => {
    const loadMru = (key) => {
        if (typeof localStorage === "undefined") {
            return;
        }
        try {
            const raw = localStorage.getItem(key);
            if (!raw) {
                return;
            }
            const parsed = JSON.parse(raw);
            Object.entries(parsed).forEach(([entryKey, entry]) => {
                if (!entry || typeof entry !== "object")
                    return;
                const count = Number(entry.count);
                const lastUsedAt = Number(entry.lastUsedAt);
                if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt))
                    return;
                const latex = typeof entry.latex === "string" ? entry.latex : undefined;
                const label = typeof entry.label === "string" ? entry.label : undefined;
                const hint = typeof entry.hint === "string" ? entry.hint : undefined;
                const displayLatex = typeof entry.displayLatex === "string" ? entry.displayLatex : undefined;
                state.mru.set(entryKey, { count, lastUsedAt, latex, label, hint, displayLatex });
            });
        }
        catch {
            // ignore storage errors
        }
    };
    const flushMruSave = () => {
        var _a;
        if (typeof localStorage === "undefined") {
            return;
        }
        if (state.mruSaveTimer === null) {
            return;
        }
        window.clearTimeout(state.mruSaveTimer);
        const keyToSave = (_a = state.mruSaveKey) !== null && _a !== void 0 ? _a : state.mruStorageKey;
        state.mruSaveTimer = null;
        state.mruSaveKey = null;
        saveMru(state, keyToSave);
    };
    const ensureMruStorageKey = () => {
        var _a, _b;
        const nextKey = (_b = (_a = state.resolveMruStorageKey) === null || _a === void 0 ? void 0 : _a.call(state)) !== null && _b !== void 0 ? _b : DEFAULT_MRU_STORAGE_KEY;
        if (!nextKey || nextKey === state.mruStorageKey) {
            return;
        }
        flushMruSave();
        state.mru.clear();
        state.mruStorageKey = nextKey;
        loadMru(state.mruStorageKey);
    };
    const recordMru = (candidate) => {
        var _a, _b;
        const candidateId = candidate.id;
        if (!candidateId) {
            return;
        }
        ensureMruStorageKey();
        const entry = (_a = state.mru.get(candidateId)) !== null && _a !== void 0 ? _a : { count: 0, lastUsedAt: 0 };
        entry.count += 1;
        entry.lastUsedAt = Date.now();
        if (!candidate.apply) {
            const latex = normalizeLatexKey(candidate.key.latex);
            if (latex) {
                entry.latex = latex;
                entry.label = candidate.label;
                entry.hint = candidate.hint;
                entry.displayLatex = candidate.displayLatex;
            }
        }
        state.mru.set(candidateId, entry);
        if (state.mru.size > MAX_MRU_ENTRIES) {
            const sorted = Array.from(state.mru.entries()).sort((a, b) => {
                const aScore = a[1].lastUsedAt;
                const bScore = b[1].lastUsedAt;
                return aScore - bScore;
            });
            const trimCount = state.mru.size - MAX_MRU_ENTRIES;
            for (let i = 0; i < trimCount; i += 1) {
                const key = (_b = sorted[i]) === null || _b === void 0 ? void 0 : _b[0];
                if (key) {
                    state.mru.delete(key);
                }
            }
        }
        scheduleMruSave(state);
    };
    const applyMruRanking = (items) => {
        ensureMruStorageKey();
        if (state.mru.size === 0 || items.length <= 1) {
            return items;
        }
        const ranked = items.map((item, index) => {
            var _a, _b;
            const entry = state.mru.get(item.id);
            return {
                item,
                index,
                count: (_a = entry === null || entry === void 0 ? void 0 : entry.count) !== null && _a !== void 0 ? _a : 0,
                lastUsedAt: (_b = entry === null || entry === void 0 ? void 0 : entry.lastUsedAt) !== null && _b !== void 0 ? _b : 0,
            };
        });
        ranked.sort((a, b) => {
            if (a.count !== b.count) {
                return b.count - a.count;
            }
            if (a.lastUsedAt !== b.lastUsedAt) {
                return b.lastUsedAt - a.lastUsedAt;
            }
            return a.index - b.index;
        });
        return ranked.map((entry) => entry.item);
    };
    const buildRecentCandidates = (limit = 8) => {
        ensureMruStorageKey();
        const entries = Array.from(state.mru.entries())
            .map(([id, entry]) => ({ id, entry }))
            .filter((item) => !!item.entry &&
            typeof item.entry.latex === "string" &&
            typeof item.entry.label === "string" &&
            typeof item.entry.hint === "string")
            .sort((a, b) => {
            var _a, _b, _c, _d;
            const timeDiff = ((_a = b.entry.lastUsedAt) !== null && _a !== void 0 ? _a : 0) - ((_b = a.entry.lastUsedAt) !== null && _b !== void 0 ? _b : 0);
            if (timeDiff !== 0)
                return timeDiff;
            return ((_c = b.entry.count) !== null && _c !== void 0 ? _c : 0) - ((_d = a.entry.count) !== null && _d !== void 0 ? _d : 0);
        })
            .slice(0, Math.max(0, limit));
        return entries.map(({ id, entry }, index) => {
            var _a, _b, _c, _d;
            const latex = (_a = entry.latex) !== null && _a !== void 0 ? _a : "";
            const label = (_b = entry.label) !== null && _b !== void 0 ? _b : latex;
            const hint = (_c = entry.hint) !== null && _c !== void 0 ? _c : label;
            const displayLatex = (_d = entry.displayLatex) !== null && _d !== void 0 ? _d : latex;
            return {
                id,
                key: getKeyByLatex(latex, label, displayLatex),
                label,
                hint,
                displayLatex,
                priority: 240 - index,
            };
        });
    };
    const buildQuickCandidates = () => {
        // A short, stable set for discoverability when the user hasn't typed a token yet.
        const tokens = [
            "frac",
            "sqrt",
            "sum",
            "int",
            "lim",
            "cases",
            "pmatrix",
            "aligned",
            "text",
            "bb",
            "defeq",
            "to",
        ];
        const results = [];
        const seen = new Set();
        tokens.forEach((token) => {
            const candidates = buildWordCandidates(token, {
                allowContains: false,
                allowContainsMinLength: 99,
                allowedPacks: undefined,
            });
            const takeCount = token === "int" || token === "sum" ? 2 : 1;
            candidates.slice(0, takeCount).forEach((candidate) => {
                if (seen.has(candidate.id))
                    return;
                seen.add(candidate.id);
                results.push(candidate);
            });
        });
        return results;
    };
    return {
        loadMru,
        flushMruSave,
        ensureMruStorageKey,
        recordMru,
        applyMruRanking,
        buildRecentCandidates,
        buildQuickCandidates,
    };
};
