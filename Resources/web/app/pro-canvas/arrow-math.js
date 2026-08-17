// キャンバスの矢頭を TikZ (arrows.meta) の実物に合わせるための寸法と形。
//
// 係数は当て推量ではなく実測値: `\draw[line width=W, -{Tip}]` を線幅
// 0.4/0.8/1.0/1.5/2.0pt でコンパイルし、PDF のパスを取り出して最小二乗で
// `寸法 = 定数 + 係数 × 線幅` に当てたもの（残差 ≤ 0.003pt）。
//
// TikZ の矢頭は「多角形を塗る」だけでなく「同じ線幅で縁取る」ので、見た目は
// 多角形より線幅ぶん太い。縁取りを省くと線幅 1pt で針のように見えるため、
// 描画側は必ず fill と stroke の両方を掛けること。
// あわせて TikZ は矢頭の手前で線を止める（`trim`）。止めないと Stealth の
// 切り欠きが線で埋まってしまう。
const METRICS = {
    Stealth: { length: [3, 1.461], halfWidth: [1.125, 0.564], inset: [0.975, 0.509] },
    Latex: { length: [3, 1.939], halfWidth: [1.126, 0.817], inset: [0, 0] },
    Bar: { length: [0, 0], halfWidth: [1.5, 2], inset: [0, 0] },
};
/** Latex の反った側面（実測したベジエ制御点。先端からの距離と半幅の比）。 */
const LATEX_CURVE = { c1: { along: 0.123, across: 0.078 }, c2: { along: 0.663, across: 0.520 } };
export const isArrowKind = (value) => value === "Stealth" || value === "Latex" || value === "Bar";
/**
 * 矢頭の寸法。`unitPerPt` はシーン単位／pt（mm なら 0.35146）で、返り値は
 * すべてシーン単位。pt のまま欲しければ 1 を渡す。
 */
export const arrowMetrics = (kind, lineWidthPt, unitPerPt = 1) => {
    const spec = METRICS[kind];
    const at = ([base, factor]) => (base + factor * lineWidthPt) * unitPerPt;
    const length = at(spec.length), halfWidth = at(spec.halfWidth), inset = at(spec.inset);
    const half = lineWidthPt * unitPerPt / 2;
    // 縁取りが先端でどれだけ前に出るか＝(線幅/2)/sin(先端の半角)。Bar には尖りが
    // ないので線幅の半分。ここを引かないと矢印全体が端点より前にはみ出す。
    const edge = kind === "Latex"
        ? { along: length * LATEX_CURVE.c1.along, across: halfWidth * LATEX_CURVE.c1.across }
        : { along: length, across: halfWidth };
    const backset = kind === "Bar" || !(edge.across > 0)
        ? half
        : half * Math.hypot(edge.along, edge.across) / edge.across;
    // 線を止める位置（多角形の先端から測って）。TikZ は Stealth なら切り欠きの
    // さらに線幅 1/4 手前、Latex なら付け根ちょうど、Bar なら棒の線幅 1/4 手前。
    const behindTip = kind === "Latex" ? length : (kind === "Stealth" ? length - inset : 0) + half / 2;
    return { length, halfWidth, inset, backset, trim: backset + behindTip };
};
/**
 * 矢頭の SVG パス。`endPoint` はパスの端点（矢頭は backset ぶん手前に置かれる）、
 * `direction` は先端へ向かう向き（正規化不要）。
 * `filled` が false（Bar）のときは塗らずに線幅で描く。
 */
