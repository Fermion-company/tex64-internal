import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  RegionMapSchema,
  buildRegionMap,
  type NodeLineRange,
  type RegionMap,
} from "@/server/compiler/synctex-regions";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/synctex/", import.meta.url));
const probeSynctex = readFileSync(path.join(fixtureDirectory, "probe.synctex"));
const expectedProbeRegions = JSON.parse(
  readFileSync(path.join(fixtureDirectory, "probe.expected.json"), "utf8"),
) as RegionMap;

// Content-line ranges for the markers in probe.tex ([B+1, E-1], markers excluded).
const PROBE_RANGES: readonly NodeLineRange[] = [
  { id: "node-1", start: 5, end: 5 },
  { id: "node-2", start: 9, end: 11 },
  { id: "node-3", start: 15, end: 15 },
];

function syntheticSynctex(box: { height: number; depth: number }): Buffer {
  return Buffer.from(
    [
      "SyncTeX Version:1",
      "Input:2:/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls",
      "Output:pdf",
      "Magnification:1000",
      "Unit:1",
      "X Offset:0",
      "Y Offset:0",
      "Content:",
      "!100",
      "{1",
      "[1,1:0,0:26607616,44616926,0",
      "Input:1:/tmp/anywhere/./main.tex",
      `(1,1:65536,655360:6553600,${box.height},${box.depth}`,
      "x1,3:100000,655360",
      ")",
      "]",
      "}1",
      "Postamble:",
      "Count:5",
    ].join("\n"),
  );
}

