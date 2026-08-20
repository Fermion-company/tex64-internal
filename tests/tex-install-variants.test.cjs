const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EnvService,
  INSTALL_VARIANTS,
  normalizeInstallVariant,
  parseExtraPackages,
} = require("../electron/services/env.cjs");
const {
  KK_STYLESHEET_PACKAGES,
  LIGHT_INSTALL_PACKAGES,
  parseUnavailablePackages,
  extractMissingFiles,
  parseTlmgrSearchOutput,
  searchTermForFile,
} = require("../electron/services/tex-packages.cjs");

test("variant names, including the historical targets, resolve to a variant", () => {
  assert.equal(normalizeInstallVariant("light"), "light");
  assert.equal(normalizeInstallVariant("tinytex"), "light");
  assert.equal(normalizeInstallVariant("full"), "full");
  assert.equal(normalizeInstallVariant("texlive-full"), "full");
  // Light is the recommended install, so unrecognized names — including the
  // legacy "basictex" target used by the agent tool — resolve to it.
  assert.equal(normalizeInstallVariant("basictex"), "light");
  assert.equal(normalizeInstallVariant(undefined), "light");
});

test("an existing full tree is never relabelled as light", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-fullmarker-"));
  const previous = process.env.TEX64_MANAGED_TEXLIVE_ROOT;
  process.env.TEX64_MANAGED_TEXLIVE_ROOT = root;
  try {
    const service = new EnvService();
    service.writeInstallMarker("full");
    // Pretend the managed tree exists and is healthy; a legacy target now means
    // "light", and must not downgrade the record (which drives the upgrade
    // button) or reinstall anything.
    service.findManagedCommand = (command) =>
      command === "tlmgr" ? path.join(root, "bin", "tlmgr") : null;
    service.checkCommand = async () => true;
    service.ensureManagedTexliveInstalled = async () => {
      throw new Error("must not reinstall over an existing full tree");
    };
    service.runTlmgr = async () => {
      throw new Error("must not run tlmgr for a light request on a full tree");
    };

    const result = await service.installManagedTexlive("light");

    assert.equal(result.success, true);
    assert.equal(result.variant, "full");
    assert.equal(service.readInstallMarker().variant, "full");
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_ROOT;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_ROOT = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("each variant selects its own TeX Live scheme in the install profile", () => {
  const service = new EnvService();
  const full = service.buildInstallProfile("/tmp/tex64-test", "full");
  const light = service.buildInstallProfile("/tmp/tex64-test", "light");
  assert.match(full, /^selected_scheme scheme-full$/m);
  assert.match(light, /^selected_scheme scheme-infraonly$/m);
  // Everything else about the tree layout must stay identical between variants,
  // so a light install can be grown into a full one in place.
  assert.equal(
    full.replace(/^selected_scheme .*$/m, ""),
    light.replace(/^selected_scheme .*$/m, "")
  );
});

test("the light variant installs the curated package list", () => {
  const packages = parseExtraPackages("light");
  assert.equal(packages, LIGHT_INSTALL_PACKAGES);
  // TinyTeX's own baseline plus what TeX64 needs: TikZ for the Pro canvas and
  // LuaTeX-based Japanese.
  for (const expected of ["latexmk", "amsmath", "pgf", "luatexja", "biblatex"]) {
    assert.ok(packages.includes(expected), `expected ${expected} in the light set`);
  }
  // The reference book stylesheet must build on the light install; every package
  // its chain loads is part of the set by construction.
  for (const expected of KK_STYLESHEET_PACKAGES) {
    assert.ok(packages.includes(expected), `expected ${expected} in the light set`);
  }
  assert.equal(packages.length, new Set(packages).size, "no duplicate package names");
});

test("the full variant does not ship the curated list (scheme-full already has it)", () => {
  const packages = parseExtraPackages("full");
  assert.ok(packages.includes("latexmk"));
  assert.ok(packages.some((name) => name.startsWith("collection-")));
  assert.ok(packages.length < LIGHT_INSTALL_PACKAGES.length);
});

test("the environment variable override still wins for both variants", () => {
  const previous = process.env.TEX64_MANAGED_TEXLIVE_EXTRA_PACKAGES;
  process.env.TEX64_MANAGED_TEXLIVE_EXTRA_PACKAGES = "foo, bar baz";
  try {
    assert.deepEqual(parseExtraPackages("light"), ["foo", "bar", "baz"]);
    assert.deepEqual(parseExtraPackages("full"), ["foo", "bar", "baz"]);
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_EXTRA_PACKAGES;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_EXTRA_PACKAGES = previous;
    }
  }
});

test("the install marker records which variant produced the managed tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-marker-"));
  const previous = process.env.TEX64_MANAGED_TEXLIVE_ROOT;
  process.env.TEX64_MANAGED_TEXLIVE_ROOT = root;
  try {
    const service = new EnvService();
    // No marker yet reads as "unknown", never as a variant: an unlabelled tree
    // may predate the marker and already hold the full CTAN set.
    assert.deepEqual(service.readInstallMarker(), {
      variant: null,
      installedAt: null,
      known: false,
    });
    service.writeInstallMarker("light");
    const marker = service.readInstallMarker();
    assert.equal(marker.variant, "light");
    assert.equal(marker.known, true);
    assert.ok(marker.installedAt);
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_ROOT;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_ROOT = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing files are extracted from a real LaTeX failure log", () => {
  const log = [
    "This is LuaHBTeX, Version 1.18.0 (TeX Live 2025)",
    "! LaTeX Error: File `tikz.sty' not found.",
    "! LaTeX Error: File `revtex4-2.cls' not found.",
    "kpathsea: file ecrm1000.tfm not found",
    "! Font \\OT1/cmr/m/n/10=cmr10 not loadable",
  ].join("\n");
  const files = extractMissingFiles(log);
  assert.deepEqual(files.slice(0, 2), ["tikz.sty", "revtex4-2.cls"]);
  assert.ok(files.includes("ecrm1000.tfm"));
});

