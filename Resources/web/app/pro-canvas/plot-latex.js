import { astToPgf, parseExpr } from "./plot-math.js";
const bin = (op, a, b) => ({ k: "bin", op, a, b });
export const latexToExpr = (latex, varName = "x") => {
    if (varName.length !== 1)
        return null;
    let at = 0, pipeDepth = 0;
    const ws = () => { while (/\s/.test(latex[at] || ""))
        at++; }, take = (s) => { ws(); if (latex.slice(at, at + s.length) !== s)
        return false; at += s.length; return true; }, command = () => { ws(); if (latex[at] !== "\\")
        return null; at++; const start = at; while (/[A-Za-z]/.test(latex[at] || ""))
        at++; return at > start ? latex.slice(start, at) : null; }, starts = () => { ws(); const c = latex[at] || ""; if (c === "|" && pipeDepth)
        return false; if (c === "(" || c === "{" || c === "|" || c === varName || c === "e" || /\d|\./.test(c))
        return true; if (c !== "\\")
        return false; const save = at, name = command(); at = save; return Boolean(name && !(["right", "cdot", "times"].includes(name))); };
    const group = (open, close) => { if (!take(open))
        throw 0; const value = expr(); if (!take(close))
        throw 0; return value; };
    const argument = () => { ws(); if (latex[at] === "{")
        return group("{", "}"); if (latex[at] === "(")
        return group("(", ")"); if (latex.slice(at, at + 5) === "\\left") {
        const save = at, name = command();
        if (name !== "left")
            throw 0;
        ws();
        const open = latex[at++], close = open === "(" ? ")" : open === "[" ? "]" : open;
        if (!"([|".includes(open))
            throw 0;
        const value = expr();
        if (command() !== "right") {
            at = save;
            throw 0;
        }
        ws();
        if (latex[at++] !== close)
            throw 0;
        return open === "|" ? { k: "call", name: "abs", args: [value] } : value;
    } return unary(); };
    const primary = () => { ws(); if (take("("))
        return ((value) => { if (!take(")"))
            throw 0; return value; })(expr()); if (take("{"))
        return ((value) => { if (!take("}"))
            throw 0; return value; })(expr()); if (take("|")) {
        pipeDepth++;
        const value = expr();
        pipeDepth--;
        if (!take("|"))
            throw 0;
        return { k: "call", name: "abs", args: [value] };
    } const number = latex.slice(at).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/); if (number) {
        at += number[0].length;
        return { k: "num", v: Number(number[0]) };
    } if (latex[at] === varName) {
        at++;
        return { k: "var" };
    } if (latex[at] === "e") {
        at++;
        return { k: "const", name: "e" };
    } const name = command(); if (!name)
        throw 0; if (name === "pi")
        return { k: "const", name: "pi" }; if (name === "left") {
        ws();
        const open = latex[at++], close = open === "(" ? ")" : open === "[" ? "]" : open;
        if (!"([|".includes(open))
            throw 0;
        const value = expr();
        if (command() !== "right") {
            throw 0;
        }
        ws();
        if (latex[at++] !== close)
            throw 0;
        return open === "|" ? { k: "call", name: "abs", args: [value] } : value;
    } if (name === "frac") {
        const a = group("{", "}"), b = group("{", "}");
        return bin("/", a, b);
    } if (name === "sqrt") {
        let degree = null;
        if (take("[")) {
            degree = expr();
            if (!take("]"))
                throw 0;
        }
        const value = group("{", "}");
        return degree ? bin("^", value, bin("/", { k: "num", v: 1 }, degree)) : { k: "call", name: "sqrt", args: [value] };
    } const direct = { exp: "exp", ln: "ln", log: "log10" }, trig = { sin: "sin", cos: "cos", tan: "tan" }, inverse = { arcsin: "asin", arccos: "acos", arctan: "atan" }; if (direct[name])
        return { k: "call", name: direct[name], args: [argument()] }; if (trig[name])
        return { k: "call", name: trig[name], args: [{ k: "call", name: "deg", args: [argument()] }] }; if (inverse[name])
        return { k: "call", name: "rad", args: [{ k: "call", name: inverse[name], args: [argument()] }] }; throw 0; };
    const power = () => { const left = primary(); if (!take("^"))
        return left; const right = latex[at] === "{" ? group("{", "}") : unary(); return bin("^", left, right); };
    const unary = () => take("-") ? { k: "neg", a: unary() } : power();
    const term = () => { var _a; let left = unary(); for (;;) {
        const save = at;
        if (take("*")) {
            left = bin("*", left, unary());
            continue;
        }
        if (take("/")) {
            left = bin("/", left, unary());
            continue;
        }
        at = save;
        const name = (_a = latex.slice(at).match(/^\\([A-Za-z]+)/)) === null || _a === void 0 ? void 0 : _a[1];
        if (name === "cdot" || name === "times") {
            command();
            left = bin("*", left, unary());
            continue;
        }
        if (starts()) {
            left = bin("*", left, unary());
            continue;
        }
        return left;
    } };
    const expr = () => { let left = term(); for (;;) {
        if (take("+"))
            left = bin("+", left, term());
        else if (take("-"))
            left = bin("-", left, term());
        else
            return left;
    } };
    try {
        const ast = expr();
        ws();
        return at === latex.length ? astToPgf(ast, varName) : null;
    }
    catch {
        return null;
    }
};
const prec = (node) => node.k === "bin" ? (node.op === "+" || node.op === "-" ? 1 : node.op === "*" ? 2 : node.op === "/" ? 2 : 4) : node.k === "neg" ? 3 : 5;
export const exprToLatex = (expr, varName = "x") => { if (varName.length !== 1)
    return null; const ast = parseExpr(expr); if (!ast)
    return null; const emit = (node, parent = null, side = "a") => { let value = null; if (node.k === "num")
    value = String(node.v);
else if (node.k === "var")
    value = varName;
else if (node.k === "const")
    value = node.name === "pi" ? "\\pi" : "e";
else if (node.k === "neg") {
    const a = emit(node.a, node);
    if (a !== null)
        value = `-${a}`;
}
else if (node.k === "call") {
    const arg = node.args.length === 1 ? node.args[0] : null, direct = { exp: "exp", ln: "ln", log10: "log" };
    if (arg && direct[node.name]) {
        const a = emit(arg);
        if (a !== null)
            value = `\\${direct[node.name]}\\left(${a}\\right)`;
    }
    else if (arg && node.name === "sqrt") {
        const a = emit(arg);
        if (a !== null)
            value = `\\sqrt{${a}}`;
    }
    else if (arg && node.name === "abs") {
        const a = emit(arg);
        if (a !== null)
            value = `\\left|${a}\\right|`;
    }
    else if (arg && ["sin", "cos", "tan"].includes(node.name) && arg.k === "call" && arg.name === "deg" && arg.args.length === 1) {
        const a = emit(arg.args[0]);
        if (a !== null)
            value = `\\${node.name}\\left(${a}\\right)`;
    }
    else if (arg && node.name === "rad" && arg.k === "call" && ["asin", "acos", "atan"].includes(arg.name) && arg.args.length === 1) {
        const a = emit(arg.args[0]);
        if (a !== null)
            value = `\\arc${arg.name.slice(1)}\\left(${a}\\right)`;
    }
}
else {
    const a = emit(node.a, node, "a"), b = emit(node.b, node, "b");
    if (a !== null && b !== null) {
        if (node.op === "/")
            value = `\\frac{${a}}{${b}}`;
        else if (node.op === "^")
            value = `${a}^{${b}}`;
        else
            value = `${a}${node.op === "*" ? "\\cdot " : node.op}${b}`;
    }
} if (value === null)
    return null; if (!parent)
    return value; const np = prec(node), pp = prec(parent), wrap = np < pp || (node.k === "bin" && parent.k === "bin" && np === pp && ((parent.op === "^" && side === "a") || (side === "b" && (parent.op === "-" || parent.op === "/")))); return wrap ? `\\left(${value}\\right)` : value; }; return emit(ast); };
