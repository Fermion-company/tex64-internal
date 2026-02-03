import { getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import { type Candidate, makeCandidate, TRIGGER_KEYS, TRIGGER_MAP } from "./math-wysiwyg-triggers.js";

export const OPERATOR_TRIGGERS: Record<
  string,
  Array<{ latex: string; label: string; displayLatex?: string }>
> = {
  "*": [
    { latex: "\\cdot", label: "⋅", displayLatex: "\\cdot" },
    { latex: "\\times", label: "×", displayLatex: "\\times" },
  ],
  "<=": [
    { latex: "\\leq", label: "≤", displayLatex: "\\leq" },
    { latex: "\\leqq", label: "≦", displayLatex: "\\leqq" },
    { latex: "\\leqslant", label: "≤", displayLatex: "\\leqslant" },
  ],
  ">=": [
    { latex: "\\geq", label: "≥", displayLatex: "\\geq" },
    { latex: "\\geqq", label: "≧", displayLatex: "\\geqq" },
    { latex: "\\geqslant", label: "≥", displayLatex: "\\geqslant" },
  ],
  "!=": [
    { latex: "\\neq", label: "≠", displayLatex: "\\neq" },
    { latex: "\\approx", label: "≈", displayLatex: "\\approx" },
    { latex: "\\ne", label: "≠", displayLatex: "\\ne" },
  ],
  "||": [
    { latex: "\\parallel", label: "∥", displayLatex: "\\parallel" },
    { latex: "\\mid", label: "∣", displayLatex: "\\mid" },
  ],
  ":=": [
    { latex: ":=", label: ":=", displayLatex: ":=" },
    { latex: "\\stackrel{def}{=}", label: "def=", displayLatex: "\\stackrel{def}{=}" },
  ],
  "->": [
    { latex: "\\to", label: "→", displayLatex: "\\to" },
    { latex: "\\rightarrow", label: "→", displayLatex: "\\rightarrow" },
    { latex: "\\Rightarrow", label: "⇒", displayLatex: "\\Rightarrow" },
  ],
  "<-": [
    { latex: "\\leftarrow", label: "←", displayLatex: "\\leftarrow" },
    { latex: "\\Leftarrow", label: "⇐", displayLatex: "\\Leftarrow" },
  ],
  "<->": [
    { latex: "\\leftrightarrow", label: "↔", displayLatex: "\\leftrightarrow" },
    { latex: "\\Leftrightarrow", label: "⇔", displayLatex: "\\Leftrightarrow" },
  ],
  "=>": [{ latex: "\\Rightarrow", label: "⇒", displayLatex: "\\Rightarrow" }],
  "<=>": [{ latex: "\\Leftrightarrow", label: "⇔", displayLatex: "\\Leftrightarrow" }],
  "+-": [{ latex: "\\pm", label: "±", displayLatex: "\\pm" }],
  "-+": [{ latex: "\\mp", label: "∓", displayLatex: "\\mp" }],
  "...": [
    { latex: "\\ldots", label: "…", displayLatex: "\\ldots" },
    { latex: "\\cdots", label: "⋯", displayLatex: "\\cdots" },
  ],
  "d/dx": [
    {
      latex: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}",
      label: "d/dx",
      displayLatex: "\\frac{\\mathrm{d}x}{\\mathrm{d}t}",
    },
  ],
  "∂/∂x": [
    {
      latex: "\\frac{\\partial #?}{\\partial #?}",
      label: "∂/∂x",
      displayLatex: "\\frac{\\partial x}{\\partial y}",
    },
  ],
};

export const OPERATOR_TRIGGER_KEYS = Object.keys(OPERATOR_TRIGGERS);
export const OPERATOR_MAX_LENGTH = OPERATOR_TRIGGER_KEYS.reduce(
  (max, key) => Math.max(max, key.length),
  1
);
export const OPERATOR_MIN_LENGTH = OPERATOR_TRIGGER_KEYS.reduce(
  (min, key) => Math.min(min, key.length),
  OPERATOR_MAX_LENGTH
);

const TRIGGER_KEYS_SORTED = [...TRIGGER_KEYS].sort();

const lowerBound = (items: string[], value: string) => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

const getPrefixMatches = (prefix: string) => {
  if (!prefix) {
    return [] as string[];
  }
  const start = lowerBound(TRIGGER_KEYS_SORTED, prefix);
  const end = lowerBound(TRIGGER_KEYS_SORTED, `${prefix}\uffff`);
  if (end <= start) {
    return [] as string[];
  }
  return TRIGGER_KEYS_SORTED.slice(start, end);
};

const buildNgramIndex = (items: string[], n: number) => {
  const map = new Map<string, string[]>();
  if (n <= 0) {
    return map;
  }
  items.forEach((item) => {
    if (item.length < n) {
      return;
    }
    // Avoid duplicating the same n-gram for one trigger (e.g. "aaaa").
    const seen = new Set<string>();
    for (let i = 0; i <= item.length - n; i += 1) {
      const gram = item.slice(i, i + n);
      if (seen.has(gram)) {
        continue;
      }
      seen.add(gram);
      const existing = map.get(gram);
      if (existing) {
        existing.push(item);
      } else {
        map.set(gram, [item]);
      }
    }
  });
  return map;
};

