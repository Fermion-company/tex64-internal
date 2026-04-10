import { getUiLocale } from "./i18n.js";

export const TAB_KEYS = [
  "files",
  "outline",
  "blocks",
  "ai",
  "project",
  "search",
  "issues",
  "settings",
] as const;

export type TabKey = (typeof TAB_KEYS)[number];

export type TabConfigEntry = {
  label: string;
  outline: string;
  title: string;
  desc: string;
  hint: string;
};

const EN_TAB_CONFIG: Record<TabKey, TabConfigEntry> = {
  files: {
    label: "Files",
    outline: "Mini outline: main.tex",
    title: "Editor Area",
    desc: "Edit with Monaco.",
    hint: "The Files tab is selected.",
  },
  outline: {
    label: "Outline",
    outline: "Chapters / figures / TODO",
    title: "Outline",
    desc: "View chapters, figures, TODOs, and references in one list.",
    hint: "Click to jump to the definition.",
  },
  blocks: {
    label: "Blocks",
    outline: "Block list",
    title: "Blocks",
    desc: "Insert formulas as blocks.",
    hint: "Confirm after previewing.",
  },
  ai: {
    label: "Axiom",
    outline: "Axiom",
    title: "Axiom",
    desc: "Use chat to propose file changes and create templates.",
    hint: "Review diffs before applying.",
  },
  project: {
    label: "Project",
    outline: "Project settings",
    title: "Project Settings",
    desc: "Manage workspace-level settings.",
    hint: "Manage main TeX and registered environments.",
  },
  search: {
    label: "Search",
    outline: "Search results",
    title: "Search",
    desc: "Search within the workspace.",
    hint: "Press Enter to search.",
  },
  issues: {
    label: "Issues",
    outline: "Build issues",
    title: "Issues",
    desc: "List build and operation issues.",
    hint: "Click to jump to the relevant location.",
  },
  settings: {
    label: "Settings",
    outline: "Settings",
    title: "Editor Settings",
    desc: "Show settings shared by the editor.",
    hint: "Project settings are in a separate tab.",
  },
};

const JA_TAB_CONFIG: Record<TabKey, TabConfigEntry> = {
  files: {
    label: "file",
    outline: "Mini outline: main.tex",
    title: "Editing area",
    desc: "Edit with Monaco.",
    hint: "File tab is selected.",
  },
  outline: {
    label: "Outline",
    outline: "Chapter/Chart/TODO",
    title: "Outline",
    desc: "Displays a list of chapters, diagrams, TODOs, and references.",
    hint: "Click to go to definition.",
  },
  blocks: {
    label: "Blocks",
    outline: "Block list",
    title: "Blocks",
    desc: "Insert formulas as blocks.",
    hint: "Confirm after previewing.",
  },
  ai: {
    label: "Axiom",
    outline: "Axiom",
    title: "Axiom",
    desc: "Suggest files and create templates via chat.",
    hint: "Check and apply the differences.",
  },
  project: {
    label: "Project",
    outline: "Project settings",
    title: "Project settings",
    desc: "Manage per-workspace settings.",
    hint: "Manage main TeX and environment registration.",
  },
  search: {
    label: "Search",
    outline: "Search results",
    title: "Search",
    desc: "Search within your workspace.",
    hint: "You can search by pressing Enter.",
  },
  issues: {
    label: "Issues",
    outline: "build error",
    title: "Issues",
    desc: "Displays a list of build and operation errors.",
    hint: "Click to move to the corresponding location.",
  },
  settings: {
    label: "Settings",
    outline: "Settings",
    title: "Editor settings",
    desc: "Displays settings common to all editors.",
    hint: "Project settings are in a separate tab.",
  },
};

export const TAB_KEY_SET = new Set<TabKey>(TAB_KEYS);

export const getTabConfig = () => (getUiLocale() === "ja" ? JA_TAB_CONFIG : EN_TAB_CONFIG);
