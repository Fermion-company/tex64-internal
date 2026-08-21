// TeX environment detection.
//
// The install screen has to answer three questions before it can show anything
// useful: is there a TeX at all, whose TeX is it (ours, MacTeX, MiKTeX, ...),
// and is its package set wide enough that the user can stop thinking about it.
// Everything here is split into pure helpers plus one service method that does
// the two process spawns, so the classification logic stays unit-testable on a
// machine with no TeX installed at all.

const path = require("path");

// Probe files, tiered. kpsewhich resolves these by name across the TEXMF trees,
// so a hit means "this package is actually installed", not "it exists on CTAN".
const PROBE_CORE = [
  "article.cls",
  "amsmath.sty",
  "graphicx.sty",
  "geometry.sty",
  "hyperref.sty",
];

// What an ordinary LaTeX user runs into within the first week. A distribution
// missing any of these will send them back to a package manager, which is the
// exact experience TeX64 exists to remove.
const PROBE_RECOMMENDED = [
  "xcolor.sty",
  "booktabs.sty",
  "listings.sty",
  "microtype.sty",
  "tikz.sty",
  "pgfplots.sty",
  "biblatex.sty",
  "fontspec.sty",
  "unicode-math.sty",
  "siunitx.sty",
  "beamer.cls",
  "luatexja.sty",
];

// Markers for collections that only scheme-full pulls in (publishers, CJK
// beyond Japanese). Present => this is a full CTAN install, not a curated one.
const PROBE_FULL = ["revtex4-2.cls", "IEEEtran.cls", "ctex.sty"];

const ALL_PROBES = [...PROBE_CORE, ...PROBE_RECOMMENDED, ...PROBE_FULL];

const TEX_ENGINES = ["lualatex", "pdflatex", "xelatex", "uplatex"];
const TEX_TOOLS = ["latexmk", "synctex", "latexindent", "biber", "tlmgr", "kpsewhich"];

// kpsewhich prints one absolute path per resolved file and simply omits the
// misses, so the basenames of the output lines are the found set.
const parseKpsewhichOutput = (output, wanted = ALL_PROBES) => {
  const wantedSet = new Set(wanted.map((name) => name.toLowerCase()));
  const found = new Set();
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const base = path.basename(line).toLowerCase();
    if (wantedSet.has(base)) {
      found.add(base);
    }
  }
  return found;
};

// Accepts the banner of `tlmgr --version`, `pdflatex --version` or
// `lualatex --version`; they all name the distribution and (for TeX Live) year.
const parseDistributionBanner = (output) => {
  const text = String(output || "");
  if (/MiKTeX/i.test(text)) {
    const version = text.match(/MiKTeX[\s-]+([\d.]+)/i);
    return {
      kind: "miktex",
      year: "",
      version: version ? version[1] : "",
      root: "",
    };
  }
  const year = text.match(/TeX Live[^\d]{0,40}(\d{4})/i);
  // `tlmgr --version` reports the tree it is bound to, which is the most
  // reliable root we can get without guessing from the binary path.
  const root = text.match(/using installation:\s*(.+)/i);
  if (year || root || /TeX Live/i.test(text)) {
    return {
      kind: "texlive",
      year: year ? year[1] : "",
      version: "",
      root: root ? root[1].trim() : "",
    };
  }
  return { kind: "unknown", year: "", version: "", root: "" };
};

