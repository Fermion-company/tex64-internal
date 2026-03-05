import type { WysiwygManualTrigger } from "./types.js";

export const MANUAL_TRIGGERS_PART_4: WysiwygManualTrigger[] = [
  {
    trigger: "smashoperator",
    priority: 74,
    pack: "personal",
    candidates: [
      {
        latex: "\\operatorname*{#?}",
        label: "smashop",
        displayLatex: "\\operatorname*{arg\\,max}",
      },
    ],
  },
  {
    trigger: "prescript",
    priority: 74,
    pack: "personal",
    candidates: [
      {
        latex: "{}^{#?}_{#?}{#?}",
        label: "prescript",
        displayLatex: "{}^{a}_{b}X",
      },
    ],
  },
  {
    trigger: "symbf",
    priority: 74,
    pack: "personal",
    candidates: [{ latex: "\\mathbf{#?}", label: "symbf", displayLatex: "\\mathbf{x}" }],
  },
  {
    trigger: "mathchoice",
    priority: 72,
    pack: "personal",
    candidates: [
      {
        latex: "\\mathchoice{#?}{#?}{#?}{#?}",
        label: "mathchoice",
        displayLatex: "\\mathchoice{A}{B}{C}{D}",
      },
    ],
  },
  {
    trigger: "unicode",
    priority: 70,
    pack: "personal",
    candidates: [
      { latex: "\\unicode{x#?}", label: "unicode", displayLatex: "\\unicode{x03B1}" },
    ],
  },
  {
    trigger: "label",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\label{#?}", label: "label", displayLatex: "\\label{eq:id}" }],
  },
  {
    trigger: "tag",
    priority: 80,
    pack: "math",
    candidates: [{ latex: "\\tag{#?}", label: "tag", displayLatex: "\\tag{A1}" }],
  },
  {
    trigger: "tagstar",
    priority: 78,
    pack: "math",
    candidates: [{ latex: "\\tag*{#?}", label: "tag*", displayLatex: "\\tag*{A1}" }],
  },
  {
    trigger: "notag",
    priority: 78,
    pack: "math",
    candidates: [{ latex: "\\notag", label: "notag", displayLatex: "\\notag" }],
  },
  {
    trigger: "nonumber",
    priority: 78,
    pack: "math",
    candidates: [{ latex: "\\nonumber", label: "nonumber", displayLatex: "\\nonumber" }],
  },
  {
    trigger: "eqref",
    priority: 78,
    pack: "math",
    candidates: [{ latex: "\\eqref{#?}", label: "eqref", displayLatex: "\\eqref{eq:id}" }],
  },
  {
    trigger: "ref",
    priority: 76,
    pack: "math",
    candidates: [{ latex: "\\ref{#?}", label: "ref", displayLatex: "\\ref{sec:id}" }],
  },
  {
    trigger: "pageref",
    priority: 76,
    pack: "math",
    candidates: [{ latex: "\\pageref{#?}", label: "pageref", displayLatex: "\\pageref{sec:id}" }],
  },
  {
    trigger: "autoref",
    priority: 76,
    pack: "math",
    candidates: [{ latex: "\\autoref{#?}", label: "autoref", displayLatex: "\\autoref{sec:id}" }],
  },
  {
    trigger: "intertext",
    priority: 76,
    pack: "math",
    candidates: [{ latex: "\\intertext{#?}", label: "intertext", displayLatex: "\\intertext{text}" }],
  },
  {
    trigger: "shortintertext",
    priority: 76,
    pack: "math",
    candidates: [
      {
        latex: "\\shortintertext{#?}",
        label: "shortintertext",
        displayLatex: "\\shortintertext{text}",
      },
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
    trigger: "align",
    priority: 82,
    candidates: [
      {
        latex: "\\begin{align*}#? &= #?\\\\#? &= #?\\end{align*}",
        label: "align*",
        displayLatex: "\\begin{align*}a &= b\\\\c &= d\\end{align*}",
      },
    ],
  },
  {
    trigger: "alignat",
    priority: 80,
    pack: "math",
    candidates: [
      {
        latex: "\\begin{alignat*}{2}#?&=#?\\quad #?&=#?\\end{alignat*}",
        label: "alignat*",
        displayLatex: "\\begin{alignat*}{2}a&=b\\quad c&=d\\end{alignat*}",
      },
    ],
  },
  {
    trigger: "flalign",
    priority: 80,
    pack: "math",
    candidates: [
      {
        latex: "\\begin{flalign*}#? &= #?\\end{flalign*}",
        label: "flalign*",
        displayLatex: "\\begin{flalign*}a &= b\\end{flalign*}",
      },
    ],
  },
  {
    trigger: "multline",
    priority: 80,
    pack: "math",
    candidates: [
      {
        latex: "\\begin{multline*}#?\\\\#?\\end{multline*}",
        label: "multline*",
        displayLatex: "\\begin{multline*}a+b\\\\=c\\end{multline*}",
      },
    ],
  },
  {
    trigger: "split",
    priority: 78,
    pack: "math",
    candidates: [
      {
        latex: "\\begin{split}#? &= #?\\\\#? &= #?\\end{split}",
        label: "split",
        displayLatex: "\\begin{split}a &= b\\\\c &= d\\end{split}",
      },
    ],
  },
  {
    trigger: "subequations",
    priority: 78,
    pack: "math",
    candidates: [
      {
        latex: "\\begin{subequations}\\begin{aligned}#? &= #?\\\\#? &= #?\\end{aligned}\\end{subequations}",
        label: "subequations",
        displayLatex:
          "\\begin{subequations}\\begin{aligned}a &= b\\\\c &= d\\end{aligned}\\end{subequations}",
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
        latex: "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}#?&#?&#?\\\\#?&#?&#?\\end{array}",
        label: "array{...}",
        displayLatex:
          "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}",
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
