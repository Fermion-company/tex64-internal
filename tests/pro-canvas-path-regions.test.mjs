import assert from "node:assert/strict";
import test from "node:test";
import { enclosedRegionAt, enclosedRegions, intersectionRegions } from "../Resources/web/app/pro-canvas/path-regions.js";
import { generateTikz } from "../Resources/web/app/pro-canvas/tikz-generate.js";

const line = (to) => ({ type: "line", to });

test("three crossings create the two bounded regions between paths", () => {
  const baseline = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })], closed: false };
  const wave = {
    start: { x: 0, y: -1 },
    segments: [line({ x: 2, y: 1 }), line({ x: 5, y: -1 }), line({ x: 8, y: 1 }), line({ x: 10, y: 1 })],
    closed: false,
  };

  const before = JSON.stringify([baseline, wave]);
  const regions = intersectionRegions(baseline, wave);

  assert.equal(regions.length, 2);
  assert.ok(regions.every(region => region.closed && region.segments.length >= 3));
  assert.equal(JSON.stringify([baseline, wave]), before, "source paths stay untouched");
});

test("a line and cubic retain the cubic boundary in the generated region", () => {
  const baseline = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })], closed: false };
  const arch = {
    start: { x: 0, y: -1 },
    segments: [{ type: "cubic", c1: { x: 2, y: 4 }, c2: { x: 8, y: 4 }, to: { x: 10, y: -1 } }],
    closed: false,
  };

  const regions = intersectionRegions(baseline, arch);

  assert.equal(regions.length, 1);
  assert.ok(regions[0].segments.some(segment => segment.type === "cubic"));
  assert.ok(Math.hypot(
    regions[0].segments.at(-1).to.x - regions[0].start.x,
    regions[0].segments.at(-1).to.y - regions[0].start.y,
  ) < 1e-7);
});

test("fewer than two crossings do not create a region", () => {
  const horizontal = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })], closed: false };
  const vertical = { start: { x: 5, y: -5 }, segments: [line({ x: 5, y: 5 })], closed: false };
  assert.deepEqual(intersectionRegions(horizontal, vertical), []);
});

test("source selection order does not change the number of regions", () => {
  const baseline = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })], closed: false };
  const wave = {
    start: { x: 0, y: -1 },
    segments: [line({ x: 2, y: 1 }), line({ x: 5, y: -1 }), line({ x: 8, y: 1 })],
    closed: false,
  };
  assert.equal(intersectionRegions(baseline, wave).length, 2);
  assert.equal(intersectionRegions(wave, baseline).length, 2);
});

test("generated regions compile to closed patterned TikZ paths", () => {
  const baseline = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })], closed: false };
  const wave = {
    start: { x: 0, y: -1 },
    segments: [line({ x: 2, y: 1 }), line({ x: 5, y: -1 }), line({ x: 8, y: 1 })],
    closed: false,
  };
  const regions = intersectionRegions(baseline, wave);
  const output = generateTikz({
    v: 1, unit: "mm", width: 100, height: 100,
    grid: { size: 5, snap: true }, styles: [],
    objects: regions.map((region, index) => ({
      id: `region-${index}`, type: "path", ...region,
      style: { props: { draw: null, fill: "#d9f99d", pattern: { name: "north east lines" } } },
    })),
  });

  assert.match(output.code, /\\usetikzlibrary\{patterns\}/);
  assert.equal((output.code.match(/-- cycle;/g) || []).length, 2);
  assert.match(output.code, /pattern=north east lines/);
});

test("paint regions can be enclosed by three separately drawn lines", () => {
  const boundaries = [
    { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })] },
    { start: { x: 10, y: 0 }, segments: [line({ x: 5, y: 8 })] },
    { start: { x: 5, y: 8 }, segments: [line({ x: 0, y: 0 })] },
  ];
  const regions = enclosedRegions(boundaries);
  const picked = enclosedRegionAt(regions, { x: 5, y: 2 });
  assert.ok(picked, "the triangle interior is clickable without selecting its three lines");
  assert.equal(picked.closed, true);
  assert.equal(picked.segments.length, 3);
  assert.equal(enclosedRegionAt(regions, { x: 20, y: 20 }), null);
});

test("paint region hit testing chooses the clicked side between two crossing paths", () => {
  const baseline = { start: { x: 0, y: 0 }, segments: [line({ x: 10, y: 0 })] };
  const wave = {
    start: { x: 0, y: -1 },
    segments: [line({ x: 2, y: 1 }), line({ x: 5, y: -1 }), line({ x: 8, y: 1 }), line({ x: 10, y: 1 })],
  };
  const regions = enclosedRegions([baseline, wave]);
  assert.equal(regions.length, 2);
  const left = enclosedRegionAt(regions, { x: 1.6, y: 0.2 });
  const right = enclosedRegionAt(regions, { x: 5, y: -0.2 });
  assert.ok(left && right);
  assert.notDeepEqual(left.start, right.start);
});

test("a closed curved boundary is directly available to the paint tool", () => {
  const circle = {
    start: { x: 10, y: 5 }, closed: true,
    segments: [
      { type: "cubic", c1: { x: 10, y: 7.76 }, c2: { x: 7.76, y: 10 }, to: { x: 5, y: 10 } },
      { type: "cubic", c1: { x: 2.24, y: 10 }, c2: { x: 0, y: 7.76 }, to: { x: 0, y: 5 } },
      { type: "cubic", c1: { x: 0, y: 2.24 }, c2: { x: 2.24, y: 0 }, to: { x: 5, y: 0 } },
      { type: "cubic", c1: { x: 7.76, y: 0 }, c2: { x: 10, y: 2.24 }, to: { x: 10, y: 5 } },
    ],
  };
  const regions = enclosedRegions([circle]);
  assert.equal(regions.length, 1);
  assert.ok(enclosedRegionAt(regions, { x: 5, y: 5 }));
  assert.equal(enclosedRegionAt(regions, { x: 11, y: 5 }), null);
});
