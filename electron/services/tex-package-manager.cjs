// Package management on top of tlmgr.
//
// Everything the Packages screen does goes through here: listing what is
// installed, searching the whole catalogue, adding from CTAN, removing, and
// updating. The parsing is kept as pure functions so it can be tested without a
// TeX installation, and every package name is validated before it can reach a
// command line — the system-TeX path runs tlmgr through an administrator
// prompt, so a name from the catalogue must never be able to become a shell
// fragment.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  extendTexlivePath,
  findTexCommand,
  findManagedTexCommand,
  getManagedTexliveRoot,
} = require("./texlive-paths.cjs");

// tlmgr package names are lowercase alphanumerics plus . _ - and nothing else.
// This is the gate that makes the privileged path safe, so it is deliberately
// stricter than tlmgr itself would accept.
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const isValidPackageName = (name) =>
  typeof name === "string" && name.length <= 128 && PACKAGE_NAME_PATTERN.test(name);

// Names like "a2ping.universal-darwin" are the per-architecture binary halves of
// a package; TeX Live installs and removes them with their parent, so showing
// them would just be thousands of rows the user can do nothing about.
const isArchPackage = (name) => typeof name === "string" && name.includes(".");

// `tlmgr info --data name,installed,size,shortdesc` emits CSV where only the
// description is quoted, and it may itself contain commas and escaped quotes.
const splitDataRow = (line) => {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
};

const parseCatalogLine = (line) => {
  const text = String(line || "").trim();
  if (!text) {
    return null;
  }
  const [name, installed, size, ...rest] = splitDataRow(text);
  if (!isValidPackageName(name)) {
    return null;
  }
  const sizeBytes = Number.parseInt(size, 10);
  return {
    name,
    installed: installed === "1",
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    shortdesc: rest.join(",").trim(),
    kind: name.startsWith("collection-")
      ? "collection"
      : name.startsWith("scheme-")
      ? "scheme"
      : "package",
  };
};

const parseCatalog = (output, options = {}) => {
  const includeArch = options.includeArch === true;
  const entries = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const entry = parseCatalogLine(line);
    if (!entry) {
      continue;
    }
    if (!includeArch && isArchPackage(entry.name)) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
};

// `tlmgr search --file` prints "package:" at column 0 with its matching files
// indented beneath.
const parseFileSearch = (output) => {
  const results = [];
  let current = null;
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    if (/^\s/.test(rawLine)) {
      if (current) {
        current.files.push(rawLine.trim());
      }
      continue;
    }
    const match = rawLine.trim().match(/^([A-Za-z0-9][A-Za-z0-9._+-]*):$/);
    if (match) {
      current = { name: match[1], files: [] };
      results.push(current);
      continue;
    }
    // Repository banners and other chatter end the current package block.
    current = null;
  }
  return results.filter((entry) => entry.files.length > 0);
};

// tlmgr refuses to strand a collection: "not removing X, needed by Y". Surfacing
// that verbatim is more useful than a generic failure, because it names the
// thing that would break.
const parseRemoveBlockers = (output) => {
  const blockers = [];
  const pattern = /not removing\s+([A-Za-z0-9][A-Za-z0-9._+-]*),\s*needed by\s+([A-Za-z0-9][A-Za-z0-9._+-]*)/gi;
  let match;
  while ((match = pattern.exec(String(output || ""))) !== null) {
    blockers.push({ name: match[1], neededBy: match[2] });
  }
  return blockers;
};

const parsePackageDetail = (output) => {
  const text = String(output || "");
  const field = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s*(.*)$`, "mi"));
    return match ? match[1].trim() : "";
  };
  const files = [];
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^Included files, by type:/i.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) {
      continue;
    }
    if (/^\S/.test(line)) {
      // A new unindented block ends the file listing.
      if (!/files:$/i.test(line.trim())) {
        inFiles = false;
      }
      continue;
    }
    const entry = line.trim().replace(/\s+details=".*"$/, "");
    if (entry) {
      files.push(entry);
    }
  }
  return {
    name: field("package"),
    shortdesc: field("shortdesc"),
    longdesc: field("longdesc"),
    installed: /^yes$/i.test(field("installed")),
    sizes: field("sizes"),
    collection: field("collection"),
    license: field("cat-license"),
    version: field("cat-version"),
    files,
  };
};

// --- privileged execution -------------------------------------------------

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// AppleScript string literal: backslash and double quote are the only escapes.
const appleScriptQuote = (value) =>
  `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Builds the one-line osascript that asks macOS for an administrator prompt.
// Exported so the quoting can be tested directly — this is the only place in the
// app that composes a privileged command line.
const buildPrivilegedScript = (command, args) => {
  const parts = [command, ...args].map(shellQuote).join(" ");
  return `do shell script ${appleScriptQuote(parts)} with administrator privileges`;
};

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000;
    const env = { ...process.env, PATH: extendTexlivePath(process.env.PATH) };
    const child = spawn(command, args, { env, windowsHide: true });
    let output = "";
    let lineBuffer = "";
    const onLine = typeof options.onLine === "function" ? options.onLine : null;
    const append = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 4_000_000) {
        output = output.slice(-4_000_000);
      }
      if (!onLine) {
        return;
      }
      lineBuffer += text;
      let index;
      while ((index = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        try {
          onLine(line);
        } catch {
          // progress reporting must never break the operation
        }
      }
    };
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? 1, output });
    });
  });

