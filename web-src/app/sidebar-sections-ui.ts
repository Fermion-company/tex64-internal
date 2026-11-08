// Collapsible sections under the file tree, as in VS Code's Explorer. Outline
// and History used to have rail icons of their own; their views live here now,
// unchanged. Each section remembers whether it is open.

export type SidebarSectionKey = "outline" | "history";

export type SidebarSectionsApi = {
  /** Expand the section and bring it into view (the file panel must be shown). */
  open: (key: SidebarSectionKey) => void;
};

const STORAGE_KEY = "tex64.sidebar.sections.v1";

export const initSidebarSections = (): SidebarSectionsApi => {
  const sections = new Map<SidebarSectionKey, { root: HTMLElement; header: HTMLButtonElement; body: HTMLElement }>();
  document.querySelectorAll<HTMLElement>(".sidebar-section[data-section]").forEach((root) => {
    const key = root.dataset.section as SidebarSectionKey;
    const header = root.querySelector<HTMLButtonElement>(".sidebar-section-header");
    const body = root.querySelector<HTMLElement>(".sidebar-section-body");
    if (header && body) sections.set(key, { root, header, body });
  });

  const readStored = (): Partial<Record<SidebarSectionKey, boolean>> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const save = () => {
    const state: Partial<Record<SidebarSectionKey, boolean>> = {};
    sections.forEach((section, key) => {
      state[key] = section.root.classList.contains("is-open");
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore storage failures
    }
  };

  const setOpen = (key: SidebarSectionKey, open: boolean) => {
    const section = sections.get(key);
    if (!section) return;
    section.root.classList.toggle("is-open", open);
    section.header.setAttribute("aria-expanded", open ? "true" : "false");
    section.body.hidden = !open;
  };

  const stored = readStored();
  sections.forEach((section, key) => {
    setOpen(key, stored[key] === true);
    section.header.addEventListener("click", () => {
      setOpen(key, !section.root.classList.contains("is-open"));
      save();
    });
  });

  const open = (key: SidebarSectionKey) => {
    const section = sections.get(key);
    if (!section) return;
    setOpen(key, true);
    save();
    window.requestAnimationFrame(() => section.root.scrollIntoView({ block: "nearest" }));
  };

  return { open };
};
