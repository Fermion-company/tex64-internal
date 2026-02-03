import type { MathKey } from "./types.js";
import { collectKeyVariants, extractCommand, getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import type { WysiwygPackId } from "./math-wysiwyg-packs.js";

export type Candidate = {
  id: string;
  key: MathKey;
  label: string;
  hint: string;
  displayLatex?: string;
  priority: number;
  apply?: (mathfield: any) => void;
};

type TriggerGroup = {
  trigger: string;
  candidates: Candidate[];
  priority: number;
  pack: WysiwygPackId;
};

const isWordToken = (value: string) => /^[A-Za-z]+$/.test(value);

const buildMathKeyDisplayLatex = (key: MathKey) => {
  const source = key.displayLatex ?? key.latex ?? key.fallback;
  if (!source) {
    return null;
  }
  const placeholders = ["x", "y", "z", "a", "b", "c"];
  let index = 0;
  return source.replace(/#\?/g, () => {
    const value = placeholders[index] ?? "x";
    index += 1;
    return value;
  });
};

export const makeCandidate = (
  trigger: string,
  key: MathKey,
  priority: number,
  labelOverride?: string,
  displayLatexOverride?: string
): Candidate => {
  const label = labelOverride ?? key.label ?? trigger;
  const displayLatex = displayLatexOverride ?? buildMathKeyDisplayLatex(key) ?? undefined;
  const id = `${normalizeLatexKey(key.latex)}|${label}`;
  return {
    id,
    key,
    label,
    hint: trigger,
    displayLatex,
    priority,
  };
};

