import { deterministicUuid } from "./run-identity";

// Matches zod's uuid() exactly (version 1-8, variant 8/9/a/b): models emit
// "UUID-shaped" ids with invalid version nibbles, and a laxer pattern here
// would let them through unmapped only to fail schema validation later.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BINARY_OPERATORS = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
  "equals",
  "approximatelyEquals",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "notEquals",
  "in",
  "notIn",
  "subset",
  "subsetOrEqual",
  "superset",
  "supersetOrEqual",
  "union",
  "intersection",
  "setDifference",
  "and",
  "or",
  "implies",
  "ifAndOnlyIf",
  "proportionalTo",
]);
const UNARY_OPERATORS = new Set([
  "negate",
  "sqrt",
  "absolute",
  "norm",
  "floor",
  "ceiling",
  "not",
]);
const STATISTICAL_OPERATORS = new Set([
  "probability",
  "expectation",
  "variance",
  "covariance",
]);
const FUNCTION_NAMES = new Set([
  "sin",
  "cos",
  "tan",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "exp",
  "min",
  "max",
  "det",
  "gcd",
  "lcm",
  "arg",
  "realPart",
  "imaginaryPart",
]);
const ACCENTS = new Set(["hat", "bar", "tilde", "dot", "doubleDot", "vector"]);
const SYMBOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const LITERAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const GREEK_SYMBOLS: Readonly<Record<string, string>> = {
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon",
  "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa",
  "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho",
  "σ": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "χ": "chi",
  "ψ": "psi", "ω": "omega", "Γ": "Gamma", "Δ": "Delta", "Θ": "Theta",
  "Λ": "Lambda", "Ξ": "Xi", "Π": "Pi", "Σ": "Sigma", "Φ": "Phi",
  "Ψ": "Psi", "Ω": "Omega", "∞": "infty",
};

/**
 * Models write structured math with predictable shortcuts: an operator name
 * as the `kind` itself, Unicode greek or numerics as symbol names, plain
 * numbers for literal values. Each has one faithful structured form, so
 * rewrite instead of failing — anything else stays for zod to report.
 */
function normalizeMathExpression(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMathExpression(entry));
  }
  if (!value || typeof value !== "object") return value;
  let node = value as Record<string, unknown>;
  const kind = typeof node.kind === "string" ? node.kind : null;

  if (kind === "negative") {
    node = {
      kind: "unary",
      operator: "negate",
      operand: node.operand ?? node.expression ?? node.left,
    };
  } else if (kind && BINARY_OPERATORS.has(kind)) {
    node = { kind: "binary", operator: kind, left: node.left, right: node.right };
  } else if (kind && UNARY_OPERATORS.has(kind)) {
    node = {
      kind: "unary",
      operator: kind,
      operand: node.operand ?? node.expression ?? node.left,
    };
  } else if (kind && STATISTICAL_OPERATORS.has(kind)) {
    node = {
      kind: "statisticalOperator",
      operator: kind,
      expression: node.expression ?? node.operand,
      ...(node.condition === undefined ? {} : { condition: node.condition }),
      ...(node.subscript === undefined ? {} : { subscript: node.subscript }),
    };
  } else if (kind === "sum" || kind === "product") {
    node = {
      kind: "largeOperator",
      operator: kind,
      expression: node.expression ?? node.operand,
      ...(node.index === undefined ? {} : { index: node.index }),
      ...(node.lowerBound === undefined ? {} : { lowerBound: node.lowerBound }),
      ...(node.upperBound === undefined ? {} : { upperBound: node.upperBound }),
    };
  } else if (kind && FUNCTION_NAMES.has(kind)) {
    const args = Array.isArray(node.arguments)
      ? node.arguments
      : [node.operand ?? node.expression].filter((entry) => entry !== undefined);
    node = { kind: "function", name: kind, arguments: args };
  } else if (kind && ACCENTS.has(kind) && kind !== "vector") {
    node = {
      kind: "accent",
      accent: kind,
      expression: node.expression ?? node.operand,
    };
  } else if (
    kind &&
    !("left" in node) &&
    !("operand" in node) &&
    !("expression" in node) &&
    !("arguments" in node) &&
    Object.keys(node).length === 1 &&
    SYMBOL_NAME_PATTERN.test(kind)
  ) {
    // `{kind: "theta"}` — the name landed in the discriminator slot.
    node = { kind: "symbol", name: kind };
  }

  if (node.kind === "symbol" && typeof node.name === "string") {
    let name = node.name.replace(/^\\+/u, "");
    name = GREEK_SYMBOLS[name] ?? name;
    if (LITERAL_PATTERN.test(name)) {
      return { kind: "literal", value: name };
    }
    if (!SYMBOL_NAME_PATTERN.test(name)) {
      return { kind: "text", value: node.name };
    }
    return { kind: "symbol", name };
  }
  if (node.kind === "literal" && typeof node.value === "number") {
    node = { ...node, value: String(node.value) };
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(node)) {
    result[key] =
      key === "kind" || key === "operator" || key === "name" ||
      key === "accent" || key === "relation" || key === "annotation" ||
      key === "value" || key === "quantifier" || key === "direction" ||
      key === "orientation" || key === "delimiter" || key === "order"
        ? entry
        : normalizeMathExpression(entry);
  }
  return result;
}

/**
 * Identifier-valued keys inside a document patch. `sourceId` is deliberately
 * absent: it must name a verified source record and is never invented here.
 */
