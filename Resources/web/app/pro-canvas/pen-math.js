/**
 * 既存の開いたパスの続きを描くための、末尾アンカーの疑似ノード。
 * 最後のセグメントの出ハンドルを鏡写しにして持たせることで、続きが
 * 折れずに繋がる（直線で終わっているパスは角として続ける）。
 * 既存セグメントには触らない（append 専用）ので、元の曲線は歪まない。
 */
export const penSeedFromEnd = (path) => {
    const last = path.segments[path.segments.length - 1];
    if (!last)
        return { p: { ...path.start }, kind: "corner", out: null };
    if (last.type !== "cubic")
        return { p: { ...last.to }, kind: "corner", out: null };
    const out = { x: last.to.x - last.c2.x, y: last.to.y - last.c2.y };
    return Math.hypot(out.x, out.y) < 1e-9
        ? { p: { ...last.to }, kind: "corner", out: null }
        : { p: { ...last.to }, kind: "manual", out };
};
export const penSegmentFor = (prev, lastOut, anchor, handle) => {
    var _a, _b, _c, _d;
    if (!lastOut && !handle)
        return { type: "line", to: { ...anchor } };
    return { type: "cubic", c1: { x: prev.x + ((_a = lastOut === null || lastOut === void 0 ? void 0 : lastOut.x) !== null && _a !== void 0 ? _a : 0), y: prev.y + ((_b = lastOut === null || lastOut === void 0 ? void 0 : lastOut.y) !== null && _b !== void 0 ? _b : 0) }, c2: { x: anchor.x - ((_c = handle === null || handle === void 0 ? void 0 : handle.x) !== null && _c !== void 0 ? _c : 0), y: anchor.y - ((_d = handle === null || handle === void 0 ? void 0 : handle.y) !== null && _d !== void 0 ? _d : 0) }, to: { ...anchor } };
};
// centripetal（α=.5）Catmull-Rom。一様版は弦長が不均一だと短い弦を隣の長い弦が支配して overshoot/loop する。
export const buildPenSegments = (nodes, closed) => {
    if (nodes.length < 2)
        return [];
    const n = nodes.length, count = closed ? n : n - 1;
    const at = (i) => nodes[(i + n) % n].p;
    const dt = (i) => Math.sqrt(Math.max(Math.hypot(at(i + 1).x - at(i).x, at(i + 1).y - at(i).y), 1e-9));
    const velocity = (i) => {
        if (nodes[i].kind !== "auto")
            return null;
        const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
        if (!hasPrev && !hasNext)
            return null;
        const dPrev = hasPrev ? dt(i - 1) : 0, dNext = hasNext ? dt(i) : 0;
        const sPrev = hasPrev ? { x: (at(i).x - at(i - 1).x) / dPrev, y: (at(i).y - at(i - 1).y) / dPrev } : null;
        const sNext = hasNext ? { x: (at(i + 1).x - at(i).x) / dNext, y: (at(i + 1).y - at(i).y) / dNext } : null;
        if (sPrev && sNext) {
            const w = dPrev + dNext;
            return { x: (sPrev.x * dNext + sNext.x * dPrev) / w, y: (sPrev.y * dNext + sNext.y * dPrev) / w };
        }
        return sPrev || sNext;
    };
    const segments = [];
    for (let i = 0; i < count; i++) {
        const a = nodes[i], b = nodes[(i + 1) % n], d = dt(i), va = velocity(i), vb = velocity((i + 1) % n);
        const outA = a.kind === "manual" ? a.out : va ? { x: va.x * d / 3, y: va.y * d / 3 } : null;
        const inB = b.kind === "manual" ? b.out : vb ? { x: vb.x * d / 3, y: vb.y * d / 3 } : null;
        if (!outA && !inB) {
            segments.push({ type: "line", to: { ...b.p } });
            continue;
        }
        let c1 = { x: a.p.x + ((outA === null || outA === void 0 ? void 0 : outA.x) || 0), y: a.p.y + ((outA === null || outA === void 0 ? void 0 : outA.y) || 0) };
        let c2 = { x: b.p.x - ((inB === null || inB === void 0 ? void 0 : inB.x) || 0), y: b.p.y - ((inB === null || inB === void 0 ? void 0 : inB.y) || 0) };
        // 開パスの auto 端は自然境界条件（B''=0 ⟺ 端の制御点 = (端点+隣の制御点)/2）。端だけ硬くなるのを防ぐ。
        if (!closed && n > 2 && i === 0 && a.kind === "auto")
            c1 = { x: (a.p.x + c2.x) / 2, y: (a.p.y + c2.y) / 2 };
        if (!closed && n > 2 && i === count - 1 && b.kind === "auto")
            c2 = { x: (b.p.x + c1.x) / 2, y: (b.p.y + c1.y) / 2 };
        segments.push({ type: "cubic", c1, c2, to: { ...b.p } });
    }
    return segments;
};
