import type { SectionEntry } from "./types.js";

const HEADING_LEVELS = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
} as const;

export type StructureHeading = SectionEntry & { kind: keyof typeof HEADING_LEVELS };

const stripLatexComment = (line: string) => {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return line.slice(0, index);
  }
  return line;
};

/** Extracts structural commands from an open TeX buffer without DOM or LSP state. */
export const extractStructureHeadings = (source: string, path = ""): StructureHeading[] => {
  const headings: StructureHeading[] = [];
  source.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    const line = stripLatexComment(rawLine);
    const command = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = command.exec(line)) !== null) {
      const kind = match[1] as keyof typeof HEADING_LEVELS;
      headings.push({
        kind,
        title: match[2].trim(),
        path,
        line: lineIndex + 1,
        level: HEADING_LEVELS[kind],
      });
    }
  });
  return headings;
};

type ProStructureDeps = {
  getActiveFileSnapshot: () => { path: string; content: string } | null;
  getIndexSections: () => SectionEntry[];
  onJumpToSection: (entry: SectionEntry) => void;
};

const LABEL_BY_LEVEL = ["", "part", "chap", "sec", "sub", "subsub", "para"];

export const initProStructureUi = (deps: ProStructureDeps) => {
  const button = document.getElementById("pro-structure-button");
  const panel = document.getElementById("pro-structure-drawer");
  const list = document.getElementById("pro-structure-list");
  const empty = document.getElementById("pro-structure-empty");
  if (!(button instanceof HTMLButtonElement) || !(panel instanceof HTMLElement) || !(list instanceof HTMLElement)) {
    return null;
  }

  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const render = () => {
    const snapshot = deps.getActiveFileSnapshot();
    const indexed = snapshot
      ? deps.getIndexSections().filter((entry) => entry.path === snapshot.path)
      : [];
    const entries: Array<SectionEntry & { kind?: string }> = indexed.length > 0
      ? indexed
      : snapshot && /\.tex$/i.test(snapshot.path)
        ? extractStructureHeadings(snapshot.content, snapshot.path)
        : [];
    list.replaceChildren();
    entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pro-structure-item";
      item.style.setProperty("--structure-depth", String(Math.max(entry.level - 1, 0)));
      const label = document.createElement("span");
      label.className = "pro-structure-level";
      label.textContent = entry.kind ?? LABEL_BY_LEVEL[entry.level] ?? "item";
      const title = document.createElement("span");
      title.className = "pro-structure-title";
      title.textContent = entry.title;
      item.append(label, title);
      item.addEventListener("click", () => {
        deps.onJumpToSection(entry);
        close();
      });
      list.append(item);
    });
    empty?.classList.toggle("is-hidden", entries.length > 0);
  };

  const toggle = () => {
    if (document.documentElement.dataset.proMode !== "true") return;
    if (open) return close();
    render();
    open = true;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    list.querySelector<HTMLButtonElement>("button")?.focus();
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      button.focus();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === "o" && document.documentElement.dataset.proMode === "true"
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  }, true);
  new MutationObserver(() => {
    if (document.documentElement.dataset.proMode !== "true") close();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-pro-mode"] });

  return { close, render, toggle };
};
