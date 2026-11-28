"use strict";

const path = require("node:path");
const { loadRecordedReads } = require("./build/preview-cache.cjs");
const { resolveReleaseBuildTarget } = require("./build/release-build-target.cjs");

/** error.code when the build target is not unique; error.candidates lists the documents. */
const BUILD_TARGET_CHOICE = "BUILD_TARGET_CHOICE";
const stripTexComments = (content) => String(content ?? "").split(/\r?\n/).map((line) => {
  let result = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") { result += line.slice(i, i + 2); i += 1; }
    else if (line[i] === "%") break;
    else result += line[i];
  }
  return result;
}).join("\n");

// Source shown as an example is not the file's own structure: a chapter that
// prints a complete "\documentclass … \begin{document}" listing is still a
// fragment. Drop verbatim-like material before looking for the real preamble.
const VERBATIM_ENV = "(?:[A-Za-z@]*[Vv]erbatim[A-Za-z@*]*|lstlisting\\*?|minted\\*?|[A-Za-z@]*[Ll]isting[A-Za-z@*]*|filecontents\\*?|comment|luacode\\*?)";
const verbatimEnvironment = new RegExp(`^\\s*\\{(${VERBATIM_ENV})\\}`);
const skipGroup = (source, start, open, close) => {
  let depth = 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  return source.length;
};

// Strip comments and literal examples in a single pass. A percent sign in a
// verbatim example is printed; it cannot comment out the real input after it.
const activeTexSource = (source) => {
  source = String(source ?? "");
  const tokens = /\\(?:[A-Za-z@]+|[\s\S])|%/g;
  let text = "", start = 0, token;
  while ((token = tokens.exec(source))) {
    const command = token[0];
    let end = tokens.lastIndex;
    if (command === "%") {
      const newline = source.indexOf("\n", end);
      end = newline < 0 ? source.length : newline;
    } else if (command === "\\begin") {
      const env = verbatimEnvironment.exec(source.slice(end));
      if (!env) continue;
      const close = new RegExp(`\\\\end\\s*\\{${env[1].replace(/\*/g, "\\*")}\\}`, "g");
      close.lastIndex = end + env[0].length;
      end = close.exec(source) ? close.lastIndex : source.length;
    } else if (command === "\\KKcodeS") {
      const close = source.indexOf("\\KKcodeE", end);
      end = close < 0 ? source.length : close + "\\KKcodeE".length;
    } else if (["\\verb", "\\lstinline", "\\mintinline", "\\KKverb"].includes(command)) {
      if (source[end] === "*") end++;
      if (command === "\\lstinline" || command === "\\mintinline") {
        if (source[end] === "[") end = skipGroup(source, end, "[", "]");
        if (command === "\\mintinline" && source[end] === "{") end = skipGroup(source, end, "{", "}");
      }
      const delimiter = source[end];
      if (!delimiter || /\s/u.test(delimiter)) continue;
      if ((command === "\\mintinline" || command === "\\lstinline") && delimiter === "{") {
        end = skipGroup(source, end, "{", "}");
      } else {
        const close = source.indexOf(delimiter, end + 1);
        const newline = source.indexOf("\n", end + 1);
        end = close >= 0 && (newline < 0 || close < newline) ? close + 1 : newline >= 0 ? newline : source.length;
      }
    } else if (command !== "\\\\") {
      continue;
    }
    text += source.slice(start, token.index) + source.slice(token.index, end).replace(/[^\r\n]/g, " ");
    start = end;
    tokens.lastIndex = end;
  }
  return text + source.slice(start);
};

