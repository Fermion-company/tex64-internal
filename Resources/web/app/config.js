import { getUiLocale } from "./i18n.js";
export const TAB_KEYS = [
    "files",
    "outline",
    "blocks",
    "ai",
    "history",
    "git",
    "project",
    "search",
    "issues",
    "settings",
];
const EN_TAB_CONFIG = {
    files: {
        label: "Files",
        outline: "Mini outline: main.tex",
        title: "Editor Area",
    },
    outline: {
        label: "Outline",
        outline: "Chapters / figures / TODO",
        title: "Outline",
    },
    blocks: {
        label: "Math",
        outline: "Math",
        title: "Math",
    },
    ai: {
        label: "Axiom",
        outline: "Axiom",
        title: "Axiom",
    },
    git: { label: "Git", outline: "Git", title: "Git" },
    history: { label: "History", outline: "History", title: "History" },
    project: {
        label: "Project",
        outline: "Project settings",
        title: "Project Settings",
    },
    search: {
        label: "Search",
        outline: "Search results",
        title: "Search",
    },
    issues: {
        label: "Issues",
        outline: "Build issues",
        title: "Issues",
    },
    settings: {
        label: "Settings",
        outline: "Settings",
        title: "Editor Settings",
    },
};
// The Japanese tab copy had degraded to machine-mangled English at some point;
// this is the actual Japanese. Other locales fall back to EN_TAB_CONFIG.
const JA_TAB_CONFIG = {
    files: {
        label: "ファイル",
        outline: "ミニアウトライン: main.tex",
        title: "編集エリア",
    },
    outline: {
        label: "アウトライン",
        outline: "章・図表・TODO",
        title: "アウトライン",
    },
    blocks: {
        label: "数式",
        outline: "数式",
        title: "数式",
    },
    ai: {
        label: "Axiom",
        outline: "Axiom",
        title: "Axiom",
    },
    git: { label: "Git", outline: "Git", title: "Git" },
    history: { label: "履歴", outline: "履歴", title: "履歴" },
    project: {
        label: "プロジェクト",
        outline: "プロジェクト設定",
        title: "プロジェクト設定",
    },
    search: {
        label: "検索",
        outline: "検索結果",
        title: "検索",
    },
    issues: {
        label: "Issues",
        outline: "ビルドエラー",
        title: "Issues",
    },
    settings: {
        label: "設定",
        outline: "設定",
        title: "エディタ設定",
    },
};
export const TAB_KEY_SET = new Set(TAB_KEYS);
export const getTabConfig = () => (getUiLocale() === "ja" ? JA_TAB_CONFIG : EN_TAB_CONFIG);
