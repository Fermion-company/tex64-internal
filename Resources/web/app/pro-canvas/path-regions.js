import { reversePath, splitSegmentAt } from "./canvas-math.js";
const EPS = 1e-8;
const CUBIC_SAMPLES = 64;
const clonePoint = (point) => ({ ...point });
const cloneSegment = (segment) => segment.type === "line"
    ? { type: "line", to: clonePoint(segment.to) }
    : { type: "cubic", c1: clonePoint(segment.c1), c2: clonePoint(segment.c2), to: clonePoint(segment.to) };
const cross = (a, b) => a.x * b.y - a.y * b.x;
const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const positionValue = (position) => position.segmentIndex + position.t;
const pointOnSegment = (from, segment, t) => {
    if (segment.type === "line")
        return {
            x: from.x + (segment.to.x - from.x) * t,
            y: from.y + (segment.to.y - from.y) * t,
        };
    const u = 1 - t;
    return {
        x: u ** 3 * from.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t ** 3 * segment.to.x,
        y: u ** 3 * from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t ** 3 * segment.to.y,
    };
};
const derivativeOnSegment = (from, segment, t) => {
    if (segment.type === "line")
        return { x: segment.to.x - from.x, y: segment.to.y - from.y };
    const u = 1 - t;
    return {
        x: 3 * u * u * (segment.c1.x - from.x) + 6 * u * t * (segment.c2.x - segment.c1.x) + 3 * t * t * (segment.to.x - segment.c2.x),
        y: 3 * u * u * (segment.c1.y - from.y) + 6 * u * t * (segment.c2.y - segment.c1.y) + 3 * t * t * (segment.to.y - segment.c2.y),
    };
};
const segmentFrom = (path, index) => index === 0 ? path.start : path.segments[index - 1].to;
const samplePieces = (path) => {
    const pieces = [];
    path.segments.forEach((segment, segmentIndex) => {
        const from = segmentFrom(path, segmentIndex);
        const count = segment.type === "line" ? 1 : CUBIC_SAMPLES;
        let previous = clonePoint(from);
        for (let index = 0; index < count; index++) {
            const t = index / count, tEnd = (index + 1) / count;
            const to = pointOnSegment(from, segment, tEnd);
            pieces.push({ segmentIndex, t, tEnd, from: previous, to });
            previous = to;
        }
    });
    return pieces;
};
const lineIntersection = (a, b) => {
    const ar = { x: a.to.x - a.from.x, y: a.to.y - a.from.y };
    const br = { x: b.to.x - b.from.x, y: b.to.y - b.from.y };
    const denominator = cross(ar, br);
    if (Math.abs(denominator) < EPS)
        return null;
    const delta = { x: b.from.x - a.from.x, y: b.from.y - a.from.y };
    const aT = cross(delta, br) / denominator;
    const bT = cross(delta, ar) / denominator;
    if (aT < -EPS || aT > 1 + EPS || bT < -EPS || bT > 1 + EPS)
        return null;
    return { aT: Math.max(0, Math.min(1, aT)), bT: Math.max(0, Math.min(1, bT)) };
};
const refineIntersection = (aPath, bPath, a, b) => {
    const aFrom = segmentFrom(aPath, a.segmentIndex), bFrom = segmentFrom(bPath, b.segmentIndex);
    const aSegment = aPath.segments[a.segmentIndex], bSegment = bPath.segments[b.segmentIndex];
    let aT = a.t, bT = b.t;
    for (let iteration = 0; iteration < 10; iteration++) {
        const aPoint = pointOnSegment(aFrom, aSegment, aT), bPoint = pointOnSegment(bFrom, bSegment, bT);
        const error = { x: aPoint.x - bPoint.x, y: aPoint.y - bPoint.y };
        if (Math.hypot(error.x, error.y) < 1e-10)
            break;
        const aDerivative = derivativeOnSegment(aFrom, aSegment, aT), bDerivative = derivativeOnSegment(bFrom, bSegment, bT);
        const determinant = cross(aDerivative, bDerivative);
        if (Math.abs(determinant) < EPS)
            break;
        const deltaA = -cross(error, bDerivative) / determinant;
        const deltaB = -cross(error, aDerivative) / determinant;
        const nextA = Math.max(0, Math.min(1, aT + deltaA));
        const nextB = Math.max(0, Math.min(1, bT + deltaB));
        if (Math.abs(nextA - aT) + Math.abs(nextB - bT) < 1e-12)
            break;
        aT = nextA;
        bT = nextB;
    }
    const aPoint = pointOnSegment(aFrom, aSegment, aT), bPoint = pointOnSegment(bFrom, bSegment, bT);
    return {
        point: { x: (aPoint.x + bPoint.x) / 2, y: (aPoint.y + bPoint.y) / 2 },
        a: { segmentIndex: a.segmentIndex, t: aT },
        b: { segmentIndex: b.segmentIndex, t: bT },
    };
};
const intersections = (aPath, bPath) => {
    const found = [];
    for (const aPiece of samplePieces(aPath))
        for (const bPiece of samplePieces(bPath)) {
            const hit = lineIntersection(aPiece, bPiece);
            if (!hit)
                continue;
            const refined = refineIntersection(aPath, bPath, { segmentIndex: aPiece.segmentIndex, t: aPiece.t + (aPiece.tEnd - aPiece.t) * hit.aT }, { segmentIndex: bPiece.segmentIndex, t: bPiece.t + (bPiece.tEnd - bPiece.t) * hit.bT });
            if (found.some(existing => pointDistance(existing.point, refined.point) < 1e-5
                && Math.abs(positionValue(existing.a) - positionValue(refined.a)) < 1e-5
                && Math.abs(positionValue(existing.b) - positionValue(refined.b)) < 1e-5))
                continue;
            found.push(refined);
        }
    return found;
};
const sliceSegment = (from, segment, startT, endT) => {
    if (startT <= EPS && endT >= 1 - EPS)
        return cloneSegment(segment);
    if (startT <= EPS)
        return splitSegmentAt(from, segment, endT)[0];
    const [, afterStart] = splitSegmentAt(from, segment, startT);
    if (endT >= 1 - EPS)
        return afterStart;
    return splitSegmentAt(pointOnSegment(from, segment, startT), afterStart, (endT - startT) / (1 - startT))[0];
};
const subpath = (path, start, end, startPoint, endPoint) => {
    const segments = [];
    for (let index = start.segmentIndex; index <= end.segmentIndex; index++) {
        const from = segmentFrom(path, index);
        const startT = index === start.segmentIndex ? start.t : 0;
        const endT = index === end.segmentIndex ? end.t : 1;
        if (endT - startT <= EPS)
            continue;
        segments.push(sliceSegment(from, path.segments[index], startT, endT));
    }
    if (segments.length)
        segments[segments.length - 1].to = clonePoint(endPoint);
    return { start: clonePoint(startPoint), segments };
};
const sampledArea = (path) => {
    const points = [path.start];
    let from = path.start;
    for (const segment of path.segments) {
        const count = segment.type === "line" ? 1 : 12;
        for (let index = 1; index <= count; index++)
            points.push(pointOnSegment(from, segment, index / count));
        from = segment.to;
    }
    let twiceArea = 0;
    for (let index = 0; index < points.length; index++) {
        const current = points[index], next = points[(index + 1) % points.length];
        twiceArea += current.x * next.y - current.y * next.x;
    }
    return Math.abs(twiceArea) / 2;
};
const signedSampledArea = (path) => {
    const points = sampledPoints(path);
    let twiceArea = 0;
    for (let index = 0; index < points.length; index++) {
        const current = points[index], next = points[(index + 1) % points.length];
        twiceArea += current.x * next.y - current.y * next.x;
    }
    return twiceArea / 2;
};
const sampledPoints = (path) => {
    const points = [clonePoint(path.start)];
    let from = path.start;
    for (const segment of path.segments) {
        const count = segment.type === "line" ? 1 : 16;
        for (let index = 1; index <= count; index++)
            points.push(pointOnSegment(from, segment, index / count));
        from = segment.to;
    }
    return points;
};
const pointInRegion = (region, point) => {
    const points = sampledPoints(region);
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const a = points[index], b = points[previous];
        if ((a.y > point.y) === (b.y > point.y))
            continue;
        const crossingX = (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
        if (point.x < crossingX)
            inside = !inside;
    }
    return inside;
};
const expandedPath = (path) => {
    var _a, _b;
    const copy = { start: clonePoint(path.start), segments: path.segments.map(cloneSegment), closed: false };
    const end = (_b = (_a = copy.segments[copy.segments.length - 1]) === null || _a === void 0 ? void 0 : _a.to) !== null && _b !== void 0 ? _b : copy.start;
    if (path.closed && pointDistance(end, copy.start) > 1e-7)
        copy.segments.push({ type: "line", to: clonePoint(copy.start) });
    return copy;
};
const startAngle = (edge) => {
    const segment = edge.segments[0];
    if (!segment)
        return 0;
    const derivative = derivativeOnSegment(edge.start, segment, 0);
    return Math.atan2(derivative.y, derivative.x);
};
const uniquePositions = (positions) => {
    const sorted = [...positions].sort((left, right) => positionValue(left) - positionValue(right));
    return sorted.filter((position, index) => !index
        || Math.abs(positionValue(position) - positionValue(sorted[index - 1])) > 1e-7
        || pointDistance(position.point, sorted[index - 1].point) > 1e-7);
};
/**
 * キャンバス上の境界線を平面グラフとしてたどり、クリック可能な有限領域を返す。
 * 2 本に限らず、複数の直線・ベジェ・閉パスが組み合わさった囲みを扱う。
 */
