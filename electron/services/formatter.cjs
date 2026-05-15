const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const {
  extendTexlivePath,
  findTexCommand,
} = require("./texlive-paths.cjs");

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const safeUnlink = async (filePath) => {
  if (!filePath) {
    return;
  }
  await fsp.unlink(filePath).catch(() => null);
};

const safeRm = async (targetPath) => {
  if (!targetPath) {
    return;
  }
  await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => null);
};

const shouldForceMissingTool = (toolName) => {
  const raw = process.env.TEX64_E2E_FORCE_MISSING_TOOLS;
  if (!raw || typeof raw !== "string") {
    return false;
  }
  const needle = String(toolName ?? "").trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(needle);
};

const LATEXINDENT_SETTINGS_NAME = "latexindent.yaml";
const LATEXINDENT_OVERRIDE_NAME = "latexindent.override.yaml";
const LATEXINDENT_TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "Resources",
  LATEXINDENT_SETTINGS_NAME
);

const DEFAULT_FORMAT_SETTINGS = {
  indentStyle: "spaces-2",
  beginEndOnOwnLine: true,
  documentNoIndent: true,
  alignMathDelims: true,
  alignTableDelims: true,
  blankLines: "condense",
  customVerbatim: [],
};

const DEFAULT_ALIGN_MATH_ENVS = [
  "math",
  "displaymath",
  "equation",
  "eqnarray",
  "align",
  "alignat",
  "xalignat",
  "xxalignat",
  "flalign",
  "gather",
  "multline",
  "split",
  "aligned",
  "alignedat",
  "gathered",
  "multlined",
  "cases",
  "dcases",
  "rcases",
  "numcases",
  "subnumcases",
  "empheq",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "array",
  "subarray",
  "substack",
  "subequations",
  "dmath",
  "dgroup",
  "darray",
  "IEEEeqnarray",
  "IEEEeqnarraybox",
  "mathpar",
  "mathparpagebreakable",
];
const DEFAULT_ALIGN_TABLE_ENVS = [
  "table",
  "tabular",
  "tabularx",
  "tabulary",
  "longtable",
  "ltablex",
  "xltabular",
  "tabu",
  "longtabu",
  "supertabular",
  "tblr",
  "longtblr",
];

const DEFAULT_INDENT_UNIT = "  ";
const VERBATIM_ENVIRONMENTS = new Set([
  "verbatim",
  "verbatim*",
  "Verbatim",
  "lstlisting",
  "minted",
  "filecontents",
  "filecontents*",
]);
const DEFAULT_NO_INDENT_ENVIRONMENTS = new Set(["document"]);

const normalizeEnvName = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(/\\(?:begin|end)\{([^}]+)\}/);
  let name = match ? match[1] : trimmed;
  name = name.replace(/[{}]/g, "");
  name = name.replace(/^\\+/, "");
  if (!name) {
    return "";
  }
  return name.endsWith("*") ? name.slice(0, -1) : name;
};

const normalizeEnvList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = [];
  const seen = new Set();
  value.forEach((entry) => {
    const normalized = normalizeEnvName(entry);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    entries.push(normalized);
  });
  return entries;
};

const normalizeAlignEnvList = (value, fallback) => {
  if (!Array.isArray(value)) {
    return fallback.slice();
  }
  return normalizeEnvList(value);
};

const normalizeAlignEnvs = (value) => {
  if (!value || typeof value !== "object") {
    return {
      math: DEFAULT_ALIGN_MATH_ENVS.slice(),
      table: DEFAULT_ALIGN_TABLE_ENVS.slice(),
    };
  }
  return {
    math: normalizeAlignEnvList(value.math, DEFAULT_ALIGN_MATH_ENVS),
    table: normalizeAlignEnvList(value.table, DEFAULT_ALIGN_TABLE_ENVS),
  };
};

