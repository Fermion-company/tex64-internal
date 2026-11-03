"use strict";

// Prism (OpenAI's cloud LaTeX workspace) closes on 2027-01-01. Its users leave
// with "Export all projects": a zip holding one folder per project with the
// sources, figures, the last saved PDF and sometimes `conversations/*.json`.
// This module turns such a zip into local projects TeX64 can compile:
//
//   extractZip        zip → folder (path traversal and symlinks refused, 2 GB
//                     cap counted on the bytes actually inflated)
//   findProjects      which folders of the extracted tree are projects
//   analyzeProject    pure: main file, engine, bibliography tool, packages,
//                     Prism's last PDF, conversation logs
//   conversationToMarkdown  pure: a chat log → a readable note
//   readPdfOutline    text features of a PDF (title, headings, equation
//                     numbers, citations, page count)
//   comparePdfOutlines pure: the difference list shown after the first build

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { pathToFileURL } = require("node:url");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT = 50000;
// 50,000 records with ordinary names take a few MB; the directory is read
// into memory once, so its size is checked before that read.
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_TEX_READ_BYTES = 4 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".tex", ".ltx", ".sty", ".cls", ".bib", ".bbl", ".txt", ".md", ".json"]);
const IGNORED_SEGMENTS = new Set(["__MACOSX", ".git", "node_modules", ".tex64"]);

// ---------------------------------------------------------------------------
// zip extraction
//
// The zip is read with node:zlib alone. Every size in a zip is the archive's
// own claim, so the entry count and the central directory are bounded before
// they are read, and each entry is inflated as a stream through a counter
// that stops at the size the directory declared for it (those sizes sum to
// at most 2 GB). An entry that inflates to more, or to less, ends the import
// and the files written so far are removed.

const SIGNATURE = {
  local: 0x04034b50,
  central: 0x02014b50,
  end: 0x06054b50,
  zip64End: 0x06064b50,
  zip64Locator: 0x07064b50,
};

const isSymlinkAttributes = (externalFileAttributes) => {
  const mode = (Number(externalFileAttributes) >>> 16) & 0o170000;
  return mode === 0o120000;
};

const normalizeZipPath = (rawPath) => {
  const value = String(rawPath || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0")) return null;
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
};

const isIgnoredEntry = (segments) => segments.some((segment) => IGNORED_SEGMENTS.has(segment) || segment === ".DS_Store");

const abortError = () => Object.assign(new Error("Import cancelled."), { name: "AbortError" });
const invalidZip = (detail) => new Error(`Invalid zip: ${detail}`);

const strictDecoder = (label) => {
  try { return new TextDecoder(label, { fatal: true }); } catch { return null; }
};
const STRICT_UTF8 = strictDecoder("utf-8");
const STRICT_SHIFT_JIS = strictDecoder("shift_jis");
const LOOSE_UTF8 = new TextDecoder("utf-8");

// Names are UTF-8 when bit 11 says so and, in practice, also in zips from
// macOS and web services that leave the bit unset. A name that is not valid
// UTF-8 is most often Shift_JIS from Windows' "Send to compressed folder".
const decodeZipName = (bytes, flags) => {
  try { if (STRICT_UTF8) return STRICT_UTF8.decode(bytes); } catch { /* fall through */ }
  if (!(flags & 0x800) && STRICT_SHIFT_JIS) {
    try { return STRICT_SHIFT_JIS.decode(bytes); } catch { /* fall through */ }
  }
  return LOOSE_UTF8.decode(bytes);
};

const dosDateTime = (date, time) => {
  const value = new Date(Date.UTC(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2));
  return Number.isNaN(value.getTime()) ? null : value;
};

const readExactly = async (handle, length, position) => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw invalidZip("truncated");
    offset += bytesRead;
  }
  return buffer;
};

const readUInt64 = (buffer, offset) => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidZip("size out of range");
  return Number(value);
};

