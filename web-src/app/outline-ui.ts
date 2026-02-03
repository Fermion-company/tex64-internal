import type { AppContext } from "./context.js";
import type { IndexEntry, SectionEntry } from "./types.js";
import { dedupeByKey, dedupeSections, pickCitationEntries } from "./index-utils.js";

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
    const baseLevel = showNumbering ? Math.min(...entries.map((entry) => entry.level)) : 0;
    const counters = showNumbering ? new Array(8).fill(0) : [];
    const sectionLabels = ["章", "節", "小節", "項", "小項", "段落", "小段落"];
    entries.forEach((entry) => {
      const depth = Math.max(entry.level - baseLevel, 0);
      let prefix = "";
      if (showNumbering) {
        counters[depth] += 1;
        for (let i = depth + 1; i < counters.length; i += 1) {
          counters[i] = 0;
        }
        const numberParts = counters.slice(0, depth + 1).filter((value) => value > 0);
        const label = sectionLabels[depth] ?? "節";
        prefix = `${numberParts.join(".")}${label} `;
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
    const todoEntries = dedupeByKey(filterEntries(deps.getIndexTodos()));
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
            ? "ワークスペースが未選択です。"
            : outlineMode === "current" && deps.getActiveFilePath() === null
            ? "ファイルが未選択です。"
            : "インデックス項目が見つかりません。";
      }
    }
  };

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