const normalizeFormatSettings = (value) => {
  const settings = { ...DEFAULT_FORMAT_SETTINGS };
  if (!value || typeof value !== "object") {
    return { ...settings, alignEnvs: normalizeAlignEnvs(null) };
  }
  if (
    value.indentStyle === "spaces-2" ||
    value.indentStyle === "spaces-4" ||
    value.indentStyle === "tab"
  ) {
    settings.indentStyle = value.indentStyle;
  }
  if (typeof value.beginEndOnOwnLine === "boolean") {
    settings.beginEndOnOwnLine = value.beginEndOnOwnLine;
  }
  if (typeof value.documentNoIndent === "boolean") {
    settings.documentNoIndent = value.documentNoIndent;
  }
  if (typeof value.alignMathDelims === "boolean") {
    settings.alignMathDelims = value.alignMathDelims;
  }
  if (typeof value.alignTableDelims === "boolean") {
    settings.alignTableDelims = value.alignTableDelims;
  }
  if (
    value.blankLines === "preserve" ||
    value.blankLines === "condense" ||
    value.blankLines === "remove"
  ) {
    settings.blankLines = value.blankLines;
  }
  settings.customVerbatim = normalizeEnvList(value.customVerbatim);
  settings.alignEnvs = normalizeAlignEnvs(value.alignEnvs);
  return settings;
};

const formatIndentValue = (indentStyle) => {
  if (indentStyle === "spaces-4") {
    return "\"    \"";
  }
  if (indentStyle === "tab") {
    return "\"\\t\"";
  }
  return "\"  \"";
};

const resolveIndentUnit = (indentStyle) => {
  if (indentStyle === "spaces-4") {
    return "    ";
  }
  if (indentStyle === "tab") {
    return "\t";
  }
  return DEFAULT_INDENT_UNIT;
};

const buildSimpleIndentConfig = (settings) => {
  const verbatimEnvs = new Set(VERBATIM_ENVIRONMENTS);
  normalizeEnvList(settings.customVerbatim).forEach((name) => {
    verbatimEnvs.add(name);
    verbatimEnvs.add(`${name}*`);
  });
  const noIndentEnvs = new Set();
  if (settings.documentNoIndent) {
    DEFAULT_NO_INDENT_ENVIRONMENTS.forEach((env) => noIndentEnvs.add(env));
  }
  return {
    indentUnit: resolveIndentUnit(settings.indentStyle),
    verbatimEnvs,
    noIndentEnvs,
  };
};

const buildMathEnvSet = (settings) => {
  const envs = Array.isArray(settings?.alignEnvs?.math)
    ? settings.alignEnvs.math
    : DEFAULT_ALIGN_MATH_ENVS;
  return new Set(normalizeEnvList(envs));
};

const buildVerbatimEnvNameSet = (settings) => {
  const envs = new Set();
  VERBATIM_ENVIRONMENTS.forEach((name) => {
    const normalized = normalizeEnvName(name);
    if (normalized) {
      envs.add(normalized);
    }
  });
  normalizeEnvList(settings?.customVerbatim).forEach((name) => {
    envs.add(name);
  });
  return envs;
};

const yamlEscape = (value) =>
  String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const yamlQuote = (value) => `"${yamlEscape(value)}"`;

const expandStarVariants = (names) => {
  const entries = new Set();
  names.forEach((name) => {
    const normalized = normalizeEnvName(name);
    if (!normalized) {
      return;
    }
    entries.add(normalized);
    entries.add(`${normalized}*`);
  });
  return Array.from(entries);
};

const buildBlankLineSettings = (blankLines) => {
  switch (blankLines) {
    case "preserve":
      return { preserveBlankLines: 1, condenseMultipleBlankLinesInto: 0 };
    case "remove":
      return { preserveBlankLines: 0, condenseMultipleBlankLinesInto: 0 };
    default:
      return { preserveBlankLines: 1, condenseMultipleBlankLinesInto: 1 };
  }
};

const buildAlignDelimsConfig = (settings) => {
  const config = {};
  const alignEnvs = settings.alignEnvs ?? {};
  const mathEnvs = Array.isArray(alignEnvs.math)
    ? alignEnvs.math
    : DEFAULT_ALIGN_MATH_ENVS;
  const tableEnvs = Array.isArray(alignEnvs.table)
    ? alignEnvs.table
    : DEFAULT_ALIGN_TABLE_ENVS;
  const apply = (names, enabled) => {
    expandStarVariants(names).forEach((name) => {
      config[name] = enabled ? 1 : 0;
    });
  };
  apply(mathEnvs, settings.alignMathDelims);
  apply(tableEnvs, settings.alignTableDelims);
  return config;
};