const CONTAINS_INDEX_2 = buildNgramIndex(TRIGGER_KEYS, 2);
const CONTAINS_INDEX_3 = buildNgramIndex(TRIGGER_KEYS, 3);

const getContainsCandidates = (query: string) => {
  if (!query) {
    return [] as string[];
  }
  const useTrigram = query.length >= 3;
  const n = useTrigram ? 3 : 2;
  if (query.length < n) {
    return [] as string[];
  }
  const index = useTrigram ? CONTAINS_INDEX_3 : CONTAINS_INDEX_2;
  let best: string[] | null = null;
  const seen = new Set<string>();
  for (let i = 0; i <= query.length - n; i += 1) {
    const gram = query.slice(i, i + n);
    if (seen.has(gram)) {
      continue;
    }
    seen.add(gram);
    const matches = index.get(gram);
    if (!matches) {
      continue;
    }
    if (!best || matches.length < best.length) {
      best = matches;
    }
  }
  return best ?? [];
};

export const buildOperatorCandidates = (token: string) => {
  const entries = OPERATOR_TRIGGERS[token];
  if (!entries) {
    return [] as Candidate[];
  }
  return entries.map((entry, index) => {
    const key = getKeyByLatex(entry.latex, entry.label, entry.displayLatex);
    return makeCandidate(token, key, 120 - index * 2, entry.label, entry.displayLatex);
  });
};

type WordCandidateOptions = {
  allowContains?: boolean;
  allowContainsMinLength?: number;
  allowedPacks?: Set<string>;
};

export const buildWordCandidates = (token: string, options: WordCandidateOptions = {}) => {
  const normalized = token.toLowerCase();
  const allowContains = options.allowContains ?? true;
  const allowContainsMinLength = options.allowContainsMinLength ?? 2;
  const canContains = allowContains && normalized.length >= allowContainsMinLength;
  const allowedPacks = options.allowedPacks;
  const prefixMatches: Array<{ candidate: Candidate; score: number }> = [];
  const containsMatches: Array<{ candidate: Candidate; score: number }> = [];

  const prefixTriggers = getPrefixMatches(normalized);
  prefixTriggers.forEach((trigger) => {
    const matchType = trigger === normalized ? "exact" : "prefix";
    const group = TRIGGER_MAP.get(trigger);
    if (!group) {
      return;
    }
    if (allowedPacks && !allowedPacks.has(group.pack)) {
      return;
    }
    const baseScoreMap = { exact: 220, prefix: 180 } as const;
    const lengthPenalty = trigger.length - normalized.length;
    const baseScore = baseScoreMap[matchType] - lengthPenalty;
    group.candidates.forEach((candidate) => {
      const scriptBoost = 0;
      const isAlias = candidate.hint !== trigger;
      const aliasPenalty =
        isAlias && normalized.length <= 2 ? 140 : isAlias && matchType !== "exact" ? 40 : 0;
      const score =
        baseScore + candidate.priority + group.priority + scriptBoost - aliasPenalty;
      prefixMatches.push({ candidate, score });
    });
  });

  if (canContains) {
    getContainsCandidates(normalized).forEach((trigger) => {
      if (trigger === normalized || trigger.startsWith(normalized)) {
        return;
      }
      if (!trigger.includes(normalized)) {
        return;
      }
      const group = TRIGGER_MAP.get(trigger);
      if (!group) {
        return;
      }
      if (allowedPacks && !allowedPacks.has(group.pack)) {
        return;
      }
      const baseScoreMap = { contains: 120 } as const;
      const indexPenalty = trigger.indexOf(normalized) * 2;
      const lengthPenalty = trigger.length - normalized.length;
      const baseScore = baseScoreMap.contains - lengthPenalty - indexPenalty;
      group.candidates.forEach((candidate) => {
        const scriptBoost = 0;
        const isAlias = candidate.hint !== trigger;
        const aliasPenalty =
          isAlias && normalized.length <= 2 ? 140 : isAlias ? 40 : 0;
        const score =
          baseScore + candidate.priority + group.priority + scriptBoost - aliasPenalty;
        containsMatches.push({ candidate, score });
      });
    });
  }

  prefixMatches.sort((a, b) => b.score - a.score);
  containsMatches.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: Candidate[] = [];
  const pushMatches = (items: Array<{ candidate: Candidate }>) => {
    for (const { candidate } of items) {
      const keyId = normalizeLatexKey(candidate.key.latex) || candidate.id;
      if (seen.has(keyId)) {
        continue;
      }
      seen.add(keyId);
      results.push(candidate);
      if (results.length >= 10) {
        break;
      }
    }
  };
  pushMatches(prefixMatches);
  if (results.length < 10) {
    pushMatches(containsMatches);
  }

  return results;
};
