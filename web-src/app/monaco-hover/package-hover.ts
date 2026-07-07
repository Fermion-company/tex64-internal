// One-line hints for common packages and document classes, keyed by
// lowercase name. Keep each hint short — it renders inside the hover card.
const KNOWN_PACKAGE_HINTS: Record<string, string> = {
  // Math
  amsmath: "AMS math environments (align, gather, cases, …)",
  amssymb: "AMS symbol fonts (\\mathbb, \\mathfrak, extra symbols)",
  amsfonts: "AMS fonts (blackboard bold, fraktur)",
  amsthm: "Theorem/proof environments",
  mathtools: "amsmath extensions and fixes",
  bm: "Bold math symbols (\\bm)",
  physics: "Physics notation (derivatives, bra-ket)",
  siunitx: "SI units and number formatting (\\SI, \\num)",
  nicematrix: "Better matrices with borders/annotations",
  mathrsfs: "Script math alphabet (\\mathscr)",
  dsfont: "Double-stroke math font (\\mathds)",
  esint: "Extra integral signs (\\oiint, …)",
  cancel: "Strike out terms in math (\\cancel)",
  derivative: "Derivative notation helpers",
  tensor: "Tensor index notation",
  // Graphics / figures
  graphicx: "Include and scale graphics (\\includegraphics)",
  tikz: "Programmatic drawings and diagrams",
  pgfplots: "Plots and charts built on TikZ",
  subcaption: "Sub-figures/sub-tables with captions",
  subfigure: "Sub-figures (legacy; prefer subcaption)",
  caption: "Customize caption format",
  float: "Improved float placement ([H])",
  wrapfig: "Wrap text around figures",
  rotating: "Rotate figures/tables (sidewaysfigure)",
  svg: "Include SVG files",
  standalone: "Compile TikZ/figures standalone",
  // Tables
  booktabs: "Publication-quality tables (\\toprule, \\midrule)",
  tabularx: "Auto-width table columns (X column)",
  longtable: "Multi-page tables",
  multirow: "Cells spanning multiple rows",
  makecell: "Line breaks and formatting inside cells",
  array: "Extended column definitions",
  colortbl: "Colored table rows/cells",
  threeparttable: "Tables with notes",
  // Layout / typography
  geometry: "Page size and margins",
  fancyhdr: "Custom headers and footers",
  titlesec: "Customize section heading format",
  setspace: "Line spacing (\\onehalfspacing, …)",
  parskip: "Paragraph spacing instead of indent",
  enumitem: "Customize list spacing/labels",
  microtype: "Micro-typography (protrusion, expansion)",
  multicol: "Multi-column layout",
  pdflscape: "Landscape pages (rotated in PDF)",
  afterpage: "Execute after current page ends",
  placeins: "Keep floats in their section (\\FloatBarrier)",
  appendix: "Appendix formatting helpers",
  abstract: "Customize abstract layout",
  // Fonts / encoding
  fontspec: "Load system fonts (LuaLaTeX/XeLaTeX)",
  inputenc: "Input encoding (pdfLaTeX; utf8 default since 2018)",
  fontenc: "Font encoding (T1 recommended for pdfLaTeX)",
  lmodern: "Latin Modern fonts",
  newtxtext: "Times-like text font",
  newtxmath: "Times-like math font",
  mathpazo: "Palatino text/math fonts",
  helvet: "Helvetica-like sans-serif",
  babel: "Multilingual hyphenation and names",
  polyglossia: "Multilingual support (XeLaTeX/LuaLaTeX)",
  luatexja: "Japanese typesetting for LuaLaTeX",
  ctex: "Chinese typesetting",
  kotex: "Korean typesetting",
  // References / links
  hyperref: "Clickable links and PDF bookmarks",
  cleveref: "Smart references with type names (\\cref)",
  url: "Line-breakable URLs (\\url)",
  doi: "DOI links",
  nameref: "Reference section names",
  varioref: "Page-aware references",
  // Bibliography
  biblatex: "Modern bibliography (biber backend)",
  natbib: "Author-year citations (\\citet, \\citep)",
  cite: "Compressed numeric citations",
  csquotes: "Context-sensitive quotation marks",
  // Code / verbatim
  listings: "Source code listings",
  minted: "Syntax-highlighted code (needs -shell-escape + Pygments)",
  verbatim: "Extended verbatim environments",
  fancyvrb: "Fancy verbatim (customizable)",
  algorithm2e: "Algorithm pseudocode environments",
  algorithmicx: "Algorithm pseudocode (algpseudocode)",
  algpseudocode: "Pseudocode layout for algorithmicx",
  // Utilities
  xcolor: "Color support (\\textcolor, \\definecolor)",
  todonotes: "Margin TODO notes",
  comment: "Block comment environment",
  ifthen: "Conditional commands",
  etoolbox: "Programming tools for class/package authors",
  xparse: "Modern command definitions (\\NewDocumentCommand)",
  calc: "Arithmetic in lengths",
  xspace: "Smart trailing space for macros",
  lipsum: "Dummy text (\\lipsum)",
  blindtext: "Dummy text (\\blindtext)",
  datetime2: "Date/time formatting",
  fancybox: "Framed/shadow boxes",
  tcolorbox: "Colored/framed content boxes",
  mdframed: "Framed environments with page breaks",
  framed: "Simple framed environments",
  adjustbox: "Scale/trim/clip any content",
  import: "Include files with relative paths",
  subfiles: "Compile chapters standalone",
  chngcntr: "Change counter resets",
  footmisc: "Footnote customization",
  marginnote: "Margin notes without floats",
  refcheck: "Find unused labels",
  showkeys: "Show label keys in draft",
  lineno: "Line numbers for review",
  ulem: "Underline/strikethrough (\\sout)",
  soul: "Letter-spacing and highlighting",
  // Classes
  article: "Standard article class",
  report: "Standard report class (chapters)",
  book: "Standard book class",
  beamer: "Presentation slides",
  memoir: "Flexible book/report class",
  scrartcl: "KOMA-Script article",
  scrreprt: "KOMA-Script report",
  scrbook: "KOMA-Script book",
  moderncv: "CV/résumé class",
  revtex4: "APS/AIP journals (REVTeX)",
  "revtex4-2": "APS/AIP journals (REVTeX 4.2)",
  ieeetran: "IEEE Transactions class",
  acmart: "ACM publications class",
  llncs: "Springer LNCS class",
  elsarticle: "Elsevier journals class",
  jsarticle: "Japanese article (pLaTeX)",
  jsbook: "Japanese book (pLaTeX)",
  ltjsarticle: "Japanese article (LuaLaTeX)",
  ltjsbook: "Japanese book (LuaLaTeX)",
  jlreq: "Japanese class following JLReq",
};

export const buildPackageHoverMarkdown = (
  pkgName: string,
  commandName: "usepackage" | "RequirePackage" | "documentclass"
) => {
  const normalized = pkgName.trim();
  if (!normalized) {
    return null;
  }
  const hint = KNOWN_PACKAGE_HINTS[normalized.toLowerCase()];
  const encoded = encodeURIComponent(normalized);
  const lines = [
    `\`${normalized}\``,
    hint ? `${hint}` : null,
    `[CTAN](https://ctan.org/pkg/${encoded})`,
    `\`texdoc ${normalized}\``,
  ].filter(Boolean);
  const syntax =
    commandName === "documentclass"
      ? "\\documentclass[options]{class}"
      : commandName === "RequirePackage"
        ? "\\RequirePackage[options]{package}"
        : "\\usepackage[options]{package}";
  return [`\`\`\`tex\n${syntax}\n\`\`\``, ...lines].join("\n");
};