const documentClassOf = (source) => {
  const declaration = /\\document(?:class|style)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(source);
  if (!declaration) return null;
  const body = /\\begin\s*\{document\}/.exec(source);
  if (!body || body.index < declaration.index) return null;
  // Body material before the declaration means the class line is quoted text.
  if (/\\(?:begin\s*\{|part\b|chapter\b|(?:sub)*section\b|input\b|include\b)/.test(source.slice(0, declaration.index))) {
    return null;
  }
  return declaration[1].trim();
};

// activeTexSource also blanks \\, so "\\input" is not read as \input.
const texStructure = (content) => activeTexSource(content);
const isStandaloneDocument = (content) => Boolean(documentClassOf(texStructure(content)));

const parseIncludes = (source) => {
  const result = [];
  const body = /\\begin\s*\{document\}/.exec(source);
  const endPattern = /\\end\s*\{document\}/g;
  endPattern.lastIndex = body ? body.index + body[0].length : 0;
  const end = endPattern.exec(source);
  const commands = /\\(input|include|subfile|subfileinclude)\s*\{([^{}]*)\}|\\(input)\s+("[^"\n]+"|[^\s{}\\%]+)|\\((?:sub)?(?:import|includefrom|inputfrom))\s*\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
  for (const match of source.slice(0, end?.index).matchAll(commands)) {
    const file = (match[2] ?? match[4] ?? match[7]).trim().replace(/^"(.+)"$/, "$1");
    const directory = match[6]?.trim();
    if (!file || /[\\#$]/.test(file) || (directory && /[\\#$]/.test(directory))) continue;
    result.push({ kind: match[1] ?? match[3] ?? match[5], directory, file });
  }
  return result;
};

// For the AI document map, word count and bibliography lookups (with
// offsets, or one whole-line include). The build graph below uses
// parseIncludes, which also stops at \end{document}.
const parseTexIncludes = (content, { masked = false, withPosition = false, wholeLine = false } = {}) => {
  const source = masked ? content : activeTexSource(content);
  const pattern = /\\(input|include|subfile|subfileinclude|InputIfFileExists)\s*\{([^}]*)\}|\\(input)\s+([^\s{}\\%]+)|\\((?:sub)?(?:import|includefrom|inputfrom))\s*\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
  const matches = Array.from(source.matchAll(pattern));
  if (wholeLine && (matches.length !== 1 || source.trim() !== matches[0][0])) return [];
  return matches.map(match => {
    const entry = match[5]
      ? { kind: match[5], directory: match[6].trim(), file: match[7].trim() }
      : { kind: match[1] || match[3], file: (match[2] ?? match[4]).trim() };
    if (withPosition) entry.offset = match.index;
    return entry;
  });
};

// Build, the AI document map and source ownership use the same ordered search.
const includeCandidates = (include, file, base, mainDir) => {
  const subfile = include.kind.startsWith("subfile");
  const dir = include.directory !== undefined
    ? path.posix.join(include.kind.startsWith("sub") ? base : mainDir, include.directory)
    : subfile ? path.posix.dirname(file) : base;
  const withExt = name => path.posix.extname(name) ? name : `${name}.tex`;
  const candidates = [withExt(path.posix.join(dir, include.file))];
  if (include.directory === undefined && !subfile) candidates.push(withExt(path.posix.normalize(include.file)));
  return [...new Set(candidates)].map(candidate => ({
    file: candidate,
    base: include.directory !== undefined || subfile ? path.posix.dirname(candidate) : base,
  }));
};

// Follow TeX's search directory through plain includes and imported/subfile trees.
const findTexIncludeBase = async (document, requested, read) => {
  const cwd = path.posix.dirname(document);
  if (document === requested) return cwd;
  const queue = [{ file: document, base: cwd, depth: 0 }];
  const visited = new Set();
  for (let index = 0; index < queue.length && visited.size < 2000; index++) {
    const entry = queue[index];
    const key = entry.file + "\0" + entry.base;
    if (visited.has(key) || entry.depth > 16) continue;
    visited.add(key);
    for (const include of parseTexIncludes(await read(entry.file))) {
      for (const child of includeCandidates(include, entry.file, entry.base, cwd)) {
        if (await read(child.file) === null) continue;
        if (child.file === requested) return child.base;
        queue.push({ ...child, depth: entry.depth + 1 });
        break;
      }
    }
  }
  return null;
};

// \includeonly{a, b} in a document's preamble: of the files it reads with
// \include (and the commands built on it), only those named are read. LaTeX
// drops every space from the list (\zap@space).
const INCLUDE_KINDS = new Set(["include", "subfileinclude", "includefrom", "subincludefrom"]);
const includeName = (name) => String(name).replace(/\s+/g, "").replace(/\.tex$/i, "");
// Only the option-free standard classes have a known preamble here. A
// project class or the stock class's size file can shadow that contract.
const STANDARD_CLASSES = new Set(["article", "report", "book"]);
const PREAMBLE_DEPTH = 16;
const PREAMBLE_VISITS = 256;
const includeSelected = (names, { kind, directory, file }) => !names || !INCLUDE_KINDS.has(kind) ||
  names.has(includeName(file)) || (directory !== undefined && names.has(includeName(join(directory, file))));

const { dirname, isAbsolute, join, normalize: normalizePath, extname } = path.posix;
const up = (file) => file === ".." || file.startsWith("../");
const joinImportPath = (directory, file) => {
  const joined = join(directory, file);
  return directory.startsWith("./") && !up(joined) ? `./${joined}` : joined;
};
const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;

const requestChoice = (candidates, requested = null) => {
  const error = new Error(requested
    ? `Several documents could be built for ${requested}. Choose one.`
    : "Several documents could be built. Choose one.");
  error.code = BUILD_TARGET_CHOICE;
  error.candidates = candidates.sort(comparePaths);
  error.requested = requested;
  throw error;
};

// onMagicRoot: called when a `% !TEX root` line in the requested file decides
// the target (live preview then follows that document only).
const resolveBuildTarget = async (workspace, requestedPath, { includingDocuments = false, requireUniqueOwner = false,
  includesOf = null, recordedReads = loadRecordedReads, onMagicRoot = null } = {}) => {
  const root = workspace.getRootPath();
  if (!includingDocuments && !requireUniqueOwner && includesOf === null) {
    return resolveReleaseBuildTarget(workspace, requestedPath, {
      onMagicRoot,
      async recordedOwner(documents, requested) {
        const candidates = documents.filter((file) => file !== requested);
        if (candidates.length < 2) return null;
        const reads = await Promise.all(candidates.map(async (file) => {
          try {
            const inputs = await recordedReads?.({
              rootPath: root, mainFileName: file, requiredFiles: [file, requested],
            });
            return inputs?.has(file) && inputs.has(requested) ? file : null;
          } catch {
            return null;
          }
        }));
        const owners = reads.filter(Boolean);
        return owners.length === 1 ? owners[0] : null;
      },
    });
  }
  const normalize = (file) => {
    const result = path.relative(root, workspace.resolvePath(file)).split(path.sep).join("/");
    if (!result || up(result) || isAbsolute(result)) throw new Error("Invalid build target.");
    return result;
  };
  const current = () => { if (workspace.getRootPath() !== root) throw new Error("Workspace changed."); };
  const readCache = new Map();
  const read = async (file) => {
    current();
    if (!readCache.has(file)) {
      readCache.set(file, (async () => {
        try {
          const relativePath = normalize(file); // retain the workspace realpath guard
          return await workspace.readFile(relativePath);
        } catch {
          return null;
        }
      })());
    }
    const content = await readCache.get(file);
    current();
    return content;
  };
  const sourceCache = new Map();
  const structure = async (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, read(file).then(texStructure));
    return sourceCache.get(file);
  };
  let inventory;
  const buildFiles = () => {
    inventory ??= (workspace.listBuildTexFiles?.({ includeStyles: true }) ?? workspace.listFiles()).then((files) => {
      current();
      return files;
    });
    return inventory;
  };
  const standaloneDocuments = async () => {
    const found = [];
    for (const candidate of await buildFiles()) {
      if (!/\.tex$/i.test(candidate)) continue;
      const className = documentClassOf(await structure(candidate));
      if (className) found.push({ file: candidate, className });
    }
    return found;
  };
  const rootInfo = async () => {
    const info = await workspace.rootInfo().catch(() => null);
    current();
    return info;
  };
  let customBuildSetup;
  const hasCustomBuildSetup = () => customBuildSetup ??= Promise.all(
    [".latexmkrc", "latexmkrc"].map(read)
  ).then((files) => files.some((content) => content !== null));
  const recent = requireUniqueOwner ? [] : workspace.getRecentBuildTargets?.() ?? [];
  if (!requestedPath || !/\.tex$/i.test(requestedPath)) {
    if (includingDocuments) return [];
    const info = await rootInfo();
    if (info?.source === "manual" && await read(info.path) !== null) return info.path;
    for (const file of recent) {
      if (documentClassOf(await structure(file))) return file;
    }
    if (await read("main.tex") !== null) return "main.tex";
    const documents = (await standaloneDocuments()).map(({ file }) => file);
    if (documents.length === 1) return documents[0];
    if (documents.length > 1) requestChoice(documents);
    return info?.path && await read(info.path) !== null ? info.path : "main.tex";
  }

  const requested = normalize(requestedPath);
  if (await read(requested) === null) throw new Error(`File not found: ${requested}`);
  if (!includingDocuments && includesOf === null) {
    const magic = await workspace.resolveTexRootFromMagic(requested).catch(() => null);
    current();
    if (magic && normalize(magic) !== requested && await read(magic) !== null) {
      onMagicRoot?.();
      return normalize(magic);
    }
    const className = documentClassOf(await structure(requested));
    if (className && className !== "subfiles") return requested;
  }

  let recursiveLookup;
  const filesByBasename = () => {
    recursiveLookup ??= buildFiles().then((files) => {
      const index = new Map();
      for (const file of files) {
        if (!/\.(?:tex|sty|cls|clo)$/i.test(file)) continue;
        const name = path.posix.basename(file);
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(file);
      }
      return index;
    });
    return recursiveLookup;
  };
  const findInput = async (names, rootBases) => {
    for (const name of names) {
      const directOnly = isAbsolute(name) || /^\.\.?\//.test(name);
      const bases = directOnly ? ["."] : rootBases;
      const candidates = extname(name) ? [name] : [`${name}.tex`, name];
      for (const base of bases) {
        for (const candidate of candidates) {
          const direct = isAbsolute(candidate) ? candidate : join(base, candidate);
          if (await read(direct) !== null) return normalize(direct);
          if (directOnly || !/\.(?:tex|sty|cls)$/i.test(candidate)) continue;
          // Build puts the document directory and workspace on TEXINPUTS
          // with //, so TeX also searches their subdirectories, in that order.
          const matching = (await filesByBasename()).get(path.posix.basename(candidate)) ?? [];
          const prefix = base === "." ? "" : `${base}/`;
          const suffix = `/${normalizePath(candidate)}`;
          const matches = matching.filter((file) => file.startsWith(prefix) && file.endsWith(suffix));
          // A collision here depends on TeX's directory enumeration order.
          if (matches.length > 1) return null;
          if (matches.length === 1 && await read(matches[0]) !== null) return matches[0];
        }
      }
    }
    return undefined;
  };
  // Parse a closed grammar: a stock class followed by only literal inputs
  // and includeonly lists. Any other token makes the whole selection unknown,
  // including code after a literal includeonly and before begin{document}.
  const includeOnlyOf = async (document, rootBases) => {
    if (await hasCustomBuildSetup()) return { selected: null, sources: null };
    const sources = new Set([document]);
    const active = new Set();
    let visits = 0;
    let selected = null;
    const scan = async (file, main = false) => {
      if (active.has(file) || active.size >= PREAMBLE_DEPTH || visits++ >= PREAMBLE_VISITS) return false;
      const content = await read(file);
      if (content === null) return false;
      active.add(file);
      sources.add(file);
      try {
        let rest = stripTexComments(content);
        if (main) {
          const declaration = /^[ \t\r\n]*\\documentclass[ \t\r\n]*\{([a-z]+)\}/.exec(rest);
          if (!STANDARD_CLASSES.has(declaration?.[1])) return false;
          const shadows = new Set([`${declaration[1]}.cls`, "size10.clo", "bk10.clo"]);
          if ((await buildFiles()).some((name) => shadows.has(path.posix.basename(name).toLowerCase()))) return false;
          for (const name of shadows) {
            for (const base of rootBases) if (await read(join(base, name)) !== null) return false;
          }
          rest = rest.slice(declaration[0].length);
        }
        for (;;) {
          rest = rest.replace(/^[ \t\r\n]+/, "");
          if (main && /^\\begin[ \t\r\n]*\{document\}/.test(rest)) return true;
          if (!rest) return !main;
          const selection = /^\\includeonly[ \t\r\n]*\{([A-Za-z0-9.,/_ \t\r\n-]*)\}/.exec(rest);
          if (selection) {
            selected = new Set(selection[1].split(",").map(includeName).filter(Boolean));
            rest = rest.slice(selection[0].length);
            continue;
          }
          const input = /^\\input(?:[ \t\r\n]*\{([A-Za-z0-9_-]+(?:\.tex)?)\}|[ \t\r\n]+([A-Za-z0-9_-]+(?:\.tex)?)(?=[ \t\r\n]|$))/.exec(rest);
          if (!input) return false;
          const name = input[1] ?? input[2];
          const basename = (extname(name) ? name : `${name}.tex`).toLowerCase();
          const alternatives = (await buildFiles()).filter((candidate) =>
            [basename, name.toLowerCase()].includes(path.posix.basename(candidate).toLowerCase()));
          // Only one unambiguous project input. The graph's more permissive
          // TEXINPUTS guesses must never become proof of exclusion.
          if (alternatives.length !== 1 || !rootBases.includes(dirname(alternatives[0])) ||
              await findInput([name], rootBases) !== alternatives[0] ||
              !await scan(alternatives[0])) return false;
          rest = rest.slice(input[0].length);
        }
      } finally {
        active.delete(file);
      }
    };
    return await scan(document, true) ? { selected, sources } : { selected: null, sources: null };
  };
  const includeCache = new Map();
  const graphCache = new Map();
  const preambleCache = new Map();
  const rootBasesFor = (document) => [...new Set([dirname(document), "."])];
  const preamble = (document) => {
    if (!preambleCache.has(document)) preambleCache.set(document, includeOnlyOf(document, rootBasesFor(document)));
    return preambleCache.get(document);
  };
  const includeGraph = async (document, onEdge = null) => {
    if (!onEdge && graphCache.has(document)) return graphCache.get(document);
    const files = new Set();
    const seen = new Set();
    const rootBases = rootBasesFor(document);
    // what this document's \includeonly leaves out is not read
    const { selected } = await preamble(document);
    const queue = [{ file: document, importPath: null, search: [] }];
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      const key = JSON.stringify([entry.file, entry.importPath, entry.search]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!includeCache.has(entry.file)) includeCache.set(entry.file, parseIncludes(await structure(entry.file)));
      for (const { kind, directory, file } of includeCache.get(entry.file)) {
        if (!includeSelected(selected, { kind, directory, file })) continue;
        let importPath = entry.importPath;
        let search = entry.search;
        const subfile = kind === "subfile" || kind === "subfileinclude";
        let name = file;
        if (directory !== undefined || subfile) {
          const dir = directory ?? dirname(file);
          const base = kind.startsWith("sub") ? entry.importPath : null;
          importPath = isAbsolute(dir)
            ? normalizePath(dir)
            : joinImportPath(base ?? (dir.startsWith("./") ? "./" : "."), dir);
          search = [...new Set([importPath, ...search])];
          name = subfile && isAbsolute(file)
            ? file
            : joinImportPath(importPath, subfile ? path.posix.basename(file) : file);
        }
        const names = directory !== undefined || subfile || isAbsolute(name)
          ? [name]
          : [...search.map((prefix) => joinImportPath(prefix, name)), name];
        const candidate = await findInput(names, rootBases);
        if (!candidate) continue;
        onEdge?.({ from: entry.file, kind, directory, file, target: candidate });
        files.add(candidate);
        queue.push({ file: candidate, importPath, search });
      }
    }
    if (!onEdge) graphCache.set(document, files);
    return files;
  };

  // (resolveIncludesOf) the files `includesOf` reads as this document's
  // Build reaches it: with the bases \import, \subimport and \subfile set
  if (includesOf !== null) {
    const from = normalize(includesOf);
    const edges = new Map();
    await includeGraph(requested, (edge) => { if (edge.from === from) edges.set(JSON.stringify(edge), edge); });
    return [...edges.values()];
  }

  const documents = (await standaloneDocuments()).filter(({ file }) => file !== requested);
  const info = includingDocuments ? null : await rootInfo();
  const manual = info?.source === "manual" ? info.path : null;
  if (manual && manual !== requested && !documents.some(({ file }) => file === manual) && await read(manual) !== null) {
    documents.push({ file: manual, className: null });
  }
  // There is no decision for the recorder to change when the sole document
  // already owns the fragment. Avoid hashing an entire opaque preamble chain.
  const soleDocument = documents.length === 1 ? documents[0].file : null;
  if (soleDocument && (await includeGraph(soleDocument)).has(requested)) {
    return includingDocuments ? [soleDocument] : soleDocument;
  }

  const owners = [];
  const fresh = [];
  for (const document of documents) {
    const { file } = document;
    const { sources } = await preamble(file);
    const reads = await Promise.resolve().then(() => recordedReads?.({
      rootPath: root,
      mainFileName: file,
      requiredFiles: [...(sources ?? [file]), requested],
    })).catch(() => null);
    current();
    if (reads?.has(requested)) {
      fresh.push(document);
      owners.push(document);
    } else if ((await includeGraph(file)).has(requested)) {
      owners.push(document);
    }
  }
  if (includingDocuments) return owners.map(({ file }) => file).sort(comparePaths);
  // Bibliography writes still ask when the document would affect which file is edited.
  if (requireUniqueOwner && manual && owners.some(({ file }) => file === manual)) return manual;
  if (requireUniqueOwner && owners.length > 1) requestChoice(owners.map(({ file }) => file), requested);
  if (fresh.length === 1) return fresh[0].file;
  if (fresh.length > 1) {
    if (fresh.some(({ file }) => file === manual)) return manual;
    requestChoice(fresh.map(({ file }) => file), requested);
  }
  if (manual && owners.some(({ file }) => file === manual)) return manual;

  // An independently compilable chapter is an intermediate node when a
  // document above it includes the requested source too.
  const roots = [];
  for (const owner of owners) {
    let nested = false;
    if (owner.className === "subfiles") {
      for (const other of owners) {
        if (other !== owner && (await includeGraph(other.file)).has(owner.file)) {
          nested = true;
          break;
        }
      }
    }
    if (!nested) roots.push(owner.file);
  }
  const candidates = roots.length ? roots : owners.map(({ file }) => file);
  if (candidates.length > 1) requestChoice(candidates, requested);
  return candidates[0] ?? requested;
};

const resolveIncludingDocuments = (workspace, requestedPath) =>
  resolveBuildTarget(workspace, requestedPath, { includingDocuments: true });

/**
 * What `fromFile` reads, as the Build of `rootFile` resolves it (the bases
 * \import, \subimport and \subfile set, TEXINPUTS search included), as
 * [{ from, kind, directory, file, target }]: `file` as written, `target`
 * the workspace file read. For Jump from a line that reads a file.
 */
const resolveIncludesOf = (workspace, rootFile, fromFile) =>
  resolveBuildTarget(workspace, rootFile, { includesOf: fromFile });

module.exports = {
  BUILD_TARGET_CHOICE, resolveBuildTarget, resolveIncludingDocuments, resolveIncludesOf, stripTexComments, activeTexSource,
  isStandaloneDocument, parseTexIncludes, includeCandidates, findTexIncludeBase,
};