export const arrowShape = (kind, endPoint, direction, metrics) => {
    const length = Math.hypot(direction.x, direction.y);
    if (!(length > 1e-9))
        return null;
    const ux = direction.x / length, uy = direction.y / length, px = -uy, py = ux;
    const tip = { x: endPoint.x - ux * metrics.backset, y: endPoint.y - uy * metrics.backset };
    const at = (along, across) => `${tip.x - ux * along + px * across},${tip.y - uy * along + py * across}`;
    const { length: al, halfWidth: aw, inset } = metrics;
    if (kind === "Bar")
        return { d: `M ${at(0, aw)} L ${at(0, -aw)}`, filled: false };
    if (kind === "Stealth") {
        return { d: `M ${at(0, 0)} L ${at(al, aw)} L ${at(al - inset, 0)} L ${at(al, -aw)} Z`, filled: true };
    }
    const c1 = LATEX_CURVE.c1, c2 = LATEX_CURVE.c2;
    return {
        d: `M ${at(0, 0)} C ${at(al * c1.along, aw * c1.across)} ${at(al * c2.along, aw * c2.across)} ${at(al, aw)}`
            + ` L ${at(al, -aw)} C ${at(al * c2.along, -aw * c2.across)} ${at(al * c1.along, -aw * c1.across)} ${at(0, 0)} Z`,
        filled: true,
    };
};
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cubicAt = (from, seg, t) => {
    const u = 1 - t;
    return {
        x: u * u * u * from.x + 3 * u * u * t * seg.c1.x + 3 * u * t * t * seg.c2.x + t * t * t * seg.to.x,
        y: u * u * u * from.y + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t * t * t * seg.to.y,
    };
};
/** 折れ線近似での長さ（曲線は 32 分割）。 */
const segmentLength = (from, seg) => {
    if (seg.type === "line")
        return Math.hypot(seg.to.x - from.x, seg.to.y - from.y);
    let total = 0, previous = from;
    for (let i = 1; i <= 32; i += 1) {
        const point = cubicAt(from, seg, i / 32);
        total += Math.hypot(point.x - previous.x, point.y - previous.y);
        previous = point;
    }
    return total;
};
/** 始点から測って弧長 `distance` になる位置のパラメータ t。 */
const parameterAtLength = (from, seg, distance) => {
    if (seg.type === "line") {
        const total = segmentLength(from, seg);
        return total > 0 ? distance / total : 0;
    }
    let walked = 0, previous = from;
    for (let i = 1; i <= 32; i += 1) {
        const t = i / 32, point = cubicAt(from, seg, t), step = Math.hypot(point.x - previous.x, point.y - previous.y);
        if (walked + step >= distance)
            return step > 0 ? (i - 1 + (distance - walked) / step) / 32 : t;
        walked += step;
        previous = point;
    }
    return 1;
};
const splitAt = (from, seg, t) => {
    if (seg.type === "line") {
        const mid = lerp(from, seg.to, t);
        return [{ type: "line", to: mid }, { type: "line", to: { ...seg.to } }];
    }
    const a = lerp(from, seg.c1, t), b = lerp(seg.c1, seg.c2, t), c = lerp(seg.c2, seg.to, t);
    const d = lerp(a, b, t), e = lerp(b, c, t), mid = lerp(d, e, t);
    return [{ type: "cubic", c1: a, c2: d, to: mid }, { type: "cubic", c1: e, c2: c, to: { ...seg.to } }];
};
/**
 * 矢頭に隠れる分だけ両端を詰めたパスを返す（元のパスは変更しない）。
 * 詰めるとセグメントが消えてしまうほど短いときは、その端は詰めない
 * ——短い線でも「線が消えた」ように見えないほうがましなので。
 */
export const trimPathForArrows = (path, startTrim, endTrim) => {
    const segments = path.segments.slice();
    let start = path.start;
    if (!segments.length)
        return { start, segments };
    if (endTrim > 0) {
        const index = segments.length - 1, seg = segments[index];
        const from = index === 0 ? start : segments[index - 1].to;
        const total = segmentLength(from, seg);
        if (total > endTrim * 1.05) {
            segments[index] = splitAt(from, seg, parameterAtLength(from, seg, total - endTrim))[0];
        }
    }
    if (startTrim > 0) {
        const seg = segments[0], total = segmentLength(start, seg);
        if (total > startTrim * 1.05) {
            const [head, rest] = splitAt(start, seg, parameterAtLength(start, seg, startTrim));
            start = head.to; // 前半の終点＝切った点が、新しい始点。
            segments[0] = rest;
        }
    }
    return { start, segments };
};
/** 端点での接線（先端へ向かう向き）。曲線では退化した制御点を読み飛ばす。 */
export const endTangent = (path, end) => {
    const segments = path.segments;
    if (!segments.length)
        return null;
    const candidates = [];
    if (end === "start") {
        const first = segments[0], to = path.start;
        if (first.type === "cubic")
            candidates.push(sub(to, first.c1), sub(to, first.c2));
        candidates.push(sub(to, first.to));
    }
    else {
        const last = segments[segments.length - 1], to = last.to;
        const before = segments.length > 1 ? segments[segments.length - 2].to : path.start;
        if (last.type === "cubic")
            candidates.push(sub(to, last.c2), sub(to, last.c1));
        candidates.push(sub(to, before));
    }
    return candidates.find((v) => Math.hypot(v.x, v.y) > 1e-9) || null;
};
