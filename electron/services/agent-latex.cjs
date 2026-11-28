const { activeTexSource } = require("./tex-build-target.cjs");
const DEFAULT_LATEX_SYMBOL_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "ltx",
  "dtx",
]);
const LATEX_REF_COMMANDS = [
  "ref",
  "eqref",
  "pageref",
  "vref",
  "Vref",
  "vpageref",
  "Vpageref",
  "autoref",
  "cref",
  "Cref",
  "nameref",
  "Nameref",
  "namecref",
  "Namecref",
  "labelcref",
  "Labelcref",
  "cpageref",
  "Cpageref",
  "fullref",
  "fref",
  "Fref",
];
const LATEX_REF_RANGE_COMMANDS = [
  "crefrange",
  "Crefrange",
  "vrefrange",
  "Vrefrange",
  "cpagerefrange",
  "Cpagerefrange",
];
const LATEX_CITE_COMMANDS = [
  "cite",
  "citet",
  "citep",
  "citealt",
  "citealp",
  "citetext",
  "citeauthor",
  "citefullauthor",
  "citeyear",
  "citeyearpar",
  "Cite",
  "Citet",
  "Citep",
  "Citealt",
  "Citealp",
  "Citetext",
  "Citeauthor",
  "Citefullauthor",
  "Citeyear",
  "Citeyearpar",
  "nocite",
  "parencite",
  "Parencite",
  "textcite",
  "Textcite",
  "footcite",
  "Footcite",
  "autocite",
  "Autocite",
  "autocites",
  "Autocites",
  "smartcite",
  "Smartcite",
  "smartcites",
  "Smartcites",
  "supercite",
  "Supercite",
  "supercites",
  "Supercites",
  "footfullcite",
  "Footfullcite",
  "notecite",
  "Notecite",
  "pnotecite",
  "Pnotecite",
  "fnotecite",
  "Fnotecite",
  "volcite",
  "Volcite",
  "pvolcite",
  "Pvolcite",
  "tvolcite",
  "Tvolcite",
  "cites",
  "Cites",
  "parencites",
  "Parencites",
  "textcites",
  "Textcites",
];

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceKeyInList = (value, from, to) => {
  if (typeof value !== "string") {
    return { text: value, count: 0 };
  }
  let count = 0;
  const parts = value.split(",");
  const updated = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed !== from) {
      return part;
    }
    count += 1;
    const leading = part.match(/^\s*/)?.[0] ?? "";
    const trailing = part.match(/\s*$/)?.[0] ?? "";
    return `${leading}${to}${trailing}`;
  });
  return { text: updated.join(","), count };
};

const LABEL_PATTERN = /(\\label\*?)\s*\{([^}]*)\}/dg;
const REF_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_COMMANDS.join("|")})\\*?)\\s*\\{([^}]*)\\}`,
  "dg"
);
const REF_RANGE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_RANGE_COMMANDS.join("|")})\\*?)\\s*\\{([^}]*)\\}\\s*\\{([^}]*)\\}`,
  "dg"
);
const CITE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_CITE_COMMANDS.join("|")})\\*?(?:\\s*\\[[^\\]]*\\])*)\\s*\\{([^}]*)\\}`,
  "dg"
);
const BIBITEM_PATTERN = /(\\bibitem\*?(?:\s*\[[^\]]*\])?)\s*\{([^}]*)\}/dg;
const BIB_REFERENCE_FIELD_PATTERN =
  /^(\s*(?:crossref|xref|xdata|entryset|related)\s*=\s*[{"])([^}"\r\n]*)([}"])/gim;

const renameLatexInText = (content, { from, to, renameLabels, renameCites }) => {
  const active = activeTexSource(content);
  const edits = [];
  let count = 0;
  const collect = (pattern, ...keyGroups) => {
    for (const match of active.matchAll(pattern)) {
      for (const keyGroup of keyGroups) {
        const [start, end] = match.indices[keyGroup];
        const replacement = replaceKeyInList(content.slice(start, end), from, to);
        if (!replacement.count) continue;
        edits.push({ start, end, text: replacement.text });
        count += replacement.count;
      }
    }
  };
  if (renameLabels) {
    collect(LABEL_PATTERN, 2);
    collect(REF_RANGE_PATTERN, 2, 3);
    collect(REF_PATTERN, 2);
  }
  if (renameCites) {
    collect(CITE_PATTERN, 2);
    collect(BIBITEM_PATTERN, 2);
  }
  // Rebuild only the matched argument spans, leaving examples, comments,
  // command spacing and original line endings byte-for-byte intact.
  let cursor = 0;
  const parts = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    parts.push(content.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(content.slice(cursor));
  return { text: parts.join(""), count };
};

const renameBibEntryKey = (content, from, to) => {
  const entryPattern = new RegExp(
    `(^\\s*@\\w+\\s*\\{\\s*)${escapeRegex(from)}(\\s*,)`,
    "gmi"
  );
  let totalCount = 0;
  const renamedEntries = content.replace(entryPattern, (_match, prefix, suffix) => {
    totalCount += 1;
    return `${prefix}${to}${suffix}`;
  });
  const text = renamedEntries.replace(
    BIB_REFERENCE_FIELD_PATTERN,
    (match, prefix, keys, suffix) => {
      const result = replaceKeyInList(keys, from, to);
      if (result.count === 0) {
        return match;
      }
      totalCount += result.count;
      return `${prefix}${result.text}${suffix}`;
    }
  );
  return { text, count: totalCount };
};

module.exports = {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
};
