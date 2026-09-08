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
    git: { label: "Git", outline: "Git", title: "Git", desc: "", hint: "" },
    history: { label: "History", outline: "History", title: "History", desc: "", hint: "" },
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
// The Japanese tab copy had degraded to machine-mangled English at some point;
// this is the actual Japanese. Other locales fall back to EN_TAB_CONFIG.
const JA_TAB_CONFIG = {
    files: {
        label: "ファイル",
        outline: "ミニアウトライン: main.tex",
        title: "編集エリア",
        desc: "Monaco で編集します。",
        hint: "ファイルタブを選択中です。",
    },
    outline: {
        label: "アウトライン",
        outline: "章・図表・TODO",
        title: "アウトライン",
        desc: "章・図表・TODO・参照の一覧を表示します。",
        hint: "クリックで定義位置へ移動します。",
    },
    blocks: {
        label: "ブロック",
        outline: "ブロック一覧",
        title: "ブロック",
        desc: "数式をブロックとして挿入します。",
        hint: "プレビューを確認してから確定します。",
    },
    ai: {
        label: "Axiom",
        outline: "Axiom",
        title: "Axiom",
        desc: "チャットでファイルの提案やテンプレート作成を行います。",
        hint: "差分を確認して適用します。",
    },
    git: { label: "Git", outline: "Git", title: "Git", desc: "", hint: "" },
    history: { label: "履歴", outline: "履歴", title: "履歴", desc: "", hint: "" },
    project: {
        label: "プロジェクト",
        outline: "プロジェクト設定",
        title: "プロジェクト設定",
        desc: "ワークスペースごとの設定を管理します。",
        hint: "メイン TeX と環境登録を管理します。",
    },
    search: {
        label: "検索",
        outline: "検索結果",
        title: "検索",
        desc: "ワークスペース内を検索します。",
        hint: "Enter で検索できます。",
    },
    issues: {
        label: "Issues",
        outline: "ビルドエラー",
        title: "Issues",
        desc: "ビルドや操作のエラーを一覧表示します。",
        hint: "クリックで該当箇所へ移動します。",
    },
    settings: {
        label: "設定",
        outline: "設定",
        title: "エディタ設定",
        desc: "全エディタ共通の設定を表示します。",
        hint: "プロジェクト設定は別タブにあります。",
    },
};
export const TAB_KEY_SET = new Set(TAB_KEYS);
export const getTabConfig = () => (getUiLocale() === "ja" ? JA_TAB_CONFIG : EN_TAB_CONFIG);
