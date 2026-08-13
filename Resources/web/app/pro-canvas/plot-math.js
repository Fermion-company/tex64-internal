const functions = {
    sin: { n: 1, fn: x => Math.sin(x * Math.PI / 180) }, cos: { n: 1, fn: x => Math.cos(x * Math.PI / 180) }, tan: { n: 1, fn: x => Math.tan(x * Math.PI / 180) },
    asin: { n: 1, fn: x => Math.asin(x) * 180 / Math.PI }, acos: { n: 1, fn: x => Math.acos(x) * 180 / Math.PI }, atan: { n: 1, fn: x => Math.atan(x) * 180 / Math.PI },
    sqrt: { n: 1, fn: Math.sqrt }, abs: { n: 1, fn: Math.abs }, exp: { n: 1, fn: Math.exp }, ln: { n: 1, fn: Math.log }, log10: { n: 1, fn: Math.log10 }, log2: { n: 1, fn: Math.log2 },
    floor: { n: 1, fn: Math.floor }, ceil: { n: 1, fn: Math.ceil }, round: { n: 1, fn: Math.round }, deg: { n: 1, fn: x => x * 180 / Math.PI }, rad: { n: 1, fn: x => x * Math.PI / 180 },
    min: { n: 2, fn: Math.min }, max: { n: 2, fn: Math.max }, mod: { n: 2, fn: (x, y) => x % y },
};
export const compileExpr = (src) => {
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
        const value = Number(number[0]);
        return () => value;
    } const ident = (_a = src.slice(at).match(/^[A-Za-z][A-Za-z0-9]*/)) === null || _a === void 0 ? void 0 : _a[0]; if (!ident)
        throw 0; at += ident.length; if (ident === "x")
        return x => x; if (ident === "pi")
        return () => Math.PI; if (ident === "e")
        return () => Math.E; const entry = functions[ident]; if (!entry || !take("("))
        throw 0; const args = [expr()]; while (take(","))
        args.push(expr()); if (!take(")") || args.length !== entry.n)
        throw 0; return x => entry.fn(...args.map(arg => arg(x))); };
    const power = () => { const left = primary(); if (!take("^"))
        return left; const right = unary(); return x => Math.pow(left(x), right(x)); };
    const unary = () => take("-") ? ((value => x => -value(x))(unary())) : power();
    const term = () => { let left = unary(); for (;;) {
        if (take("*")) {
            const right = unary(), prev = left;
            left = x => prev(x) * right(x);
        }
        else if (take("/")) {
            const right = unary(), prev = left;
            left = x => prev(x) / right(x);
        }
        else
            return left;
    } };
    const expr = () => { let left = term(); for (;;) {
        if (take("+")) {
            const right = term(), prev = left;
            left = x => prev(x) + right(x);
        }
        else if (take("-")) {
            const right = term(), prev = left;
            left = x => prev(x) - right(x);
        }
        else
            return left;
    } };
    try {
        const fn = expr();
        ws();
        return at === src.length ? fn : null;
    }
    catch {
        return null;
    }
};
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
export const niceTicks = (min, max, target = 5) => { if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    return []; const raw = (max - min) / Math.max(1, target), power = Math.pow(10, Math.floor(Math.log10(raw))), fraction = raw / power, nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10, step = nice * power, out = []; for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step)
    out.push(Math.abs(value) < step * 1e-10 ? 0 : Number(value.toPrecision(12))); return out; };
export const autoRange = (ys) => { const finite = ys.filter(Number.isFinite); if (!finite.length)
    return { min: -1, max: 1 }; const min = Math.min(...finite), max = Math.max(...finite); if (min === max)
    return { min: -1, max: 1 }; const pad = (max - min) * .05; return { min: min - pad, max: max + pad }; };
