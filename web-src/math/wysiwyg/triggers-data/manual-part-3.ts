import type { WysiwygManualTrigger } from "./types.js";

export const MANUAL_TRIGGERS_PART_3: WysiwygManualTrigger[] = [
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
    trigger: "xleftrightarrow",
    priority: 90,
    candidates: [
      {
        latex: "\\xleftrightarrow{#?}",
        label: "x↔",
        displayLatex: "\\xleftrightarrow{a}",
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
    trigger: "underset",
    priority: 90,
    candidates: [
      { latex: "\\underset{#?}{#?}", label: "under", displayLatex: "\\underset{a}{b}" },
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
    trigger: "quad",
    priority: 82,
    candidates: [{ latex: "\\quad", label: "quad", displayLatex: "\\quad" }],
  },
  {
    trigger: "qquad",
    priority: 82,
    candidates: [{ latex: "\\qquad", label: "qquad", displayLatex: "\\qquad" }],
  },
  {
    trigger: "thinspace",
    priority: 76,
    candidates: [{ latex: "\\,", label: "\\,", displayLatex: "\\," }],
  },
  {
    trigger: "medspace",
    priority: 76,
    candidates: [{ latex: "\\:", label: "\\:", displayLatex: "\\:" }],
  },
  {
    trigger: "thickspace",
    priority: 76,
    candidates: [{ latex: "\\;", label: "\\;", displayLatex: "\\;" }],
  },
  {
    trigger: "negspace",
    priority: 76,
    candidates: [{ latex: "\\!", label: "\\!", displayLatex: "\\!" }],
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
    trigger: "middle",
    priority: 88,
    pack: "math",
    candidates: [
      {
        latex: "\\left(#?\\middle|#?\\right)",
        label: "middle|",
        displayLatex: "\\left(a\\middle|b\\right)",
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
    trigger: "coloneqq",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\coloneqq", label: ":=", displayLatex: "\\coloneqq" }],
  },
  {
    trigger: "eqqcolon",
    priority: 90,
    pack: "math",
    candidates: [{ latex: "\\eqqcolon", label: "=:", displayLatex: "\\eqqcolon" }],
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
    candidates: [{ latex: "\\mathrm{#?}", label: "text", displayLatex: "\\mathrm{unit}" }],
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
    candidates: [
      { latex: "\\mathbb{R}", label: "ℝ", displayLatex: "\\mathbb{R}" },
      { latex: "\\mathbb{C}", label: "ℂ", displayLatex: "\\mathbb{C}" },
      { latex: "\\mathbb{Z}", label: "ℤ", displayLatex: "\\mathbb{Z}" },
      { latex: "\\mathbb{Q}", label: "ℚ", displayLatex: "\\mathbb{Q}" },
      { latex: "\\mathbb{N}", label: "ℕ", displayLatex: "\\mathbb{N}" },
    ],
  },
  {
    trigger: "bb",
    priority: 80,
    pack: "math",
    candidates: [
      { latex: "\\mathbb{R}", label: "ℝ", displayLatex: "\\mathbb{R}" },
      { latex: "\\mathbb{C}", label: "ℂ", displayLatex: "\\mathbb{C}" },
      { latex: "\\mathbb{Z}", label: "ℤ", displayLatex: "\\mathbb{Z}" },
      { latex: "\\mathbb{Q}", label: "ℚ", displayLatex: "\\mathbb{Q}" },
      { latex: "\\mathbb{N}", label: "ℕ", displayLatex: "\\mathbb{N}" },
    ],
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
];
