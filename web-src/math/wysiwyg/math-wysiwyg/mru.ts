import { buildWordCandidates } from "../math-wysiwyg-candidates.js";
import { getKeyByLatex, normalizeLatexKey } from "../math-wysiwyg-keymap.js";
import { DEFAULT_MRU_STORAGE_KEY, MAX_MRU_ENTRIES } from "./constants.js";
import type { Candidate } from "../math-wysiwyg-triggers.js";
import type { MruEntry } from "./types.js";

export type MathWysiwygMruState = {
  mruStorageKey: string;
  mru: Map<string, MruEntry>;
  mruSaveTimer: number | null;
  mruSaveKey: string | null;
  resolveMruStorageKey: () => string;
};

export type MathWysiwygMruOps = {
  loadMru: (key: string) => void;
  flushMruSave: () => void;
  ensureMruStorageKey: () => void;
  recordMru: (candidate: Candidate) => void;
  applyMruRanking: (items: Candidate[]) => Candidate[];
  buildRecentCandidates: (limit?: number) => Candidate[];
  buildQuickCandidates: () => Candidate[];
};

const saveMru = (state: MathWysiwygMruState, key: string) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const payload: Record<string, MruEntry> = {};
    state.mru.forEach((entry, id) => {
      payload[id] = entry;
    });
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
};

const scheduleMruSave = (state: MathWysiwygMruState) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  if (state.mruSaveTimer !== null) {
    return;
  }
  state.mruSaveKey = state.mruStorageKey;
  state.mruSaveTimer = window.setTimeout(() => {
    const keyToSave = state.mruSaveKey ?? state.mruStorageKey;
    state.mruSaveTimer = null;
    state.mruSaveKey = null;
    saveMru(state, keyToSave);
  }, 150);
};

export const createMathWysiwygMruOps = (state: MathWysiwygMruState): MathWysiwygMruOps => {
  const loadMru = (key: string) => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, MruEntry>;
      Object.entries(parsed).forEach(([entryKey, entry]) => {
        if (!entry || typeof entry !== "object") return;
        const count = Number(entry.count);
        const lastUsedAt = Number(entry.lastUsedAt);
        if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt)) return;
        const latex = typeof entry.latex === "string" ? entry.latex : undefined;
        const label = typeof entry.label === "string" ? entry.label : undefined;
        const hint = typeof entry.hint === "string" ? entry.hint : undefined;
        const displayLatex = typeof entry.displayLatex === "string" ? entry.displayLatex : undefined;
        state.mru.set(entryKey, { count, lastUsedAt, latex, label, hint, displayLatex });
      });
    } catch {
      // ignore storage errors
    }
  };

  const flushMruSave = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (state.mruSaveTimer === null) {
      return;
    }
    window.clearTimeout(state.mruSaveTimer);
    const keyToSave = state.mruSaveKey ?? state.mruStorageKey;
    state.mruSaveTimer = null;
    state.mruSaveKey = null;
    saveMru(state, keyToSave);
  };

  const ensureMruStorageKey = () => {
    const nextKey = state.resolveMruStorageKey?.() ?? DEFAULT_MRU_STORAGE_KEY;
    if (!nextKey || nextKey === state.mruStorageKey) {
      return;
    }
    flushMruSave();
    state.mru.clear();
    state.mruStorageKey = nextKey;
    loadMru(state.mruStorageKey);
  };

  const recordMru = (candidate: Candidate) => {
    const candidateId = candidate.id;
    if (!candidateId) {
      return;
    }
    ensureMruStorageKey();
    const entry = state.mru.get(candidateId) ?? { count: 0, lastUsedAt: 0 };
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
        const key = sorted[i]?.[0];
        if (key) {
          state.mru.delete(key);
        }
      }
    }
    scheduleMruSave(state);
  };

  const applyMruRanking = (items: Candidate[]) => {
    ensureMruStorageKey();
    if (state.mru.size === 0 || items.length <= 1) {
      return items;
    }
    const ranked = items.map((item, index) => {
      const entry = state.mru.get(item.id);
      return {
        item,
        index,
        count: entry?.count ?? 0,
        lastUsedAt: entry?.lastUsedAt ?? 0,
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
      .filter(
        (item) =>
          !!item.entry &&
          typeof item.entry.latex === "string" &&
          typeof item.entry.label === "string" &&
          typeof item.entry.hint === "string"
      )
      .sort((a, b) => {
        const timeDiff = (b.entry.lastUsedAt ?? 0) - (a.entry.lastUsedAt ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return (b.entry.count ?? 0) - (a.entry.count ?? 0);
      })
      .slice(0, Math.max(0, limit));

    return entries.map(({ id, entry }, index) => {
      const latex = entry.latex ?? "";
      const label = entry.label ?? latex;
      const hint = entry.hint ?? label;
      const displayLatex = entry.displayLatex ?? latex;
      return {
        id,
        key: getKeyByLatex(latex, label, displayLatex),
        label,
        hint,
        displayLatex,
        priority: 240 - index,
      } satisfies Candidate;
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
    const results: Candidate[] = [];
    const seen = new Set<string>();
    tokens.forEach((token) => {
      const candidates = buildWordCandidates(token, {
        allowContains: false,
        allowContainsMinLength: 99,
        allowedPacks: undefined,
      });
      const takeCount = token === "int" || token === "sum" ? 2 : 1;
      candidates.slice(0, takeCount).forEach((candidate) => {
        if (seen.has(candidate.id)) return;
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

