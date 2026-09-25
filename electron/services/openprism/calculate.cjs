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
};

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
    try { return { expression, value: calculate(expression) }; }
    catch (error) { return { expression, error: error.message }; }
  }) };
};
module.exports = { calculate, calculateBatch };
