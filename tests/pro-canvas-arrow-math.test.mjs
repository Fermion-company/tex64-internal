// キャンバスの矢頭が TikZ (arrows.meta) の実物と同じ寸法・同じ位置になることを
// 押さえるテスト。REFERENCE の数値は推測ではなく実測値で、
//   \draw[line width=W, -{Tip}] (0,0) -- (2,0);
// を線幅ごとに pdflatex でコンパイルし、PDF のパス座標を取り出したもの（TeX pt）。
// 係数を触るときはこの手順で取り直すこと。

import test from "node:test";
import assert from "node:assert/strict";

const { arrowMetrics, arrowShape, endTangent, isArrowKind, trimPathForArrows } = await import(
  "../Resources/web/app/pro-canvas/arrow-math.js"
);

/** 実測値: [線幅, 多角形の長さ, 付け根の半幅, 切り欠き, 端点からの線の短縮量] */
const REFERENCE = {
  Stealth: [
    [0.4, 3.5815, 1.3512, 1.1790, 3.074],
    [1.0, 4.4610, 1.6885, 1.4830, 4.653],
    [2.0, 5.9194, 2.2542, 1.9942, 7.276],
  ],
  Latex: [
    [0.4, 3.7739, 1.45245, 0, 4.598],
    [1.0, 4.9388, 1.9424, 0, 7.003],
    [2.0, 6.8774, 2.7587, 0, 11.001],
  ],
  Bar: [
    [0.4, 0, 2.30085, 0, 0.300],
    [1.0, 0, 3.49965, 0, 0.749],
    [2.0, 0, 5.5016, 0, 1.503],
  ],
};

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected} (±${tolerance})`);

for (const [kind, rows] of Object.entries(REFERENCE)) {
  test(`${kind} の寸法が実測の TikZ と一致する`, () => {
    for (const [width, length, halfWidth, inset, shortening] of rows) {
      const m = arrowMetrics(kind, width);
      near(m.length, length, 0.01, `${kind} ${width}pt length`);
      near(m.halfWidth, halfWidth, 0.01, `${kind} ${width}pt halfWidth`);
      near(m.inset, inset, 0.01, `${kind} ${width}pt inset`);
      near(m.trim, shortening, 0.08, `${kind} ${width}pt trim`);
    }
  });
}

test("シーン単位への換算は寸法に比例する", () => {
  const pt = arrowMetrics("Stealth", 1), mm = arrowMetrics("Stealth", 1, 0.35146);
  for (const key of ["length", "halfWidth", "inset", "backset", "trim"]) {
    near(mm[key], pt[key] * 0.35146, 1e-9, `scaled ${key}`);
  }
});

test("縁取り後の見た目の先端がちょうど端点に載る", () => {
  // backset ぶん手前に多角形を置き、そこから (線幅/2)/sin(半角) だけ縁取りが前に出る。
  for (const kind of ["Stealth", "Latex"]) {
    const width = 1.5, m = arrowMetrics(kind, width);
    const shape = arrowShape(kind, { x: 10, y: 0 }, { x: 1, y: 0 }, m);
    const tipX = Number(shape.d.slice(2).split(",")[0]);
    near(tipX, 10 - m.backset, 1e-9, `${kind} polygon tip`);
    const edge = kind === "Latex"
      ? { along: m.length * 0.123, across: m.halfWidth * 0.078 }
      : { along: m.length, across: m.halfWidth };
    const miter = (width / 2) * Math.hypot(edge.along, edge.across) / edge.across;
    near(tipX + miter, 10, 1e-6, `${kind} stroked tip lands on the end point`);
  }
});

test("Bar は塗らずに線で描く／他は塗る", () => {
  const dir = { x: 1, y: 0 };
  assert.equal(arrowShape("Bar", { x: 0, y: 0 }, dir, arrowMetrics("Bar", 1)).filled, false);
  assert.equal(arrowShape("Stealth", { x: 0, y: 0 }, dir, arrowMetrics("Stealth", 1)).filled, true);
  assert.equal(arrowShape("Latex", { x: 0, y: 0 }, dir, arrowMetrics("Latex", 1)).filled, true);
});

test("向きが潰れている矢頭は描かない", () => {
  assert.equal(arrowShape("Stealth", { x: 0, y: 0 }, { x: 0, y: 0 }, arrowMetrics("Stealth", 1)), null);
});

test("isArrowKind は既知の矢頭だけを通す", () => {
  assert.ok(isArrowKind("Stealth") && isArrowKind("Latex") && isArrowKind("Bar"));
  assert.ok(!isArrowKind("") && !isArrowKind(undefined) && !isArrowKind("stealth"));
});

test("直線は矢頭に隠れる分だけ縮む（向きは変わらない）", () => {
  const path = { start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 100, y: 0 } }] };
  const trimmed = trimPathForArrows(path, 3, 7);
  assert.deepEqual(trimmed.start, { x: 3, y: 0 });
  assert.deepEqual(trimmed.segments[0].to, { x: 93, y: 0 });
  assert.deepEqual(path.segments[0].to, { x: 100, y: 0 }); // 元は壊さない
});

test("短すぎる線は縮めない（消えるより残すほうがまし）", () => {
  const path = { start: { x: 0, y: 0 }, segments: [{ type: "line", to: { x: 2, y: 0 } }] };
  const trimmed = trimPathForArrows(path, 0, 5);
  assert.deepEqual(trimmed.segments[0].to, { x: 2, y: 0 });
});

test("曲線を縮めても元の曲線の上に載ったまま", () => {
  const seg = { type: "cubic", c1: { x: 20, y: 60 }, c2: { x: 60, y: -40 }, to: { x: 90, y: 20 } };
  const path = { start: { x: 0, y: 0 }, segments: [seg] };
  const trimmed = trimPathForArrows(path, 0, 8);
  const at = (t) => {
    const u = 1 - t;
    return {
      x: u ** 3 * 0 + 3 * u * u * t * seg.c1.x + 3 * u * t * t * seg.c2.x + t ** 3 * seg.to.x,
      y: u ** 3 * 0 + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t ** 3 * seg.to.y,
    };
  };
  const end = trimmed.segments[0].to;
  let best = Infinity;
  for (let i = 0; i <= 2000; i += 1) {
    const p = at(i / 2000);
    best = Math.min(best, Math.hypot(p.x - end.x, p.y - end.y));
  }
  near(best, 0, 0.02, "trimmed end stays on the original curve");
});

test("端点の接線は潰れた制御点を読み飛ばす", () => {
  const path = {
    start: { x: 0, y: 0 },
    segments: [{ type: "cubic", c1: { x: 0, y: 0 }, c2: { x: 5, y: 5 }, to: { x: 10, y: 0 } }],
  };
  const start = endTangent(path, "start");
  assert.ok(Math.hypot(start.x, start.y) > 0);
  assert.deepEqual(endTangent(path, "end"), { x: 5, y: -5 });
  assert.equal(endTangent({ start: { x: 0, y: 0 }, segments: [] }, "end"), null);
});
