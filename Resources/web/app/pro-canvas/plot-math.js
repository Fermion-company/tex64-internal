export const PLOT_PALETTE = ["#2563eb", "#dc2626", "#059669", "#9333ea", "#ea580c", "#0891b2"];
export const zoomRange = (min, max, focusT, factor) => { const width = Math.max(1e-6, Math.min(1e9, Math.abs(max - min) * Math.max(Number.MIN_VALUE, factor))), focus = Math.max(0, Math.min(1, focusT)), value = min + (max - min) * focus; return { min: value - width * focus, max: value + width * (1 - focus) }; };
export const panRange = (min, max, deltaT) => { const delta = (max - min) * deltaT; return { min: min + delta, max: max + delta }; };
export const normalizePlotDimension = (value, current) => { const next = Number(value); return Number.isFinite(next) && next > 0 ? next : current; };
const functions = {
    sin: { n: 1, fn: x => Math.sin(x * Math.PI / 180) }, cos: { n: 1, fn: x => Math.cos(x * Math.PI / 180) }, tan: { n: 1, fn: x => Math.tan(x * Math.PI / 180) },
    asin: { n: 1, fn: x => Math.asin(x) * 180 / Math.PI }, acos: { n: 1, fn: x => Math.acos(x) * 180 / Math.PI }, atan: { n: 1, fn: x => Math.atan(x) * 180 / Math.PI },
    sqrt: { n: 1, fn: Math.sqrt }, abs: { n: 1, fn: Math.abs }, exp: { n: 1, fn: Math.exp }, ln: { n: 1, fn: Math.log }, log10: { n: 1, fn: Math.log10 }, log2: { n: 1, fn: Math.log2 },
    floor: { n: 1, fn: Math.floor }, ceil: { n: 1, fn: Math.ceil }, round: { n: 1, fn: Math.round }, deg: { n: 1, fn: x => x * 180 / Math.PI }, rad: { n: 1, fn: x => x * Math.PI / 180 },
    min: { n: 2, fn: Math.min }, max: { n: 2, fn: Math.max }, mod: { n: 2, fn: (x, y) => x % y },
};
/** `x^2` だけでなく、ユーザーが自然に入力する `y=x^2` / `f(x)=x^2` も受け付ける。 */
export const normalizePlotExpression = (source) => source.trim().replace(/^(?:[xy]|[fgr]\s*\(\s*[xt]\s*\))\s*=\s*/i, "");
export const parseExpr = (source) => {
    const src = normalizePlotExpression(source);
    let at = 0;
    const ws = () => { while (/\s/.test(src[at] || ""))
        at++; }, take = (s) => { ws(); if (src.slice(at, at + s.length) !== s)
        return false; at += s.length; return true; };
    const primary = () => { var _a; ws(); if (take("(")) {
        const value = expr();
        if (!take(")"))
            throw 0;
        return value;
    } const number = src.slice(at).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/); if (number) {
        at += number[0].length;
        return { k: "num", v: Number(number[0]) };
    } const theta = src[at] === "θ" ? "θ" : null, ident = theta || ((_a = src.slice(at).match(/^[A-Za-z][A-Za-z0-9]*/)) === null || _a === void 0 ? void 0 : _a[0]); if (!ident)
        throw 0; at += ident.length; if (ident === "x" || ident === "t" || ident === "theta" || ident === "θ")
        return { k: "var" }; if (ident === "pi" || ident === "e")
        return { k: "const", name: ident }; const entry = functions[ident]; if (!entry || !take("("))
        throw 0; const args = [expr()]; while (take(","))
        args.push(expr()); if (!take(")") || args.length !== entry.n)
        throw 0; return { k: "call", name: ident, args }; };
    const power = () => { const left = primary(); if (!take("^"))
        return left; return { k: "bin", op: "^", a: left, b: unary() }; };
    const unary = () => take("-") ? { k: "neg", a: unary() } : power();
    const term = () => { let left = unary(); for (;;) {
        if (take("*"))
            left = { k: "bin", op: "*", a: left, b: unary() };
        else if (take("/"))
            left = { k: "bin", op: "/", a: left, b: unary() };
        else
            return left;
    } };
    const expr = () => { let left = term(); for (;;) {
        if (take("+"))
            left = { k: "bin", op: "+", a: left, b: term() };
        else if (take("-"))
            left = { k: "bin", op: "-", a: left, b: term() };
        else
            return left;
    } };
    try {
        const ast = expr();
        ws();
        return at === src.length ? ast : null;
    }
    catch {
        return null;
    }
};
export const compileAst = (ast) => { const compile = (node) => { if (node.k === "num")
    return () => node.v; if (node.k === "var")
    return x => x; if (node.k === "const")
    return () => node.name === "pi" ? Math.PI : Math.E; if (node.k === "neg") {
    const a = compile(node.a);
    return x => -a(x);
} if (node.k === "call") {
    const entry = functions[node.name], args = node.args.map(compile);
    return entry && args.length === entry.n ? x => entry.fn(...args.map(arg => arg(x))) : () => NaN;
} const a = compile(node.a), b = compile(node.b); if (node.op === "+")
    return x => a(x) + b(x); if (node.op === "-")
    return x => a(x) - b(x); if (node.op === "*")
    return x => a(x) * b(x); if (node.op === "/")
    return x => a(x) / b(x); return x => Math.pow(a(x), b(x)); }; return compile(ast); };