const readEndRecord = async (handle, zipSize) => {
  const tailLength = Math.min(zipSize, 22 + 0xffff);
  if (tailLength < 22) throw invalidZip("no end record");
  const tail = await readExactly(handle, tailLength, zipSize - tailLength);
  let at = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === SIGNATURE.end) { at = index; break; }
  }
  if (at < 0) throw invalidZip("no end record");
  const endOffset = zipSize - tailLength + at;
  const record = {
    disk: tail.readUInt16LE(at + 4),
    directoryDisk: tail.readUInt16LE(at + 6),
    count: tail.readUInt16LE(at + 10),
    directorySize: tail.readUInt32LE(at + 12),
    directoryOffset: tail.readUInt32LE(at + 16),
    directoryEnd: endOffset,
  };
  if (record.count === 0xffff || record.directorySize === 0xffffffff || record.directoryOffset === 0xffffffff) {
    if (endOffset < 20) throw invalidZip("no zip64 locator");
    const locator = await readExactly(handle, 20, endOffset - 20);
    if (locator.readUInt32LE(0) !== SIGNATURE.zip64Locator) throw invalidZip("no zip64 locator");
    const recordOffset = readUInt64(locator, 8);
    if (recordOffset + 56 > endOffset - 20) throw invalidZip("zip64 end record out of range");
    const zip64 = await readExactly(handle, 56, recordOffset);
    if (zip64.readUInt32LE(0) !== SIGNATURE.zip64End) throw invalidZip("no zip64 end record");
    record.disk = zip64.readUInt32LE(16);
    record.directoryDisk = zip64.readUInt32LE(20);
    record.count = readUInt64(zip64, 32);
    record.directorySize = readUInt64(zip64, 40);
    record.directoryOffset = readUInt64(zip64, 48);
    record.directoryEnd = recordOffset;
  }
  if (record.disk !== 0 || record.directoryDisk !== 0) throw invalidZip("split archives are not supported");
  return record;
};

// The zip64 extra field carries, in this order, whichever of the three
// values the record itself set to 0xffffffff.
const applyZip64Extra = (entry, extra) => {
  const wanted = ["uncompressedSize", "compressedSize", "localHeaderOffset"].filter((key) => entry[key] === 0xffffffff);
  if (wanted.length === 0) return;
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const body = extra.subarray(at + 4, at + 4 + extra.readUInt16LE(at + 2));
    if (id === 0x0001) {
      wanted.forEach((key, index) => {
        if ((index + 1) * 8 > body.length) throw invalidZip("short zip64 field");
        entry[key] = readUInt64(body, index * 8);
      });
      return;
    }
    at += 4 + body.length;
  }
  throw invalidZip("missing zip64 field");
};

const readCentralDirectory = async (handle, zipSize) => {
  const end = await readEndRecord(handle, zipSize);
  if (end.count > MAX_ENTRY_COUNT || end.directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error("The zip holds too many files.");
  }
  if (end.directoryOffset + end.directorySize > end.directoryEnd || end.count * 46 > end.directorySize) {
    throw invalidZip("central directory out of range");
  }
  const directory = await readExactly(handle, end.directorySize, end.directoryOffset);
  const entries = [];
  let at = 0;
  for (let index = 0; index < end.count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIGNATURE.central) throw invalidZip("damaged central directory");
    const flags = directory.readUInt16LE(at + 8);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const next = at + 46 + nameLength + extraLength + directory.readUInt16LE(at + 32);
    if (next > directory.length) throw invalidZip("damaged central directory");
    const entry = {
      path: decodeZipName(directory.subarray(at + 46, at + 46 + nameLength), flags),
      flags,
      method: directory.readUInt16LE(at + 10),
      mtime: dosDateTime(directory.readUInt16LE(at + 14), directory.readUInt16LE(at + 12)),
      compressedSize: directory.readUInt32LE(at + 20),
      uncompressedSize: directory.readUInt32LE(at + 24),
      externalFileAttributes: directory.readUInt32LE(at + 38),
      localHeaderOffset: directory.readUInt32LE(at + 42),
    };
    applyZip64Extra(entry, directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    entries.push(entry);
    at = next;
  }
  return entries;
};

