export const MANUAL_TRIGGERS_PART_1 = [
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
        trigger: "tfrac",
        priority: 115,
        candidates: [{ latex: "\\tfrac{#?}{#?}", label: "tfrac", displayLatex: "\\tfrac{a}{b}" }],
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
        trigger: "smallmatrix",
        priority: 98,
        pack: "math",
        candidates: [
            {
                latex: "\\begin{smallmatrix}#?&#?\\\\#?&#?\\end{smallmatrix}",
                label: "smallmatrix",
                displayLatex: "\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}",
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
        trigger: "dcases",
        priority: 96,
        pack: "math",
        candidates: [
            {
                latex: "\\begin{dcases}#?&#?\\\\#?&#?\\end{dcases}",
                label: "dcases",
                displayLatex: "\\begin{dcases}x&x>0\\\\-x&x\\le 0\\end{dcases}",
            },
        ],
    },
    {
        trigger: "rcases",
        priority: 96,
        pack: "math",
        candidates: [
            {
                latex: "\\begin{rcases}#?&#?\\\\#?&#?\\end{rcases}",
                label: "rcases",
                displayLatex: "\\begin{rcases}x&x>0\\\\-x&x\\le 0\\end{rcases}",
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
        trigger: "dbinom",
        priority: 88,
        candidates: [
            { latex: "\\dbinom{#?}{#?}", label: "dbinom", displayLatex: "\\dbinom{n}{k}" },
        ],
    },
    {
        trigger: "tbinom",
        priority: 88,
        candidates: [
            { latex: "\\tbinom{#?}{#?}", label: "tbinom", displayLatex: "\\tbinom{n}{k}" },
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
                latex: "\\left\\lVert #?\\right\\rVert",
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
                latex: "\\left\\lceil #?\\right\\rceil",
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
                latex: "\\left\\lfloor #?\\right\\rfloor",
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
            {
                latex: "\\overset{#?}{\\cancel{#?}}",
                label: "cancelto",
                displayLatex: "\\overset{0}{\\cancel{x}}",
            },
        ],
    },
    {
        trigger: "tilde",
        priority: 80,
        candidates: [{ latex: "\\tilde{#?}", label: "~", displayLatex: "\\tilde{x}" }],
    },
];
