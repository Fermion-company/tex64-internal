// Package sets and on-demand package resolution.
//
// The light install follows TinyTeX's model (https://yihui.org/tinytex): start
// from TeX Live's `scheme-infraonly`, add a curated package list, and let the
// build loop pull anything else in on first use. The last part is what makes a
// small install safe — without it a light distribution just relocates the "I hit
// a missing .sty" problem onto the user.

// TinyTeX's own baseline (tools/pkgs-custom.txt): enough infrastructure to
// compile an ordinary LaTeX document with any of the four engines.
const TINYTEX_BASE_PACKAGES = [
  "amscls", "amsfonts", "amsmath", "atbegshi", "atveryend", "auxhook", "babel",
  "bibtex", "bigintcalc", "bitset", "bookmark", "booktabs", "cm", "dehyph",
  "dvipdfmx", "dvips", "ec", "epstopdf", "epstopdf-pkg", "etex", "etexcmds",
  "etoolbox", "euenc", "extractbb", "fancyvrb", "filehook", "firstaid", "float",
  "fontspec", "framed", "geometry", "gettitlestring", "glyphlist", "graphics",
  "graphics-cfg", "graphics-def", "helvetic", "hycolor", "hyperref", "hyph-utf8",
  "iftex", "inconsolata", "infwarerr", "intcalc", "knuth-lib", "kvdefinekeys",
  "kvoptions", "kvsetkeys", "l3kernel", "l3packages", "latex", "latex-bin",
  "latex-fonts", "latexconfig", "latexmk", "letltxmacro", "lm", "lm-math",
  "ltxcmds", "lua-alt-getopt", "lua-uni-algos", "luahbtex", "lualatex-math",
  "lualibs", "luaotfload", "luatex", "mdwtools", "metafont", "mfware", "natbib",
  "pdfescape", "pdftex", "pdftexcmds", "plain", "psnfss", "refcount",
  "rerunfilecheck", "stringenc", "tex", "tex-ini-files", "texlive-scripts-extra",
  "times", "tipa", "tools", "unicode-data", "unicode-math", "uniquecounter",
  "url", "xcolor", "xetex", "xetexconfig", "xkeyval", "xunicode", "zapfding",
];

// What TeX64 adds on top for its own audience: math/science writing, TikZ
// figures (the Pro canvas emits TikZ), bibliographies, and Japanese via LuaTeX.
// Names are TeX Live *package* names, which are not always the LaTeX package
// name: empheq ships inside mathtools, subcaption inside caption, tabularx
// inside tools. A `tlmgr install --dry-run` of this list is the way to check.
const TEX64_ESSENTIAL_PACKAGES = [
  // math & science
  "mathtools", "physics", "siunitx", "cancel", "mhchem", "braket",
  // figures & drawing
  "pgf", "pgfplots", "standalone", "tcolorbox", "adjustbox", "collectbox",
  "caption", "wrapfig", "environ", "trimspaces",
  // bibliography
  "biblatex", "biber", "csquotes", "logreq", "xstring",
  // code & algorithms
  "listings", "algorithms", "algorithmicx", "algorithm2e",
  // document layout
  "enumitem", "titlesec", "fancyhdr", "setspace", "multirow",
  "microtype", "cleveref", "todonotes", "lastpage", "xifthen", "ifmtarg",
  // classes people actually use
  "beamer", "translator", "koma-script", "memoir",
  // Japanese (LuaTeX-first, matching the default engine)
  "luatexja", "haranoaji", "bxjscls", "jsclasses", "japanese-otf", "uptex",
  "uplatex", "ptex-base", "platex", "zxjatype",
  // formatting / tooling used by the editor itself
  "latexindent", "synctex", "texcount",
];

// Everything the reference book stylesheet chain pulls in
// (kkbookmaker/reference/styles/mainset-expl3tr.sty and the styles/ files it
// loads), resolved to TeX Live *package* names with `tlmgr search --file`, plus
// their own dependencies. This is the concrete "a real book must build" target
// for the light set: if one of these is missing, the light install has failed at
// its job. Verified by installing a fresh light tree and compiling a document
// that loads the whole chain — the pass condition is zero on-demand repairs.
const KK_STYLESHEET_PACKAGES = [
  // Japanese book class and trimmarks
  "jlreq", "bxcjkjatype", "ifptex",
  // tables
  "tabularray", "ninecolors", "functional", "diagbox",
  // ruled/underlined text, rules, columns
  "luwa-ul", "lua-ul", "luacolor", "modernruler", "paracol",
  // KK symbol/typesetting packages the stylesheet builds on
  "kkran", "kksymbols", "kkluaverb",
  // floats and margins
  "wrapfig2", "pict2e", "marginnote", "needspace", "varwidth", "everyshi",
  // boxes and chemistry
  "pdfcol", "tikzfill", "chemfig", "simplekv",
  // Lua glue and position tracking pulled in transitively
  "luacode", "zref",
  // index
  "makeindex",
];