class TexPackageService {
  constructor(envService) {
    this.envService = envService;
    this.catalogCache = null;
    this.platform = process.platform;
  }

  // Which TeX Live these operations apply to. The app-managed tree needs no
  // privileges; a system installation is only writable behind the OS admin
  // prompt, which the user answers themselves.
  resolveTarget() {
    const managed = findManagedTexCommand("tlmgr");
    if (managed) {
      return {
        tlmgr: managed,
        scope: "managed",
        root: getManagedTexliveRoot(),
        needsAdmin: false,
      };
    }
    const system = findTexCommand("tlmgr");
    if (!system) {
      return { tlmgr: null, scope: "none", root: "", needsAdmin: false };
    }
    return {
      tlmgr: system,
      scope: "system",
      root: path.resolve(path.dirname(system), "..", ".."),
      needsAdmin: true,
    };
  }

  // Read-only tlmgr calls never need privileges, whichever tree they read.
  async runRead(args, options = {}) {
    const target = this.resolveTarget();
    if (!target.tlmgr) {
      throw new Error("No TeX Live installation was found.");
    }
    return runCommand(target.tlmgr, args, options);
  }

  // Mutations. On the managed tree this is a plain child process; on a system
  // tree it goes through the macOS administrator prompt, which the user has to
  // approve every time — the app never stores or handles the password.
  async runWrite(args, options = {}) {
    const target = this.resolveTarget();
    if (!target.tlmgr) {
      throw new Error("No TeX Live installation was found.");
    }
    for (const arg of args) {
      if (typeof arg !== "string" || arg.includes("\n")) {
        throw new Error("Invalid tlmgr argument.");
      }
    }
    if (!target.needsAdmin) {
      return runCommand(target.tlmgr, args, options);
    }
    if (this.platform !== "darwin") {
      throw new Error(
        "Changing a system TeX Live from TeX64 is only supported on macOS."
      );
    }
    const script = buildPrivilegedScript(target.tlmgr, args);
    // osascript streams nothing until it finishes, so privileged runs report
    // completion rather than progress.
    const result = await runCommand("osascript", ["-e", script], {
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok && /User canceled|-128/i.test(result.output)) {
      return { ok: false, code: 1, output: "cancelled", cancelled: true };
    }
    return result;
  }

  assertNames(names) {
    const list = Array.isArray(names) ? names : [names];
    const clean = list.map((name) => String(name || "").trim()).filter(Boolean);
    if (clean.length === 0) {
      throw new Error("No package was given.");
    }
    for (const name of clean) {
      if (!isValidPackageName(name)) {
        throw new Error(`Refusing to act on an invalid package name: ${name}`);
      }
    }
    return clean;
  }

  // The whole catalogue — installed and not — read from the local database, so
  // the search field can filter it without touching the network.
  async getCatalog(options = {}) {
    if (!options.force && this.catalogCache && Date.now() - this.catalogCache.at < 60_000) {
      return this.catalogCache.value;
    }
    const target = this.resolveTarget();
    if (!target.tlmgr) {
      const empty = { scope: "none", needsAdmin: false, root: "", packages: [] };
      this.catalogCache = { at: Date.now(), value: empty };
      return empty;
    }
    const result = await this.runRead(
      ["info", "--data", "name,installed,size,shortdesc"],
      { timeoutMs: 120000 }
    );
    const value = {
      scope: target.scope,
      needsAdmin: target.needsAdmin,
      root: target.root,
      packages: parseCatalog(result.output),
    };
    this.catalogCache = { at: Date.now(), value };
    return value;
  }

  async searchFiles(term) {
    const text = String(term || "").trim();
    if (text.length < 2) {
      return [];
    }
    // tlmgr takes this as a regular expression; anything the user typed is data,
    // so the metacharacters are escaped rather than honoured.
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await this.runRead(["search", "--file", escaped], { timeoutMs: 60000 });
    return parseFileSearch(result.output);
  }

  // The escape hatch for a package too new to be in the local database. This is
  // the only search that touches the network.
  async searchCtan(term) {
    const text = String(term || "").trim();
    if (text.length < 2) {
      return [];
    }
    const result = await this.runRead(["search", "--global", text], { timeoutMs: 120000 });
    const names = [];
    for (const line of String(result.output).split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._+-]*)\s+-\s+(.*)$/);
      if (match && isValidPackageName(match[1]) && !isArchPackage(match[1])) {
        names.push({ name: match[1], shortdesc: match[2].trim() });
      }
    }
    return names;
  }

  // texdoc's own default is to launch a viewer itself. Asking it for the machine
  // readable list instead keeps the choice here: the app opens the file, and a
  // package with no local documentation gets a real answer rather than silence.
  async docPath(name) {
    const [clean] = this.assertNames(name);
    const texdoc = findManagedTexCommand("texdoc") || findTexCommand("texdoc");
    if (!texdoc) {
      throw new Error("texdoc was not found in this TeX installation.");
    }
    const result = await runCommand(texdoc, ["-l", "-M", clean], { timeoutMs: 30000 });
    const found = parseTexdocList(result.output).find((entry) => fs.existsSync(entry.path));
    if (!found) {
      throw new Error(`No local documentation for ${clean}.`);
    }
    return found.path;
  }

  async getDetail(name) {
    const [clean] = this.assertNames(name);
    const result = await this.runRead(["info", "--list", clean], { timeoutMs: 60000 });
    return parsePackageDetail(result.output);
  }

  async install(names, onProgress) {
    const clean = this.assertNames(names);
    const result = await this.runWrite(["install", ...clean], {
      timeoutMs: 60 * 60 * 1000,
      onLine: progressReporter(onProgress),
    });
    this.catalogCache = null;
    return {
      ok: result.ok,
      cancelled: result.cancelled === true,
      output: result.output,
    };
  }

  // Preflight first: tlmgr will not strand a collection, and knowing that before
  // anything is deleted is the difference between a warning and a surprise.
  async remove(names, options = {}) {
    const clean = this.assertNames(names);
    if (options.force !== true) {
      const dry = await this.runWrite(["remove", "--dry-run", ...clean], {
        timeoutMs: 5 * 60 * 1000,
      });
      const blockers = parseRemoveBlockers(dry.output);
      if (blockers.length > 0) {
        return { ok: false, blockers, output: dry.output };
      }
      if (dry.cancelled) {
        return { ok: false, cancelled: true, blockers: [], output: dry.output };
      }
    }
    const args = options.force === true ? ["remove", "--force", ...clean] : ["remove", ...clean];
    const result = await this.runWrite(args, { timeoutMs: 30 * 60 * 1000 });
    this.catalogCache = null;
    return {
      ok: result.ok,
      cancelled: result.cancelled === true,
      blockers: parseRemoveBlockers(result.output),
      output: result.output,
    };
  }

  async update(onProgress) {
    const result = await this.runWrite(["update", "--self", "--all"], {
      timeoutMs: 3 * 60 * 60 * 1000,
      onLine: progressReporter(onProgress),
    });
    this.catalogCache = null;
    return {
      ok: result.ok,
      cancelled: result.cancelled === true,
      output: result.output,
    };
  }
}