describe("buildRegionMap", () => {
  it("resolves contaminated lualatex records by per-line-box majority voting", () => {
    const map = buildRegionMap({ synctex: probeSynctex, ranges: PROBE_RANGES });

    expect(map).not.toBeNull();
    expect(RegionMapSchema.safeParse(map).success).toBe(true);
    // node-1's four line boxes all open as "(1,7:" (the paragraph-end line,
    // outside every range) and contain lua-contaminated x1,17 / k470,* records;
    // majority voting over in-range fine records resolves them to node-1 and
    // merging collapses the four strips into one rect. node-3's line box opens
    // as "(1,17:" and is recovered from its x1,15 records. The header and
    // page-number footer boxes collect zero in-range votes and are dropped.
    expect(map).toEqual(expectedProbeRegions);
    expect(map?.nodes.map((node) => node.id)).toEqual(["node-1", "node-2", "node-3"]);
    expect(map?.nodes[0]?.rects).toHaveLength(1);
  });

  it("round-trips a gzip-compressed synctex file", () => {
    const map = buildRegionMap({ synctex: gzipSync(probeSynctex), ranges: PROBE_RANGES });
    expect(map).toEqual(expectedProbeRegions);
  });

  it("routes \\par blank-line votes to the preceding node via source aliases", () => {
    // With the compiled source available, votes recorded on blank lines (where
    // \par fires) alias to the nearest preceding content line. node-1's boxes
    // then carry their full vote mass in-range, so the region map is at least
    // as complete as the alias-less one, and the stray-box guard (active only
    // with aliases) must not drop any node.
    const probeSource = readFileSync(path.join(fixtureDirectory, "probe.tex"), "utf8");
    const aliased = buildRegionMap({
      synctex: probeSynctex,
      ranges: PROBE_RANGES,
      sourceText: probeSource,
    });
    const plain = buildRegionMap({ synctex: probeSynctex, ranges: PROBE_RANGES });

    expect(aliased).not.toBeNull();
    expect(RegionMapSchema.safeParse(aliased).success).toBe(true);
    expect(aliased?.nodes.map((node) => node.id)).toEqual([
      "node-1",
      "node-2",
      "node-3",
    ]);
    for (const node of plain?.nodes ?? []) {
      const counterpart = aliased?.nodes.find((item) => item.id === node.id);
      expect(counterpart).toBeDefined();
      expect(counterpart?.rects.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("accepts Input records that appear after Content", () => {
    // Input:1 for main.tex appears mid-body, after the first vbox opened.
    const map = buildRegionMap({
      synctex: syntheticSynctex({ height: 327680, depth: 65536 }),
      ranges: [{ id: "node", start: 3, end: 3 }],
    });
    expect(map).toEqual({
      schemaVersion: 1,
      nodes: [{ id: "node", rects: [{ page: 1, x: 1, y: 4.98, width: 99.63, height: 5.98 }] }],
    });
  });

  it("matches the main file by basename with ./ normalization", () => {
    const map = buildRegionMap({
      synctex: syntheticSynctex({ height: 327680, depth: 65536 }),
      ranges: [{ id: "node", start: 3, end: 3 }],
      mainFileName: "./main.tex",
    });
    expect(map?.nodes).toHaveLength(1);

    const other = buildRegionMap({
      synctex: syntheticSynctex({ height: 327680, depth: 65536 }),
      ranges: [{ id: "node", start: 3, end: 3 }],
      mainFileName: "other.tex",
    });
    expect(other).toEqual({ schemaVersion: 1, nodes: [] });
  });

  it("returns null on malformed input", () => {
    expect(buildRegionMap({ synctex: Buffer.from("not a synctex file"), ranges: PROBE_RANGES })).toBeNull();
    expect(buildRegionMap({ synctex: Buffer.from(""), ranges: PROBE_RANGES })).toBeNull();
    // gzip magic followed by garbage
    expect(
      buildRegionMap({ synctex: Buffer.from([0x1f, 0x8b, 0x01, 0x02, 0x03]), ranges: PROBE_RANGES }),
    ).toBeNull();
    // truncated body: sheet and boxes still open at end of file
    const truncated = probeSynctex.toString("utf8").split("\n").slice(0, 40).join("\n");
    expect(buildRegionMap({ synctex: Buffer.from(truncated), ranges: PROBE_RANGES })).toBeNull();
    // stray hbox close where no hbox is open
    const strayClose = syntheticSynctex({ height: 327680, depth: 65536 })
      .toString("utf8")
      .replace("x1,3:100000,655360", ")");
    expect(buildRegionMap({ synctex: Buffer.from(strayClose), ranges: PROBE_RANGES })).toBeNull();
  });

  it("rejects oversized or invalid region maps via RegionMapSchema", () => {
    const rect = { page: 1, x: 0, y: 0, width: 10, height: 10 };
    const valid: RegionMap = { schemaVersion: 1, nodes: [{ id: "a", rects: [rect] }] };
    expect(RegionMapSchema.safeParse(valid).success).toBe(true);

    const tooManyNodes = {
      schemaVersion: 1,
      nodes: Array.from({ length: 10_001 }, (_, index) => ({ id: `n${index}`, rects: [] })),
    };
    expect(RegionMapSchema.safeParse(tooManyNodes).success).toBe(false);

    const tooManyRects = {
      schemaVersion: 1,
      nodes: [{ id: "a", rects: Array.from({ length: 201 }, () => rect) }],
    };
    expect(RegionMapSchema.safeParse(tooManyRects).success).toBe(false);

    const invalids = [
      { schemaVersion: 2, nodes: [] },
      { schemaVersion: 1, nodes: [{ id: "", rects: [rect] }] },
      { schemaVersion: 1, nodes: [{ id: "a", rects: [{ ...rect, x: -1 }] }] },
      { schemaVersion: 1, nodes: [{ id: "a", rects: [{ ...rect, y: Number.POSITIVE_INFINITY }] }] },
      { schemaVersion: 1, nodes: [{ id: "a", rects: [{ ...rect, page: 1.5 }] }] },
      { schemaVersion: 1, nodes: [{ id: "a", rects: [{ ...rect, page: 0 }] }] },
    ];
    for (const candidate of invalids) {
      expect(RegionMapSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("assigns lines to the innermost enclosing range when ranges nest", () => {
    const nested: readonly NodeLineRange[] = [{ id: "outer", start: 5, end: 15 }, ...PROBE_RANGES];
    const map = buildRegionMap({ synctex: probeSynctex, ranges: nested });
    // The inner nodes win every line they cover; "outer" only ever collects the
    // stray line-7 \par votes, which never reach majority inside any line box,
    // so it produces no rect and is omitted from the map.
    expect(map).toEqual(expectedProbeRegions);
  });

  it("drops line boxes with no vertical extent", () => {
    const zeroHeight = buildRegionMap({
      synctex: syntheticSynctex({ height: 0, depth: 0 }),
      ranges: [{ id: "node", start: 3, end: 3 }],
    });
    expect(zeroHeight).toEqual({ schemaVersion: 1, nodes: [] });

    // The probe contains a genuine "(1,9:...:23592960,0,0" box whose votes fall
    // inside node-2's range; dropping it leaves node-2 with the equation rect only.
    const map = buildRegionMap({ synctex: probeSynctex, ranges: PROBE_RANGES });
    expect(map?.nodes.find((node) => node.id === "node-2")?.rects).toHaveLength(1);
  });

  it("returns an empty map for empty ranges", () => {
    expect(buildRegionMap({ synctex: probeSynctex, ranges: [] })).toEqual({
      schemaVersion: 1,
      nodes: [],
    });
  });
});
