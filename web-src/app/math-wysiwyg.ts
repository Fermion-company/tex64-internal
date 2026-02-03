import { getMathFieldSelectionRange } from "./blocks/math-input-utils.js";
import {
  buildOperatorCandidates,
  buildWordCandidates,
  OPERATOR_MAX_LENGTH,
  OPERATOR_MIN_LENGTH,
  OPERATOR_TRIGGERS,
} from "./math-wysiwyg-candidates.js";
import { getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import {
  getInternalSelectionRanges,
  indexToOffsetInRange,
  offsetToIndexInRange,
  resolveScopeRange,
  setSelectionRange,
} from "./math-wysiwyg-selection.js";
import type { Candidate } from "./math-wysiwyg-triggers.js";
import type { MathKey } from "./types.js";

export type MathWysiwygApi = {
  attach: (mathfield: HTMLElement) => void;
  detach: () => void;
  handleKeydown: (event: KeyboardEvent) => boolean;
  setComposing: (value: boolean) => void;
  close: () => void;
  openExplicitSuggestions: () => boolean;
  updateConfig: (config: Partial<MathWysiwygConfig>) => void;
  getWordCandidates: (token: string) => MathWysiwygWordCandidate[];
  openCustomCandidates: (candidates: CustomCandidate[], options?: { selectedIndex?: number }) => void;
};

export type MathWysiwygWordCandidate = {
  id: string;
  key: MathKey;
  label: string;
  hint: string;
  displayLatex?: string;
};

type MathWysiwygDeps = {
  container: HTMLElement | null;
  insertKey: (key: MathKey) => void;
  autoSuggest?: boolean;
  enabledPacks?: string[];
  mruStorageKey?: string;
  getMruStorageKey?: () => string;
};

type MathWysiwygConfig = {
  autoSuggest: boolean;
  enabledPacks: string[];
};

type TokenIndexMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator";
};

type TokenMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator";
};

type SuggestOptions = {
  explicit?: boolean;
};

type CustomCandidate = {
  id: string;
  label: string;
  hint: string;
  displayLatex?: string;
  apply: (mathfield: any) => void;
};

const isWordToken = (value: string) => /^[A-Za-z]+$/.test(value);
const AUTO_WORD_MIN_LENGTH = 3;
const AUTO_WORD_ALLOWLIST = new Set(["pi", "mu", "nu", "xi"]);
const AUTO_CONTAINS_MIN_LENGTH = 4;
const EXPLICIT_WORD_MIN_LENGTH = 1;
const EXPLICIT_SUFFIX_MIN_LENGTH = 6;
const DEFAULT_MRU_STORAGE_KEY = "tex64.math-wysiwyg.mru";
const MAX_MRU_ENTRIES = 200;
const AUTO_REPLACE_OPERATORS = new Set([
  "=>",
  "<=>",
  "<=",
  ">=",
  "!=",
  "+-",
  "-+",
  "->",
  "<-",
  "<->",
  "...",
  "d/dx",
  "∂/∂x",
]);

type MruEntry = {
  count: number;
  lastUsedAt: number;
  latex?: string;
  label?: string;
  hint?: string;
  displayLatex?: string;
};

const findOperatorToken = (text: string, cursorIndex: number): TokenIndexMatch | null => {
  const maxLength = OPERATOR_MAX_LENGTH;
  const minLength = Math.max(1, OPERATOR_MIN_LENGTH);
  for (let length = maxLength; length >= minLength; length -= 1) {
    const start = cursorIndex - length;
    if (start < 0) {
      continue;
    }
    const token = text.slice(start, cursorIndex);
    if (token in OPERATOR_TRIGGERS) {
      return { token, range: { start, end: cursorIndex }, kind: "operator" };
    }
  }
  return null;
};

const findWordToken = (text: string, cursorIndex: number): TokenIndexMatch | null => {
  let start = cursorIndex;
  while (start > 0) {
    const char = text[start - 1];
    if (!/[A-Za-z]/.test(char)) {
      break;
    }
    start -= 1;
  }
  if (start === cursorIndex) {
    return null;
  }
  const token = text.slice(start, cursorIndex);
  if (!isWordToken(token)) {
    return null;
  }
  const prev = start > 0 ? text[start - 1] : "";
  if (prev === "\\") {
    return null;
  }
  return { token, range: { start, end: cursorIndex }, kind: "word" };
};

