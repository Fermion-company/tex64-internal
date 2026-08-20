import { uiText } from "./i18n.js";
// One line naming what was found and where, so a user with an existing MacTeX
// can see we are using *their* install rather than wondering what we did.
export const describeDetection = (report) => {
    if (!report) {
        return "";
    }
    if (!report.hasEngine) {
        return uiText("No TeX distribution was found on this computer.", "この環境に TeX は見つかりませんでした。");
    }
    const name = report.distribution.name;
    const where = report.source === "managed"
        ? uiText("installed by TeX64", "TeX64 が導入した環境")
        : uiText("already on this computer", "この環境に既にあるもの");
    const detail = `${name} — ${where}`;
    if (report.distribution.root) {
        return `${detail}\n${report.distribution.root}`;
    }
    return detail;
};
// What the coverage probe means in words. "on-demand" is the light install's
// promise: the gaps are real but they close themselves on first build.
export const describeCoverage = (report) => {
    if (!report || !report.hasEngine) {
        return "";
    }
    switch (report.coverage.level) {
        case "full":
            return uiText("Full package set — everything from CTAN is available.", "フルパッケージ — CTAN の全パッケージが使えます。");
        case "on-demand":
            return uiText("Missing packages are downloaded automatically the first time a document needs them.", "足りないパッケージは、初めて必要になったときに自動で取得されます。");
        case "recommended":
            return uiText("Common packages are available; a few specialist ones are not installed.", "よく使うパッケージは揃っています（一部の専門パッケージは未導入）。");
        case "minimal":
            return uiText("This is a minimal package set — common packages are missing.", "パッケージが最小構成です。よく使うパッケージが不足しています。");
        case "broken":
            return uiText("Core LaTeX packages are missing, so most documents will not build.", "LaTeX の基本パッケージが欠けています。多くの文書はビルドできません。");
        default:
            return "";
    }
};
export const INSTALL_VARIANT_LABELS = {
    get full() {
        return {
            badge: "",
            title: uiText("Everything", "フル"),
            detail: uiText("Every CTAN package up front, so the machine never needs the network again.", "最初に CTAN の全パッケージを入れる。以後ネットワーク不要。"),
            size: uiText("about 5 GB · 30–60 min", "約 5 GB・30〜60 分"),
        };
    },
    get light() {
        return {
            badge: uiText("Recommended", "おすすめ"),
            title: uiText("Light", "ライト"),
            detail: uiText("Ready in minutes. Anything a document needs later installs itself on first use.", "数分で使える。後から必要になったパッケージは初回使用時に自動で入る。"),
            size: uiText("about 500 MB · a few minutes", "約 500 MB・数分"),
        };
    },
};