export const enclosedRegions = (sourcePaths) => {
    const sources = sourcePaths.filter(path => path.segments.length);
    const paths = sources.map(expandedPath);
    const positions = paths.map(path => [
        { segmentIndex: 0, t: 0, point: clonePoint(path.start) },
        { segmentIndex: path.segments.length - 1, t: 1, point: clonePoint(path.segments[path.segments.length - 1].to) },
    ]);
    for (let left = 0; left < paths.length; left++)
        for (let right = left + 1; right < paths.length; right++) {
            for (const hit of intersections(paths[left], paths[right])) {
                positions[left].push({ ...hit.a, point: clonePoint(hit.point) });
                positions[right].push({ ...hit.b, point: clonePoint(hit.point) });
            }
        }
    const atomic = [];
    const direct = [];
    paths.forEach((path, pathIndex) => {
        const stops = uniquePositions(positions[pathIndex]);
        const hadIntersection = stops.length > 2;
        if (sources[pathIndex].closed && !hadIntersection) {
            direct.push({ start: clonePoint(sources[pathIndex].start), segments: sources[pathIndex].segments.map(cloneSegment), closed: true });
        }
        for (let index = 0; index < stops.length - 1; index++) {
            const start = stops[index], end = stops[index + 1];
            if (positionValue(end) - positionValue(start) <= EPS)
                continue;
            const piece = subpath(path, start, end, start.point, end.point);
            if (piece.segments.length && pointDistance(piece.start, piece.segments[piece.segments.length - 1].to) > 1e-7)
                atomic.push(piece);
        }
    });
    const vertices = [];
    const vertexFor = (point) => {
        const existing = vertices.findIndex(vertex => pointDistance(vertex, point) < 1e-5);
        if (existing >= 0)
            return existing;
        vertices.push(clonePoint(point));
        return vertices.length - 1;
    };
    const halfEdges = [];
    atomic.forEach(edge => {
        const from = vertexFor(edge.start), to = vertexFor(edge.segments[edge.segments.length - 1].to);
        if (from === to)
            return;
        const forward = { start: clonePoint(vertices[from]), segments: edge.segments.map(cloneSegment) };
        forward.segments[forward.segments.length - 1].to = clonePoint(vertices[to]);
        const reverse = reversePath(forward);
        reverse.start = clonePoint(vertices[to]);
        reverse.segments[reverse.segments.length - 1].to = clonePoint(vertices[from]);
        const forwardIndex = halfEdges.length, reverseIndex = forwardIndex + 1;
        halfEdges.push({ ...forward, from, to, twin: reverseIndex, angle: startAngle(forward), used: false });
        halfEdges.push({ ...reverse, from: to, to: from, twin: forwardIndex, angle: startAngle(reverse), used: false });
    });
    const outgoing = vertices.map(() => []);
    halfEdges.forEach((edge, index) => outgoing[edge.from].push(index));
    outgoing.forEach(edges => edges.sort((left, right) => halfEdges[left].angle - halfEdges[right].angle));
    const faces = [];
    halfEdges.forEach((start, startIndex) => {
        if (start.used)
            return;
        const walked = [];
        let currentIndex = startIndex;
        for (let guard = 0; guard <= halfEdges.length; guard++) {
            const current = halfEdges[currentIndex];
            if (current.used)
                break;
            current.used = true;
            walked.push(currentIndex);
            const options = outgoing[current.to], twinAt = options.indexOf(current.twin);
            if (twinAt < 0 || options.length < 2)
                break;
            currentIndex = options[(twinAt - 1 + options.length) % options.length];
            if (currentIndex === startIndex) {
                const segments = walked.flatMap(index => halfEdges[index].segments.map(cloneSegment));
                const region = { start: clonePoint(start.start), segments, closed: true };
                if (segments.length >= 2 && signedSampledArea(region) > 1e-6)
                    faces.push(region);
                break;
            }
        }
    });
    return [...direct, ...faces];
};
/** クリック位置を含む最小の有限領域を返す。入れ子でも内側を優先する。 */
export const enclosedRegionAt = (regions, point) => {
    var _a;
    const containing = regions.filter(region => pointInRegion(region, point));
    containing.sort((left, right) => sampledArea(left) - sampledArea(right));
    return (_a = containing[0]) !== null && _a !== void 0 ? _a : null;
};
/**
 * 2 本の開いたパスが挟む有限領域を、元の線・ベジェ形状を保った閉パスとして返す。
 * 交点が 3 個なら、両パス上で隣り合う交点対から通常 2 領域が得られる。
 */