export const initMathWysiwyg = (deps: MathWysiwygDeps): MathWysiwygApi => {
  let autoSuggest = deps.autoSuggest ?? true;
  let enabledPacks = new Set(deps.enabledPacks ?? []);
  let mathfield: HTMLElement | null = null;
  let eventController: AbortController | null = null;
  let composing = false;
  let active = false;
  let explicitSession = false;
  let forcedTextMode = false;
  let syncingMode = false;
  let holdTextModeUntil = 0;
  let selectedIndex = 0;
  let currentRange: { start: number; end: number } | null = null;
  let currentCandidates: Candidate[] = [];
  let suppressNextUpdate = false;
  let lastInputTime = 0;
  const resolveMruStorageKey = () =>
    deps.getMruStorageKey?.() ?? deps.mruStorageKey ?? DEFAULT_MRU_STORAGE_KEY;
  let mruStorageKey = resolveMruStorageKey();
  const mru = new Map<string, MruEntry>();
  let mruSaveTimer: number | null = null;
  let mruSaveKey: string | null = null;

  const panel = document.createElement("div");
  panel.className = "math-wysiwyg-panel";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-hidden", "true");

  let panelHost: HTMLElement | null = null;

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
      Object.entries(parsed).forEach(([key, entry]) => {
        if (!entry || typeof entry !== "object") return;
        const count = Number(entry.count);
        const lastUsedAt = Number(entry.lastUsedAt);
        if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt)) return;
        const latex = typeof entry.latex === "string" ? entry.latex : undefined;
        const label = typeof entry.label === "string" ? entry.label : undefined;
        const hint = typeof entry.hint === "string" ? entry.hint : undefined;
        const displayLatex =
          typeof entry.displayLatex === "string" ? entry.displayLatex : undefined;
        mru.set(key, { count, lastUsedAt, latex, label, hint, displayLatex });
      });
    } catch {
      // ignore storage errors
    }
  };

  const saveMru = (key: string) => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const payload: Record<string, MruEntry> = {};
      mru.forEach((entry, id) => {
        payload[id] = entry;
      });
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  };

  const scheduleMruSave = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (mruSaveTimer !== null) {
      return;
    }
    mruSaveKey = mruStorageKey;
    mruSaveTimer = window.setTimeout(() => {
      const keyToSave = mruSaveKey ?? mruStorageKey;
      mruSaveTimer = null;
      mruSaveKey = null;
      saveMru(keyToSave);
    }, 150);
  };

  const flushMruSave = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (mruSaveTimer === null) {
      return;
    }
    window.clearTimeout(mruSaveTimer);
    const keyToSave = mruSaveKey ?? mruStorageKey;
    mruSaveTimer = null;
    mruSaveKey = null;
    saveMru(keyToSave);
  };

  const ensureMruStorageKey = () => {
    const nextKey = resolveMruStorageKey();
    if (!nextKey || nextKey === mruStorageKey) {
      return;
    }
    flushMruSave();
    mru.clear();
    mruStorageKey = nextKey;
    loadMru(mruStorageKey);
  };

  const recordMru = (candidate: Candidate) => {
    const candidateId = candidate.id;
    if (!candidateId) {
      return;
    }
    ensureMruStorageKey();
    const entry = mru.get(candidateId) ?? { count: 0, lastUsedAt: 0 };
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
    mru.set(candidateId, entry);
    if (mru.size > MAX_MRU_ENTRIES) {
      const sorted = Array.from(mru.entries()).sort((a, b) => {
        const aScore = a[1].lastUsedAt;
        const bScore = b[1].lastUsedAt;
        return aScore - bScore;
      });
      const trimCount = mru.size - MAX_MRU_ENTRIES;
      for (let i = 0; i < trimCount; i += 1) {
        const key = sorted[i]?.[0];
        if (key) {
          mru.delete(key);
        }
      }
    }
    scheduleMruSave();
  };

  const applyMruRanking = (items: Candidate[]) => {
    ensureMruStorageKey();
    if (mru.size === 0 || items.length <= 1) {
      return items;
    }
    const ranked = items.map((item, index) => {
      const entry = mru.get(item.id);
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
    const entries = Array.from(mru.entries())
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

  const buildMatrixOpCandidates = () => {
    if (!mathfield) {
      return [] as Candidate[];
    }
    const mf = mathfield as any;
    if (typeof mf.getValue !== "function") {
      return [] as Candidate[];
    }
    const latex = mf.getValue("latex");
    if (typeof latex !== "string" || !latex) {
      return [] as Candidate[];
    }
    const selection = getMathFieldSelectionRange(mf);
    const cursorOffset = typeof mf.position === "number" ? mf.position : selection.end;
    const cursorIndex = offsetToIndexInRange(mf, 0, cursorOffset);
    const tokenRegex = /\\(begin|end)\{([A-Za-z*]+)\}/g;
    const matrixNames = new Set([
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
    const stack: Array<{ name: string; bodyStart: number }> = [];
    let match: RegExpExecArray | null = null;
    let inMatrix = false;
    while ((match = tokenRegex.exec(latex))) {
      const kind = match[1];
      const name = match[2];
      const tokenStart = match.index;
      const tokenText = match[0];
      if (kind === "begin") {
        stack.push({ name, bodyStart: tokenStart + tokenText.length });
        continue;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name !== name) continue;
        const entry = stack.splice(i, 1)[0];
        const base = name.replace(/\*$/, "");
        const bodyEnd = tokenStart;
        if (cursorIndex >= entry.bodyStart && cursorIndex <= bodyEnd && matrixNames.has(base)) {
          inMatrix = true;
        }
        break;
      }
      if (inMatrix) break;
    }
    if (!inMatrix || typeof mf.executeCommand !== "function") {
      return [] as Candidate[];
    }
    const applyCommand = (command: string) => (target: any) => {
      if (typeof target.executeCommand !== "function") {
        return;
      }
      try {
        const ok = Boolean(target.executeCommand(command));
        if (ok) {
          target.dispatchEvent?.(new Event("input", { bubbles: true }));
        }
      } catch {
        // ignore
      }
    };
    const makeOp = (
      id: string,
      label: string,
      hint: string,
      displayLatex: string,
      command: string,
      priority: number
    ) =>
      ({
        id,
        key: getKeyByLatex(label, label, displayLatex),
        label,
        hint,
        displayLatex,
        priority,
        apply: applyCommand(command),
      }) satisfies Candidate;

    return [
      makeOp(
        "matrix-op:add-row",
        "+row",
        "行を追加",
        "\\begin{matrix}a\\\\b\\end{matrix}",
        "addRowAfter",
        260
      ),
      makeOp(
        "matrix-op:add-col",
        "+col",
        "列を追加",
        "\\begin{matrix}a&b\\end{matrix}",
        "addColumnAfter",
        258
      ),
      makeOp(
        "matrix-op:remove-row",
        "-row",
        "行を削除",
        "\\begin{matrix}a\\\\b\\end{matrix}",
        "removeRow",
        256
      ),
      makeOp(
        "matrix-op:remove-col",
        "-col",
        "列を削除",
        "\\begin{matrix}a&b\\end{matrix}",
        "removeColumn",
        254
      ),
    ];
  };

  const buildExplicitFallbackCandidates = () => {
    const matrixOps = buildMatrixOpCandidates();
    const recent = buildRecentCandidates(matrixOps.length > 0 ? 6 : 8);
    const quick = buildQuickCandidates();
    const seen = new Set<string>();
    const results: Candidate[] = [];
    const pushAll = (items: Candidate[]) => {
      items.forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        results.push(item);
      });
    };
    pushAll(matrixOps);
    pushAll(recent);
    pushAll(quick);
    return results.slice(0, 14);
  };

  loadMru(mruStorageKey);

  const resolvePanelHost = () => {
    if (panelHost && panelHost.isConnected) {
      return panelHost;
    }
    if (!deps.container) {
      return null;
    }
    const host =
      (deps.container.closest(".panel-body.blocks-panel") as HTMLElement | null) ??
      (deps.container.closest(".panel-body") as HTMLElement | null) ??
      deps.container;
    panelHost = host;
    return host;
  };

  const positionPanelNearCaret = () => {
    if (!deps.container || !active) {
      return;
    }
    const host = resolvePanelHost();
    if (!host) {
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const containerRect = deps.container.getBoundingClientRect();
    const margin = 8;
    const offset = 20;
    const maxWidth = Math.max(160, hostRect.width - margin * 2);

    panel.style.position = "absolute";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxWidth = `${maxWidth}px`;

    let left = margin;
    let top = Math.round(containerRect.bottom - hostRect.top + offset);

    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(margin, top)}px`;

    const panelRect = panel.getBoundingClientRect();
    if (panelRect.width > 0 && hostRect.width > 0) {
      const maxLeft = Math.max(margin, hostRect.width - panelRect.width - margin);
      left = Math.min(Math.max(margin, left), maxLeft);
      panel.style.left = `${left}px`;
    }

    if (panelRect.height > 0 && hostRect.height > 0) {
      const maxTop = Math.max(margin, hostRect.height - panelRect.height - margin);
      const wouldOverflowBottom =
        panelRect.bottom > hostRect.bottom - margin && panelRect.height < hostRect.height;
      if (wouldOverflowBottom) {
        const aboveTop = Math.round(containerRect.top - hostRect.top - panelRect.height - offset);
        if (aboveTop >= margin) {
          panel.style.top = `${aboveTop}px`;
          return;
        }
      }
      top = Math.min(Math.max(margin, top), maxTop);
      panel.style.top = `${top}px`;
    }
  };

  const ensurePanel = () => {
    const host = resolvePanelHost();
    if (!host) {
      return;
    }
    if (!panel.isConnected) {
      host.appendChild(panel);
    }
  };

  const setPanelVisible = (visible: boolean) => {
    active = visible;
    if (!visible) {
      explicitSession = false;
    }
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    deps.container?.classList.toggle("has-wysiwyg-suggestions", visible);
    if (!visible) {
      panel.textContent = "";
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      panel.style.removeProperty("right");
      panel.style.removeProperty("bottom");
      panel.style.removeProperty("max-width");
    }
  };

  const renderCandidate = (candidate: Candidate, index: number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "math-wysiwyg-item";
    button.setAttribute("role", "option");
    const isActive = index === selectedIndex;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");

    const symbol = document.createElement("span");
    symbol.className = "math-wysiwyg-symbol";
    const MathLiveGlobal = (window as any).MathLive;
    if (candidate.displayLatex && MathLiveGlobal?.convertLatexToMarkup) {
      try {
        const latexToRender = `\\displaystyle ${candidate.displayLatex}`;
        symbol.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
      } catch {
        symbol.textContent = candidate.label;
      }
    } else {
      symbol.textContent = candidate.label;
    }

    const label = document.createElement("span");
    label.className = "math-wysiwyg-label";
    label.textContent = candidate.hint;

    button.appendChild(symbol);
    button.appendChild(label);

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      applyCandidate(index);
    });

    return button;
  };

  const renderPanel = () => {
    if (!active) {
      return;
    }
    panel.textContent = "";
    currentCandidates.forEach((candidate, index) => {
      panel.appendChild(renderCandidate(candidate, index));
    });
    positionPanelNearCaret();
    scrollActiveIntoView();
  };

  const scrollActiveIntoView = () => {
    if (!active) {
      return;
    }
    const activeItem = panel.querySelector(".math-wysiwyg-item.is-active") as
      | HTMLElement
      | null;
    if (!activeItem) {
      return;
    }
    try {
      activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // ignore
    }
  };

  const updateCandidates = (tokenMatch: TokenMatch | null, options: SuggestOptions = {}) => {
    const explicit = options.explicit ?? false;
    if (!tokenMatch) {
      if (explicit) {
        currentCandidates = buildExplicitFallbackCandidates();
        currentRange = null;
        selectedIndex = 0;
        if (currentCandidates.length === 0) {
          setPanelVisible(false);
          return;
        }
        ensurePanel();
        setPanelVisible(true);
        renderPanel();
        return;
      }
      currentCandidates = [];
      currentRange = null;
      selectedIndex = 0;
      setPanelVisible(false);
      return;
    }
    const allowedPacks = explicit ? undefined : enabledPacks.size > 0 ? enabledPacks : undefined;
    if (tokenMatch.kind === "word") {
      const normalized = tokenMatch.token.toLowerCase();
      const minLength = explicit
        ? EXPLICIT_WORD_MIN_LENGTH
        : AUTO_WORD_ALLOWLIST.has(normalized)
        ? 2
        : AUTO_WORD_MIN_LENGTH;
      if (tokenMatch.token.length < minLength) {
        currentCandidates = [];
        currentRange = null;
        selectedIndex = 0;
        setPanelVisible(false);
        return;
      }
    }

    let effectiveMatch = tokenMatch;
    let nextCandidates: Candidate[] =
      tokenMatch.kind === "operator"
        ? buildOperatorCandidates(tokenMatch.token)
        : buildWordCandidates(tokenMatch.token, {
            allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
            allowedPacks,
          });

    const allowSuffixRescue =
      explicit && tokenMatch.kind === "word" && tokenMatch.token.length >= EXPLICIT_SUFFIX_MIN_LENGTH;
    if (allowSuffixRescue && nextCandidates.length === 0) {
      const minSuffixLength = 2;
      for (
        let dropPrefix = 1;
        dropPrefix <= tokenMatch.token.length - minSuffixLength;
        dropPrefix += 1
      ) {
        const suffix = tokenMatch.token.slice(dropPrefix);
        const suffixCandidates = buildWordCandidates(suffix, {
          allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
          allowedPacks,
        });
        if (suffixCandidates.length === 0) {
          continue;
        }
        effectiveMatch = {
          ...tokenMatch,
          token: suffix,
          range: {
            start: tokenMatch.range.start + dropPrefix,
            end: tokenMatch.range.end,
          },
        };
        nextCandidates = suffixCandidates;
        break;
      }
    }

    if (nextCandidates.length === 0) {
      currentCandidates = [];
      currentRange = null;
      setPanelVisible(false);
      return;
    }

    nextCandidates = applyMruRanking(nextCandidates);

    const sameList =
      currentCandidates.length === nextCandidates.length &&
      currentCandidates.every((item, idx) => item.id === nextCandidates[idx].id);

    currentCandidates = nextCandidates;
    currentRange = effectiveMatch.range;
    if (!sameList) {
      selectedIndex = 0;
    } else {
      selectedIndex = Math.max(0, Math.min(selectedIndex, currentCandidates.length - 1));
    }

    ensurePanel();
    setPanelVisible(true);
    renderPanel();
  };

  const getWordCandidates = (token: string): MathWysiwygWordCandidate[] => {
    const normalized = token.trim();
    if (!normalized) {
      return [];
    }
    const allowedPacks = enabledPacks.size > 0 ? enabledPacks : undefined;
    return buildWordCandidates(normalized, { allowedPacks }).map((candidate) => ({
      id: candidate.id,
      key: candidate.key,
      label: candidate.label,
      hint: candidate.hint,
      displayLatex: candidate.displayLatex,
    }));
  };

  const openCustomCandidates = (
    candidates: CustomCandidate[],
    options?: { selectedIndex?: number }
  ) => {
    if (!candidates || candidates.length === 0) {
      return;
    }
    const mapped: Candidate[] = candidates.map((candidate, index) => ({
      id: candidate.id,
      key: getKeyByLatex(candidate.label, candidate.label, candidate.displayLatex),
      label: candidate.label,
      hint: candidate.hint,
      displayLatex: candidate.displayLatex,
      priority: 100 - index,
      apply: candidate.apply,
    }));
    currentCandidates = mapped;
    currentRange = null;
    selectedIndex = Math.max(
      0,
      Math.min(options?.selectedIndex ?? 0, currentCandidates.length - 1)
    );
    ensurePanel();
    setPanelVisible(true);
    renderPanel();
  };

  const getModeAtOffset = (
    mathfieldApi: any,
    offset: number
  ): "math" | "text" | "latex" | null => {
    if (offset < 0) {
      return null;
    }
    if (typeof mathfieldApi?.getElementInfo === "function") {
      try {
        const info = mathfieldApi.getElementInfo(offset);
        const mode = info?.mode ?? null;
        if (mode === "math" || mode === "text" || mode === "latex") {
          return mode;
        }
      } catch {
        // ignore
      }
    }
    const internalModel = (mathfieldApi as { _mathfield?: any })?._mathfield?.model;
    if (internalModel && typeof internalModel.at === "function") {
      try {
        const atom = internalModel.at(offset);
        const mode = atom?.mode ?? null;
        if (mode === "math" || mode === "text" || mode === "latex") {
          return mode;
        }
      } catch {
        // ignore
      }
    }
    return null;
  };

  const nowMs = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const syncMathfieldMode = (mathfieldApi: any, cursorOffset: number) => {
    if (syncingMode) {
      return;
    }
    const currentMode =
      typeof mathfieldApi?.mode === "string"
        ? (mathfieldApi.mode as "math" | "text" | "latex")
        : null;
    if (!currentMode || currentMode === "latex") {
      forcedTextMode = false;
      return;
    }

    // If the user changed modes manually while we were forcing, stop managing it.
    if (forcedTextMode && currentMode !== "text") {
      forcedTextMode = false;
    }

    const modeAtCursor =
      getModeAtOffset(mathfieldApi, cursorOffset) ??
      getModeAtOffset(mathfieldApi, cursorOffset - 1);
    const wantsText = modeAtCursor === "text";

    const setMode = (nextMode: "math" | "text") => {
      // Prefer setting the model mode directly to avoid `switchMode()` converting the current selection.
      const internalModel = (mathfieldApi as { _mathfield?: any })?._mathfield?.model;
      if (internalModel) {
        try {
          internalModel.mode = nextMode;
          return true;
        } catch {
          // ignore
        }
      }
      try {
        syncingMode = true;
        mathfieldApi.mode = nextMode;
      } catch {
        // ignore
      } finally {
        syncingMode = false;
      }
      const updated =
        typeof mathfieldApi?.mode === "string"
          ? (mathfieldApi.mode as "math" | "text" | "latex")
          : null;
      if (updated === nextMode) {
        return true;
      }
      return false;
    };

    if (wantsText) {
      if (currentMode !== "text") {
        if (setMode("text")) {
          forcedTextMode = true;
        }
      }
      return;
    }

    if (forcedTextMode && currentMode === "text") {
      if (nowMs() < holdTextModeUntil) {
        return;
      }
      setMode("math");
      forcedTextMode = false;
    }
  };

  const isInSuppressedTextContext = (mathfieldApi: any, cursorOffset: number) => {
    const mode =
      typeof mathfieldApi?.mode === "string"
        ? (mathfieldApi.mode as "math" | "text" | "latex")
        : null;
    if (mode === "text") {
      return true;
    }
    const modeAtCursor =
      getModeAtOffset(mathfieldApi, cursorOffset) ??
      getModeAtOffset(mathfieldApi, cursorOffset - 1);
    if (modeAtCursor === "text") {
      return true;
    }
    if (typeof mathfieldApi?.getValue !== "function") {
      return false;
    }
    const latex = mathfieldApi.getValue("latex");
    if (typeof latex !== "string" || !latex) {
      return false;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
    if (cursorIndex <= 0) {
      return false;
    }
    const textLikeCommands = new Set(["text", "operatorname"]);
    let depth = 0;
    const stack: number[] = [];
    const isLetter = (ch: string) => /[A-Za-z]/.test(ch);

    for (let i = 0; i < latex.length && i < cursorIndex; i += 1) {
      const ch = latex[i];
      if (ch === "\\") {
        let j = i + 1;
        if (j >= cursorIndex) {
          break;
        }
        let command = "";
        if (isLetter(latex[j] ?? "")) {
          const start = j;
          while (j < cursorIndex && isLetter(latex[j] ?? "")) {
            j += 1;
          }
          command = latex.slice(start, j);
        } else {
          command = latex[j] ?? "";
          j += 1;
        }
        if (textLikeCommands.has(command)) {
          let k = j;
          while (k < cursorIndex && latex[k] === " ") {
            k += 1;
          }
          if (latex[k] === "{") {
            stack.push(depth + 1);
          }
        }
        i = Math.max(i, j - 1);
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        while (stack.length > 0 && (stack[stack.length - 1] ?? 0) > depth) {
          stack.pop();
        }
      }
    }
    return stack.length > 0;
  };

  const refresh = (options: SuggestOptions = {}) => {
    if (!mathfield || composing) {
      return;
    }
    if (suppressNextUpdate) {
      suppressNextUpdate = false;
      if (!options.explicit) {
        return;
      }
    }
    const mathfieldApi = mathfield as any;
    if (typeof mathfieldApi.getValue !== "function") {
      updateCandidates(null, options);
      return;
    }
    const selection = getMathFieldSelectionRange(mathfieldApi);
    const selectionRanges =
      selection.start !== selection.end ? getInternalSelectionRanges(mathfieldApi) : [];
    const cursorOffset =
      typeof mathfieldApi.position === "number" ? mathfieldApi.position : selection.end;
    const mode =
      typeof mathfieldApi.mode === "string"
        ? (mathfieldApi.mode as "math" | "text" | "latex")
        : null;
    if (mode === "text" && !options.explicit) {
      // Avoid noisy suggestions while typing inside \\text{...} and similar text-mode segments.
      updateCandidates(null, options);
      return;
    }
    const isPlaceholderSelection =
      selection.start !== selection.end &&
      selectionRanges.some(
        (range) => cursorOffset >= range.start && cursorOffset <= range.end
      );
    if (selection.start !== selection.end && !isPlaceholderSelection) {
      const selectionLength = Math.abs(selection.end - selection.start);
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      if (selectionLength > 1 && now - lastInputTime > 120) {
        updateCandidates(null, options);
        return;
      }
    }
    const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
    const rawValue = mathfieldApi.getValue(scopeRange.start, scopeRange.end, "latex");
    if (typeof rawValue !== "string") {
      updateCandidates(null, options);
      return;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, scopeRange.start, cursorOffset);
    const toOffsetMatch = (match: TokenIndexMatch | null): TokenMatch | null => {
      if (!match) {
        return null;
      }
      const startOffset = indexToOffsetInRange(
        mathfieldApi,
        scopeRange.start,
        scopeRange.end,
        match.range.start
      );
      const endOffset = indexToOffsetInRange(
        mathfieldApi,
        scopeRange.start,
        scopeRange.end,
        match.range.end
      );
      return { token: match.token, range: { start: startOffset, end: endOffset }, kind: match.kind };
    };
    const operatorMatch = toOffsetMatch(findOperatorToken(rawValue, cursorIndex));
    if (operatorMatch) {
      if (!options.explicit && autoSuggest && AUTO_REPLACE_OPERATORS.has(operatorMatch.token)) {
        if (isInSuppressedTextContext(mathfieldApi, cursorOffset)) {
          updateCandidates(null, options);
          return;
        }
        const candidates = buildOperatorCandidates(operatorMatch.token);
        const candidate = candidates[0];
        if (candidate) {
          suppressNextUpdate = true;
          setPanelVisible(false);
          setSelectionRange(mathfieldApi, operatorMatch.range.start, operatorMatch.range.end);
          deps.insertKey(candidate.key);
          window.setTimeout(() => {
            suppressNextUpdate = false;
            currentCandidates = [];
            currentRange = null;
            selectedIndex = 0;
            if (autoSuggest) {
              refresh();
            }
          }, 0);
          return;
        }
      }
      // Only show operator suggestions on explicit/manual trigger.
      if (options.explicit) {
        updateCandidates(operatorMatch, options);
      } else {
        updateCandidates(null, options);
      }
      return;
    }
    const wordMatch = toOffsetMatch(findWordToken(rawValue, cursorIndex));
    if (!options.explicit && wordMatch) {
      const normalized = wordMatch.token.toLowerCase();
      const minLength = AUTO_WORD_ALLOWLIST.has(normalized) ? 2 : AUTO_WORD_MIN_LENGTH;
      if (wordMatch.token.length >= minLength && isInSuppressedTextContext(mathfieldApi, cursorOffset)) {
        updateCandidates(null, options);
        return;
      }
    }
    updateCandidates(wordMatch, options);
  };

  const close = () => {
    updateCandidates(null);
  };

  const openExplicitSuggestions = () => {
    if (!mathfield || composing) {
      return false;
    }
    explicitSession = true;
    refresh({ explicit: true });
    return active;
  };

  const updateConfig = (config: Partial<MathWysiwygConfig>) => {
    if (typeof config.autoSuggest === "boolean") {
      autoSuggest = config.autoSuggest;
    }
    if (Array.isArray(config.enabledPacks)) {
      enabledPacks = new Set(config.enabledPacks);
    }
    if (!autoSuggest && active && !explicitSession) {
      updateCandidates(null);
      return;
    }
    if (autoSuggest && mathfield && !composing) {
      refresh();
    }
  };

  const applyCandidate = (index: number) => {
    if (!mathfield || index < 0 || index >= currentCandidates.length) {
      return;
    }
    const candidate = currentCandidates[index];
    const shouldKeepExplicitSession = explicitSession;
    recordMru(candidate);
    const mathfieldApi = mathfield as any;
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    const insertedLatex =
      typeof candidate.key.latex === "string" ? normalizeLatexKey(candidate.key.latex) : "";

    // Treat `\text{#?}` as a mode entry action rather than inserting a placeholder.
    // This avoids a MathLive edge case where a text-mode placeholder at the very beginning
    // gets replaced as math text (dropping the `\text{...}` wrapper).
    if (insertedLatex === "\\text{#?}") {
      suppressNextUpdate = true;
      setPanelVisible(false);
      if (currentRange) {
        setSelectionRange(mathfieldApi, currentRange.start, currentRange.end);
      }
      try {
        // If there's a selection (e.g. the trigger token), remove it first.
        if (currentRange && typeof mathfieldApi.executeCommand === "function") {
          mathfieldApi.executeCommand("deleteBackward");
        }
      } catch {
        // ignore
      }
      try {
        const internalModel = (mathfieldApi as { _mathfield?: any })?._mathfield?.model;
        if (internalModel) {
          internalModel.mode = "text";
        }
        try {
          mathfieldApi.mode = "text";
        } catch {
          // ignore
        }
        forcedTextMode = true;
        holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
      window.setTimeout(() => {
        suppressNextUpdate = false;
        currentCandidates = [];
        currentRange = null;
        selectedIndex = 0;
        if (shouldKeepExplicitSession) {
          explicitSession = true;
          refresh({ explicit: true });
        } else if (autoSuggest) {
          refresh();
        }
        if (typeof mathfieldApi.focus === "function") {
          mathfieldApi.focus();
        }
      }, 0);
      return;
    }
    if (candidate.apply) {
      suppressNextUpdate = true;
      setPanelVisible(false);
      if (currentRange) {
        setSelectionRange(mathfieldApi, currentRange.start, currentRange.end);
      }
      candidate.apply(mathfieldApi);
      window.setTimeout(() => {
        suppressNextUpdate = false;
        if (shouldKeepExplicitSession) {
          explicitSession = true;
          refresh({ explicit: true });
        } else if (autoSuggest) {
          refresh();
        }
      }, 0);
      return;
    }
    if (!currentRange) {
      return;
    }
    suppressNextUpdate = true;
    setPanelVisible(false);
    setSelectionRange(mathfieldApi, currentRange.start, currentRange.end);
    deps.insertKey(candidate.key);
    if (typeof candidate.key.latex === "string" && candidate.key.latex.includes("#?")) {
      try {
        const ranges = getInternalSelectionRanges(mathfieldApi);
        const target = ranges.find((range) => range.start >= currentRange.start) ?? null;
        if (target) {
          setSelectionRange(mathfieldApi, target.start, target.end);
          const inserted = normalizeLatexKey(candidate.key.latex);
          const shouldForceText =
            inserted.startsWith("\\text{") || inserted.startsWith("\\operatorname{");
          if (shouldForceText) {
            try {
              const internalModel = (mathfieldApi as { _mathfield?: any })?._mathfield?.model;
              if (internalModel) {
                internalModel.mode = "text";
              } else {
                mathfieldApi.mode = "text";
              }
              forcedTextMode = true;
              holdTextModeUntil = nowMs() + 200;
            } catch {
              // ignore mode switch failures
            }
          } else {
            syncMathfieldMode(mathfieldApi, target.end);
          }
        }
      } catch {
        // ignore placeholder positioning failures
      }
    }
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    window.setTimeout(() => {
      suppressNextUpdate = false;
      currentCandidates = [];
      currentRange = null;
      selectedIndex = 0;
      if (shouldKeepExplicitSession) {
        explicitSession = true;
        refresh({ explicit: true });
      } else if (autoSuggest) {
        refresh();
      }
      if (typeof mathfieldApi.focus === "function") {
        mathfieldApi.focus();
      }
    }, 0);
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (!active) {
      return false;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % currentCandidates.length;
      renderPanel();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + currentCandidates.length) % currentCandidates.length;
      renderPanel();
      return true;
    }
    if (event.key === "Enter") {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
      }
      event.preventDefault();
      applyCandidate(selectedIndex);
      return true;
    }
    if (event.key === " " || event.key === "Spacebar") {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
      }
      event.preventDefault();
      updateCandidates(null);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      updateCandidates(null);
      return true;
    }
    if (!autoSuggest && !explicitSession) {
      if (
        event.key !== "Shift" &&
        event.key !== "Control" &&
        event.key !== "Alt" &&
        event.key !== "Meta"
      ) {
        updateCandidates(null);
      }
    }
    return false;
  };

  const attach = (target: HTMLElement) => {
    if (mathfield === target) {
      return;
    }
    detach();
    mathfield = target;
    eventController = new AbortController();
    const { signal } = eventController;
    const mathfieldApi = mathfield as any;

    mathfield.addEventListener(
      "input",
      () => {
        lastInputTime =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );
    const handleModeKeydown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (typeof mathfieldApi?.mode === "string" && mathfieldApi.mode === "latex") {
        return;
      }
      const key = event.key;
      const isPrintable =
        (typeof key === "string" && key.length === 1) || key === " " || key === "Spacebar";
      if (!isPrintable) {
        return;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      const cursorOffset =
        typeof mathfieldApi.position === "number" ? mathfieldApi.position : selection.end;
      const cursorMode =
        getModeAtOffset(mathfieldApi, cursorOffset) ??
        getModeAtOffset(mathfieldApi, cursorOffset - 1);

      const internalModel = (mathfieldApi as { _mathfield?: any })?._mathfield?.model;
      if (!internalModel) {
        return;
      }
      if (cursorMode === "text") {
        try {
          internalModel.mode = "text";
          forcedTextMode = true;
          if (internalModel.selectionIsPlaceholder) {
            holdTextModeUntil = nowMs() + 200;
          }
        } catch {
          // ignore
        }
      } else if (forcedTextMode && cursorMode === "math") {
        if (nowMs() < holdTextModeUntil) {
          try {
            internalModel.mode = "text";
          } catch {
            // ignore
          }
          return;
        }
        try {
          internalModel.mode = "math";
          forcedTextMode = false;
        } catch {
          // ignore
        }
      }
    };

    mathfield.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
    const shadowRoot = (mathfield as { shadowRoot?: ShadowRoot }).shadowRoot;
    if (shadowRoot) {
      shadowRoot.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
    }
    mathfield.addEventListener(
      "keyup",
      (event) => {
        // When the panel is open, ArrowUp/ArrowDown are used for navigating candidates.
        // Don't refresh the candidate list on keyup in that case, or we'll close/replace it.
        if (active && event.key.startsWith("Arrow")) {
          return;
        }
        if (
          event.key.startsWith("Arrow") ||
          event.key === "Backspace" ||
          event.key === "Delete"
        ) {
          if (autoSuggest || explicitSession) {
            refresh(explicitSession ? { explicit: true } : undefined);
          }
        }
      },
      { signal }
    );
    mathfield.addEventListener(
      "focus",
      () => {
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );
    mathfield.addEventListener(
      "selection-change",
      () => {
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );

    mathfield.addEventListener(
      "blur",
      () => {
        updateCandidates(null);
      },
      { signal }
    );

    if ((autoSuggest || explicitSession) && typeof mathfieldApi.getValue === "function") {
      refresh(explicitSession ? { explicit: true } : undefined);
    }
  };

  const detach = () => {
    eventController?.abort();
    eventController = null;
    if (!mathfield) {
      return;
    }
    mathfield = null;
    updateCandidates(null);
  };

  const setComposing = (value: boolean) => {
    composing = value;
    if (composing) {
      updateCandidates(null);
    } else if (autoSuggest || explicitSession) {
      refresh(explicitSession ? { explicit: true } : undefined);
    }
  };

  return {
    attach,
    detach,
    handleKeydown,
    setComposing,
    close,
    openExplicitSuggestions,
    updateConfig,
    getWordCandidates,
    openCustomCandidates,
  };
};