// Which entries are written, checked before anything touches the disk.
// APFS and NTFS fold case and Unicode normalization, so `Fig.png` and
// `fig.png`, or a file and a folder of one name, would land on one path:
// the first entry keeps it and a later one is left out, never replacing a
// file already written. Duplicate names are left out the same way.
const planEntries = (entries) => {
  const planned = [];
  const fileKeys = new Set();
  const folderKeys = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    if (/[\\/]$/.test(entry.path)) continue;
    const normalized = normalizeZipPath(entry.path);
    if (!normalized) throw new Error(`Unsafe path inside the zip: ${entry.path}`);
    if (isIgnoredEntry(normalized.split("/"))) continue;
    if (isSymlinkAttributes(entry.externalFileAttributes)) continue;
    if (entry.flags & 0x1) throw invalidZip(`encrypted entry ${normalized}`);
    if (entry.method !== 0 && entry.method !== 8) throw invalidZip(`unsupported compression in ${normalized}`);
    const keySegments = normalized.normalize("NFC").toLowerCase().split("/");
    const key = keySegments.join("/");
    const folders = keySegments.slice(0, -1).map((_, index) => keySegments.slice(0, index + 1).join("/"));
    if (fileKeys.has(key) || folderKeys.has(key) || folders.some((folder) => fileKeys.has(folder))) continue;
    fileKeys.add(key);
    folders.forEach((folder) => folderKeys.add(folder));
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("The zip expands to more than 2 GB.");
    planned.push({ entry, relativePath: normalized });
  }
  return planned;
};

// One entry → one new file. `wx` refuses anything already at the path, a
// symbolic link included; `onCreated` hears of the file once it exists so a
// failure later on can remove it.
const writeEntry = async (zip, zipSize, entry, target, { signal, onCreated }) => {
  const header = await readExactly(zip, 30, entry.localHeaderOffset);
  if (header.readUInt32LE(0) !== SIGNATURE.local) throw invalidZip(`damaged entry ${target}`);
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > zipSize) throw invalidZip(`damaged entry ${target}`);
  let written = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      callback(written > entry.uncompressedSize ? invalidZip(`entry larger than declared: ${target}`) : null, chunk);
    },
  });
  const output = await fsp.open(target, "wx");
  onCreated(target);
  try {
    const source = entry.compressedSize > 0
      ? zip.createReadStream({ start, end: start + entry.compressedSize - 1, autoClose: false })
      : Readable.from([]);
    const stages = entry.method === 8 ? [source, zlib.createInflateRaw(), counter] : [source, counter];
    await pipeline(...stages, output.createWriteStream(), ...(signal ? [{ signal }] : []));
  } finally {
    await output.close().catch(() => {});
  }
  if (written !== entry.uncompressedSize) throw invalidZip(`entry smaller than declared: ${target}`);
  return written;
};

const extractZip = async (zipPath, destinationDir, { onProgress = () => {}, signal } = {}) => {
  const stat = await fsp.stat(zipPath);
  if (!stat.isFile()) throw new Error("The selected path is not a zip file.");
  if (stat.size > MAX_TOTAL_BYTES) throw new Error("The zip is larger than 2 GB.");
  const checkAborted = () => { if (signal?.aborted) throw abortError(); };
  checkAborted();
  const zip = await fsp.open(zipPath, "r");
  // What this call made, so that a failure or a cancel leaves nothing behind.
  let createdRoot = null;
  const createdFolders = [];
  const createdFiles = [];
  try {
    const planned = planEntries(await readCentralDirectory(zip, stat.size));
    if (planned.length === 0) throw new Error("The zip holds no files.");
    // A zip whose every entry sits under one folder (the usual `export/` or the
    // zip's own name) unpacks that folder's contents, so the destination does
    // not end up as `<zip>/<zip>/…`.
    const firstSegments = new Set(planned.map(({ relativePath }) => relativePath.split("/")[0]));
    if (firstSegments.size === 1 && planned.every(({ relativePath }) => relativePath.includes("/"))) {
      for (const item of planned) item.relativePath = item.relativePath.split("/").slice(1).join("/");
    }
    checkAborted();
    const root = path.resolve(destinationDir);
    createdRoot = (await fsp.mkdir(root, { recursive: true })) ?? null;
    const realRoot = await fsp.realpath(root);
    let written = 0;
    const files = [];
    for (const { entry, relativePath } of planned) {
      checkAborted();
      const target = path.resolve(realRoot, ...relativePath.split("/"));
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
        throw new Error(`Unsafe path inside the zip: ${relativePath}`);
      }
      const madeFolder = await fsp.mkdir(path.dirname(target), { recursive: true });
      if (madeFolder) createdFolders.push(madeFolder);
      const parentReal = await fsp.realpath(path.dirname(target));
      if (parentReal !== realRoot && !parentReal.startsWith(realRoot + path.sep)) {
        throw new Error(`Unsafe path inside the zip: ${relativePath}`);
      }
      const size = await writeEntry(zip, stat.size, entry, target, { signal, onCreated: (file) => createdFiles.push(file) });
      if (entry.mtime) await fsp.utimes(target, entry.mtime, entry.mtime).catch(() => {});
      written += 1;
      files.push({ relativePath, size, mtime: entry.mtime ? entry.mtime.getTime() : stat.mtimeMs });
      onProgress({ current: written, total: planned.length, relativePath });
    }
    return { root: realRoot, files };
  } catch (error) {
    if (createdRoot) {
      await fsp.rm(createdRoot, { recursive: true, force: true }).catch(() => {});
    } else {
      for (const file of createdFiles) await fsp.rm(file, { force: true }).catch(() => {});
      for (const folder of createdFolders.reverse()) await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
    throw signal?.aborted ? abortError() : error;
  } finally {
    await zip.close().catch(() => {});
  }
};