export const intersectionRegions = (aPath, bPath) => {
    if (aPath.closed || bPath.closed || !aPath.segments.length || !bPath.segments.length)
        return [];
    const hits = intersections(aPath, bPath).sort((left, right) => positionValue(left.a) - positionValue(right.a));
    if (hits.length < 2)
        return [];
    const bOrder = [...hits].sort((left, right) => positionValue(left.b) - positionValue(right.b));
    const bRank = new Map(bOrder.map((hit, index) => [hit, index]));
    const regions = [];
    for (let index = 0; index < hits.length - 1; index++) {
        const first = hits[index], second = hits[index + 1];
        if (Math.abs(bRank.get(first) - bRank.get(second)) !== 1)
            continue;
        const alongA = subpath(aPath, first.a, second.a, first.point, second.point);
        const bFirst = positionValue(first.b) <= positionValue(second.b) ? first : second;
        const bSecond = bFirst === first ? second : first;
        const ascendingB = subpath(bPath, bFirst.b, bSecond.b, bFirst.point, bSecond.point);
        const alongB = bFirst === second ? ascendingB : reversePath(ascendingB);
        const region = {
            start: clonePoint(first.point),
            segments: [...alongA.segments, ...alongB.segments],
            closed: true,
        };
        if (region.segments.length >= 2 && sampledArea(region) > 1e-6)
            regions.push(region);
    }
    return regions;
};