const isInside = (child, parent) => {
  if (!child || !parent) {
    return false;
  }
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// "Whose TeX is this?" — the managed tree is ours to install into and upgrade;
// anything else is the user's and must never be written to.
const classifySource = (commandPath, managedRoot) => {
  if (!commandPath) {
    return "none";
  }
  if (managedRoot && (commandPath === managedRoot || isInside(commandPath, managedRoot))) {
    return "managed";
  }
  return "system";
};

// TeX Live year taken from the install path (/usr/local/texlive/2025/...), used
// when the banner did not carry one.
const yearFromPath = (value) => {
  const match = String(value || "").match(/texlive[\\/](\d{4})/i);
  return match ? match[1] : "";
};

const rootFromBinPath = (commandPath) => {
  const match = String(commandPath || "").match(/^(.*[\\/]texlive[\\/]\d{4})[\\/]/i);
  return match ? match[1] : "";
};

const describeDistribution = ({
  kind,
  year,
  version,
  root,
  source,
  platform,
  isTinytex = false,
}) => {
  if (kind === "miktex") {
    return version ? `MiKTeX ${version}` : "MiKTeX";
  }
  if (kind !== "texlive") {
    return "TeX (unrecognized distribution)";
  }
  const label = year ? `TeX Live ${year}` : "TeX Live";
  if (source === "managed") {
    return `${label} (TeX64 managed)`;
  }
  // TinyTeX drops a `.tinytex` token in its root precisely so tools can tell it
  // apart from a plain TeX Live; it is still tlmgr-managed, just started small.
  if (isTinytex) {
    return `TinyTeX (${label})`;
  }
  // MacTeX is TeX Live in /usr/local/texlive fronted by /Library/TeX/texbin;
  // naming it MacTeX is what the user actually recognizes.
  if (platform === "darwin" && source === "system" && /^\/usr\/local\/texlive/.test(String(root || ""))) {
    return `MacTeX / ${label}`;
  }
  return label;
};

// Coverage tiers describe an existing installation. TeX64's own installer is
// always scheme-full; these tiers are only diagnostic.
const classifyCoverage = (found, kind = "texlive", options = {}) => {
  const has = (name) => found.has(String(name).toLowerCase());
  const missingCore = PROBE_CORE.filter((name) => !has(name));
  const missingRecommended = PROBE_RECOMMENDED.filter((name) => !has(name));
  const missingFull = PROBE_FULL.filter((name) => !has(name));
  // MiKTeX installs missing packages on demand at build time.
  if (
    missingCore.length === 0 &&
    (kind === "miktex" || options.autoInstallsOnDemand === true)
  ) {
    return {
      level: "on-demand",
      autoInstall: true,
      missingCore: [],
      missingRecommended: [],
      missingFull: [],
      probed: ALL_PROBES.length,
      found: found.size,
    };
  }
  let level = "full";
  if (missingCore.length > 0) {
    level = "broken";
  } else if (missingRecommended.length > 2) {
    level = "minimal";
  } else if (missingFull.length > 0 || missingRecommended.length > 0) {
    level = "recommended";
  }
  return {
    level,
    missingCore,
    missingRecommended,
    missingFull,
    probed: ALL_PROBES.length,
    found: found.size,
  };
};

// The single decision the screen renders. `useExisting` means we show a green
// "ready" state and no install button at all: a user who already has MacTeX
// should never be asked to download 5 GB again.
const buildRecommendation = ({
  source,
  hasEngine,
  hasLatexmk,
  hasSynctex,
  coverageLevel,
}) => {
  if (source === "none" || !hasEngine) {
    return {
      action: "install",
      reason: "no-tex",
    };
  }
  if (coverageLevel === "broken") {
    return { action: "install", reason: "core-packages-missing" };
  }
  if (!hasLatexmk || !hasSynctex) {
    // An engine without latexmk/synctex builds, but loses the build loop and
    // forward/reverse search. Ours can supply those without touching theirs.
    return { action: "install", reason: source === "managed" ? "repair" : "missing-build-tools" };
  }
  if (coverageLevel === "minimal") {
    return { action: "expand", reason: "thin-package-set" };
  }
  return { action: "use-existing", reason: "ready" };
};

module.exports = {
  PROBE_CORE,
  PROBE_RECOMMENDED,
  PROBE_FULL,
  ALL_PROBES,
  TEX_ENGINES,
  TEX_TOOLS,
  parseKpsewhichOutput,
  parseDistributionBanner,
  classifySource,
  yearFromPath,
  rootFromBinPath,
  describeDistribution,
  classifyCoverage,
  buildRecommendation,
};