const progressReporter = (onProgress) => {
  if (typeof onProgress !== "function") {
    return null;
  }
  return (line) => {
    const match = line.match(/\[(\d+)\/(\d+)\]/);
    if (match) {
      onProgress({
        current: Number(match[1]),
        total: Number(match[2]),
        line: line.trim(),
      });
      return;
    }
    if (/^(tlmgr|update|install|remove):/i.test(line.trim())) {
      onProgress({ current: null, total: null, line: line.trim() });
    }
  };
};

// `texdoc -l -M` prints one tab-separated row per candidate, best match first:
// name, score, absolute path, ?, description. Anything else it says (such as the
// "Sorry, no local documentation" note) has no tabs and is skipped.
const parseTexdocList = (stdout) => {
  const rows = [];
  for (const line of String(stdout || "").split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const file = parts[2].trim();
    if (!file || !path.isAbsolute(file)) {
      continue;
    }
    rows.push({ name: parts[0].trim(), path: file, description: (parts[4] ?? "").trim() });
  }
  return rows;
};

module.exports = {
  TexPackageService,
  parseTexdocList,
  PACKAGE_NAME_PATTERN,
  isValidPackageName,
  isArchPackage,
  splitDataRow,
  parseCatalogLine,
  parseCatalog,
  parseFileSearch,
  parseRemoveBlockers,
  parsePackageDetail,
  shellQuote,
  appleScriptQuote,
  buildPrivilegedScript,
};
