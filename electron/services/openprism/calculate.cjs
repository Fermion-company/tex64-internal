"use strict";

// Numeric expressions only: no JavaScript evaluation, files or process access.
const functions = {
  sqrt: [1, Math.sqrt], abs: [1, Math.abs], exp: [1, Math.exp],
  log: [1, Math.log], log10: [1, Math.log10],
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
  asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
  pow: [2, Math.pow],
  min: [null, Math.min], max: [null, Math.max],
  sum: [null, (...values) => values.reduce((a, b) => a + b, 0)],
  mean: [null, (...values) => values.reduce((a, b) => a + b, 0) / values.length],
  // School mathematics: counting, integers, rounding.
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], sign: [1, Math.sign],
  cbrt: [1, Math.cbrt], log2: [1, Math.log2], ln: [1, Math.log],
  fact: [1, (n) => { const k = wholeNumber(n, "fact", 170); let r = 1; for (let i = 2; i <= k; i += 1) r *= i; return r; }],
  comb: [2, (n, r) => { const a = wholeNumber(n, "comb"); const b = wholeNumber(r, "comb"); if (b > a) return 0; let v = 1; for (let i = 1; i <= Math.min(b, a - b); i += 1) v = (v * (a - Math.min(b, a - b) + i)) / i; return Math.round(v); }],
  perm: [2, (n, r) => { const a = wholeNumber(n, "perm"); const b = wholeNumber(r, "perm"); if (b > a) return 0; let v = 1; for (let i = 0; i < b; i += 1) v *= a - i; return v; }],
  gcd: [null, (...values) => values.map((v) => wholeNumber(Math.abs(v), "gcd")).reduce((x, y) => { while (y) [x, y] = [y, x % y]; return x; })],
  lcm: [null, (...values) => values.map((v) => wholeNumber(Math.abs(v), "lcm")).reduce((x, y) => { if (!x || !y) return 0; let a = x, b = y; while (b) [a, b] = [b, a % b]; return (x / a) * y; })],
};

function wholeNumber(value, name, max = 1e6) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} needs whole numbers from 0 to ${max}.`);
  return value;
}

/** p/q for a value that is a simple fraction (|q| <= 100000), else null. */
function asFraction(value) {
  if (!Number.isFinite(value) || Number.isInteger(value)) return null;
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, x = value;
  for (let i = 0; i < 40; i += 1) {
    const a = Math.floor(x);
    [h1, h0] = [a * h1 + h0, h1];
    [k1, k0] = [a * k1 + k0, k1];
    if (k1 > 100000) return null;
    if (Math.abs(value - h1 / k1) <= 1e-12 * Math.max(1, Math.abs(value))) return `${h1}/${k1}`;
    const frac = x - a;
    if (frac === 0) break;
    x = 1 / frac;
  }
  return null;
}

function calculate(expression) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 2000) {
    throw new Error("Use a numeric expression of 1–2000 characters.");
  }
  const tokens = [];
  let rest = expression.trim();
  while (rest) {
    const match = /^(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[a-z][a-z0-9]*|\*\*|[+\-*/%^(),])/i.exec(rest);
    if (!match) throw new Error("Unsupported expression syntax.");
    tokens.push(match[0]);
    if (tokens.length > 1000) throw new Error("Expression is too long.");
    rest = rest.slice(match[0].length).trimStart();
  }
  let index = 0;
  let depth = 0;
  const nested = (fn) => {
    if (++depth > 64) throw new Error("Expression is nested too deeply.");
    try { return fn(); } finally { depth--; }
  };
  const take = (token) => tokens[index] === token ? (index++, true) : false;
  const need = (token) => { if (!take(token)) throw new Error(`Expected ${token}.`); };
  const atom = () => nested(() => {
    if (take("(")) { const value = add(); need(")"); return value; }
    const token = tokens[index++];
    if (token === "pi") return Math.PI;
    if (token === "e") return Math.E;
    if (/^(?:\d|\.\d)/.test(token || "")) return Number(token);
    if (!Object.hasOwn(functions, token || "")) throw new Error("Unknown numeric function or value.");
    need("(");
    const args = [add()];
    while (take(",")) args.push(add());
    need(")");
    const [arity, fn] = functions[token];
    if (arity !== null && args.length !== arity) throw new Error(`${token} needs ${arity} arguments.`);
    return fn(...args);
  });
  const power = () => {
    const value = atom();
    return take("^") || take("**") ? value ** unary() : value;
  };
  const unary = () => nested(() => take("+") ? unary() : take("-") ? -unary() : power());
  const multiply = () => {
    let value = unary();
    while (["*", "/", "%"].includes(tokens[index])) {
      const op = tokens[index++]; const right = unary();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const add = () => {
    let value = multiply();
    while (["+", "-"].includes(tokens[index])) {
      const op = tokens[index++]; const right = multiply();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const value = add();
  if (index !== tokens.length) throw new Error("Unexpected expression suffix.");
  if (!Number.isFinite(value)) throw new Error("Expression has no finite real result.");
  return value;
}

const calculateBatch = (args) => {
  if (!Array.isArray(args?.expressions) || !args.expressions.length || args.expressions.length > 50) {
    return { error: "Provide 1–50 numeric expressions." };
  }
  return { precision: "IEEE 754 double; radians for angles; round only for final presentation", results: args.expressions.map((expression) => {
    try {
      const value = calculate(expression);
      const fraction = asFraction(value);
      return fraction ? { expression, value, fraction } : { expression, value };
    }
    catch (error) { return { expression, error: error.message }; }
  }) };
};
module.exports = { calculate, calculateBatch, asFraction };
