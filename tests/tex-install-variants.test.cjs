const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EnvService,
  INSTALL_VARIANTS,
  DEFAULT_INSTALL_VARIANT,
  normalizeInstallVariant,
  extractMissingTexFiles,
  parseTlmgrSearchPackages,
  rewriteRelocatedSymlinks,
} = require("../electron/services/env.cjs");

test("new and historical lightweight targets resolve to the quick profile", () => {
  for (const name of [undefined, "basictex", "light", "tinytex", "minimal", "texlive-light"]) {
    assert.equal(normalizeInstallVariant(name), "light", String(name));
  }
  assert.equal(DEFAULT_INSTALL_VARIANT, "light");
  assert.deepEqual(Object.keys(INSTALL_VARIANTS), ["light", "full"]);
  assert.equal(INSTALL_VARIANTS.light.bundle, "TinyTeX-1");
  assert.equal(INSTALL_VARIANTS.light.scheme, "scheme-small");
});

test("only explicit full aliases resolve to scheme-full", () => {
  for (const name of ["full", "texlive-full", "scheme-full"]) {
    assert.equal(normalizeInstallVariant(name), "full", name);
  }
  assert.equal(INSTALL_VARIANTS.full.scheme, "scheme-full");
});

test("install-tl profiles remain valid for both supported variants", () => {
  const service = new EnvService();
  const light = service.buildInstallProfile("/tmp/tex64-test", "light");
  const full = service.buildInstallProfile("/tmp/tex64-test", "full");
  assert.match(light, /^selected_scheme scheme-small$/m);
  assert.match(full, /^selected_scheme scheme-full$/m);
  assert.doesNotMatch(light, /tinytex-1/);
});

test("the install marker preserves light and full profiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-marker-"));
  const previous = process.env.TEX64_MANAGED_TEXLIVE_ROOT;
  process.env.TEX64_MANAGED_TEXLIVE_ROOT = root;
  try {
    const service = new EnvService();
    assert.deepEqual(service.readInstallMarker(), {
      variant: null,
      installedAt: null,
      known: false,
    });
    service.writeInstallMarker("light");
    assert.equal(service.readInstallMarker().variant, "light");
    service.writeInstallMarker("full");
    assert.equal(service.readInstallMarker().variant, "full");
    assert.ok(service.readInstallMarker().installedAt);
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_ROOT;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_ROOT = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a light managed tree stays light until full is explicitly requested", async () => {
  const service = new EnvService();
  service.findManagedCommand = (command) =>
    ["tlmgr", "synctex"].includes(command) ? `/managed/${command}` : null;
  service.readInstallMarker = () => ({ variant: "light", installedAt: null, known: true });
  service.ensureManagedTexliveInstalled = async () => "/managed/tlmgr";
  service.runTlmgr = async () => {
    throw new Error("a light install must not expand itself");
  };
  service.checkCommand = async () => true;
  let marker = null;
  service.writeInstallMarker = (variant) => {
    marker = variant;
  };

  const result = await service.installManagedTexlive("light");

  assert.equal(marker, "light");
  assert.equal(result.variant, "light");
  assert.equal(result.success, true);
});

test("a light managed tree bootstraps the SyncTeX command", async () => {
  const service = new EnvService();
  service.findManagedCommand = (command) => (command === "tlmgr" ? "/managed/tlmgr" : null);
  service.readInstallMarker = () => ({ variant: "light", installedAt: null, known: true });
  let tlmgrCall = null;
  service.runTlmgr = async (args, options) => {
    tlmgrCall = { args, options };
    return { ok: true, code: 0, output: "" };
  };
  service.checkCommand = async () => true;
  service.writeInstallMarker = () => {};

  const result = await service.installManagedTexlive("light");

  assert.deepEqual(tlmgrCall.args, ["install", "synctex"]);
  assert.equal(tlmgrCall.options.allowFailure, false);
  assert.equal(result.success, true);
});

