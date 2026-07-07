export const MANUAL_TRIGGERS_PART_4 = [
    {
        trigger: "smashoperator",
        priority: 74,
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
        candidates: [{ latex: "\\mathbf{#?}", label: "symbf", displayLatex: "\\mathbf{x}" }],
    },
    {
        trigger: "mathchoice",
        priority: 72,
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
        candidates: [
            { latex: "\\unicode{x#?}", label: "unicode", displayLatex: "\\unicode{x03B1}" },
        ],
    },
    {
        trigger: "label",
        priority: 80,
        candidates: [{ latex: "\\label{#?}", label: "label", displayLatex: "\\label{eq:id}" }],
    },
    {
        trigger: "tag",
        priority: 80,
        candidates: [{ latex: "\\tag{#?}", label: "tag", displayLatex: "\\tag{A1}" }],
    },
    {
        trigger: "tagstar",
        priority: 78,
        candidates: [{ latex: "\\tag*{#?}", label: "tag*", displayLatex: "\\tag*{A1}" }],
    },
    {
        trigger: "notag",
        priority: 78,
        candidates: [{ latex: "\\notag", label: "notag", displayLatex: "\\notag" }],
    },
    {
        trigger: "nonumber",
        priority: 78,
        candidates: [{ latex: "\\nonumber", label: "nonumber", displayLatex: "\\nonumber" }],
    },
    {
        trigger: "eqref",
        priority: 78,
        candidates: [{ latex: "\\eqref{#?}", label: "eqref", displayLatex: "\\eqref{eq:id}" }],
    },
    {
        trigger: "ref",
        priority: 76,
        candidates: [{ latex: "\\ref{#?}", label: "ref", displayLatex: "\\ref{sec:id}" }],
    },
    {
        trigger: "pageref",
        priority: 76,
        candidates: [{ latex: "\\pageref{#?}", label: "pageref", displayLatex: "\\pageref{sec:id}" }],
    },
    {
        trigger: "autoref",
        priority: 76,
        candidates: [{ latex: "\\autoref{#?}", label: "autoref", displayLatex: "\\autoref{sec:id}" }],
    },
    {
        trigger: "intertext",
        priority: 76,
        candidates: [{ latex: "\\intertext{#?}", label: "intertext", displayLatex: "\\intertext{text}" }],
    },
    {
        trigger: "shortintertext",
        priority: 76,
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
        candidates: [
            {
                latex: "\\begin{subequations}\\begin{aligned}#? &= #?\\\\#? &= #?\\end{aligned}\\end{subequations}",
                label: "subequations",
                displayLatex: "\\begin{subequations}\\begin{aligned}a &= b\\\\c &= d\\end{aligned}\\end{subequations}",
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
                displayLatex: "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}",
            },
        ],
    },
    {
        trigger: "hbar",
        priority: 85,
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
        candidates: [
            {
                latex: "\\langle #? \\vert #? \\rangle",
                label: "⟨ | ⟩",
                displayLatex: "\\langle \\phi \\vert \\psi \\rangle",
            },
        ],
    },
    // ===== Function operators =====
    { trigger: "sinh", priority: 100, candidates: [{ latex: "\\sinh", label: "sinh", displayLatex: "\\sinh" }] },
    { trigger: "cosh", priority: 100, candidates: [{ latex: "\\cosh", label: "cosh", displayLatex: "\\cosh" }] },
    { trigger: "tanh", priority: 100, candidates: [{ latex: "\\tanh", label: "tanh", displayLatex: "\\tanh" }] },
    { trigger: "coth", priority: 100, candidates: [{ latex: "\\coth", label: "coth", displayLatex: "\\coth" }] },
    { trigger: "hom", priority: 85, candidates: [{ latex: "\\hom", label: "hom", displayLatex: "\\hom" }] },
    { trigger: "deg", priority: 85, candidates: [{ latex: "\\deg", label: "deg", displayLatex: "\\deg" }] },
    { trigger: "arg", priority: 85, candidates: [{ latex: "\\arg", label: "arg", displayLatex: "\\arg" }] },
    { trigger: "Pr", priority: 85, candidates: [{ latex: "\\Pr", label: "Pr", displayLatex: "\\Pr" }] },
    { trigger: "lg", priority: 85, candidates: [{ latex: "\\lg", label: "lg", displayLatex: "\\lg" }] },
    // ===== Arrows =====
    { trigger: "hookrightarrow", priority: 85, candidates: [{ latex: "\\hookrightarrow", label: "↪", displayLatex: "\\hookrightarrow" }] },
    { trigger: "hookleftarrow", priority: 85, candidates: [{ latex: "\\hookleftarrow", label: "↩", displayLatex: "\\hookleftarrow" }] },
    {
        trigger: "uparrow",
        priority: 85,
        candidates: [
            { latex: "\\uparrow", label: "↑", displayLatex: "\\uparrow" },
            { latex: "\\Uparrow", label: "⇑", displayLatex: "\\Uparrow" },
        ],
    },
    {
        trigger: "downarrow",
        priority: 85,
        candidates: [
            { latex: "\\downarrow", label: "↓", displayLatex: "\\downarrow" },
            { latex: "\\Downarrow", label: "⇓", displayLatex: "\\Downarrow" },
        ],
    },
    {
        trigger: "updownarrow",
        priority: 85,
        candidates: [
            { latex: "\\updownarrow", label: "↕", displayLatex: "\\updownarrow" },
            { latex: "\\Updownarrow", label: "⇕", displayLatex: "\\Updownarrow" },
        ],
    },
    { trigger: "nearrow", priority: 80, candidates: [{ latex: "\\nearrow", label: "↗", displayLatex: "\\nearrow" }] },
    { trigger: "searrow", priority: 80, candidates: [{ latex: "\\searrow", label: "↘", displayLatex: "\\searrow" }] },
    { trigger: "swarrow", priority: 80, candidates: [{ latex: "\\swarrow", label: "↙", displayLatex: "\\swarrow" }] },
    { trigger: "nwarrow", priority: 80, candidates: [{ latex: "\\nwarrow", label: "↖", displayLatex: "\\nwarrow" }] },
    {
        trigger: "longrightarrow",
        priority: 85,
        candidates: [
            { latex: "\\longrightarrow", label: "⟶", displayLatex: "\\longrightarrow" },
            { latex: "\\Longrightarrow", label: "⟹", displayLatex: "\\Longrightarrow" },
        ],
    },
    {
        trigger: "longleftarrow",
        priority: 85,
        candidates: [
            { latex: "\\longleftarrow", label: "⟵", displayLatex: "\\longleftarrow" },
            { latex: "\\Longleftarrow", label: "⟸", displayLatex: "\\Longleftarrow" },
        ],
    },
    {
        trigger: "longleftrightarrow",
        priority: 85,
        candidates: [
            { latex: "\\longleftrightarrow", label: "⟷", displayLatex: "\\longleftrightarrow" },
            { latex: "\\Longleftrightarrow", label: "⟺", displayLatex: "\\Longleftrightarrow" },
        ],
    },
    { trigger: "longmapsto", priority: 85, candidates: [{ latex: "\\longmapsto", label: "⟼", displayLatex: "\\longmapsto" }] },
    { trigger: "rightharpoonup", priority: 80, candidates: [{ latex: "\\rightharpoonup", label: "⇀", displayLatex: "\\rightharpoonup" }] },
    { trigger: "rightharpoondown", priority: 80, candidates: [{ latex: "\\rightharpoondown", label: "⇁", displayLatex: "\\rightharpoondown" }] },
    { trigger: "leftharpoonup", priority: 80, candidates: [{ latex: "\\leftharpoonup", label: "↼", displayLatex: "\\leftharpoonup" }] },
    { trigger: "leftharpoondown", priority: 80, candidates: [{ latex: "\\leftharpoondown", label: "↽", displayLatex: "\\leftharpoondown" }] },
    { trigger: "rightleftharpoons", priority: 80, candidates: [{ latex: "\\rightleftharpoons", label: "⇌", displayLatex: "\\rightleftharpoons" }] },
    { trigger: "twoheadrightarrow", priority: 80, candidates: [{ latex: "\\twoheadrightarrow", label: "↠", displayLatex: "\\twoheadrightarrow" }] },
    // ===== Relations =====
    { trigger: "prec", priority: 85, candidates: [{ latex: "\\prec", label: "≺", displayLatex: "\\prec" }, { latex: "\\preceq", label: "⪯", displayLatex: "\\preceq" }] },
    { trigger: "succ", priority: 85, candidates: [{ latex: "\\succ", label: "≻", displayLatex: "\\succ" }, { latex: "\\succeq", label: "⪰", displayLatex: "\\succeq" }] },
    { trigger: "vdash", priority: 85, candidates: [{ latex: "\\vdash", label: "⊢", displayLatex: "\\vdash" }] },
    { trigger: "dashv", priority: 85, candidates: [{ latex: "\\dashv", label: "⊣", displayLatex: "\\dashv" }] },
    { trigger: "models", priority: 85, candidates: [{ latex: "\\models", label: "⊨", displayLatex: "\\models" }] },
    { trigger: "bowtie", priority: 80, candidates: [{ latex: "\\bowtie", label: "⋈", displayLatex: "\\bowtie" }] },
    { trigger: "sim", priority: 90, candidates: [{ latex: "\\sim", label: "∼", displayLatex: "\\sim" }] },
    { trigger: "simeq", priority: 90, candidates: [{ latex: "\\simeq", label: "≃", displayLatex: "\\simeq" }] },
    { trigger: "cong", priority: 90, candidates: [{ latex: "\\cong", label: "≅", displayLatex: "\\cong" }] },
    { trigger: "doteq", priority: 80, candidates: [{ latex: "\\doteq", label: "≐", displayLatex: "\\doteq" }] },
    { trigger: "asymp", priority: 80, candidates: [{ latex: "\\asymp", label: "≍", displayLatex: "\\asymp" }] },
    { trigger: "sqsubset", priority: 80, candidates: [{ latex: "\\sqsubset", label: "⊏", displayLatex: "\\sqsubset" }, { latex: "\\sqsubseteq", label: "⊑", displayLatex: "\\sqsubseteq" }] },
    { trigger: "sqsupset", priority: 80, candidates: [{ latex: "\\sqsupset", label: "⊐", displayLatex: "\\sqsupset" }, { latex: "\\sqsupseteq", label: "⊒", displayLatex: "\\sqsupseteq" }] },
    // ===== Binary operators =====
    { trigger: "ast", priority: 80, candidates: [{ latex: "\\ast", label: "∗", displayLatex: "\\ast" }] },
    { trigger: "star", priority: 80, candidates: [{ latex: "\\star", label: "⋆", displayLatex: "\\star" }] },
    { trigger: "bullet", priority: 80, candidates: [{ latex: "\\bullet", label: "•", displayLatex: "\\bullet" }] },
    { trigger: "diamond", priority: 80, candidates: [{ latex: "\\diamond", label: "◇", displayLatex: "\\diamond" }] },
    { trigger: "ominus", priority: 80, candidates: [{ latex: "\\ominus", label: "⊖", displayLatex: "\\ominus" }] },
    { trigger: "oslash", priority: 80, candidates: [{ latex: "\\oslash", label: "⊘", displayLatex: "\\oslash" }] },
    { trigger: "odot", priority: 80, candidates: [{ latex: "\\odot", label: "⊙", displayLatex: "\\odot" }] },
    { trigger: "sqcap", priority: 80, candidates: [{ latex: "\\sqcap", label: "⊓", displayLatex: "\\sqcap" }] },
    { trigger: "sqcup", priority: 80, candidates: [{ latex: "\\sqcup", label: "⊔", displayLatex: "\\sqcup" }] },
    { trigger: "uplus", priority: 80, candidates: [{ latex: "\\uplus", label: "⊎", displayLatex: "\\uplus" }] },
    { trigger: "dagger", priority: 80, candidates: [{ latex: "\\dagger", label: "†", displayLatex: "\\dagger" }, { latex: "\\ddagger", label: "‡", displayLatex: "\\ddagger" }] },
    { trigger: "wr", priority: 75, candidates: [{ latex: "\\wr", label: "≀", displayLatex: "\\wr" }] },
    { trigger: "amalg", priority: 75, candidates: [{ latex: "\\amalg", label: "⨿", displayLatex: "\\amalg" }] },
    { trigger: "triangleleft", priority: 80, candidates: [{ latex: "\\triangleleft", label: "◁", displayLatex: "\\triangleleft" }] },
    { trigger: "triangleright", priority: 80, candidates: [{ latex: "\\triangleright", label: "▷", displayLatex: "\\triangleright" }] },
    // ===== Large operators =====
    { trigger: "coprod", priority: 90, candidates: [{ latex: "\\coprod", label: "∐", displayLatex: "\\coprod" }] },
    { trigger: "bigsqcup", priority: 80, candidates: [{ latex: "\\bigsqcup", label: "⊔", displayLatex: "\\bigsqcup" }] },
    { trigger: "bigvee", priority: 80, candidates: [{ latex: "\\bigvee", label: "⋁", displayLatex: "\\bigvee" }] },
    { trigger: "bigwedge", priority: 80, candidates: [{ latex: "\\bigwedge", label: "⋀", displayLatex: "\\bigwedge" }] },
    { trigger: "bigodot", priority: 80, candidates: [{ latex: "\\bigodot", label: "⊙", displayLatex: "\\bigodot" }] },
    { trigger: "bigoplus", priority: 80, candidates: [{ latex: "\\bigoplus", label: "⊕", displayLatex: "\\bigoplus" }] },
    { trigger: "bigotimes", priority: 80, candidates: [{ latex: "\\bigotimes", label: "⊗", displayLatex: "\\bigotimes" }] },
    { trigger: "biguplus", priority: 80, candidates: [{ latex: "\\biguplus", label: "⊎", displayLatex: "\\biguplus" }] },
    // ===== Dots =====
    { trigger: "vdots", priority: 80, candidates: [{ latex: "\\vdots", label: "⋮", displayLatex: "\\vdots" }] },
    { trigger: "ddots", priority: 80, candidates: [{ latex: "\\ddots", label: "⋱", displayLatex: "\\ddots" }] },
    // ===== Accents/decorations =====
    { trigger: "widehat", priority: 80, candidates: [{ latex: "\\widehat{#?}", label: "widehat", displayLatex: "\\widehat{AB}" }] },
    { trigger: "widetilde", priority: 80, candidates: [{ latex: "\\widetilde{#?}", label: "widetilde", displayLatex: "\\widetilde{AB}" }] },
    { trigger: "check", priority: 80, candidates: [{ latex: "\\check{#?}", label: "check", displayLatex: "\\check{x}" }] },
    { trigger: "breve", priority: 80, candidates: [{ latex: "\\breve{#?}", label: "breve", displayLatex: "\\breve{x}" }] },
    { trigger: "acute", priority: 80, candidates: [{ latex: "\\acute{#?}", label: "acute", displayLatex: "\\acute{x}" }] },
    { trigger: "grave", priority: 80, candidates: [{ latex: "\\grave{#?}", label: "grave", displayLatex: "\\grave{x}" }] },
    { trigger: "mathring", priority: 80, candidates: [{ latex: "\\mathring{#?}", label: "ring", displayLatex: "\\mathring{x}" }] },
    // ===== Logic =====
    { trigger: "nexists", priority: 85, candidates: [{ latex: "\\nexists", label: "∄", displayLatex: "\\nexists" }] },
    { trigger: "top", priority: 80, candidates: [{ latex: "\\top", label: "⊤", displayLatex: "\\top" }] },
    { trigger: "bot", priority: 80, candidates: [{ latex: "\\bot", label: "⊥", displayLatex: "\\bot" }] },
    // ===== Miscellaneous symbols =====
    { trigger: "aleph", priority: 85, candidates: [{ latex: "\\aleph", label: "ℵ", displayLatex: "\\aleph" }] },
    { trigger: "imath", priority: 80, candidates: [{ latex: "\\imath", label: "ı", displayLatex: "\\imath" }] },
    { trigger: "jmath", priority: 80, candidates: [{ latex: "\\jmath", label: "ȷ", displayLatex: "\\jmath" }] },
    { trigger: "Re", priority: 85, candidates: [{ latex: "\\Re", label: "ℜ", displayLatex: "\\Re" }] },
    { trigger: "Im", priority: 85, candidates: [{ latex: "\\Im", label: "ℑ", displayLatex: "\\Im" }] },
    { trigger: "wp", priority: 80, candidates: [{ latex: "\\wp", label: "℘", displayLatex: "\\wp" }] },
    { trigger: "complement", priority: 80, candidates: [{ latex: "\\complement", label: "∁", displayLatex: "\\complement" }] },
    { trigger: "varnothing", priority: 80, candidates: [{ latex: "\\varnothing", label: "∅", displayLatex: "\\varnothing" }] },
    { trigger: "triangle", priority: 80, candidates: [{ latex: "\\triangle", label: "△", displayLatex: "\\triangle" }] },
    { trigger: "surd", priority: 80, candidates: [{ latex: "\\surd", label: "√", displayLatex: "\\surd" }] },
    // ===== Command-name-faithful triggers (corpus-simulation gap fill) =====
    // A real-arXiv keystroke simulation (2026-07) showed these standard
    // commands produced ZERO candidates when typed by their exact LaTeX name —
    // worst-case UX: suggestions that appear on a prefix ("op"), then vanish
    // as the user finishes typing the actual command ("operatorname").
    {
        trigger: "mathrm",
        priority: 100,
        candidates: [{ latex: "\\mathrm{#?}", label: "mathrm", displayLatex: "\\mathrm{d}" }],
    },
    {
        trigger: "mathbf",
        priority: 100,
        candidates: [
            { latex: "\\mathbf{#?}", label: "mathbf", displayLatex: "\\mathbf{x}" },
            { latex: "\\boldsymbol{#?}", label: "boldsymbol", displayLatex: "\\boldsymbol{\\mu}" },
        ],
    },
    {
        trigger: "mathcal",
        priority: 100,
        candidates: [{ latex: "\\mathcal{#?}", label: "mathcal", displayLatex: "\\mathcal{L}" }],
    },
    {
        trigger: "mathbb",
        priority: 100,
        candidates: [{ latex: "\\mathbb{#?}", label: "mathbb", displayLatex: "\\mathbb{R}" }],
    },
    {
        trigger: "operatorname",
        priority: 100,
        candidates: [
            { latex: "\\operatorname{#?}", label: "operatorname", displayLatex: "\\operatorname{tr}" },
        ],
    },
    {
        // Below "text" (85) so \text stays first at the shared "tex..." prefix.
        trigger: "textrm",
        priority: 78,
        candidates: [{ latex: "\\textrm{#?}", label: "textrm", displayLatex: "\\textrm{text}" }],
    },
    {
        trigger: "langle",
        priority: 95,
        candidates: [
            { latex: "\\langle", label: "⟨", displayLatex: "\\langle" },
            { latex: "\\langle #? \\rangle", label: "⟨ ⟩", displayLatex: "\\langle x \\rangle" },
        ],
    },
    {
        trigger: "rangle",
        priority: 95,
        candidates: [{ latex: "\\rangle", label: "⟩", displayLatex: "\\rangle" }],
    },
    {
        trigger: "lfloor",
        priority: 90,
        candidates: [
            { latex: "\\lfloor", label: "⌊", displayLatex: "\\lfloor" },
            { latex: "\\lfloor #? \\rfloor", label: "⌊ ⌋", displayLatex: "\\lfloor x \\rfloor" },
        ],
    },
    {
        trigger: "rfloor",
        priority: 90,
        candidates: [{ latex: "\\rfloor", label: "⌋", displayLatex: "\\rfloor" }],
    },
    {
        trigger: "lceil",
        priority: 90,
        candidates: [
            { latex: "\\lceil", label: "⌈", displayLatex: "\\lceil" },
            { latex: "\\lceil #? \\rceil", label: "⌈ ⌉", displayLatex: "\\lceil x \\rceil" },
        ],
    },
    {
        trigger: "rceil",
        priority: 90,
        candidates: [{ latex: "\\rceil", label: "⌉", displayLatex: "\\rceil" }],
    },
    {
        trigger: "lvert",
        priority: 88,
        candidates: [
            { latex: "\\lvert", label: "|", displayLatex: "\\lvert" },
            { latex: "\\lvert #? \\rvert", label: "| |", displayLatex: "\\lvert x \\rvert" },
            { latex: "\\lVert", label: "‖", displayLatex: "\\lVert" },
            { latex: "\\lVert #? \\rVert", label: "‖ ‖", displayLatex: "\\lVert x \\rVert" },
        ],
    },
    {
        trigger: "rvert",
        priority: 88,
        candidates: [
            { latex: "\\rvert", label: "|", displayLatex: "\\rvert" },
            { latex: "\\rVert", label: "‖", displayLatex: "\\rVert" },
        ],
    },
    {
        trigger: "cfrac",
        priority: 95,
        candidates: [{ latex: "\\cfrac{#?}{#?}", label: "cfrac", displayLatex: "\\cfrac{a}{b}" }],
    },
    {
        trigger: "pmod",
        priority: 90,
        candidates: [{ latex: "\\pmod{#?}", label: "(mod n)", displayLatex: "x \\pmod{n}" }],
    },
    {
        trigger: "prime",
        priority: 85,
        candidates: [{ latex: "\\prime", label: "′", displayLatex: "x^{\\prime}" }],
    },
    // \dotsc / \dotsb are amsmath context-aware dots; MathLive does not parse
    // them, so insert the equivalent fixed forms.
    {
        // One above dotsb: at the shared "dots" prefix \ldots should edge \cdots
        // (amsmath's own default for \dots in comma context).
        trigger: "dotsc",
        priority: 79,
        candidates: [{ latex: "\\ldots", label: "…", displayLatex: "\\ldots" }],
    },
    {
        trigger: "dotsb",
        priority: 77,
        candidates: [{ latex: "\\cdots", label: "⋯", displayLatex: "\\cdots" }],
    },
    // \Box (amssymb) — same glyph as \square, which MathLive renders.
    {
        trigger: "box",
        priority: 82,
        candidates: [{ latex: "\\square", label: "□", displayLatex: "\\square" }],
    },
];