export const compileExpr = (src) => { const ast = parseExpr(src); return ast ? compileAst(ast) : null; };
const astPrec = (node) => node.k === "bin" ? (node.op === "+" || node.op === "-" ? 1 : node.op === "*" || node.op === "/" ? 2 : 4) : node.k === "neg" ? 3 : 5;
export const astToPgf = (ast, varName) => { const emit = (node, parent = null, side = "a") => { let value; if (node.k === "num")
    value = String(node.v);
else if (node.k === "var")
    value = varName;
else if (node.k === "const")
    value = node.name;
else if (node.k === "neg")
    value = `-${emit(node.a, node)}`;
else if (node.k === "call")
    value = `${node.name}(${node.args.map(arg => emit(arg)).join(",")})`;
else
    value = `${emit(node.a, node, "a")}${node.op}${emit(node.b, node, "b")}`; if (!parent)
    return value; const np = astPrec(node), pp = astPrec(parent); let wrap = np < pp; if (node.k === "bin" && parent.k === "bin" && np === pp) {
    if (parent.op === "^" && side === "a")
        wrap = true;
    else if (side === "b" && (parent.op === "-" || parent.op === "/" || (parent.op === "+" && node.op === "-")))
        wrap = true;
    else if (side === "b" && parent.op === "*" && node.op === "/")
        wrap = true;
} return wrap ? `(${value})` : value; }; return emit(ast); };
export const samplePlot = (fn, min, max, samples) => { const pieces = []; let piece = []; const count = Math.max(2, Math.floor(samples)); for (let i = 0; i <= count; i++) {
    const x = min + (max - min) * i / count, y = fn(x);
    if (!Number.isFinite(y) || Math.abs(y) > 1e6) {
        if (piece.length)
            pieces.push(piece);
        piece = [];
    }
    else
        piece.push({ x, y });
} if (piece.length)
    pieces.push(piece); return pieces; };
export const sampleParametric = (fx, fy, min, max, samples) => { const pieces = []; let piece = []; const count = Math.max(2, Math.floor(samples)); for (let i = 0; i <= count; i++) {
    const t = min + (max - min) * i / count, x = fx(t), y = fy(t);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
        if (piece.length)
            pieces.push(piece);
        piece = [];
    }
    else
        piece.push({ x, y });
} if (piece.length)
    pieces.push(piece); return pieces; };
export const parsePoints = (src) => src.replace(/\r/g, "").split("\n").flatMap(line => { const parts = line.trim().split(/[\s,]+/); if (parts.length !== 2)
    return []; const x = Number(parts[0]), y = Number(parts[1]); return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []; });
export const niceTicks = (min, max, target = 5) => { if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    return []; const raw = (max - min) / Math.max(1, target), power = Math.pow(10, Math.floor(Math.log10(raw))), fraction = raw / power, nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10, step = nice * power, out = []; for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step)
    out.push(Math.abs(value) < step * 1e-10 ? 0 : Number(value.toPrecision(12))); return out; };
export const snapRangeToNice = (min, max) => { if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    return { min, max }; const width = max - min, raw = width / 5, power = Math.pow(10, Math.floor(Math.log10(raw))), fraction = raw / power, nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10, grid = nice * power / 10, limit = width * .02, isNice = (value) => { if (value === 0)
    return true; const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(value)))), scaled = Math.abs(value) / magnitude; return [1, 2, 2.5, 5, 10].some(mark => Math.abs(scaled - mark) < 1e-10); }, snap = (value) => { if (isNice(value))
    return value; const candidate = Math.round(value / grid) * grid; return Math.abs(candidate - value) <= limit ? Number(candidate.toPrecision(12)) : value; }; return { min: snap(min), max: snap(max) }; };
export const autoRange = (ys) => { const finite = ys.filter(Number.isFinite); if (!finite.length)
    return { min: -1, max: 1 }; const min = Math.min(...finite), max = Math.max(...finite); if (min === max)
    return { min: -1, max: 1 }; const pad = (max - min) * .05; return { min: min - pad, max: max + pad }; };