// ---------------------------------------------------------------------------
// project discovery

// Prism exports one folder per project; a project is the shallowest folder
// that holds a .tex file directly. A zip that is a single project (tex at the
// root) and a wrapper folder such as `projects/` both fall out of this rule.
const findProjects = (relativePaths, { maxDepth = 4 } = {}) => {
  const texDirs = new Set();
  for (const relativePath of relativePaths) {
    const normalized = normalizeZipPath(relativePath);
    if (!normalized || !/\.(tex|ltx)$/i.test(normalized)) continue;
    const segments = normalized.split("/");
    if (isIgnoredEntry(segments)) continue;
    texDirs.add(segments.slice(0, -1).join("/"));
  }
  if (texDirs.size === 0) return [];
  if (texDirs.has("")) return [""];
  const sorted = [...texDirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const projects = [];
  for (const dir of sorted) {
    if (dir.split("/").length > maxDepth) continue;
    if (projects.some((root) => dir === root || dir.startsWith(`${root}/`))) continue;
    projects.push(dir);
  }
  return projects;
};

// ---------------------------------------------------------------------------
// project analysis (pure)

const stripComments = (source) => String(source || "").replace(/(^|[^\\])%.*$/gm, "$1");

const DOCUMENTCLASS_RE = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/;
const USEPACKAGE_RE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const INPUT_RE = /\\(?:input|include|subfile|import|subimport)\s*(?:\{[^}]*\}\s*)?\{([^}]*)\}/g;

const texBaseName = (value) => String(value || "").trim().replace(/\.tex$/i, "");

const collectInputs = (source) => {
  const inputs = new Set();
  let match;
  INPUT_RE.lastIndex = 0;
  while ((match = INPUT_RE.exec(source))) {
    const raw = texBaseName(match[1]).replace(/\\/g, "/");
    if (raw) inputs.add(raw);
  }
  return inputs;
};

const detectEngine = (source, documentClass, classOptions) => {
  const text = source;
  const cls = String(documentClass || "").toLowerCase();
  const options = String(classOptions || "").toLowerCase();
  const hasLua = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(luatexja|luatexja-[a-z]+|luacode|lualatex-math)\b/.test(text) || /^ltj/.test(cls) || cls === "jlreq" && /lualatex|luatex/.test(options);
  if (hasLua) return "lualatex";
  const hasXe = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(xecjk|xeCJK|zxjatype|xltxtra|xunicode)\b/i.test(text) || /\bxelatex\b/.test(options);
  if (hasXe) return "xelatex";
  const hasFontspec = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bfontspec\b/.test(text);
  if (hasFontspec) return "xelatex";
  if (/\buplatex\b|\bplatex\b|\bdvipdfmx\b/.test(options) || /^(u?js(article|book|report)|u?jarticle|u?jbook|u?jreport|jlreq|bxjsarticle|bxjsbook)$/.test(cls)) {
    return "uplatex";
  }
  return "pdflatex";
};

