const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROBE_CORE,
  PROBE_RECOMMENDED,
  ALL_PROBES,
  parseKpsewhichOutput,
  parseDistributionBanner,
  classifySource,
  rootFromBinPath,
  yearFromPath,
  describeDistribution,
  classifyCoverage,
  buildRecommendation,
} = require("../electron/services/tex-detect.cjs");

const foundSet = (names) => new Set(names.map((name) => name.toLowerCase()));

test("kpsewhich output maps back to the probed file names", () => {
  const output = [
    "/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls",
    "/usr/local/texlive/2025/texmf-dist/tex/latex/amsmath/amsmath.sty",
    "/usr/local/texlive/2025/texmf-dist/tex/latex/unrelated/other.sty",
    "",
  ].join("\n");
  const found = parseKpsewhichOutput(output);
  assert.ok(found.has("article.cls"));
  assert.ok(found.has("amsmath.sty"));
  assert.equal(found.has("other.sty"), false);
  assert.equal(found.size, 2);
});

test("distribution banners are recognized for TeX Live, MacTeX and MiKTeX", () => {
  const tlmgr = [
    "tlmgr revision 69803 (2024-02-21 01:23:45 +0100)",
    "tlmgr using installation: /usr/local/texlive/2025",
    "TeX Live (https://tug.org/texlive) version 2025",
  ].join("\n");
  const parsedTlmgr = parseDistributionBanner(tlmgr);
  assert.equal(parsedTlmgr.kind, "texlive");
  assert.equal(parsedTlmgr.year, "2025");
  assert.equal(parsedTlmgr.root, "/usr/local/texlive/2025");

  const engine = "This is LuaHBTeX, Version 1.18.0 (TeX Live 2024)";
  assert.deepEqual(parseDistributionBanner(engine).year, "2024");

  const miktex = "MiKTeX-pdfTeX 4.14 (MiKTeX 24.1)";
  const parsedMiktex = parseDistributionBanner(miktex);
  assert.equal(parsedMiktex.kind, "miktex");
  assert.equal(parsedMiktex.version, "24.1");

  assert.equal(parseDistributionBanner("something else entirely").kind, "unknown");
});

test("a binary inside the managed root is ours, anything else is the user's", () => {
  const managedRoot = "/Users/Shared/TeX64/texlive/2026";
  assert.equal(
    classifySource(`${managedRoot}/bin/universal-darwin/lualatex`, managedRoot),
    "managed"
  );
  assert.equal(classifySource("/Library/TeX/texbin/lualatex", managedRoot), "system");
  assert.equal(classifySource(null, managedRoot), "none");
  // A path that merely starts with the same characters is not inside the root.
  assert.equal(classifySource("/Users/Shared/TeX64/texlive/2026-old/bin/x", managedRoot), "system");
});

test("install root and year are recoverable from a binary path", () => {
  assert.equal(
    rootFromBinPath("/usr/local/texlive/2025/bin/universal-darwin/lualatex"),
    "/usr/local/texlive/2025"
  );
  assert.equal(rootFromBinPath("/Library/TeX/texbin/lualatex"), "");
  assert.equal(yearFromPath("/usr/local/texlive/2025"), "2025");
});

test("distribution names say what the user recognizes", () => {
  assert.equal(
    describeDistribution({
      kind: "texlive",
      year: "2025",
      root: "/usr/local/texlive/2025",
      source: "system",
      platform: "darwin",
    }),
    "MacTeX / TeX Live 2025"
  );
  assert.equal(
    describeDistribution({ kind: "texlive", year: "2026", source: "managed", platform: "darwin" }),
    "TeX Live 2026 (TeX64 managed)"
  );
  assert.equal(
    describeDistribution({
      kind: "texlive",
      year: "2025",
      source: "system",
      platform: "darwin",
      isTinytex: true,
    }),
    "TinyTeX (TeX Live 2025)"
  );
  assert.equal(describeDistribution({ kind: "miktex", version: "24.1" }), "MiKTeX 24.1");
});

test("coverage tiers separate a full CTAN tree from a thin one", () => {
  assert.equal(classifyCoverage(foundSet(ALL_PROBES)).level, "full");

  // Core + everyday packages present, specialist collections absent.
  assert.equal(
    classifyCoverage(foundSet([...PROBE_CORE, ...PROBE_RECOMMENDED])).level,
    "recommended"
  );

  // Core only: this is the BasicTeX/TinyTeX-0 shape that sends users hunting for
  // packages, which is exactly what the detection has to call out.
  assert.equal(classifyCoverage(foundSet(PROBE_CORE)).level, "minimal");

  assert.equal(classifyCoverage(foundSet(["amsmath.sty"])).level, "broken");
});

test("on-demand distributions are not nagged about missing packages", () => {
  // MiKTeX installs at build time by itself.
  assert.equal(classifyCoverage(foundSet(PROBE_CORE), "miktex").level, "on-demand");
  // So does our own managed tree, because we own its tlmgr.
  assert.equal(
    classifyCoverage(foundSet(PROBE_CORE), "texlive", { autoInstallsOnDemand: true }).level,
    "on-demand"
  );
  // ...but only once the core is actually there.
  assert.equal(
    classifyCoverage(foundSet([]), "texlive", { autoInstallsOnDemand: true }).level,
    "broken"
  );
});

test("recommendation: an existing complete TeX is used as is", () => {
  assert.deepEqual(
    buildRecommendation({
      source: "system",
      hasEngine: true,
      hasLatexmk: true,
      hasSynctex: true,
      coverageLevel: "full",
    }),
    { action: "use-existing", reason: "ready" }
  );
});

test("recommendation: no TeX at all means install", () => {
  assert.equal(
    buildRecommendation({ source: "none", hasEngine: false, coverageLevel: "unknown" }).action,
    "install"
  );
});

test("recommendation: an engine without latexmk/synctex is not enough", () => {
  assert.equal(
    buildRecommendation({
      source: "system",
      hasEngine: true,
      hasLatexmk: false,
      hasSynctex: true,
      coverageLevel: "full",
    }).reason,
    "missing-build-tools"
  );
});

test("recommendation: a thin existing install is expanded, not replaced", () => {
  assert.equal(
    buildRecommendation({
      source: "system",
      hasEngine: true,
      hasLatexmk: true,
      hasSynctex: true,
      coverageLevel: "minimal",
    }).action,
    "expand"
  );
});