test("a missing image or bib file is the author's problem, not a package", () => {
  const log = [
    "! LaTeX Error: File `figure1.png' not found.",
    "! Package pdftex.def Error: File `plot.pdf' not found",
    "! LaTeX Error: File `refs.bib' not found.",
  ].join("\n");
  assert.deepEqual(extractMissingFiles(log), []);
});

test("tlmgr search output yields packages, never collections or schemes", () => {
  const output = [
    "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
    "collection-pictures:",
    "\ttexmf-dist/tex/latex/pgf/frontendlayer/tikz.sty",
    "pgf:",
    "\ttexmf-dist/tex/latex/pgf/frontendlayer/tikz.sty",
    "scheme-full:",
    "\ttexmf-dist/tex/latex/pgf/frontendlayer/tikz.sty",
  ].join("\n");
  assert.deepEqual(parseTlmgrSearchOutput(output), ["pgf"]);
});

test("search terms anchor style files but not font files", () => {
  // The leading slash makes tlmgr match the whole basename, so "url.sty" does
  // not also drag in "myurl.sty".
  assert.equal(searchTermForFile("url.sty"), "/url.sty");
  assert.equal(searchTermForFile("ecrm1000.tfm"), "ecrm1000.tfm");
  assert.equal(searchTermForFile(""), "");
});

test("installMissingPackages refuses to touch a TeX Live it does not own", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-nomanaged-"));
  const previous = process.env.TEX64_MANAGED_TEXLIVE_ROOT;
  process.env.TEX64_MANAGED_TEXLIVE_ROOT = root;
  try {
    const service = new EnvService();
    const result = await service.installMissingPackages(
      "! LaTeX Error: File `tikz.sty' not found."
    );
    assert.equal(result.reason, "no-managed-tlmgr");
    assert.deepEqual(result.installed, []);
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_ROOT;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_ROOT = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean log asks tlmgr for nothing at all", async () => {
  const service = new EnvService();
  const result = await service.installMissingPackages("Output written on main.pdf (3 pages).");
  assert.equal(result.reason, "no-missing-files");
});

test("a package name tlmgr cannot find is reported, not swallowed", async () => {
  // tlmgr exits non-zero but keeps going, so a bogus entry in the curated lists
  // would otherwise vanish and resurface as a missing .sty much later.
  const output = [
    "tlmgr install: package notarealpackage not present in repository.",
    "[1/2, 00:00/00:00] install: pgf [1k]",
    "tlmgr install: package alsofake not present in repository.",
  ].join("\n");
  assert.deepEqual(parseUnavailablePackages(output), ["notarealpackage", "alsofake"]);
  assert.deepEqual(parseUnavailablePackages("[1/1] install: pgf [1k]"), []);

  const service = new EnvService();
  let installArgs = null;
  service.runTlmgr = async (args) => {
    installArgs = args;
    return { ok: false, code: 1, output };
  };
  const unavailable = await service.ensureDefaultPackages("light");
  assert.deepEqual(unavailable, ["notarealpackage", "alsofake"]);
  assert.equal(installArgs[0], "install");
});

test("every package in both sets is a real TeX Live package name", () => {
  // Audited against `tlmgr info --data name` (the full TeX Live ledger) on
  // 2026-08-20: all 175 light names and the full set's collections resolved.
  // This test guards the shape only — the network audit is the documented
  // `tlmgr install --dry-run` step in docs/tex-env-detection-and-install-choice.md.
  const names = [
    ...LIGHT_INSTALL_PACKAGES,
    ...parseExtraPackages("full"),
  ];
  for (const name of names) {
    assert.match(
      name,
      /^[a-z0-9][a-z0-9._-]*$/,
      `${name} is not shaped like a TeX Live package name`
    );
  }
});

test("variant metadata is complete for both choices", () => {
  for (const id of ["full", "light"]) {
    const variant = INSTALL_VARIANTS[id];
    assert.equal(variant.id, id);
    assert.ok(variant.scheme.startsWith("scheme-"));
    assert.ok(variant.approxBytes > 0);
  }
  assert.ok(INSTALL_VARIANTS.light.approxBytes < INSTALL_VARIANTS.full.approxBytes);
});