const detectBibTool = (source) => {
  const biblatex = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{[^}]*\bbiblatex\b[^}]*\}/.exec(source);
  if (biblatex) {
    const options = String(biblatex[1] || "").toLowerCase();
    const backend = /backend\s*=\s*([a-z0-9]+)/.exec(options);
    if (backend && backend[1] === "bibtex") return "bibtex";
    if (backend && backend[1] === "bibtex8") return "bibtex";
    return "biber";
  }
  if (/\\bibliographystyle\s*\{/.test(source) || /\\bibliography\s*\{/.test(source)) return "bibtex";
  return "none";
};

const packageNamesOf = (source) => {
  const names = [];
  const seen = new Set();
  const push = (name) => {
    const trimmed = String(name || "").trim();
    if (!trimmed || !/^[A-Za-z0-9@_.+-]+$/.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    names.push(trimmed);
  };
  const cls = DOCUMENTCLASS_RE.exec(source);
  if (cls) push(`${cls[2].trim()}.cls`);
  let match;
  USEPACKAGE_RE.lastIndex = 0;
  while ((match = USEPACKAGE_RE.exec(source))) {
    match[1].split(",").forEach((entry) => push(`${entry.trim()}.sty`));
  }
  return names;
};

const sortCandidates = (candidates, includedBaseNames) => {
  const score = (candidate) => {
    const base = texBaseName(path.posix.basename(candidate.path)).toLowerCase();
    const included = includedBaseNames.has(texBaseName(candidate.path).toLowerCase()) || includedBaseNames.has(base);
    return [
      base === "main" ? 0 : 1,
      included ? 1 : 0,
      -(candidate.mtime || 0),
      candidate.path.split("/").length,
      candidate.path,
    ];
  };
  return [...candidates].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] < right[index]) return -1;
      if (left[index] > right[index]) return 1;
    }
    return 0;
  });
};

/**
 * Analyze a project from its file list. Every entry: `{ path, size?, mtime?, content? }`,
 * paths relative to the project root with `/` separators; `content` holds
 * the text of .tex/.bib files. The result is deterministic and does not touch
 * the file system.
 */
