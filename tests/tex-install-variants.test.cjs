const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EnvService,
  INSTALL_VARIANTS,
  normalizeInstallVariant,
} = require("../electron/services/env.cjs");

test("every current and historical install target resolves to scheme-full", () => {
  for (const name of [
    undefined,
    "full",
    "texlive-full",
    "scheme-full",
    "basictex",
    "light",
    "tinytex",
    "minimal",
  ]) {
    assert.equal(normalizeInstallVariant(name), "full", String(name));
  }
  assert.deepEqual(Object.keys(INSTALL_VARIANTS), ["full"]);
  assert.equal(INSTALL_VARIANTS.full.scheme, "scheme-full");
});

test("the install profile always selects scheme-full", () => {
  const service = new EnvService();
  for (const legacyVariant of [undefined, "full", "light", "basictex"]) {
    const profile = service.buildInstallProfile("/tmp/tex64-test", legacyVariant);
    assert.match(profile, /^selected_scheme scheme-full$/m);
    assert.doesNotMatch(profile, /scheme-infraonly/);
  }
});

test("the install marker records the normalized full profile", () => {
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
    const marker = service.readInstallMarker();
    assert.equal(marker.variant, "full");
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

test("a retired light marker remains visible for the one-time full upgrade", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-legacy-marker-"));
  const previous = process.env.TEX64_MANAGED_TEXLIVE_ROOT;
  process.env.TEX64_MANAGED_TEXLIVE_ROOT = root;
  try {
    fs.writeFileSync(
      path.join(root, "tex64-install.json"),
      JSON.stringify({ variant: "light", installedAt: "2026-08-19T00:00:00.000Z" })
    );
    const service = new EnvService();
    assert.equal(service.readInstallMarker().variant, "light");
  } finally {
    if (previous === undefined) {
      delete process.env.TEX64_MANAGED_TEXLIVE_ROOT;
    } else {
      process.env.TEX64_MANAGED_TEXLIVE_ROOT = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a retired partial tree is upgraded with scheme-full before being marked full", async () => {
  const service = new EnvService();
  service.findManagedCommand = (command) => (command === "tlmgr" ? "/managed/tlmgr" : null);
  service.readInstallMarker = () => ({ variant: "light", installedAt: null, known: true });
  service.ensureManagedTexliveInstalled = async () => {
    throw new Error("an existing tree must be upgraded in place");
  };
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

  const result = await service.installManagedTexlive("light");

  assert.deepEqual(tlmgrCall.args, ["install", "scheme-full"]);
  assert.equal(tlmgrCall.options.allowFailure, false);
  assert.equal(marker, "full");
  assert.equal(result.variant, "full");
  assert.equal(result.success, true);
});