const MANUAL_TRIGGERS: Array<{
  trigger: string;
  priority: number;
  candidates: Array<{ latex: string; label: string; displayLatex?: string }>;
  pack?: WysiwygPackId;
}> = [
  {
    trigger: "sum",
    priority: 120,
    candidates: [
      { latex: "\\sum", label: "Σ", displayLatex: "\\sum" },
      { latex: "\\sum_{#?}^{#?}", label: "Σ_{ }^{ }", displayLatex: "\\sum_{i=1}^{n}" },
      { latex: "\\prod", label: "Π", displayLatex: "\\prod" },
    ],
  },
  {
    trigger: "prod",
    priority: 120,
    candidates: [
      { latex: "\\prod", label: "Π", displayLatex: "\\prod" },
      { latex: "\\prod_{#?}^{#?}", label: "Π_{ }^{ }", displayLatex: "\\prod_{i=1}^{n}" },
    ],
  },
  {
    trigger: "int",
    priority: 120,
    candidates: [
      { latex: "\\int", label: "∫", displayLatex: "\\int" },
      {
        latex: "\\int #? \\, \\mathrm{d}#?",
        label: "∫ f dx",
        displayLatex: "\\int f(x)\\,\\mathrm{d}x",
      },
      { latex: "\\int_{#?}^{#?}", label: "∫_{ }^{ }", displayLatex: "\\int_{0}^{1}" },
      { latex: "\\iint", label: "∬", displayLatex: "\\iint" },
      { latex: "\\iiint", label: "∭", displayLatex: "\\iiint" },
      { latex: "\\oint", label: "∮", displayLatex: "\\oint" },
    ],
  },
  {
    trigger: "sqrt",
    priority: 120,
    candidates: [
      { latex: "\\sqrt{#?}", label: "√", displayLatex: "\\sqrt{x}" },
      { latex: "\\sqrt[#?]{#?}", label: "√n", displayLatex: "\\sqrt[n]{x}" },
    ],
  },
  {
    trigger: "frac",
    priority: 120,
    candidates: [
      { latex: "\\frac{#?}{#?}", label: "a/b", displayLatex: "\\frac{a}{b}" },
      { latex: "\\dfrac{#?}{#?}", label: "dfrac", displayLatex: "\\dfrac{a}{b}" },
    ],
  },
  {
    trigger: "lim",
    priority: 110,
    candidates: [
      { latex: "\\lim", label: "lim", displayLatex: "\\lim" },
      {
        latex: "\\lim_{#? \\to #?}",
        label: "lim_{x→a}",
        displayLatex: "\\lim_{x \\to a}",
      },
    ],
  },
  {
    trigger: "limsup",
    priority: 100,
    candidates: [
      { latex: "\\limsup", label: "lim sup", displayLatex: "\\limsup" },
      { latex: "\\limsup_{#?}", label: "limsup_n", displayLatex: "\\limsup_{n}" },
    ],
  },
  {
    trigger: "liminf",
    priority: 100,
    candidates: [
      { latex: "\\liminf", label: "lim inf", displayLatex: "\\liminf" },
      { latex: "\\liminf_{#?}", label: "liminf_n", displayLatex: "\\liminf_{n}" },
    ],
  },
  {
    trigger: "argmin",
    priority: 90,
    candidates: [
      {
        latex: "\\operatorname*{arg\\,min}",
        label: "argmin",
        displayLatex: "\\operatorname*{arg\\,min}",
      },
    ],
  },
  {
    trigger: "argmax",
    priority: 90,
    candidates: [
      {
        latex: "\\operatorname*{arg\\,max}",
        label: "argmax",
        displayLatex: "\\operatorname*{arg\\,max}",
      },
    ],
  },
  {
    trigger: "min",
    priority: 85,
    pack: "math",
    candidates: [
      { latex: "\\min", label: "min", displayLatex: "\\min" },
      { latex: "\\min_{#?}", label: "min_{ }", displayLatex: "\\min_{x}" },
    ],
  },
  {
    trigger: "max",
    priority: 85,
    pack: "math",
    candidates: [
      { latex: "\\max", label: "max", displayLatex: "\\max" },
      { latex: "\\max_{#?}", label: "max_{ }", displayLatex: "\\max_{x}" },
    ],
  },
  {
    trigger: "sup",
    priority: 85,
    pack: "math",
    candidates: [
      { latex: "\\sup", label: "sup", displayLatex: "\\sup" },
      { latex: "\\sup_{#?}", label: "sup_{ }", displayLatex: "\\sup_{x}" },
    ],
  },
  {
    trigger: "gcd",
    priority: 85,
    pack: "math",
    candidates: [{ latex: "\\gcd", label: "gcd", displayLatex: "\\gcd" }],
  },
  {
    trigger: "lcm",
    priority: 85,
    pack: "math",
    candidates: [
      {
        latex: "\\operatorname{lcm}",
        label: "lcm",
        displayLatex: "\\operatorname{lcm}",
      },
    ],
  },
  {
    trigger: "mod",
    priority: 80,
    pack: "math",
    candidates: [
      { latex: "\\bmod", label: "bmod", displayLatex: "\\bmod" },
      { latex: "\\pmod{#?}", label: "pmod", displayLatex: "\\pmod{n}" },
    ],
  },
  {
    trigger: "sgn",
    priority: 80,
    pack: "math",
    candidates: [
      {
        latex: "\\operatorname{sgn}",
        label: "sgn",
        displayLatex: "\\operatorname{sgn}",
      },
    ],
  },
  {
    trigger: "det",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\det", label: "det", displayLatex: "\\det" }],
  },
  {
    trigger: "tr",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\operatorname{tr}",
        label: "tr",
        displayLatex: "\\operatorname{tr}",
      },
    ],
  },
  {
    trigger: "rank",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\operatorname{rank}",
        label: "rank",
        displayLatex: "\\operatorname{rank}",
      },
    ],
  },
  {
    trigger: "ker",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\ker", label: "ker", displayLatex: "\\ker" }],
  },
  {
    trigger: "dim",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\dim", label: "dim", displayLatex: "\\dim" }],
  },
  {
    trigger: "Var",
    priority: 85,
    pack: "cs",
    candidates: [
      {
        latex: "\\operatorname{Var}",
        label: "Var",
        displayLatex: "\\operatorname{Var}",
      },
    ],
  },
  {
    trigger: "Cov",
    priority: 85,
    pack: "cs",
    candidates: [
      {
        latex: "\\operatorname{Cov}",
        label: "Cov",
        displayLatex: "\\operatorname{Cov}",
      },
    ],
  },
  {
    trigger: "set",
    priority: 90,
    pack: "cs",
    candidates: [
      {
        latex: "\\left\\{#? \\mid #?\\right\\}",
        label: "{ x | ... }",
        displayLatex: "\\left\\{x \\mid x>0\\right\\}",
      },
    ],
  },
  {
    trigger: "matrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{matrix}#?&#?\\\\#?&#?\\end{matrix}",
        label: "matrix",
        displayLatex: "\\begin{matrix}a&b\\\\c&d\\end{matrix}",
      },
    ],
  },
  {
    trigger: "pmatrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}",
        label: "pmatrix",
        displayLatex: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      },
    ],
  },
  {
    trigger: "bmatrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}",
        label: "bmatrix",
        displayLatex: "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}",
      },
    ],
  },
  {
    trigger: "Bmatrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{Bmatrix}#?&#?\\\\#?&#?\\end{Bmatrix}",
        label: "Bmatrix",
        displayLatex: "\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}",
      },
    ],
  },
  {
    trigger: "vmatrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}",
        label: "vmatrix",
        displayLatex: "\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}",
      },
    ],
  },
  {
    trigger: "Vmatrix",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{Vmatrix}#?&#?\\\\#?&#?\\end{Vmatrix}",
        label: "Vmatrix",
        displayLatex: "\\begin{Vmatrix}a&b\\\\c&d\\end{Vmatrix}",
      },
    ],
  },
  {
    trigger: "cases",
    priority: 100,
    candidates: [
      {
        latex: "\\begin{cases}#?&#?\\\\#?&#?\\end{cases}",
        label: "cases",
        displayLatex: "\\begin{cases}x&x>0\\\\-x&x\\le 0\\end{cases}",
      },
      {
        latex: "\\begin{cases}#? , & #?\\\\#? , & #?\\end{cases}",
        label: "cases (cond)",
        displayLatex: "\\begin{cases}x,&x>0\\\\-x,&x\\le 0\\end{cases}",
      },
    ],
  },
  {
    trigger: "binom",
    priority: 90,
    candidates: [
      { latex: "\\binom{#?}{#?}", label: "nCk", displayLatex: "\\binom{n}{k}" },
    ],
  },
  {
    trigger: "abs",
    priority: 90,
    candidates: [
      {
        latex: "\\left|#?\\right|",
        label: "|x|",
        displayLatex: "\\left|x\\right|",
      },
    ],
  },
  {
    trigger: "norm",
    priority: 90,
    candidates: [
      {
        latex: "\\left\\lVert#?\\right\\rVert",
        label: "‖x‖",
        displayLatex: "\\left\\lVert x\\right\\rVert",
      },
    ],
  },
  {
    trigger: "ceil",
    priority: 90,
    candidates: [
      {
        latex: "\\left\\lceil#?\\right\\rceil",
        label: "⌈x⌉",
        displayLatex: "\\left\\lceil x\\right\\rceil",
      },
    ],
  },
  {
    trigger: "floor",
    priority: 90,
    candidates: [
      {
        latex: "\\left\\lfloor#?\\right\\rfloor",
        label: "⌊x⌋",
        displayLatex: "\\left\\lfloor x\\right\\rfloor",
      },
    ],
  },
  {
    trigger: "vec",
    priority: 90,
    candidates: [
      { latex: "\\vec{#?}", label: "→x", displayLatex: "\\vec{x}" },
      { latex: "\\overrightarrow{#?}", label: "over→", displayLatex: "\\overrightarrow{AB}" },
    ],
  },
  {
    trigger: "hat",
    priority: 80,
    candidates: [{ latex: "\\hat{#?}", label: "^", displayLatex: "\\hat{x}" }],
  },
  {
    trigger: "bar",
    priority: 80,
    candidates: [{ latex: "\\bar{#?}", label: "¯", displayLatex: "\\bar{x}" }],
  },
  {
    trigger: "overline",
    priority: 80,
    candidates: [
      { latex: "\\overline{#?}", label: "overline", displayLatex: "\\overline{AB}" },
    ],
  },
  {
    trigger: "underline",
    priority: 80,
    candidates: [
      { latex: "\\underline{#?}", label: "underline", displayLatex: "\\underline{AB}" },
    ],
  },
  {
    trigger: "overbrace",
    priority: 80,
    pack: "personal",
    candidates: [
      { latex: "\\overbrace{#?}", label: "overbrace", displayLatex: "\\overbrace{x}" },
      { latex: "\\overbrace{#?}^{#?}", label: "overbrace^", displayLatex: "\\overbrace{x}^{n}" },
    ],
  },
  {
    trigger: "underbrace",
    priority: 80,
    pack: "personal",
    candidates: [
      { latex: "\\underbrace{#?}", label: "underbrace", displayLatex: "\\underbrace{x}" },
      { latex: "\\underbrace{#?}_{#?}", label: "underbrace_", displayLatex: "\\underbrace{x}_{n}" },
    ],
  },
  {
    trigger: "boxed",
    priority: 75,
    pack: "personal",
    candidates: [{ latex: "\\boxed{#?}", label: "boxed", displayLatex: "\\boxed{x}" }],
  },
  {
    trigger: "cancel",
    priority: 75,
    pack: "personal",
    candidates: [
      { latex: "\\cancel{#?}", label: "cancel", displayLatex: "\\cancel{x}" },
      { latex: "\\bcancel{#?}", label: "bcancel", displayLatex: "\\bcancel{x}" },
      { latex: "\\xcancel{#?}", label: "xcancel", displayLatex: "\\xcancel{x}" },
    ],
  },
  {
    trigger: "cancelto",
    priority: 70,
    pack: "personal",
    candidates: [
      { latex: "\\cancelto{#?}{#?}", label: "cancelto", displayLatex: "\\cancelto{0}{x}" },
    ],
  },
  {
    trigger: "tilde",
    priority: 80,
    candidates: [{ latex: "\\tilde{#?}", label: "~", displayLatex: "\\tilde{x}" }],
  },
  {
    trigger: "dot",
    priority: 80,
    candidates: [
      { latex: "\\cdot", label: "⋅", displayLatex: "\\cdot" },
      { latex: "\\dot{#?}", label: "dot", displayLatex: "\\dot{x}" },
    ],
  },
  {
    trigger: "ddot",
    priority: 80,
    candidates: [{ latex: "\\ddot{#?}", label: "ddot", displayLatex: "\\ddot{x}" }],
  },
  {
    trigger: "angle",
    priority: 80,
    candidates: [{ latex: "\\angle", label: "∠", displayLatex: "\\angle" }],
  },
  {
    trigger: "real",
    priority: 90,
    candidates: [{ latex: "\\mathbb{R}", label: "ℝ", displayLatex: "\\mathbb{R}" }],
  },
  {
    trigger: "complex",
    priority: 90,
    candidates: [{ latex: "\\mathbb{C}", label: "ℂ", displayLatex: "\\mathbb{C}" }],
  },
  {
    trigger: "integer",
    priority: 90,
    candidates: [{ latex: "\\mathbb{Z}", label: "ℤ", displayLatex: "\\mathbb{Z}" }],
  },
  {
    trigger: "rational",
    priority: 90,
    candidates: [{ latex: "\\mathbb{Q}", label: "ℚ", displayLatex: "\\mathbb{Q}" }],
  },
  {
    trigger: "natural",
    priority: 90,
    candidates: [{ latex: "\\mathbb{N}", label: "ℕ", displayLatex: "\\mathbb{N}" }],
  },
  {
    trigger: "prob",
    priority: 90,
    pack: "cs",
    candidates: [{ latex: "\\mathbb{P}", label: "ℙ", displayLatex: "\\mathbb{P}" }],
  },
  {
    trigger: "expect",
    priority: 90,
    pack: "cs",
    candidates: [{ latex: "\\mathbb{E}", label: "E", displayLatex: "\\mathbb{E}" }],
  },
  {
    trigger: "log",
    priority: 110,
    candidates: [
      { latex: "\\log", label: "log", displayLatex: "\\log" },
      { latex: "\\log_{#?}", label: "log_b", displayLatex: "\\log_{b}" },
    ],
  },
  {
    trigger: "ln",
    priority: 110,
    candidates: [{ latex: "\\ln", label: "ln", displayLatex: "\\ln" }],
  },
  {
    trigger: "exp",
    priority: 110,
    candidates: [
      { latex: "\\exp", label: "exp", displayLatex: "\\exp" },
      { latex: "e^{#?}", label: "e^", displayLatex: "e^{x}" },
    ],
  },
  {
    trigger: "sin",
    priority: 110,
    candidates: [{ latex: "\\sin", label: "sin", displayLatex: "\\sin" }],
  },
  {
    trigger: "cos",
    priority: 110,
    candidates: [{ latex: "\\cos", label: "cos", displayLatex: "\\cos" }],
  },
  {
    trigger: "tan",
    priority: 110,
    candidates: [{ latex: "\\tan", label: "tan", displayLatex: "\\tan" }],
  },
  {
    trigger: "cot",
    priority: 100,
    candidates: [{ latex: "\\cot", label: "cot", displayLatex: "\\cot" }],
  },
  {
    trigger: "sec",
    priority: 100,
    candidates: [{ latex: "\\sec", label: "sec", displayLatex: "\\sec" }],
  },
  {
    trigger: "csc",
    priority: 100,
    candidates: [{ latex: "\\csc", label: "csc", displayLatex: "\\csc" }],
  },
  {
    trigger: "arcsin",
    priority: 100,
    candidates: [{ latex: "\\arcsin", label: "arcsin", displayLatex: "\\arcsin" }],
  },
  {
    trigger: "arccos",
    priority: 100,
    candidates: [{ latex: "\\arccos", label: "arccos", displayLatex: "\\arccos" }],
  },
  {
    trigger: "arctan",
    priority: 100,
    candidates: [{ latex: "\\arctan", label: "arctan", displayLatex: "\\arctan" }],
  },
  {
    trigger: "inf",
    priority: 100,
    candidates: [
      { latex: "\\infty", label: "∞", displayLatex: "\\infty" },
      { latex: "\\inf", label: "inf", displayLatex: "\\inf" },
      { latex: "\\inf_{#?}", label: "inf_{ }", displayLatex: "\\inf_{x}" },
    ],
  },
  {
    trigger: "infty",
    priority: 100,
    candidates: [{ latex: "\\infty", label: "∞", displayLatex: "\\infty" }],
  },
  {
    trigger: "alpha",
    priority: 85,
    candidates: [{ latex: "\\alpha", label: "α", displayLatex: "\\alpha" }],
  },
  {
    trigger: "beta",
    priority: 85,
    candidates: [{ latex: "\\beta", label: "β", displayLatex: "\\beta" }],
  },
  {
    trigger: "gamma",
    priority: 85,
    candidates: [
      { latex: "\\gamma", label: "γ", displayLatex: "\\gamma" },
      { latex: "\\Gamma", label: "Γ", displayLatex: "\\Gamma" },
    ],
  },
  {
    trigger: "delta",
    priority: 85,
    candidates: [
      { latex: "\\delta", label: "δ", displayLatex: "\\delta" },
      { latex: "\\Delta", label: "Δ", displayLatex: "\\Delta" },
    ],
  },
  {
    trigger: "zeta",
    priority: 85,
    candidates: [{ latex: "\\zeta", label: "ζ", displayLatex: "\\zeta" }],
  },
  {
    trigger: "eta",
    priority: 85,
    candidates: [{ latex: "\\eta", label: "η", displayLatex: "\\eta" }],
  },
  {
    trigger: "iota",
    priority: 85,
    candidates: [{ latex: "\\iota", label: "ι", displayLatex: "\\iota" }],
  },
  {
    trigger: "kappa",
    priority: 85,
    candidates: [
      { latex: "\\kappa", label: "κ", displayLatex: "\\kappa" },
      { latex: "\\varkappa", label: "ϰ", displayLatex: "\\varkappa" },
    ],
  },
  {
    trigger: "lambda",
    priority: 85,
    candidates: [
      { latex: "\\lambda", label: "λ", displayLatex: "\\lambda" },
      { latex: "\\Lambda", label: "Λ", displayLatex: "\\Lambda" },
    ],
  },
  {
    trigger: "mu",
    priority: 85,
    candidates: [{ latex: "\\mu", label: "μ", displayLatex: "\\mu" }],
  },
  {
    trigger: "nu",
    priority: 85,
    candidates: [{ latex: "\\nu", label: "ν", displayLatex: "\\nu" }],
  },
  {
    trigger: "xi",
    priority: 85,
    candidates: [
      { latex: "\\xi", label: "ξ", displayLatex: "\\xi" },
      { latex: "\\Xi", label: "Ξ", displayLatex: "\\Xi" },
    ],
  },
  {
    trigger: "tau",
    priority: 85,
    candidates: [{ latex: "\\tau", label: "τ", displayLatex: "\\tau" }],
  },
  {
    trigger: "upsilon",
    priority: 85,
    candidates: [
      { latex: "\\upsilon", label: "υ", displayLatex: "\\upsilon" },
      { latex: "\\Upsilon", label: "Υ", displayLatex: "\\Upsilon" },
    ],
  },
  {
    trigger: "chi",
    priority: 85,
    candidates: [{ latex: "\\chi", label: "χ", displayLatex: "\\chi" }],
  },
  {
    trigger: "psi",
    priority: 85,
    candidates: [
      { latex: "\\psi", label: "ψ", displayLatex: "\\psi" },
      { latex: "\\Psi", label: "Ψ", displayLatex: "\\Psi" },
    ],
  },
  {
    trigger: "omega",
    priority: 85,
    candidates: [
      { latex: "\\omega", label: "ω", displayLatex: "\\omega" },
      { latex: "\\Omega", label: "Ω", displayLatex: "\\Omega" },
    ],
  },
  {
    trigger: "partial",
    priority: 90,
    candidates: [{ latex: "\\partial", label: "∂", displayLatex: "\\partial" }],
  },
  {
    trigger: "nabla",
    priority: 90,
    pack: "physics",
    candidates: [{ latex: "\\nabla", label: "∇", displayLatex: "\\nabla" }],
  },
  {
    trigger: "grad",
    priority: 80,
    pack: "physics",
    candidates: [{ latex: "\\nabla", label: "∇", displayLatex: "\\nabla" }],
  },
  {
    trigger: "forall",
    priority: 90,
    pack: "cs",
    candidates: [{ latex: "\\forall", label: "∀", displayLatex: "\\forall" }],
  },
  {
    trigger: "exists",
    priority: 90,
    pack: "cs",
    candidates: [{ latex: "\\exists", label: "∃", displayLatex: "\\exists" }],
  },
  {
    trigger: "empty",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\emptyset", label: "∅", displayLatex: "\\emptyset" }],
  },
  {
    trigger: "in",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\in", label: "∈", displayLatex: "\\in" }],
  },
  {
    trigger: "notin",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\notin", label: "∉", displayLatex: "\\notin" }],
  },
  {
    trigger: "mid",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mid", label: "∣", displayLatex: "\\mid" }],
  },
  {
    trigger: "nmid",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\nmid", label: "∤", displayLatex: "\\nmid" }],
  },
  {
    trigger: "parallel",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\parallel", label: "∥", displayLatex: "\\parallel" }],
  },
  {
    trigger: "perp",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\perp", label: "⊥", displayLatex: "\\perp" }],
  },
  {
    trigger: "subset",
    priority: 80,
    pack: "cs",
    candidates: [
      { latex: "\\subset", label: "⊂", displayLatex: "\\subset" },
      { latex: "\\subseteq", label: "⊆", displayLatex: "\\subseteq" },
      { latex: "\\subsetneq", label: "⊊", displayLatex: "\\subsetneq" },
    ],
  },
  {
    trigger: "supset",
    priority: 80,
    pack: "cs",
    candidates: [
      { latex: "\\supset", label: "⊃", displayLatex: "\\supset" },
      { latex: "\\supseteq", label: "⊇", displayLatex: "\\supseteq" },
      { latex: "\\supsetneq", label: "⊋", displayLatex: "\\supsetneq" },
    ],
  },
  {
    trigger: "cup",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\cup", label: "∪", displayLatex: "\\cup" }],
  },
  {
    trigger: "bigcup",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\bigcup", label: "⋃", displayLatex: "\\bigcup" }],
  },
  {
    trigger: "cap",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\cap", label: "∩", displayLatex: "\\cap" }],
  },
  {
    trigger: "bigcap",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\bigcap", label: "⋂", displayLatex: "\\bigcap" }],
  },
  {
    trigger: "iff",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\iff", label: "⇔", displayLatex: "\\iff" }],
  },
  {
    trigger: "therefore",
    priority: 70,
    pack: "cs",
    candidates: [{ latex: "\\therefore", label: "∴", displayLatex: "\\therefore" }],
  },
  {
    trigger: "because",
    priority: 70,
    pack: "cs",
    candidates: [{ latex: "\\because", label: "∵", displayLatex: "\\because" }],
  },
  {
    trigger: "epsilon",
    priority: 85,
    candidates: [
      { latex: "\\epsilon", label: "ε", displayLatex: "\\epsilon" },
      { latex: "\\varepsilon", label: "ϵ", displayLatex: "\\varepsilon" },
    ],
  },
  {
    trigger: "theta",
    priority: 85,
    candidates: [
      { latex: "\\theta", label: "θ", displayLatex: "\\theta" },
      { latex: "\\vartheta", label: "ϑ", displayLatex: "\\vartheta" },
    ],
  },
  {
    trigger: "phi",
    priority: 85,
    candidates: [
      { latex: "\\phi", label: "φ", displayLatex: "\\phi" },
      { latex: "\\varphi", label: "ϕ", displayLatex: "\\varphi" },
    ],
  },
  {
    trigger: "rho",
    priority: 85,
    candidates: [
      { latex: "\\rho", label: "ρ", displayLatex: "\\rho" },
      { latex: "\\varrho", label: "ϱ", displayLatex: "\\varrho" },
    ],
  },
  {
    trigger: "pi",
    priority: 85,
    candidates: [
      { latex: "\\pi", label: "π", displayLatex: "\\pi" },
      { latex: "\\pi_{#?}", label: "π_i", displayLatex: "\\pi_{i}" },
      { latex: "\\pi^{#?}", label: "π^2", displayLatex: "\\pi^{2}" },
      { latex: "\\pi_{#?}^{#?}", label: "π_i^n", displayLatex: "\\pi_{i}^{n}" },
      { latex: "\\varpi", label: "ϖ", displayLatex: "\\varpi" },
      { latex: "\\Pi", label: "Π", displayLatex: "\\Pi" },
    ],
  },
  {
    trigger: "sigma",
    priority: 85,
    candidates: [
      { latex: "\\sigma", label: "σ", displayLatex: "\\sigma" },
      { latex: "\\varsigma", label: "ς", displayLatex: "\\varsigma" },
      { latex: "\\Sigma", label: "Σ", displayLatex: "\\Sigma" },
    ],
  },
  {
    trigger: "leq",
    priority: 90,
    candidates: [
      { latex: "\\leq", label: "≤", displayLatex: "\\leq" },
      { latex: "\\leqq", label: "≦", displayLatex: "\\leqq" },
      { latex: "\\leqslant", label: "≤", displayLatex: "\\leqslant" },
    ],
  },
  {
    trigger: "geq",
    priority: 90,
    candidates: [
      { latex: "\\geq", label: "≥", displayLatex: "\\geq" },
      { latex: "\\geqq", label: "≧", displayLatex: "\\geqq" },
      { latex: "\\geqslant", label: "≥", displayLatex: "\\geqslant" },
    ],
  },
  {
    trigger: "neq",
    priority: 90,
    candidates: [
      { latex: "\\neq", label: "≠", displayLatex: "\\neq" },
      { latex: "\\ne", label: "≠", displayLatex: "\\ne" },
    ],
  },
  {
    trigger: "ll",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\ll", label: "≪", displayLatex: "\\ll" }],
  },
  {
    trigger: "gg",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\gg", label: "≫", displayLatex: "\\gg" }],
  },
  {
    trigger: "approx",
    priority: 90,
    candidates: [
      { latex: "\\approx", label: "≈", displayLatex: "\\approx" },
      { latex: "\\sim", label: "∼", displayLatex: "\\sim" },
      { latex: "\\simeq", label: "≃", displayLatex: "\\simeq" },
    ],
  },
  {
    trigger: "equiv",
    priority: 90,
    candidates: [
      { latex: "\\equiv", label: "≡", displayLatex: "\\equiv" },
      { latex: "\\cong", label: "≅", displayLatex: "\\cong" },
    ],
  },
  {
    trigger: "propto",
    priority: 90,
    candidates: [{ latex: "\\propto", label: "∝", displayLatex: "\\propto" }],
  },
  {
    trigger: "to",
    priority: 90,
    candidates: [
      { latex: "\\to", label: "→", displayLatex: "\\to" },
      { latex: "\\rightarrow", label: "→", displayLatex: "\\rightarrow" },
    ],
  },
  {
    trigger: "leftarrow",
    priority: 90,
    candidates: [
      { latex: "\\leftarrow", label: "←", displayLatex: "\\leftarrow" },
      { latex: "\\Leftarrow", label: "⇐", displayLatex: "\\Leftarrow" },
    ],
  },
  {
    trigger: "rightarrow",
    priority: 90,
    candidates: [
      { latex: "\\rightarrow", label: "→", displayLatex: "\\rightarrow" },
      { latex: "\\Rightarrow", label: "⇒", displayLatex: "\\Rightarrow" },
    ],
  },
  {
    trigger: "leftrightarrow",
    priority: 90,
    candidates: [
      { latex: "\\leftrightarrow", label: "↔", displayLatex: "\\leftrightarrow" },
      { latex: "\\Leftrightarrow", label: "⇔", displayLatex: "\\Leftrightarrow" },
    ],
  },
  {
    trigger: "mapsto",
    priority: 90,
    candidates: [{ latex: "\\mapsto", label: "↦", displayLatex: "\\mapsto" }],
  },
  {
    trigger: "xrightarrow",
    priority: 90,
    candidates: [
      {
        latex: "\\xrightarrow{#?}",
        label: "x→",
        displayLatex: "\\xrightarrow{a}",
      },
    ],
  },
  {
    trigger: "xleftarrow",
    priority: 90,
    candidates: [
      {
        latex: "\\xleftarrow{#?}",
        label: "x←",
        displayLatex: "\\xleftarrow{a}",
      },
    ],
  },
  {
    trigger: "overset",
    priority: 90,
    candidates: [
      { latex: "\\overset{#?}{#?}", label: "over", displayLatex: "\\overset{a}{b}" },
    ],
  },
  {
    trigger: "implies",
    priority: 85,
    candidates: [{ latex: "\\Rightarrow", label: "⇒", displayLatex: "\\Rightarrow" }],
  },
  {
    trigger: "impliedby",
    priority: 85,
    pack: "cs",
    candidates: [{ latex: "\\Leftarrow", label: "⇐", displayLatex: "\\Leftarrow" }],
  },
  {
    trigger: "cdot",
    priority: 85,
    candidates: [{ latex: "\\cdot", label: "⋅", displayLatex: "\\cdot" }],
  },
  {
    trigger: "times",
    priority: 85,
    candidates: [{ latex: "\\times", label: "×", displayLatex: "\\times" }],
  },
  {
    trigger: "div",
    priority: 85,
    candidates: [{ latex: "\\div", label: "÷", displayLatex: "\\div" }],
  },
  {
    trigger: "divide",
    priority: 130,
    candidates: [{ latex: "\\div", label: "÷", displayLatex: "\\div" }],
  },
  {
    trigger: "pm",
    priority: 85,
    candidates: [{ latex: "\\pm", label: "±", displayLatex: "\\pm" }],
  },
  {
    trigger: "mp",
    priority: 85,
    candidates: [{ latex: "\\mp", label: "∓", displayLatex: "\\mp" }],
  },
  {
    trigger: "circ",
    priority: 85,
    candidates: [{ latex: "\\circ", label: "∘", displayLatex: "\\circ" }],
  },
  {
    trigger: "oplus",
    priority: 85,
    candidates: [{ latex: "\\oplus", label: "⊕", displayLatex: "\\oplus" }],
  },
  {
    trigger: "otimes",
    priority: 85,
    candidates: [{ latex: "\\otimes", label: "⊗", displayLatex: "\\otimes" }],
  },
  {
    trigger: "setminus",
    priority: 85,
    candidates: [{ latex: "\\setminus", label: "∖", displayLatex: "\\setminus" }],
  },
  {
    trigger: "ldots",
    priority: 80,
    candidates: [{ latex: "\\ldots", label: "…", displayLatex: "\\ldots" }],
  },
  {
    trigger: "cdots",
    priority: 80,
    candidates: [{ latex: "\\cdots", label: "⋯", displayLatex: "\\cdots" }],
  },
  {
    trigger: "par",
    priority: 90,
    candidates: [
      {
        latex: "\\left(#?\\right)",
        label: "( )",
        displayLatex: "\\left(x\\right)",
      },
    ],
  },
  {
    trigger: "brack",
    priority: 90,
    candidates: [
      {
        latex: "\\left[#?\\right]",
        label: "[ ]",
        displayLatex: "\\left[x\\right]",
      },
    ],
  },
  {
    trigger: "brace",
    priority: 90,
    candidates: [
      {
        latex: "\\left\\{#?\\right\\}",
        label: "{ }",
        displayLatex: "\\left\\{x\\right\\}",
      },
    ],
  },
  {
    trigger: "anglebr",
    priority: 90,
    candidates: [
      {
        latex: "\\langle #? \\rangle",
        label: "⟨ ⟩",
        displayLatex: "\\langle x \\rangle",
      },
    ],
  },
  {
    trigger: "inner",
    priority: 90,
    candidates: [
      {
        latex: "\\langle #?, #? \\rangle",
        label: "⟨x,y⟩",
        displayLatex: "\\langle x, y \\rangle",
      },
      {
        latex: "\\langle #? \\rangle",
        label: "⟨x⟩",
        displayLatex: "\\langle x \\rangle",
      },
    ],
  },
  {
    trigger: "eval",
    priority: 90,
    candidates: [
      {
        latex: "\\left.#?\\right|_{#?}",
        label: "|_{ }",
        displayLatex: "\\left. f(x) \\right|_{x=0}",
      },
    ],
  },
  {
    trigger: "defeq",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\stackrel{def}{=}",
        label: "def=",
        displayLatex: "\\stackrel{def}{=}",
      },
    ],
  },
  {
    trigger: "and",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\land", label: "∧", displayLatex: "\\land" }],
  },
  {
    trigger: "or",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\lor", label: "∨", displayLatex: "\\lor" }],
  },
  {
    trigger: "not",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\neg", label: "¬", displayLatex: "\\neg" }],
  },
  {
    trigger: "ni",
    priority: 80,
    pack: "cs",
    candidates: [{ latex: "\\ni", label: "∋", displayLatex: "\\ni" }],
  },
  {
    trigger: "ddx",
    priority: 90,
    candidates: [
      {
        latex: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}",
        label: "d/dx",
        displayLatex: "\\frac{\\mathrm{d}x}{\\mathrm{d}t}",
      },
    ],
  },
  {
    trigger: "pdx",
    priority: 90,
    candidates: [
      {
        latex: "\\frac{\\partial #?}{\\partial #?}",
        label: "∂/∂x",
        displayLatex: "\\frac{\\partial x}{\\partial y}",
      },
    ],
  },
  {
    trigger: "d2dx2",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\frac{\\mathrm{d}^2 #?}{\\mathrm{d}#?^2}",
        label: "d^2/dx^2",
        displayLatex: "\\frac{\\mathrm{d}^2 y}{\\mathrm{d}x^2}",
      },
    ],
  },
  {
    trigger: "p2dx2",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\frac{\\partial^2 #?}{\\partial #?^2}",
        label: "∂^2/∂x^2",
        displayLatex: "\\frac{\\partial^2 f}{\\partial x^2}",
      },
    ],
  },
  {
    trigger: "d3dx3",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\frac{\\mathrm{d}^3 #?}{\\mathrm{d}#?^3}",
        label: "d^3/dx^3",
        displayLatex: "\\frac{\\mathrm{d}^3 y}{\\mathrm{d}x^3}",
      },
    ],
  },
  {
    trigger: "p3dx3",
    priority: 90,
    pack: "math",
    candidates: [
      {
        latex: "\\frac{\\partial^3 #?}{\\partial #?^3}",
        label: "∂^3/∂x^3",
        displayLatex: "\\frac{\\partial^3 f}{\\partial x^3}",
      },
    ],
  },
  {
    trigger: "divergence",
    priority: 90,
    pack: "physics",
    candidates: [{ latex: "\\nabla\\cdot", label: "∇·", displayLatex: "\\nabla\\cdot" }],
  },
  {
    trigger: "curl",
    priority: 90,
    pack: "physics",
    candidates: [
      { latex: "\\nabla\\times", label: "∇×", displayLatex: "\\nabla\\times" },
    ],
  },
  {
    trigger: "laplacian",
    priority: 90,
    pack: "physics",
    candidates: [{ latex: "\\nabla^2", label: "∇²", displayLatex: "\\nabla^2" }],
  },
  {
    trigger: "text",
    priority: 85,
    candidates: [{ latex: "\\text{#?}", label: "text", displayLatex: "\\text{unit}" }],
  },
  {
    trigger: "rm",
    priority: 80,
    candidates: [{ latex: "\\mathrm{#?}", label: "rm", displayLatex: "\\mathrm{ABC}" }],
  },
  {
    trigger: "bf",
    priority: 80,
    candidates: [{ latex: "\\mathbf{#?}", label: "bf", displayLatex: "\\mathbf{ABC}" }],
  },
  {
    trigger: "cal",
    priority: 80,
    candidates: [{ latex: "\\mathcal{#?}", label: "cal", displayLatex: "\\mathcal{A}" }],
  },
  {
    trigger: "mathbb",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathbb{#?}", label: "bb", displayLatex: "\\mathbb{A}" }],
  },
  {
    trigger: "bb",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathbb{#?}", label: "bb", displayLatex: "\\mathbb{A}" }],
  },
  {
    trigger: "mathfrak",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathfrak{#?}", label: "frak", displayLatex: "\\mathfrak{g}" }],
  },
  {
    trigger: "frak",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathfrak{#?}", label: "frak", displayLatex: "\\mathfrak{g}" }],
  },
  {
    trigger: "mathsf",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathsf{#?}", label: "sf", displayLatex: "\\mathsf{ABC}" }],
  },
  {
    trigger: "sf",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathsf{#?}", label: "sf", displayLatex: "\\mathsf{ABC}" }],
  },
  {
    trigger: "mathtt",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathtt{#?}", label: "tt", displayLatex: "\\mathtt{ABC}" }],
  },
  {
    trigger: "tt",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathtt{#?}", label: "tt", displayLatex: "\\mathtt{ABC}" }],
  },
  {
    trigger: "mathit",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathit{#?}", label: "it", displayLatex: "\\mathit{ABC}" }],
  },
  {
    trigger: "it",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\mathit{#?}", label: "it", displayLatex: "\\mathit{ABC}" }],
  },
  {
    trigger: "mathscr",
    priority: 80,
    pack: "personal",
    candidates: [{ latex: "\\mathscr{#?}", label: "scr", displayLatex: "\\mathscr{A}" }],
  },
  {
    trigger: "scr",
    priority: 80,
    pack: "personal",
    candidates: [{ latex: "\\mathscr{#?}", label: "scr", displayLatex: "\\mathscr{A}" }],
  },
  {
    trigger: "boldsymbol",
    priority: 80,
    pack: "personal",
    candidates: [
      { latex: "\\boldsymbol{#?}", label: "bold", displayLatex: "\\boldsymbol{x}" },
      { latex: "\\bm{#?}", label: "bm", displayLatex: "\\bm{x}" },
    ],
  },
  {
    trigger: "bm",
    priority: 80,
    pack: "personal",
    candidates: [{ latex: "\\bm{#?}", label: "bm", displayLatex: "\\bm{x}" }],
  },
  {
    trigger: "mathds",
    priority: 80,
    pack: "personal",
    candidates: [{ latex: "\\mathds{#?}", label: "ds", displayLatex: "\\mathbb{A}" }],
  },
  {
    trigger: "ds",
    priority: 80,
    pack: "personal",
    candidates: [{ latex: "\\mathds{#?}", label: "ds", displayLatex: "\\mathbb{A}" }],
  },
  {
    trigger: "op",
    priority: 80,
    candidates: [
      { latex: "\\operatorname{#?}", label: "op", displayLatex: "\\operatorname{Var}" },
    ],
  },
  {
    trigger: "aligned",
    priority: 80,
    candidates: [
      {
        latex: "\\begin{aligned}#? &= #?\\\\#? &= #?\\end{aligned}",
        label: "aligned",
        displayLatex: "\\begin{aligned}a &= b\\\\c &= d\\end{aligned}",
      },
    ],
  },
  {
    trigger: "array",
    priority: 80,
    candidates: [
      {
        latex: "\\begin{array}{cc}#?&#?\\\\#?&#?\\end{array}",
        label: "array{cc}",
        displayLatex: "\\begin{array}{cc}a&b\\\\c&d\\end{array}",
      },
      {
        latex: "\\begin{array}{ccc}#?&#?&#?\\\\#?&#?&#?\\end{array}",
        label: "array{ccc}",
        displayLatex: "\\begin{array}{ccc}a&b&c\\\\d&e&f\\end{array}",
      },
      {
        latex: "\\begin{array}{rcl}#?&=&#?\\\\#?&=&#?\\end{array}",
        label: "array{rcl}",
        displayLatex: "\\begin{array}{rcl}a&=&b\\\\c&=&d\\end{array}",
      },
      {
        latex: "\\begin{array}{#?}#?\\end{array}",
        label: "array{...}",
        displayLatex: "\\begin{array}{cc}a&b\\\\c&d\\end{array}",
      },
    ],
  },
  {
    trigger: "hbar",
    priority: 85,
    pack: "physics",
    candidates: [{ latex: "\\hbar", label: "ℏ", displayLatex: "\\hbar" }],
  },
  {
    trigger: "ell",
    priority: 85,
    candidates: [{ latex: "\\ell", label: "ℓ", displayLatex: "\\ell" }],
  },
  {
    trigger: "bra",
    priority: 85,
    pack: "physics",
    candidates: [
      {
        latex: "\\langle #? \\vert",
        label: "⟨ |",
        displayLatex: "\\langle \\psi \\vert",
      },
    ],
  },
  {
    trigger: "ket",
    priority: 85,
    pack: "physics",
    candidates: [
      {
        latex: "\\vert #? \\rangle",
        label: "| ⟩",
        displayLatex: "\\vert \\psi \\rangle",
      },
    ],
  },
  {
    trigger: "braket",
    priority: 85,
    pack: "physics",
    candidates: [
      {
        latex: "\\langle #? \\vert #? \\rangle",
        label: "⟨ | ⟩",
        displayLatex: "\\langle \\phi \\vert \\psi \\rangle",
      },
    ],
  },
  {
    trigger: "sekibun",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\int", label: "∫", displayLatex: "\\int" }],
  },
  {
    trigger: "shiguma",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\sum", label: "Σ", displayLatex: "\\sum" }],
  },
  {
    trigger: "henbibun",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\partial", label: "∂", displayLatex: "\\partial" }],
  },
  {
    trigger: "ruuto",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\sqrt{#?}", label: "√", displayLatex: "\\sqrt{x}" }],
  },
  {
    trigger: "bunsuu",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\frac{#?}{#?}", label: "a/b", displayLatex: "\\frac{a}{b}" }],
  },
  {
    trigger: "gyouretsu",
    priority: 70,
    pack: "jp",
    candidates: [
      {
        latex: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}",
        label: "pmatrix",
        displayLatex: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      },
    ],
  },
  {
    trigger: "bekutoru",
    priority: 70,
    pack: "jp",
    candidates: [{ latex: "\\vec{#?}", label: "→x", displayLatex: "\\vec{x}" }],
  },
  {
    trigger: "kakko",
    priority: 70,
    pack: "jp",
    candidates: [
      { latex: "\\left(#?\\right)", label: "( )", displayLatex: "\\left(x\\right)" },
    ],
  },
];

const ALIAS_TRIGGERS: Array<{
  alias: string;
  canonical: string;
  priorityBoost?: number;
}> = [
  { alias: "sigma", canonical: "sum", priorityBoost: 60 },
  { alias: "summation", canonical: "sum", priorityBoost: 50 },
  { alias: "summate", canonical: "sum", priorityBoost: 40 },
  { alias: "integral", canonical: "int", priorityBoost: 60 },
  { alias: "integrate", canonical: "int", priorityBoost: 50 },
  { alias: "integration", canonical: "int", priorityBoost: 40 },
  { alias: "antiderivative", canonical: "int", priorityBoost: 30 },
  { alias: "product", canonical: "prod", priorityBoost: 40 },
  { alias: "multiplication", canonical: "prod", priorityBoost: 30 },
  { alias: "limit", canonical: "lim", priorityBoost: 30 },
  { alias: "root", canonical: "sqrt", priorityBoost: 30 },
  { alias: "squareroot", canonical: "sqrt", priorityBoost: 30 },
  { alias: "fraction", canonical: "frac", priorityBoost: 30 },
  { alias: "divide", canonical: "frac", priorityBoost: 20 },
  { alias: "quotient", canonical: "frac", priorityBoost: 20 },
  { alias: "logarithm", canonical: "log", priorityBoost: 20 },
  { alias: "sine", canonical: "sin", priorityBoost: 20 },
  { alias: "cosine", canonical: "cos", priorityBoost: 20 },
  { alias: "tangent", canonical: "tan", priorityBoost: 20 },
  { alias: "cotangent", canonical: "cot", priorityBoost: 20 },
  { alias: "secant", canonical: "sec", priorityBoost: 20 },
  { alias: "cosecant", canonical: "csc", priorityBoost: 20 },
  { alias: "arcsine", canonical: "arcsin", priorityBoost: 20 },
  { alias: "arccosine", canonical: "arccos", priorityBoost: 20 },
  { alias: "arctangent", canonical: "arctan", priorityBoost: 20 },
  { alias: "infinity", canonical: "infty", priorityBoost: 20 },
  { alias: "infinite", canonical: "infty", priorityBoost: 15 },
  { alias: "absolute", canonical: "abs", priorityBoost: 20 },
  { alias: "absolutevalue", canonical: "abs", priorityBoost: 20 },
  { alias: "magnitude", canonical: "abs", priorityBoost: 15 },
  { alias: "norms", canonical: "norm", priorityBoost: 15 },
  { alias: "ceiling", canonical: "ceil", priorityBoost: 15 },
  { alias: "flooring", canonical: "floor", priorityBoost: 15 },
  { alias: "vector", canonical: "vec", priorityBoost: 20 },
  { alias: "arrow", canonical: "to", priorityBoost: 20 },
  { alias: "choose", canonical: "binom", priorityBoost: 20 },
  { alias: "combination", canonical: "binom", priorityBoost: 20 },
  { alias: "ncr", canonical: "binom", priorityBoost: 15 },
  { alias: "piecewise", canonical: "cases", priorityBoost: 20 },
  { alias: "mat", canonical: "matrix", priorityBoost: 15 },
  { alias: "pmat", canonical: "pmatrix", priorityBoost: 15 },
  { alias: "bmat", canonical: "bmatrix", priorityBoost: 15 },
  { alias: "realnumbers", canonical: "real", priorityBoost: 20 },
  { alias: "reals", canonical: "real", priorityBoost: 15 },
  { alias: "complexnumbers", canonical: "complex", priorityBoost: 20 },
  { alias: "complexes", canonical: "complex", priorityBoost: 15 },
  { alias: "integers", canonical: "integer", priorityBoost: 15 },
  { alias: "naturalnumbers", canonical: "natural", priorityBoost: 20 },
  { alias: "naturals", canonical: "natural", priorityBoost: 15 },
  { alias: "rationals", canonical: "rational", priorityBoost: 15 },
  { alias: "probability", canonical: "prob", priorityBoost: 20 },
  { alias: "expectation", canonical: "expect", priorityBoost: 20 },
  { alias: "union", canonical: "cup", priorityBoost: 20 },
  { alias: "intersection", canonical: "cap", priorityBoost: 20 },
  { alias: "subseteq", canonical: "subset", priorityBoost: 20 },
  { alias: "subsetof", canonical: "subset", priorityBoost: 20 },
  { alias: "subsetneq", canonical: "subset", priorityBoost: 20 },
  { alias: "superset", canonical: "supset", priorityBoost: 20 },
  { alias: "superseteq", canonical: "supset", priorityBoost: 20 },
  { alias: "supsetneq", canonical: "supset", priorityBoost: 20 },
  { alias: "element", canonical: "in", priorityBoost: 20 },
  { alias: "notelement", canonical: "notin", priorityBoost: 20 },
  { alias: "le", canonical: "leq", priorityBoost: 20 },
  { alias: "lessequal", canonical: "leq", priorityBoost: 20 },
  { alias: "leqslant", canonical: "leq", priorityBoost: 20 },
  { alias: "ge", canonical: "geq", priorityBoost: 20 },
  { alias: "greaterequal", canonical: "geq", priorityBoost: 20 },
  { alias: "geqslant", canonical: "geq", priorityBoost: 20 },
  { alias: "notequal", canonical: "neq", priorityBoost: 20 },
  { alias: "ne", canonical: "neq", priorityBoost: 20 },
  { alias: "sim", canonical: "approx", priorityBoost: 20 },
  { alias: "simeq", canonical: "approx", priorityBoost: 20 },
  { alias: "similar", canonical: "approx", priorityBoost: 20 },
  { alias: "approximately", canonical: "approx", priorityBoost: 20 },
  { alias: "cong", canonical: "equiv", priorityBoost: 20 },
  { alias: "congruent", canonical: "equiv", priorityBoost: 20 },
  { alias: "identical", canonical: "equiv", priorityBoost: 20 },
  { alias: "proportional", canonical: "propto", priorityBoost: 20 },
  { alias: "goes", canonical: "to", priorityBoost: 20 },
  { alias: "left", canonical: "leftarrow", priorityBoost: 20 },
  { alias: "iff2", canonical: "leftrightarrow", priorityBoost: 20 },
  { alias: "maps", canonical: "mapsto", priorityBoost: 20 },
  { alias: "labeledarrow", canonical: "xrightarrow", priorityBoost: 20 },
  { alias: "stackrel", canonical: "overset", priorityBoost: 20 },
  { alias: "multiply", canonical: "times", priorityBoost: 20 },
  { alias: "plusminus", canonical: "pm", priorityBoost: 20 },
  { alias: "compose", canonical: "circ", priorityBoost: 20 },
  { alias: "directsum", canonical: "oplus", priorityBoost: 20 },
  { alias: "tensor", canonical: "otimes", priorityBoost: 20 },
  { alias: "difference", canonical: "setminus", priorityBoost: 20 },
  { alias: "parentheses", canonical: "par", priorityBoost: 20 },
  { alias: "brackets", canonical: "brack", priorityBoost: 20 },
  { alias: "curly", canonical: "brace", priorityBoost: 20 },
  { alias: "langle", canonical: "anglebr", priorityBoost: 20 },
  { alias: "expectation2", canonical: "anglebr", priorityBoost: 20 },
  { alias: "dot2", canonical: "inner", priorityBoost: 20 },
  { alias: "ip", canonical: "inner", priorityBoost: 20 },
  { alias: "evaluateat", canonical: "eval", priorityBoost: 20 },
  { alias: "wedge", canonical: "and", priorityBoost: 20 },
  { alias: "vee", canonical: "or", priorityBoost: 20 },
  { alias: "lnot", canonical: "not", priorityBoost: 20 },
  { alias: "contains", canonical: "ni", priorityBoost: 20 },
  { alias: "deriv", canonical: "ddx", priorityBoost: 20 },
  { alias: "partiald", canonical: "pdx", priorityBoost: 20 },
  { alias: "curl2", canonical: "curl", priorityBoost: 20 },
  { alias: "laplace", canonical: "laplacian", priorityBoost: 20 },
  { alias: "roman", canonical: "rm", priorityBoost: 20 },
  { alias: "bold", canonical: "bf", priorityBoost: 20 },
  { alias: "script", canonical: "cal", priorityBoost: 20 },
  { alias: "operatorname", canonical: "op", priorityBoost: 20 },
  { alias: "mathrmtext", canonical: "text", priorityBoost: 20 },
  { alias: "align", canonical: "aligned", priorityBoost: 20 },
  { alias: "cases2", canonical: "array", priorityBoost: 20 },
  { alias: "table", canonical: "array", priorityBoost: 20 },
];

const buildTriggerMap = () => {
  const map = new Map<string, TriggerGroup>();

  const addCandidate = (
    trigger: string,
    key: MathKey,
    priority: number,
    labelOverride?: string,
    displayLatexOverride?: string,
    groupPriority?: number,
    pack: WysiwygPackId = "core"
  ) => {
    const normalizedTrigger = trigger.toLowerCase();
    const candidate = makeCandidate(
      normalizedTrigger,
      key,
      priority,
      labelOverride,
      displayLatexOverride
    );
    const existing = map.get(normalizedTrigger);
    if (!existing) {
      map.set(normalizedTrigger, {
        trigger: normalizedTrigger,
        candidates: [candidate],
        priority: groupPriority ?? 0,
        pack,
      });
      return;
    }
    if (!existing.candidates.some((item) => item.id === candidate.id)) {
      existing.candidates.push(candidate);
    }
    if (groupPriority !== undefined) {
      existing.priority = Math.max(existing.priority, groupPriority);
    }
    if (!existing.pack) {
      existing.pack = pack;
    }
  };

  MANUAL_TRIGGERS.forEach((entry) => {
    entry.candidates.forEach((candidate, index) => {
      const key = getKeyByLatex(
        candidate.latex,
        candidate.label,
        candidate.displayLatex
      );
      addCandidate(
        entry.trigger,
        key,
        entry.priority - index * 2,
        candidate.label,
        candidate.displayLatex,
        entry.priority,
        entry.pack ?? "core"
      );
    });
  });

  const variants = collectKeyVariants();
  variants.forEach((key) => {
    const command = extractCommand(key.latex);
    if (command) {
      addCandidate(command, key, 30, undefined, undefined, undefined, "core");
    }
    if (isWordToken(key.label)) {
      addCandidate(key.label, key, 20, undefined, undefined, undefined, "core");
    }
  });

  const addAliasCandidates = (
    alias: string,
    canonical: string,
    priorityBoost = 0
  ) => {
    const canonicalKey = canonical.toLowerCase();
    const aliasKey = alias.toLowerCase();
    const canonicalGroup = map.get(canonicalKey);
    if (!canonicalGroup) {
      return;
    }
    let aliasGroup = map.get(aliasKey);
    if (!aliasGroup) {
      aliasGroup = {
        trigger: aliasKey,
        candidates: [],
        priority: canonicalGroup.priority,
        pack: canonicalGroup.pack,
      };
      map.set(aliasKey, aliasGroup);
    }
    canonicalGroup.candidates.forEach((candidate) => {
      const aliasCandidate: Candidate = {
        ...candidate,
        hint: canonicalGroup.trigger,
        priority: candidate.priority + priorityBoost,
      };
      if (!aliasGroup?.candidates.some((item) => item.id === aliasCandidate.id)) {
        aliasGroup?.candidates.push(aliasCandidate);
      }
    });
    aliasGroup.priority = Math.max(
      aliasGroup.priority,
      canonicalGroup.priority + priorityBoost
    );
    aliasGroup.pack = canonicalGroup.pack;
  };

  ALIAS_TRIGGERS.forEach((entry) => {
    addAliasCandidates(entry.alias, entry.canonical, entry.priorityBoost ?? 0);
  });

  return map;
};

export const TRIGGER_MAP = buildTriggerMap();
export const TRIGGER_KEYS = Array.from(TRIGGER_MAP.keys());
