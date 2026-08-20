import { uiText } from "./i18n.js";

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

export type TexInstallVariant = "full";

// One line naming what was found and where, so a user with an existing MacTeX
// can see we are using *their* install rather than wondering what we did.
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
  const name = report.distribution.name;
  const where =
    report.source === "managed"
      ? uiText("installed by TeX64", "TeX64 が導入した環境")
      : uiText("already on this computer", "この環境に既にあるもの");
  const detail = `${name} — ${where}`;
  if (report.distribution.root) {
    return `${detail}\n${report.distribution.root}`;
  }
  return detail;
};

// What the coverage probe means in words. "on-demand" can still describe an
// externally installed MiKTeX tree; TeX64's own tree is always scheme-full.
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
  get full() {
    return {
      badge: "",
      title: uiText("Install TeX Live", "TeX Live を導入"),
      detail: uiText(
        "Every CTAN package, managed privately by TeX64.",
        "CTAN の全パッケージを TeX64 専用の場所に導入します。"
      ),
      size: uiText("about 5 GB · 30–60 min", "約 5 GB・30〜60 分"),
    };
  },
};