const analyzeProject = (files) => {
  const list = (Array.isArray(files) ? files : [])
    .map((file) => ({ ...file, path: normalizeZipPath(file.path) }))
    .filter((file) => file.path);
  const texFiles = list.filter((file) => /\.(tex|ltx)$/i.test(file.path));
  const candidates = [];
  const includedBaseNames = new Set();
  for (const file of texFiles) {
    const source = stripComments(file.content || "");
    collectInputs(source).forEach((name) => {
      includedBaseNames.add(name.toLowerCase());
      includedBaseNames.add(name.split("/").pop().toLowerCase());
    });
    if (DOCUMENTCLASS_RE.test(source) && /\\begin\s*\{document\}/.test(source)) {
      candidates.push(file);
    }
  }
  const ordered = sortCandidates(candidates, includedBaseNames);
  const main = ordered[0] || null;
  const mainSource = main ? stripComments(main.content || "") : "";
  // The preamble often lives in an \input'ed file; fold the directly included
  // files into the text that decides engine, bibliography tool and packages.
  const inputsOfMain = main ? collectInputs(mainSource) : new Set();
  const mainDir = main ? path.posix.dirname(main.path) : ".";
  const foldedSources = [mainSource];
  for (const file of texFiles) {
    if (!main || file === main) continue;
    const relativeToMain = path.posix.relative(mainDir === "." ? "" : mainDir, file.path);
    const base = texBaseName(relativeToMain);
    if (inputsOfMain.has(base) || inputsOfMain.has(texBaseName(file.path))) foldedSources.push(stripComments(file.content || ""));
  }
  const folded = foldedSources.join("\n");
  const cls = DOCUMENTCLASS_RE.exec(mainSource);
  const engine = main ? detectEngine(folded, cls ? cls[2] : "", cls ? cls[1] : "") : "pdflatex";
  const bibTool = main ? detectBibTool(folded) : "none";
  const packages = main ? packageNamesOf(folded) : [];
  const bibFiles = list.filter((file) => /\.bib$/i.test(file.path)).map((file) => file.path);
  const pdfs = list.filter((file) => /\.pdf$/i.test(file.path) && !/^(figures?|img|images|fig|assets)\//i.test(file.path));
  const mainStem = main ? texBaseName(main.path).toLowerCase() : "";
  const prismPdf = [...pdfs].sort((a, b) => {
    const aMatch = texBaseName(a.path.replace(/\.pdf$/i, "")).toLowerCase() === mainStem ? 0 : 1;
    const bMatch = texBaseName(b.path.replace(/\.pdf$/i, "")).toLowerCase() === mainStem ? 0 : 1;
    return aMatch - bMatch || (b.mtime || 0) - (a.mtime || 0) || a.path.localeCompare(b.path);
  })[0] || null;
  const conversations = list.filter((file) => /(^|\/)conversations\/[^/]+\.json$/i.test(file.path)).map((file) => file.path);
  return {
    mainFile: main ? main.path : null,
    candidates: ordered.map((file) => file.path),
    texFiles: texFiles.map((file) => file.path),
    engine,
    bibTool,
    packages,
    bibFiles,
    prismPdf: prismPdf ? prismPdf.path : null,
    conversations,
    documentClass: cls ? cls[2].trim() : null,
  };
};

// ---------------------------------------------------------------------------
// conversation logs → Markdown

const textOfContent = (content) => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOfContent).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.value === "string") return content.value;
    if (Array.isArray(content.parts)) return content.parts.map(textOfContent).filter(Boolean).join("\n");
    if (content.content !== undefined) return textOfContent(content.content);
  }
  return "";
};

const timeOf = (message) => {
  const raw = message.created_at ?? message.createdAt ?? message.timestamp ?? message.time ?? message.create_time ?? null;
  if (raw == null) return "";
  const number = typeof raw === "number" ? raw : Number(raw);
  const date = Number.isFinite(number) ? new Date(number < 1e12 ? number * 1000 : number) : new Date(String(raw));
  return Number.isNaN(date.getTime()) ? String(raw) : date.toISOString().replace("T", " ").slice(0, 19);
};

const roleOf = (message) => {
  const raw = message.role ?? message.author?.role ?? message.sender ?? message.from ?? "";
  return String(raw || "unknown");
};

const flattenMessages = (json) => {
  if (Array.isArray(json)) return json.filter((entry) => entry && typeof entry === "object");
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.messages)) return json.messages.filter((entry) => entry && typeof entry === "object");
  if (Array.isArray(json.turns)) return json.turns.filter((entry) => entry && typeof entry === "object");
  if (json.mapping && typeof json.mapping === "object") {
    return Object.values(json.mapping)
      .map((node) => node && node.message)
      .filter((message) => message && typeof message === "object")
      .sort((a, b) => (Number(a.create_time) || 0) - (Number(b.create_time) || 0));
  }
  return [];
};

const conversationToMarkdown = (json, name) => {
  const title = (json && typeof json === "object" && !Array.isArray(json) && (json.title || json.name)) || name;
  const messages = flattenMessages(json);
  const lines = [`# ${String(title)}`, ""];
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const created = timeOf(json);
    if (created) lines.push(`Created: ${created}`, "");
  }
  if (messages.length === 0) {
    lines.push("_No messages were found in this log._", "");
  }
  for (const message of messages) {
    const body = textOfContent(message.content ?? message.text ?? message.message ?? message.body).trim();
    if (!body) continue;
    const time = timeOf(message);
    lines.push(`## ${roleOf(message)}${time ? ` — ${time}` : ""}`, "", body, "");
  }
  return lines.join("\n");
};

