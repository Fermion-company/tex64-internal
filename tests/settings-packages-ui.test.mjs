import test from "node:test";
import assert from "node:assert/strict";
import {
  countPackages,
  formatBytes,
  rankPackages,
  scorePackage,
} from "../Resources/web/app/settings-packages-ui.js";

const pkg = (name, installed, sizeBytes = 0, shortdesc = "", kind = "package") => ({
  name,
  installed,
  sizeBytes,
  shortdesc,
  kind,
});

const CATALOG = [
  pkg("tikz-cd", false, 360448, "Create commutative diagrams with TikZ"),
  pkg("pgf", true, 20783104, "Create PostScript and PDF graphics in TeX"),
  pkg("tikzfill", true, 1258291, "Fill shapes with images and patterns"),
  pkg("tikz-3dplot", false, 98304, "Coordinate transformation styles for 3d plotting"),
  pkg("siunitx", true, 2396160, "A comprehensive (SI) units package"),
  pkg("collection-pictures", true, 0, "Graphics, pictures, diagrams", "collection"),
];

test("sizes are written the way a person reads them", () => {
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(360448), "352 KB");
  assert.equal(formatBytes(2396160), "2.3 MB");
  assert.equal(formatBytes(20783104), "20 MB");
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), "5.0 GB");
  assert.equal(formatBytes(Number.NaN), "");
});

test("an exact name beats a prefix, which beats a substring, which beats the description", () => {
  const exact = scorePackage(pkg("tikz", false), "tikz");
  const prefix = scorePackage(pkg("tikz-cd", false), "tikz");
  const substring = scorePackage(pkg("my-tikz-helper", false), "tikz");
  const desc = scorePackage(pkg("pgf", false, 0, "TikZ frontend"), "tikz");
  assert.ok(exact > prefix, "exact should win");
  assert.ok(prefix > substring, "prefix should beat substring");
  assert.ok(substring > desc, "a name hit should beat a description hit");
  assert.equal(scorePackage(pkg("unrelated", false, 0, "nothing"), "tikz"), null);
});

test("a shorter prefix match ranks above a longer one", () => {
  const short = scorePackage(pkg("tikz-cd", false), "tikz");
  const long = scorePackage(pkg("tikz-page-attachment", false), "tikz");
  assert.ok(short > long);
});

test("searching finds the thing you typed, first", () => {
  const { rows } = rankPackages(CATALOG, "tikz", "all");
  assert.equal(rows[0].name, "tikz-cd", `got ${rows.map((r) => r.name).join(", ")}`);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["tikz-cd", "tikzfill", "tikz-3dplot"]
  );
});

test("the description is searched too, so you can find a package you cannot name", () => {
  const { rows } = rankPackages(CATALOG, "commutative", "all");
  assert.deepEqual(rows.map((row) => row.name), ["tikz-cd"]);
  const units = rankPackages(CATALOG, "units", "all");
  assert.deepEqual(units.rows.map((row) => row.name), ["siunitx"]);
});

test("the filters separate what you have from what you could have", () => {
  const installed = rankPackages(CATALOG, "", "installed");
  assert.equal(installed.rows.every((row) => row.installed), true);
  assert.equal(installed.total, 4);
  const available = rankPackages(CATALOG, "", "available");
  assert.equal(available.rows.every((row) => !row.installed), true);
  assert.equal(available.total, 2);
  // A filter applies to the search too, not only to the full list.
  const availableTikz = rankPackages(CATALOG, "tikz", "available");
  assert.deepEqual(availableTikz.rows.map((row) => row.name), ["tikz-cd", "tikz-3dplot"]);
});

test("with no search, what you already have comes first", () => {
  const { rows } = rankPackages(CATALOG, "", "all");
  const firstNotInstalled = rows.findIndex((row) => !row.installed);
  const lastInstalled = rows.map((row) => row.installed).lastIndexOf(true);
  assert.ok(firstNotInstalled > lastInstalled, "installed packages should lead the list");
});

test("the list is capped, and says how much it is hiding", () => {
  const many = Array.from({ length: 500 }, (_, i) => pkg(`pkg-${i}`, i % 2 === 0));
  const { rows, total } = rankPackages(many, "pkg", "all", 120);
  assert.equal(rows.length, 120);
  assert.equal(total, 500);
});

test("counts drive the filter chips", () => {
  assert.deepEqual(countPackages(CATALOG), { all: 6, installed: 4, available: 2 });
  assert.deepEqual(countPackages([]), { all: 0, installed: 0, available: 0 });
});

test("collections and schemes stay searchable rather than being hidden", () => {
  const { rows } = rankPackages(CATALOG, "collection", "all");
  assert.equal(rows[0].name, "collection-pictures");
  assert.equal(rows[0].kind, "collection");
});