const buildVerbatimEnvironmentMap = (customVerbatim) => {
  const entries = new Set(VERBATIM_ENVIRONMENTS);
  normalizeEnvList(customVerbatim).forEach((name) => {
    entries.add(name);
    entries.add(`${name}*`);
  });
  const mapping = {};
  Array.from(entries)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
      mapping[name] = 1;
    });
  return mapping;
};

const buildLatexindentOverride = (settings) => {
  const lines = [];
  lines.push(`defaultIndent: ${formatIndentValue(settings.indentStyle)}`);
  lines.push("noAdditionalIndent:");
  lines.push(`  document: ${settings.documentNoIndent ? 1 : 0}`);
  const lineBreakValue = settings.beginEndOnOwnLine ? 1 : 0;
  const blankLines = buildBlankLineSettings(settings.blankLines);
  lines.push("modifyLineBreaks:");
  lines.push("  environments:");
  lines.push(`    BeginStartsOnOwnLine: ${lineBreakValue}`);
  lines.push(`    BodyStartsOnOwnLine: ${lineBreakValue}`);
  lines.push(`    EndStartsOnOwnLine: ${lineBreakValue}`);
  lines.push(`    EndFinishesWithLineBreak: ${lineBreakValue}`);
  lines.push(`  preserveBlankLines: ${blankLines.preserveBlankLines}`);
  lines.push(
    `  condenseMultipleBlankLinesInto: ${blankLines.condenseMultipleBlankLinesInto}`
  );

  const alignDelims = buildAlignDelimsConfig(settings);
  const alignNames = Object.keys(alignDelims).sort((a, b) => a.localeCompare(b));
  if (alignNames.length > 0) {
    lines.push("lookForAlignDelims:");
    alignNames.forEach((name) => {
      lines.push(`  ${yamlQuote(name)}: ${alignDelims[name]}`);
    });
  }

  const verbatimEnvs = buildVerbatimEnvironmentMap(settings.customVerbatim);
  const verbatimNames = Object.keys(verbatimEnvs).sort((a, b) => a.localeCompare(b));
  if (verbatimNames.length > 0) {
    lines.push("verbatimEnvironments:");
    verbatimNames.forEach((env) => {
      lines.push(`  ${yamlQuote(env)}: ${verbatimEnvs[env]}`);
    });
  }
  return `${lines.join("\n")}\n`;
};

const findCommentStart = (line) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return i;
    }
  }
  return -1;
};

const stripComments = (line) => {
  const commentIndex = findCommentStart(line);
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
};

const extractTokens = (line) => {
  const tokens = [];
  const regex = /\\(begin|end)\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(line))) {
    tokens.push({
      type: match[1],
      env: match[2]?.trim() ?? "",
      index: match.index,
    });
  }
  return tokens;
};

const shouldIndentEnv = (env, noIndentEnvs) => !noIndentEnvs.has(env);

const splitLineByEnvTokens = (line) => {
  const commentIndex = findCommentStart(line);
  const head = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? "" : line.slice(commentIndex);
  const regex = /\\(begin|end)\{[^}]+\}/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(head))) {
    tokens.push({
      index: match.index ?? 0,
      text: match[0],
    });
  }
  if (tokens.length === 0) {
    return [line];
  }
  const result = [];
  let cursor = 0;
  for (const token of tokens) {
    const before = head.slice(cursor, token.index);
    if (before.trim().length > 0) {
      result.push(before.replace(/\s+$/, ""));
    }
    result.push(token.text);
    cursor = token.index + token.text.length;
  }
  const tail = head.slice(cursor);
  if (tail.trim().length > 0) {
    result.push(tail.replace(/^\s+/, ""));
  }
  if (result.length === 0) {
    return [line];
  }
  if (comment) {
    result[result.length - 1] += comment;
  }
  return result;
};

const hasVerbatimBegin = (line, verbatimEnvs) => {
  const parsed = stripComments(line);
  const tokens = extractTokens(parsed);
  return tokens.some(
    (token) => token.type === "begin" && verbatimEnvs.has(token.env)
  );
};