const safeNoteName = (value) => String(value || "conversation").replace(/\.json$/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "conversation";

const writeConversationNotes = async (projectRoot, conversationPaths) => {
  const written = [];
  if (!Array.isArray(conversationPaths) || conversationPaths.length === 0) return written;
  const notesDir = path.join(projectRoot, "notes", "prism-conversations");
  await fsp.mkdir(notesDir, { recursive: true });
  const used = new Set();
  for (const relativePath of conversationPaths) {
    const source = path.join(projectRoot, ...relativePath.split("/"));
    let json = null;
    try {
      json = JSON.parse(await fsp.readFile(source, "utf8"));
    } catch {
      continue;
    }
    let base = safeNoteName(path.posix.basename(relativePath));
    let counter = 2;
    while (used.has(base)) base = `${safeNoteName(path.posix.basename(relativePath))}-${counter++}`;
    used.add(base);
    const target = path.join(notesDir, `${base}.md`);
    await fsp.writeFile(target, conversationToMarkdown(json, base), "utf8");
    written.push(path.posix.join("notes", "prism-conversations", `${base}.md`));
  }
  return written;
};

// ---------------------------------------------------------------------------
// reading the project from disk

const walkProject = async (projectRoot) => {
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_SEGMENTS.has(entry.name) || entry.name === ".DS_Store") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.stat(absolute);
      const extension = path.extname(entry.name).toLowerCase();
      let content;
      if ((extension === ".tex" || extension === ".ltx" || extension === ".bib") && stat.size <= MAX_TEX_READ_BYTES) {
        content = await fsp.readFile(absolute, "utf8").catch(() => undefined);
      }
      files.push({ path: relativePath, size: stat.size, mtime: stat.mtimeMs, content });
    }
  };
  await visit(projectRoot, "");
  return files;
};

// ---------------------------------------------------------------------------
// PDF outlines (text features) and their comparison

const readPdfOutlineInWorker = (pdfPath, signal) => new Promise((resolve, reject) => {
  const worker = new Worker(__filename, { workerData: { prismPdfOutline: pdfPath } });
  let done = false;
  const finish = (error, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void worker.terminate();
    error ? reject(error) : resolve(value);
  };
  const abort = () => finish(Object.assign(new Error("PDF reading cancelled"), { name: "AbortError" }));
  const timer = setTimeout(() => finish(new Error("Reading the PDF exceeded 60 seconds")), 60_000);
  signal?.addEventListener("abort", abort, { once: true });
  worker.once("message", (value) => (value && value.error ? finish(new Error(value.error)) : finish(null, value)));
  worker.once("error", (error) => finish(error));
  worker.once("exit", (code) => { if (!done) finish(new Error(`PDF worker exited early (${code})`)); });
  if (signal?.aborted) abort();
});

const readPdfOutline = async (pdfPath, { signal } = {}) => readPdfOutlineInWorker(pdfPath, signal);

async function extractPdfLines(pdfPath) {
  const stat = await fs.promises.stat(pdfPath);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("PDF must be a file smaller than 100 MB");
  const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const base = path.resolve(path.dirname(pdfjsPath), "../..");
  const { getDocument } = await import(pathToFileURL(pdfjsPath).href);
  const loading = getDocument({
    data: new Uint8Array(await fs.promises.readFile(pdfPath)),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: path.join(base, "standard_fonts") + path.sep,
    cMapUrl: path.join(base, "cmaps") + path.sep,
    cMapPacked: true,
  });
  try {
    const pdf = await loading.promise;
    const pages = [];
    const limit = Math.min(pdf.numPages, 400);
    for (let number = 1; number <= limit; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines = [];
      let current = null;
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const height = Math.hypot(item.transform[1], item.transform[3]) || item.height || 0;
        const y = Math.round(item.transform[5] * 2) / 2;
        const x = item.transform[4];
        if (current && Math.abs(current.y - y) <= Math.max(1, current.height * 0.35)) {
          const gap = x - current.endX;
          current.text += (gap > current.height * 0.25 && !current.text.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") + item.str;
          current.endX = x + (item.width || 0);
          current.height = Math.max(current.height, height);
        } else {
          if (current) lines.push(current);
          current = { text: item.str, y, x, endX: x + (item.width || 0), height };
        }
        if (item.hasEOL && current) {
          lines.push(current);
          current = null;
        }
      }
      if (current) lines.push(current);
      pages.push(lines.map((line) => ({ text: line.text.replace(/\s+/g, " ").trim(), height: Math.round(line.height * 10) / 10, x: line.x, endX: line.endX })).filter((line) => line.text));
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await loading.destroy();
  }
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const HEADING_NUMBER_RE = /^(?:(?:Chapter|Section|第)\s*)?(?:\d+|[IVXLC]+|[A-Z])(?:\.\d+)*[.．、章節]?\s+\S/;
const EQUATION_RE = /\((\d+(?:\.\d+)*[a-z]?)\)\s*$/;
const NUMERIC_CITE_RE = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;
const AUTHOR_YEAR_CITE_RE = /[\[(]((?:[A-Z][\p{L}'’-]+(?:\s+(?:and|&|et\s+al\.)\s*)?(?:\s+[A-Z][\p{L}'’-]+)*),?\s+(?:19|20)\d{2}[a-z]?(?:;\s*[^\])]+)?)[\])]/gu;

