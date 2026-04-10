import type { AppContext } from "./context.js";
import type { IndexEntry, SectionEntry } from "./types.js";
import { getUiLocale, onUiLocaleChange } from "./i18n.js";
import {
  dedupeByKey,
  dedupeByKeyAndLocation,
  dedupeSections,
  pickCitationEntries,
} from "./index-utils.js";

type OutlineDeps = {
  getActiveFilePath: () => string | null;
  getWorkspaceRootKey: () => string | null;
  getIndexLabels: () => IndexEntry[];
  getIndexCitations: () => IndexEntry[];
  getIndexSections: () => SectionEntry[];
  getIndexTodos: () => IndexEntry[];
  onJumpToLocation: (entry: IndexEntry) => void;
  onJumpToSection: (entry: SectionEntry) => void;
};

export type OutlineUiApi = {
  render: () => void;
};

export const initOutlineUi = (context: AppContext, deps: OutlineDeps): OutlineUiApi => {
  const {
    outlineEmpty,
    outlineModeCurrent,
    outlineModeProject,
    outlineSections,
    outlineTodos,
    outlineLabels,
    outlineCitations,
  } = context.dom;

  const outlineModeKey = "tex64.outline.mode";
  let outlineMode: "current" | "project" = "current";
  try {
    const stored = localStorage.getItem(outlineModeKey);
    if (stored === "project") {
      outlineMode = "project";
    }
  } catch {
    outlineMode = "current";
  }

  const filterEntriesForCurrent = <T extends { path: string }>(entries: T[]) => {
    const activePath = deps.getActiveFilePath();
    if (!activePath) {
      return [];
    }
    return entries.filter((entry) => entry.path === activePath);
  };

  const filterEntries = <T extends { path: string }>(entries: T[]) => {
    if (outlineMode === "project") {
      return entries;
    }
    return filterEntriesForCurrent(entries);
  };

  const resolveSectionLabels = () =>
    getUiLocale() === "en"
      ? ["Chapter", "Section", "Subsection", "Item", "Subitem", "Paragraph", "Subparagraph"]
      : ["chapter", "section", "measure", "term", "subsection", "paragraph", "small paragraph"];

  const renderModeButtons = () => {
    if (outlineModeCurrent instanceof HTMLButtonElement) {
      const isActive = outlineMode === "current";
      outlineModeCurrent.setAttribute("aria-pressed", isActive ? "true" : "false");
      outlineModeCurrent.classList.toggle("is-active", isActive);
    }
    if (outlineModeProject instanceof HTMLButtonElement) {
      const isActive = outlineMode === "project";
      outlineModeProject.setAttribute("aria-pressed", isActive ? "true" : "false");
      outlineModeProject.classList.toggle("is-active", isActive);
    }
  };

  const renderOutlineList = (
    container: HTMLElement,
    entries: IndexEntry[],
    kind?: string,
    options: { showLocation?: boolean } = {}
  ) => {
    container.innerHTML = "";
    if (entries.length === 0) {
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";
      if (kind) {
        item.dataset.kind = kind;
      }

      const key = document.createElement("div");
      key.textContent = entry.key;
      item.append(key);
      if (options.showLocation) {
        const meta = document.createElement("span");
        meta.className = "outline-item-meta";
        meta.textContent = entry.path ? `${entry.path}:${entry.line}` : "";
        item.append(meta);
      }
      item.addEventListener("click", () => {
        deps.onJumpToLocation(entry);
      });
      container.appendChild(item);
    });
  };

  const renderSectionList = (
    container: HTMLElement,
    entries: SectionEntry[],
    options: { showLocation?: boolean; showNumbering?: boolean } = {}
  ) => {
    container.innerHTML = "";
    if (entries.length === 0) {
      return;
    }
    const showNumbering = options.showNumbering !== false;
    const sectionLabels = resolveSectionLabels();
    const isEnglish = getUiLocale() === "en";

    const baseLevelsByPath = new Map<
      string,
      { hasChapter: boolean; minSectionOrLowerLevel: number; hasNonPart: boolean }
    >();
    if (showNumbering) {
      entries.forEach((entry) => {
        const state = baseLevelsByPath.get(entry.path) ?? {
          hasChapter: false,
          minSectionOrLowerLevel: Number.POSITIVE_INFINITY,
          hasNonPart: false,
        };
        if (entry.level === 2) {
          state.hasChapter = true;
        }
        if (entry.level >= 3 && entry.level < state.minSectionOrLowerLevel) {
          state.minSectionOrLowerLevel = entry.level;
        }
        if (entry.level !== 1) {
          state.hasNonPart = true;
        }
        baseLevelsByPath.set(entry.path, state);
      });
    }
    const stateByPath = new Map<
      string,
      { baseLevel: number; labelOffset: number; countPart: boolean; counters: number[] }
    >();
    const getStateForPath = (path: string) => {
      const existing = stateByPath.get(path);
      if (existing) {
        return existing;
      }
      const baseInfo = baseLevelsByPath.get(path);
      const hasChapter = baseInfo?.hasChapter ?? false;
      const minSectionOrLowerLevel = baseInfo?.minSectionOrLowerLevel ?? Number.POSITIVE_INFINITY;
      const hasNonPart = baseInfo?.hasNonPart ?? false;
      const baseLevel = hasChapter
        ? 2
        : Number.isFinite(minSectionOrLowerLevel)
          ? minSectionOrLowerLevel
          : 2;
      const countPart = !hasNonPart;
      const state = {
        baseLevel,
        labelOffset: Math.max(baseLevel - 2, 0),
        countPart,
        counters: new Array(8).fill(0),
      };
      stateByPath.set(path, state);
      return state;
    };

    entries.forEach((entry) => {
      let prefix = "";
      const state = showNumbering ? getStateForPath(entry.path) : null;
      const depth = showNumbering
        ? Math.max(entry.level - (state?.baseLevel ?? 0), 0)
        : entry.level;
      if (showNumbering) {
        const shouldCount = state.countPart || entry.level >= state.baseLevel;
        if (shouldCount) {
          state.counters[depth] = (state.counters[depth] ?? 0) + 1;
          for (let i = depth + 1; i < state.counters.length; i += 1) {
            state.counters[i] = 0;
          }
        }
                const numberParts = state.counters
          .slice(0, depth + 1)
          .filter((value) => value > 0);
        if (numberParts.length > 0) {
          const label = sectionLabels[Math.max(depth + state.labelOffset, 0)] ?? "section";
          prefix = isEnglish
            ? `${label} ${numberParts.join(".")} `
            : `${numberParts.join(".")}${label} `;
        }
      }

      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";
      item.dataset.kind = "section";
      item.style.paddingLeft = `${8 + depth * 12}px`;

      const title = document.createElement("div");
      title.textContent = `${prefix}${entry.title}`;

      item.append(title);
      if (options.showLocation) {
        const meta = document.createElement("span");
        meta.className = "outline-item-meta";
        meta.textContent = `${entry.path}:${entry.line}`;
        item.append(meta);
      }
      item.addEventListener("click", () => {
        deps.onJumpToSection(entry);
      });
      container.appendChild(item);
    });
  };

  const render = () => {
    if (
      !(outlineLabels instanceof HTMLElement) ||
      !(outlineCitations instanceof HTMLElement) ||
      !(outlineSections instanceof HTMLElement) ||
      !(outlineTodos instanceof HTMLElement)
    ) {
      return;
    }
    const sectionEntries = dedupeSections(
      filterEntries(deps.getIndexSections())
    );
    const todoEntries = dedupeByKeyAndLocation(filterEntries(deps.getIndexTodos()));
    const labelEntries = dedupeByKey(filterEntries(deps.getIndexLabels()));
    const citationEntries = pickCitationEntries(
      filterEntries(deps.getIndexCitations())
    );

    const showLocation = outlineMode === "project";
    renderSectionList(outlineSections, sectionEntries, {
      showLocation,
      showNumbering: outlineMode === "current",
    });
    renderOutlineList(outlineTodos, todoEntries, "todo", { showLocation });
    renderOutlineList(outlineLabels, labelEntries, undefined, { showLocation });
    renderOutlineList(outlineCitations, citationEntries, undefined, { showLocation });

    if (outlineEmpty instanceof HTMLElement) {
      const hasItems =
        sectionEntries.length > 0 ||
        todoEntries.length > 0 ||
        labelEntries.length > 0 ||
        citationEntries.length > 0;
      outlineEmpty.classList.toggle("is-hidden", hasItems);
      if (!hasItems) {
        outlineEmpty.textContent =
          deps.getWorkspaceRootKey() === null
            ? (getUiLocale() === "en" ? "No workspace selected." : "No workspace is selected.")
            : outlineMode === "current" && deps.getActiveFilePath() === null
              ? (getUiLocale() === "en" ? "No file selected." : "No file selected.")
              : (getUiLocale() === "en" ? "No index entries found." : "No index entries found.");
      }
    }
  };

  onUiLocaleChange(() => {
    renderModeButtons();
    render();
  });

  if (outlineModeCurrent instanceof HTMLButtonElement) {
    outlineModeCurrent.addEventListener("click", () => {
      outlineMode = "current";
      try {
        localStorage.setItem(outlineModeKey, outlineMode);
      } catch {
        // ignore
      }
      renderModeButtons();
      render();
    });
  }

  if (outlineModeProject instanceof HTMLButtonElement) {
    outlineModeProject.addEventListener("click", () => {
      outlineMode = "project";
      try {
        localStorage.setItem(outlineModeKey, outlineMode);
      } catch {
        // ignore
      }
      renderModeButtons();
      render();
    });
  }

  renderModeButtons();

  return { render };
};