const LIGHT_INSTALL_PACKAGES = Array.from(
  new Set([
    ...TINYTEX_BASE_PACKAGES,
    ...TEX64_ESSENTIAL_PACKAGES,
    ...KK_STYLESHEET_PACKAGES,
  ])
);

// scheme-full already carries every CTAN package; these are the few extras the
// managed tree still wants explicitly (they are schemes' scripts, not packages).
const FULL_INSTALL_PACKAGES = ["latexmk", "latexindent"];

// Patterns straight out of what LaTeX prints when a file is missing. Mirrors the
// set TinyTeX's parse_packages() keys off, plus the LuaTeX phrasings we see from
// our default engine.
const MISSING_FILE_PATTERNS = [
  // ! LaTeX Error: File `foo.sty' not found.
  /! LaTeX Error: File [`'"]([^`'"]+)['"] not found/g,
  // ! Package pdftex.def Error: File `foo.png' not found
  /! Package [^\s]+ Error: File [`'"]([^`'"]+)['"] not found/g,
  // !pdfTeX error: pdflatex (file foo): Font foo not loadable
  /!pdfTeX error:[^\n]*\(file ([^)]+)\)/g,
  // ! Font \OT1/cmr/m/n/10=cmr10 not loadable
  /! Font [^\n]*=([^\s]+) not loadable/g,
  // LuaTeX / fontspec: The font "Foo" cannot be found
  /The font ["`']([^"`']+)["`'] cannot be found/g,
  // kpathsea: ...: file foo.sty not found
  /kpathsea:[^\n]*file ([^\s]+) not found/g,
  // luaotfload | db : Font "foo" not found
  /luaotfload[^\n]*Font ["`']?([^"`'\s]+)["`']?\s+not found/g,
];

const FONT_LIKE = /\.(?:tfm|pfb|afm|otf|ttf|vf|enc|map)$/i;

// The log names files; tlmgr indexes them; the extension decides how we search.
const extractMissingFiles = (log) => {
  const text = String(log || "");
  const found = [];
  const seen = new Set();
  for (const pattern of MISSING_FILE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = String(match[1] || "").trim();
      if (!raw || raw.length > 120) {
        continue;
      }
      // A bare name with no extension is a font family, not a file we can look
      // up; skip it rather than sending tlmgr on a meaningless search.
      const name = raw.replace(/^\.\//, "");
      if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
        continue;
      }
      // Images and other user assets are the author's problem, not a missing
      // package — installing something from CTAN would never fix them.
      if (/\.(?:png|jpe?g|pdf|eps|svg|bib|tex|aux|toc|out)$/i.test(name)) {
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(name);
    }
  }
  return found;
};

// `tlmgr search --global --file "/foo.sty"` prints package names as lines ending
// in a colon, with their matching files indented beneath.
const parseTlmgrSearchOutput = (output) => {
  const names = [];
  const seen = new Set();
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) {
      continue;
    }
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*):$/);
    if (!match) {
      continue;
    }
    const name = match[1];
    // tlmgr prints the containing collection/scheme too; installing those would
    // silently pull in gigabytes when the user asked for one package.
    if (/^(?:collection|scheme)-/.test(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
};

// tlmgr keeps going past names it cannot find and only says so on stderr, so an
// install of a curated list can "succeed" while silently skipping packages. This
// pulls those names back out, which is the only way a bad entry in the lists
// above becomes visible instead of turning into a mysterious missing .sty later.
const parseUnavailablePackages = (output) => {
  const names = [];
  const pattern = /package\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+not present in repository/gi;
  let match;
  while ((match = pattern.exec(String(output || ""))) !== null) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
};

const searchTermForFile = (fileName) => {
  const name = String(fileName || "").trim();
  if (!name) {
    return "";
  }
  // Leading slash anchors the match to a full basename, so "url.sty" does not
  // also match "myurl.sty".
  return FONT_LIKE.test(name) ? name : `/${name}`;
};

module.exports = {
  TINYTEX_BASE_PACKAGES,
  TEX64_ESSENTIAL_PACKAGES,
  KK_STYLESHEET_PACKAGES,
  LIGHT_INSTALL_PACKAGES,
  FULL_INSTALL_PACKAGES,
  MISSING_FILE_PATTERNS,
  extractMissingFiles,
  parseTlmgrSearchOutput,
  parseUnavailablePackages,
  searchTermForFile,
};