const simpleIndent = (content, settings) => {
  if (!content) {
    return content ?? "";
  }
  const { indentUnit, verbatimEnvs, noIndentEnvs } = buildSimpleIndentConfig(settings);
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  const output = [];
  let indentLevel = 0;
  let inVerbatim = false;
  let verbatimEnv = null;

  for (const rawLine of lines) {
    if (inVerbatim) {
      output.push(rawLine);
      const parsed = stripComments(rawLine);
      const tokens = extractTokens(parsed);
      if (verbatimEnv) {
        const hasEnd = tokens.some(
          (token) => token.type === "end" && token.env === verbatimEnv
        );
        if (hasEnd) {
          inVerbatim = false;
          verbatimEnv = null;
          indentLevel = Math.max(indentLevel - 1, 0);
        }
      }
      continue;
    }

    const expandedLines = hasVerbatimBegin(rawLine, verbatimEnvs)
      ? [rawLine]
      : splitLineByEnvTokens(rawLine);

    for (const line of expandedLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        output.push("");
        continue;
      }

      const parsed = stripComments(line);
      const tokens = extractTokens(parsed);

      let scan = parsed.replace(/^\s+/, "");
      let dedentBefore = 0;
      const endPattern = /^\\end\{([^}]+)\}/;
      while (true) {
        const match = scan.match(endPattern);
        if (!match) {
          break;
        }
        const env = match[1]?.trim() ?? "";
        if (shouldIndentEnv(env, noIndentEnvs)) {
          dedentBefore += 1;
        }
        scan = scan.replace(endPattern, "").replace(/^\s+/, "");
      }
      indentLevel = Math.max(indentLevel - dedentBefore, 0);

      const trimmedLeading = line.replace(/^\s+/, "");
      output.push(`${indentUnit.repeat(indentLevel)}${trimmedLeading}`);

      let beginCount = 0;
      let endCount = 0;
      tokens.forEach((token) => {
        if (!shouldIndentEnv(token.env, noIndentEnvs)) {
          return;
        }
        if (token.type === "begin") {
          beginCount += 1;
        } else {
          endCount += 1;
        }
      });
      const endAfter = Math.max(endCount - dedentBefore, 0);
      indentLevel = Math.max(indentLevel + beginCount - endAfter, 0);

      for (const token of tokens) {
        if (token.type !== "begin") {
          continue;
        }
        if (!verbatimEnvs.has(token.env)) {
          continue;
        }
        const hasEndSameLine = tokens.some(
          (entry) => entry.type === "end" && entry.env === token.env && entry.index > token.index
        );
        if (!hasEndSameLine) {
          inVerbatim = true;
          verbatimEnv = token.env;
          break;
        }
      }
    }
  }

  const formatted = output.join("\n");
  return endsWithNewline ? `${formatted}\n` : formatted;
};

const stripBlankLinesInMathEnv = (content, settings) => {
  if (!content) {
    return { content: content ?? "", changed: false };
  }
  const mathEnvs = buildMathEnvSet(settings);
  if (mathEnvs.size === 0) {
    return { content, changed: false };
  }
  const verbatimEnvs = buildVerbatimEnvNameSet(settings);
  const lines = content.split(/\r?\n/);
  const output = [];
  const stack = [];
  const endsWithNewline = content.endsWith("\n");
  let changed = false;

  const isInside = (set) => stack.some((env) => set.has(env));

  for (const line of lines) {
    const parsed = stripComments(line);
    const tokens = extractTokens(parsed);

    const inMath = isInside(mathEnvs);
    const inVerbatim = isInside(verbatimEnvs);
    if (inMath && !inVerbatim && parsed.trim().length === 0) {
      changed = true;
    } else {
      output.push(line);
    }

    tokens.forEach((token) => {
      const name = normalizeEnvName(token.env);
      if (!name) {
        return;
      }
      if (token.type === "begin") {
        stack.push(name);
        return;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === name) {
          stack.splice(i, 1);
          break;
        }
      }
    });
  }

  let result = output.join("\n");
  if (endsWithNewline && output.length > 0 && !result.endsWith("\n")) {
    result += "\n";
  }
  return { content: result, changed };
};

