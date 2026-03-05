const KNOWN_PACKAGE_HINTS: Record<string, string> = {
  amsmath: "AMS Math",
  amssymb: "AMS Symbols",
  graphicx: "Graphics",
  hyperref: "Hyperlinks",
  geometry: "Page geometry",
  xcolor: "Color",
  mathtools: "Math tools",
  biblatex: "Bibliography",
  cleveref: "Cross-reference",
};

export const buildPackageHoverMarkdown = (
  pkgName: string,
  commandName: "usepackage" | "RequirePackage" | "documentclass"
) => {
  const normalized = pkgName.trim();
  if (!normalized) {
    return null;
  }
  const hint = KNOWN_PACKAGE_HINTS[normalized.toLowerCase()];
  const encoded = encodeURIComponent(normalized);
  const lines = [
    `\`${normalized}\``,
    hint ? `${hint}` : null,
    `[CTAN](https://ctan.org/pkg/${encoded})`,
    `\`texdoc ${normalized}\``,
  ].filter(Boolean);
  const syntax =
    commandName === "documentclass"
      ? "\\documentclass[options]{class}"
      : commandName === "RequirePackage"
        ? "\\RequirePackage[options]{package}"
        : "\\usepackage[options]{package}";
  return [`\`\`\`tex\n${syntax}\n\`\`\``, ...lines].join("\n");
};