const ID_KEYS = new Set([
  "id",
  "nodeId",
  "parentId",
  "columnId",
  "citationId",
  "footnoteId",
  "targetId",
  "from",
  "to",
]);
const ID_LIST_KEYS = new Set(["children", "citationIds"]);

const SUBSCRIPT_CHARS: Readonly<Record<string, string>> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "₊": "+", "₋": "-", "₌": "=", "₍": "(", "₎": ")",
  "ₐ": "a", "ₑ": "e", "ₕ": "h", "ᵢ": "i", "ⱼ": "j", "ₖ": "k",
  "ₗ": "l", "ₘ": "m", "ₙ": "n", "ₒ": "o", "ₚ": "p", "ᵣ": "r",
  "ₛ": "s", "ₜ": "t", "ᵤ": "u", "ᵥ": "v", "ₓ": "x",
};
const SUPERSCRIPT_CHARS: Readonly<Record<string, string>> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-", "⁼": "=", "⁽": "(", "⁾": ")",
  "ⁿ": "n", "ⁱ": "i",
};

/**
 * Unicode sub/superscript characters in prose (a model writing "x₀" as
 * plain text) have no glyphs in the Japanese text fonts and fail the
 * typesetting gate as missing characters. The document model's own marks
 * express the same intent, so split such runs into marked segments.
 */
function splitScriptedTextRun(
  run: Record<string, unknown>,
): Record<string, unknown>[] {
  const text = run.text;
  if (typeof text !== "string") return [run];
  const baseMarks = Array.isArray(run.marks) ? run.marks : [];
  if (baseMarks.includes("subscript") || baseMarks.includes("superscript")) {
    return [run];
  }
  const segments: { text: string; script: "subscript" | "superscript" | null }[] = [];
  for (const character of text) {
    const script =
      SUBSCRIPT_CHARS[character] !== undefined
        ? ("subscript" as const)
        : SUPERSCRIPT_CHARS[character] !== undefined
          ? ("superscript" as const)
          : null;
    const mapped =
      script === "subscript"
        ? SUBSCRIPT_CHARS[character]!
        : script === "superscript"
          ? SUPERSCRIPT_CHARS[character]!
          : character;
    const last = segments[segments.length - 1];
    if (last && last.script === script) last.text += mapped;
    else segments.push({ text: mapped, script });
  }
  if (segments.every((segment) => segment.script === null)) return [run];
  return segments.map((segment) => ({
    ...run,
    text: segment.text,
    marks:
      segment.script === null ? baseMarks : [...baseMarks, segment.script],
  }));
}

function normalizeScriptedInlineText(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => normalizeScriptedInlineText(entry));
    return mapped.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).type === "text"
        ? splitScriptedTextRun(entry as Record<string, unknown>)
        : [entry],
    );
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = normalizeScriptedInlineText(entry);
  }
  return result;
}

/**
 * Models regularly hand back readable slugs ("sec-intro") where the document
 * contract requires stable UUIDs. The slugs are internally consistent, so
 * rewrite them deterministically (documentId-scoped) instead of failing the
 * whole patch: the same slug always maps to the same UUID, references inside
 * the patch stay coherent, and ids that already are UUIDs pass untouched.
 */
export function normalizeModelDocumentPatch(
  documentId: string,
  patch: unknown,
): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const mapId = (value: unknown): unknown =>
    typeof value === "string" && value.length > 0 && !UUID_PATTERN.test(value)
      ? deterministicUuid(`${documentId}:model-node:${value}`)
      : value;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((entry) => walk(entry));
    }
    if (!node || typeof node !== "object") return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (ID_KEYS.has(key)) {
        result[key] = mapId(value);
      } else if (ID_LIST_KEYS.has(key) && Array.isArray(value)) {
        // section.children is a list of id strings while listItem.children
        // nests objects — map the strings, keep walking anything else.
        result[key] = value.map((entry) =>
          typeof entry === "string" ? mapId(entry) : walk(entry),
        );
      } else {
        result[key] = walk(value);
      }
    }
    if (
      (result.type === "equation" || result.type === "inlineMath") &&
      result.expression !== undefined
    ) {
      result.expression = normalizeMathExpression(result.expression);
    }
    return result;
  };

  const cloned = normalizeScriptedInlineText(
    walk(patch),
  ) as Record<string, unknown>;
  // The envelope's documentId is contractual, not model-invented.
  if (typeof (patch as Record<string, unknown>).documentId === "string") {
    cloned.documentId = (patch as Record<string, unknown>).documentId;
  }
  if (Array.isArray(cloned.operations)) {
    for (const operation of cloned.operations) {
      if (!operation || typeof operation !== "object") continue;
      const record = operation as Record<string, unknown>;
      const node =
        record.node && typeof record.node === "object" && !Array.isArray(record.node)
          ? (record.node as Record<string, unknown>)
          : null;
      if (!node) continue;
      // Models nest the insert position inside the node; hoist it.
      if (
        record.position === undefined &&
        node.position &&
        typeof node.position === "object"
      ) {
        record.position = node.position;
        delete node.position;
      }
      // planItemId must reference a real plan item; an invented value only
      // unlinks plan tracking, so drop it rather than failing the patch.
      if (
        typeof node.planItemId === "string" &&
        !UUID_PATTERN.test(node.planItemId)
      ) {
        delete node.planItemId;
      }
    }
  }
  return cloned;
}