test("a light managed tree upgrades in place only when full is requested", async () => {
  const service = new EnvService();
  service.findManagedCommand = (command) => (command === "tlmgr" ? "/managed/tlmgr" : null);
  service.readInstallMarker = () => ({ variant: "light", installedAt: null, known: true });
  let tlmgrCall = null;
  service.runTlmgr = async (args, options) => {
    tlmgrCall = { args, options };
    return { ok: true, code: 0, output: "" };
  };
  service.checkCommand = async () => true;
  let marker = null;
  service.writeInstallMarker = (variant) => {
    marker = variant;
  };

  const result = await service.installManagedTexlive("full");

  assert.deepEqual(tlmgrCall.args, ["install", "scheme-full"]);
  assert.equal(tlmgrCall.options.allowFailure, false);
  assert.equal(marker, "full");
  assert.equal(result.variant, "full");
  assert.equal(result.success, true);
});

test("a complete tree is never downgraded by a lightweight request", async () => {
  const service = new EnvService();
  service.findManagedCommand = (command) => (command === "tlmgr" ? "/managed/tlmgr" : null);
  service.readInstallMarker = () => ({ variant: "full", installedAt: null, known: true });
  service.runTlmgr = async () => {
    throw new Error("a complete tree must not run tlmgr for a lightweight request");
  };
  service.checkCommand = async () => true;
  let marker = null;
  service.writeInstallMarker = (variant) => {
    marker = variant;
  };

  const result = await service.installManagedTexlive("light");

  assert.equal(marker, "full");
  assert.equal(result.variant, "full");
});

test("missing TeX files are extracted conservatively from compiler output", () => {
  const output = [
    "! LaTeX Error: File `physics.sty' not found.",
    "Package foo Error: File 'custom.cls' not found",
    "! I can't find file `plain.tex'.",
    'luaotfload | db : File not found: "HaranoAjiMincho-Regular.otf".',
    "Font \\JY3/mc/m/n/10=file:HaranoAjiMincho-Regular.otf:-kern not loadable",
    "! LaTeX Error: File '../unsafe.sty' not found.",
    "! LaTeX Error: File 'physics.sty' not found.",
  ].join("\n");
  assert.deepEqual(extractMissingTexFiles(output), [
    "physics.sty",
    "custom.cls",
    "plain.tex",
    "unsafe.sty",
    "HaranoAjiMincho-Regular.otf",
  ]);
});

test("tlmgr search output resolves only the package containing the exact file", () => {
  const output = [
    "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
    "physics:",
    "  texmf-dist/tex/latex/physics/physics.sty",
    "unrelated:",
    "  texmf-dist/doc/latex/physics/physics.pdf",
  ].join("\n");
  assert.deepEqual(parseTlmgrSearchPackages(output, "physics.sty"), ["physics"]);
  assert.deepEqual(parseTlmgrSearchPackages(output, "../physics.sty"), []);
});

test(
  "relocated TinyTeX links point into the managed root",
  { skip: process.platform === "win32" },
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-relocate-"));
    const extracted = path.join(base, "extracted");
    const managed = path.join(base, "managed");
    fs.mkdirSync(path.join(extracted, "texmf-dist", "scripts"), { recursive: true });
    fs.mkdirSync(path.join(managed, "bin"), { recursive: true });
    fs.writeFileSync(path.join(extracted, "texmf-dist", "scripts", "tlmgr.pl"), "");
    fs.symlinkSync(
      path.join(extracted, "texmf-dist", "scripts", "tlmgr.pl"),
      path.join(managed, "bin", "tlmgr")
    );
    fs.symlinkSync("external-target", path.join(managed, "bin", "external"));
    try {
      assert.equal(await rewriteRelocatedSymlinks(managed, extracted), 1);
      assert.equal(
        fs.readlinkSync(path.join(managed, "bin", "tlmgr")),
        path.join(managed, "texmf-dist", "scripts", "tlmgr.pl")
      );
      assert.equal(fs.readlinkSync(path.join(managed, "bin", "external")), "external-target");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
);

test("lightweight package recovery searches and installs only managed packages", async () => {
  const service = new EnvService();
  service.isManagedLightweight = () => true;
  const calls = [];
  service.runTlmgr = async (args) => {
    calls.push(args);
    if (args[0] === "search") {
      return {
        ok: true,
        code: 0,
        output: "physics:\n  texmf-dist/tex/latex/physics/physics.sty\n",
      };
    }
    return { ok: true, code: 0, output: "" };
  };

  const result = await service.installMissingPackagesFromLog(
    "! LaTeX Error: File `physics.sty' not found."
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.packages, ["physics"]);
  assert.deepEqual(calls, [
    ["search", "--global", "--file", "/physics.sty"],
    ["install", "physics"],
  ]);
});