class FormatterService {
  extendPath(existingPath) {
    return extendTexlivePath(existingPath);
  }

  findLatexindent() {
    if (shouldForceMissingTool("latexindent")) {
      return null;
    }
    return findTexCommand("latexindent");
  }

  runProcess(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, env });
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(err);
      });
      proc.on("close", (code) => {
        resolve({ output, status: code ?? 1 });
      });
    });
  }

  async prepareLatexindentSettings(tempDir, formatSettings) {
    const template = await fsp.readFile(LATEXINDENT_TEMPLATE_PATH, "utf8").catch(() => null);
    if (!template) {
      return null;
    }
    const settingsPath = path.join(tempDir, LATEXINDENT_SETTINGS_NAME);
    const overridePath = path.join(tempDir, LATEXINDENT_OVERRIDE_NAME);
    await fsp.writeFile(settingsPath, template, "utf8");
    const override = buildLatexindentOverride(formatSettings);
    await fsp.writeFile(overridePath, override, "utf8");
    return { basePath: settingsPath, overridePath };
  }

  async formatContent(rootPath, relativePath, content, formatSettings) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    if (path.extname(relativePath).toLowerCase() !== ".tex") {
      return { ok: true, content, skipped: true };
    }
    const normalizedSettings = normalizeFormatSettings(formatSettings);
    const rawContent = content ?? "";
    const fallbackWithWarning = (warning) => {
      const formatted = simpleIndent(rawContent, normalizedSettings);
      const cleaned = stripBlankLinesInMathEnv(formatted, normalizedSettings);
      return {
        ok: true,
        content: cleaned.content,
        formatted: cleaned.content !== rawContent,
        warning,
      };
    };
    const latexindentPath = this.findLatexindent();
    if (!latexindentPath) {
      return fallbackWithWarning("latexindentがnot found。簡易FormatをUsedしました。");
    }
    const tempDir = path.join(rootPath, ".tex64", ".format");
    await ensureDirectory(tempDir);
    const runDir = path.join(
      tempDir,
      `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await ensureDirectory(runDir);
    const settingsPaths = await this.prepareLatexindentSettings(
      runDir,
      normalizedSettings
    );
    if (!settingsPaths) {
      await safeRm(runDir);
      return fallbackWithWarning("latexindentSettingsが読み込めません。簡易FormatをUsedしました。");
    }
    const baseName = path.basename(relativePath, path.extname(relativePath)) || "document";
    const tempName = `${baseName}.tex`;
    const tempPath = path.join(runDir, tempName);
    await fsp.writeFile(tempPath, rawContent, "utf8");
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(
      latexindentPath,
      [
        "-m",
        "-w",
        "-c",
        runDir,
        `-l=${settingsPaths.basePath},${settingsPaths.overridePath}`,
        tempPath,
      ],
      runDir,
      env
    ).catch((error) => ({ output: error?.message ?? String(error), status: 1 }));
    let formatted = null;
    if (result.status === 0) {
      formatted = await fsp.readFile(tempPath, "utf8").catch(() => null);
    }
    await safeRm(runDir);
    await safeUnlink(path.join(rootPath, "indent.log"));
    if (result.status === 0 && formatted !== null) {
      const cleaned = stripBlankLinesInMathEnv(formatted, normalizedSettings);
      return {
        ok: true,
        content: cleaned.content,
        formatted: cleaned.content !== rawContent,
      };
    }
    const message = (result.output ?? "").trim();
    const warning = message
      ? `latexindentに失敗しました。簡易FormatをUsedしました。(${message})`
      : "latexindentに失敗しました。簡易FormatをUsedしました。";
    return fallbackWithWarning(warning);
  }

  async formatFile(rootPath, relativePath, formatSettings) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    const absPath = path.join(rootPath, relativePath);
    const content = await fsp.readFile(absPath, "utf8");
    const result = await this.formatContent(
      rootPath,
      relativePath,
      content,
      formatSettings
    );
    if (result.ok && typeof result.content === "string" && result.content !== content) {
      await fsp.writeFile(absPath, result.content, "utf8");
    }
    return result;
  }
}

module.exports = FormatterService;
