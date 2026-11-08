// Collapsible sections under the file tree, as in VS Code's Explorer. Outline
// and History used to have rail icons of their own; their views live here now,
// unchanged. Each section remembers whether it is open.
const STORAGE_KEY = "tex64.sidebar.sections.v1";
export const initSidebarSections = () => {
    const sections = new Map();
    document.querySelectorAll(".sidebar-section[data-section]").forEach((root) => {
        const key = root.dataset.section;
        const header = root.querySelector(".sidebar-section-header");
        const body = root.querySelector(".sidebar-section-body");
        if (header && body)
            sections.set(key, { root, header, body });
    });
    const readStored = () => {
        var _a;
        try {
            const parsed = JSON.parse((_a = localStorage.getItem(STORAGE_KEY)) !== null && _a !== void 0 ? _a : "{}");
            return parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            return {};
        }
    };
    const save = () => {
        const state = {};
        sections.forEach((section, key) => {
            state[key] = section.root.classList.contains("is-open");
        });
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
        catch {
            // ignore storage failures
        }
    };
    const setOpen = (key, open) => {
        const section = sections.get(key);
        if (!section)
            return;
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
    const open = (key) => {
        const section = sections.get(key);
        if (!section)
            return;
        setOpen(key, true);
        save();
        window.requestAnimationFrame(() => section.root.scrollIntoView({ block: "nearest" }));
    };
    return { open };
};