const outlineOfLines = ({ pageCount, pages }) => {
  const allHeights = pages.flat().map((line) => line.height).filter((height) => height > 0);
  const body = median(allHeights) || 10;
  let title = "";
  const first = pages[0] || [];
  if (first.length > 0) {
    const max = Math.max(...first.map((line) => line.height));
    const titleLines = first.filter((line) => line.height >= max - 0.3);
    title = titleLines.map((line) => line.text).join(" ").trim();
  }
  const sections = [];
  const equations = [];
  const citations = [];
  pages.forEach((lines, pageIndex) => {
    for (const line of lines) {
      const text = line.text;
      if (text === title && pageIndex === 0) continue;
      const bigger = line.height >= body * 1.12;
      if (bigger && text.length <= 90 && HEADING_NUMBER_RE.test(text)) sections.push(text);
      else if (bigger && text.length <= 40 && /^(Abstract|References|Bibliography|Acknowledg|Appendix|概要|参考文献|付録|謝辞)/.test(text)) sections.push(text);
      const equation = EQUATION_RE.exec(text);
      if (equation && line.endX > 0) equations.push(equation[1]);
      NUMERIC_CITE_RE.lastIndex = 0;
      let match;
      while ((match = NUMERIC_CITE_RE.exec(text))) citations.push(`[${match[1].replace(/\s+/g, "")}]`);
      AUTHOR_YEAR_CITE_RE.lastIndex = 0;
      while ((match = AUTHOR_YEAR_CITE_RE.exec(text))) citations.push(`[${match[1].replace(/\s+/g, " ")}]`);
    }
  });
  return { pageCount, title, sections, equations, citations };
};

const firstDifference = (left, right) => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : limit;
};

/**
 * Compare two outlines. Returns one row per feature (title, sections,
 * equations, citations, pageCount): `{ key, same, prism, local, first? }`
 * where the sequence rows carry counts and the first differing entry.
 */
const comparePdfOutlines = (prism, local) => {
  const rows = [];
  rows.push({ key: "title", same: prism.title === local.title, prism: prism.title, local: local.title });
  for (const key of ["sections", "equations", "citations"]) {
    const left = prism[key] || [];
    const right = local[key] || [];
    const index = firstDifference(left, right);
    const row = { key, same: index === -1, prism: left.length, local: right.length };
    if (index !== -1) row.first = { index, prism: left[index] ?? null, local: right[index] ?? null };
    rows.push(row);
  }
  rows.push({ key: "pageCount", same: prism.pageCount === local.pageCount, prism: prism.pageCount, local: local.pageCount });
  return rows;
};

if (!isMainThread && workerData && workerData.prismPdfOutline) {
  extractPdfLines(workerData.prismPdfOutline)
    .then((lines) => parentPort.postMessage(outlineOfLines(lines)))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}

module.exports = {
  MAX_TOTAL_BYTES,
  normalizeZipPath,
  extractZip,
  findProjects,
  analyzeProject,
  detectEngine,
  detectBibTool,
  packageNamesOf,
  conversationToMarkdown,
  writeConversationNotes,
  walkProject,
  readPdfOutline,
  outlineOfLines,
  comparePdfOutlines,
};
