export const MANUAL_TRIGGERS_PART_2 = [
    {
        trigger: "dot",
        priority: 80,
        candidates: [
            { latex: "\\dot{#?}", label: "dot", displayLatex: "\\dot{x}" },
            { latex: "\\cdot", label: "⋅", displayLatex: "\\cdot" },
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
        candidates: [{ latex: "\\mathbb{P}", label: "ℙ", displayLatex: "\\mathbb{P}" }],
    },
    {
        trigger: "expect",
        priority: 90,
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
            { latex: "\\inf", label: "inf", displayLatex: "\\inf" },
            { latex: "\\inf_{#?}", label: "inf_{ }", displayLatex: "\\inf_{x}" },
            { latex: "\\infty", label: "∞", displayLatex: "\\infty" },
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
        candidates: [{ latex: "\\nabla", label: "∇", displayLatex: "\\nabla" }],
    },
    {
        trigger: "grad",
        priority: 80,
        candidates: [{ latex: "\\nabla", label: "∇", displayLatex: "\\nabla" }],
    },
    {
        trigger: "forall",
        priority: 90,
        candidates: [{ latex: "\\forall", label: "∀", displayLatex: "\\forall" }],
    },
    {
        trigger: "exists",
        priority: 90,
        candidates: [{ latex: "\\exists", label: "∃", displayLatex: "\\exists" }],
    },
    {
        trigger: "empty",
        priority: 80,
        candidates: [{ latex: "\\emptyset", label: "∅", displayLatex: "\\emptyset" }],
    },
    {
        trigger: "in",
        priority: 80,
        candidates: [{ latex: "\\in", label: "∈", displayLatex: "\\in" }],
    },
    {
        trigger: "notin",
        priority: 80,
        candidates: [{ latex: "\\notin", label: "∉", displayLatex: "\\notin" }],
    },
    {
        trigger: "mid",
        priority: 80,
        candidates: [{ latex: "\\mid", label: "∣", displayLatex: "\\mid" }],
    },
    {
        trigger: "nmid",
        priority: 80,
        candidates: [{ latex: "\\nmid", label: "∤", displayLatex: "\\nmid" }],
    },
    {
        trigger: "parallel",
        priority: 80,
        candidates: [{ latex: "\\parallel", label: "∥", displayLatex: "\\parallel" }],
    },
    {
        trigger: "perp",
        priority: 80,
        candidates: [{ latex: "\\perp", label: "⊥", displayLatex: "\\perp" }],
    },
    {
        trigger: "subset",
        priority: 80,
        candidates: [
            { latex: "\\subset", label: "⊂", displayLatex: "\\subset" },
            { latex: "\\subseteq", label: "⊆", displayLatex: "\\subseteq" },
            { latex: "\\subsetneq", label: "⊊", displayLatex: "\\subsetneq" },
        ],
    },
    {
        trigger: "supset",
        priority: 80,
        candidates: [
            { latex: "\\supset", label: "⊃", displayLatex: "\\supset" },
            { latex: "\\supseteq", label: "⊇", displayLatex: "\\supseteq" },
            { latex: "\\supsetneq", label: "⊋", displayLatex: "\\supsetneq" },
        ],
    },
    {
        trigger: "cup",
        priority: 80,
        candidates: [{ latex: "\\cup", label: "∪", displayLatex: "\\cup" }],
    },
    {
        trigger: "bigcup",
        priority: 80,
        candidates: [{ latex: "\\bigcup", label: "⋃", displayLatex: "\\bigcup" }],
    },
    {
        trigger: "cap",
        priority: 80,
        candidates: [{ latex: "\\cap", label: "∩", displayLatex: "\\cap" }],
    },
    {
        trigger: "bigcap",
        priority: 80,
        candidates: [{ latex: "\\bigcap", label: "⋂", displayLatex: "\\bigcap" }],
    },
    {
        trigger: "iff",
        priority: 80,
        candidates: [{ latex: "\\iff", label: "⇔", displayLatex: "\\iff" }],
    },
    {
        trigger: "therefore",
        priority: 70,
        candidates: [{ latex: "\\therefore", label: "∴", displayLatex: "\\therefore" }],
    },
    {
        trigger: "because",
        priority: 70,
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
        candidates: [{ latex: "\\ll", label: "≪", displayLatex: "\\ll" }],
    },
    {
        trigger: "gg",
        priority: 90,
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
];
