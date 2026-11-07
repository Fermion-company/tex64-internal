import { uiText } from "./i18n.js";
import { createExplain } from "./explain.js";

// Mirror of the report produced by EnvService.detectEnvironment() in the main
// process. The setup screen renders this instead of guessing from per-command
// availability, so it can say *which* TeX it found, not just "something works".
export type TexEnvReport = {
  hasEngine: boolean;
  source: "managed" | "system" | "none";
  ready: boolean;
  distribution: {
    kind: "texlive" | "miktex" | "unknown";
    name: string;
    year: string;
    root: string;
    isTinytex: boolean;
  };
  managedVariant: "full" | "light" | null;
  // The managed tree's TeX Live year, and the newer year it can be renewed to.
  managedYear?: string;
  renew?: { from: string; to: string } | null;
  engines: Record<string, string | null>;
  tools: Record<string, string | null>;
  coverage: {
    level: "full" | "recommended" | "minimal" | "broken" | "on-demand" | "unknown";
    missingCore: string[];
    missingRecommended: string[];
    missingFull: string[];
    probed: number;
    found: number;
  };
  recommendation: {
    action: "use-existing" | "install" | "expand";
    reason: string;
  };
  checkedAt: string;
};

export type TexInstallVariant = "light" | "full";

// The distribution's name. Whose install it is and where it lives go to the
// line's tooltip (describeDetectionSource), so a user with an existing MacTeX
// can still check we are using *their* install.
export const describeDetection = (report: TexEnvReport | null): string => {
  if (!report) {
    return "";
  }
  if (!report.hasEngine) {
    return uiText(
      "No TeX distribution was found on this computer.",
      "この環境に TeX は見つかりませんでした。"
    );
  }
  return report.distribution.name;
};

export const describeDetectionSource = (report: TexEnvReport | null): string => {
  if (!report?.hasEngine) {
    return "";
  }
  const where =
    report.source === "managed"
      ? uiText("installed by TeX64", "TeX64 が導入した環境")
      : uiText("already on this computer", "この環境に既にあるもの");
  return [where, report.distribution.root].filter(Boolean).join("\n");
};

// What the coverage probe means in words. "on-demand" can still describe an
// externally installed MiKTeX tree or TeX64's lightweight managed tree.
export const describeCoverage = (report: TexEnvReport | null): string => {
  if (!report || !report.hasEngine) {
    return "";
  }
  switch (report.coverage.level) {
    case "full":
      return uiText(
        "Full package set — everything from CTAN is available.",
        "フルパッケージ — CTAN の全パッケージが使えます。"
      );
    case "on-demand":
      return uiText(
        "Missing packages are downloaded automatically the first time a document needs them.",
        "足りないパッケージは、初めて必要になったときに自動で取得されます。"
      );
    case "recommended":
      return uiText(
        "Common packages are available; a few specialist ones are not installed.",
        "よく使うパッケージは揃っています（一部の専門パッケージは未導入）。"
      );
    case "minimal":
      return uiText(
        "This is a minimal package set — common packages are missing.",
        "パッケージが最小構成です。よく使うパッケージが不足しています。"
      );
    case "broken":
      return uiText(
        "Core LaTeX packages are missing, so most documents will not build.",
        "LaTeX の基本パッケージが欠けています。多くの文書はビルドできません。"
      );
    default:
      return "";
  }
};

export const INSTALL_VARIANT_LABELS: Record<
  TexInstallVariant,
  { title: string; detail: string; size: string; badge: string }
> = {
  get light() {
    return {
      badge: uiText("Recommended", "おすすめ"),
      title: uiText("Quick setup", "すぐにセットアップ"),
      detail: uiText(
        "Official TinyTeX-1, managed privately by TeX64. Missing packages are added automatically.",
        "TeX64 専用の公式 TinyTeX-1 です。足りないパッケージは自動で追加します。"
      ),
      size: uiText(
        "about 70 MB download · about 300 MB installed · usually 1–3 min",
        "ダウンロード約 70 MB・使用容量約 300 MB・通常 1〜3 分"
      ),
    };
  },
  get full() {
    return {
      badge: "",
      title: uiText("Install TeX Live", "TeX Live を導入"),
      detail: uiText(
        "Every CTAN package, managed privately by TeX64.",
        "CTAN の全パッケージを TeX64 専用の場所に導入します。"
      ),
      // measured 2026-09-30: install-tl, scheme-full, 72 min at about 40 Mbps
      size: uiText("about 5 GB · 30 min–2 h", "約 5 GB・30 分〜2 時間"),
    };
  },
};

// What a setup choice does and costs (the download and disk size), behind a ▾
// right under its button. Rebuilt with the labels, so it follows the UI
// language; whether it is open survives the rebuild.
const installExplainOpen = new Set<string>();
export const renderInstallExplain = (button: HTMLElement, variant: TexInstallVariant) => {
  const labels = INSTALL_VARIANT_LABELS[variant];
  const { button: toggle, panel } = createExplain([labels.detail, labels.size], { topic: labels.title, memory: installExplainOpen, key: `${button.id}:${variant}` });
  const more = document.createElement("div");
  more.className = "env-choice-more";
  const row = document.createElement("div");
  row.className = "explain-row";
  row.append(toggle);
  more.append(row, panel);
  const previous = button.nextElementSibling;
  if (previous?.classList.contains("env-choice-more")) previous.replaceWith(more);
  else button.after(more);
};
