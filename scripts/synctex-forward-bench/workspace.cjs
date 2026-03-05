const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { DEFAULT_IGNORED_DIRS } = require("./utils.cjs");

const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: process.env });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => resolve({ status: code ?? 1, output }));
  });

const resolvePdfPath = (workspacePath, configuredPdf) => {
  if (configuredPdf) {
    const target = path.isAbsolute(configuredPdf)
      ? configuredPdf
      : path.join(workspacePath, configuredPdf);
    if (fs.existsSync(target)) {
      return target;
    }
    return null;
  }
  const candidates = [
    path.join(workspacePath, "main.pdf"),
    path.join(workspacePath, "build", "main.pdf"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const collectTexFiles = (workspacePath, configuredSources, configuredSourceDirs) => {
  const collectFromDir = (baseDir) => {
    const collected = [];
    const walk = (dirPath) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const fullPath = path.join(dirPath, name);
        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(name)) {
            continue;
          }
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (name.endsWith(".tex")) {
          collected.push(fullPath);
        }
      }
    };
    walk(baseDir);
    return collected;
  };

  if (configuredSources.length > 0) {
    return configuredSources
      .map((source) => (path.isAbsolute(source) ? source : path.join(workspacePath, source)))
      .filter((target) => target.endsWith(".tex") && fs.existsSync(target))
      .sort();
  }
  if (configuredSourceDirs.length > 0) {
    const all = [];
    for (const sourceDir of configuredSourceDirs) {
      const fullDir = path.isAbsolute(sourceDir)
        ? sourceDir
        : path.join(workspacePath, sourceDir);
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) {
        continue;
      }
      all.push(...collectFromDir(fullDir));
    }
    return Array.from(new Set(all)).sort();
  }
  return collectFromDir(workspacePath).sort();
};

const isStructuralLine = (lineText) => {
  if (typeof lineText !== "string") {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) {
    return false;
  }
  if (
    /^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/\\\\\s*$/.test(trimmed)) {
    return true;
  }
  if (/(^|[^\\])&/.test(trimmed)) {
    return true;
  }
  if (
    /^\\(?:input|include|subfile|import|includeonly)\b/.test(trimmed) ||
    /^\\(?:begin\{document\}|end\{document\}|maketitle|tableofcontents|listoffigures|listoftables|appendix|bibliography|bibliographystyle|printbibliography)\b/.test(
      trimmed
    )
  ) {
    return true;
  }
  return false;
};

const runBuild = async (workspacePath, mainFile, engine) => {
  const engineFlagMap = {
    lualatex: "-lualatex",
    pdflatex: "-pdf",
    xelatex: "-xelatex",
    uplatex: "-pdfdvi",
  };
  const engineFlag = engineFlagMap[engine] ?? engineFlagMap.lualatex;
  const mainPath = path.isAbsolute(mainFile) ? mainFile : path.join(workspacePath, mainFile);
  if (!fs.existsSync(mainPath)) {
    return { ok: false, error: `main file not found: ${mainPath}` };
  }
  const relativeMain = path.relative(workspacePath, mainPath);
  const args = [
    "-g",
    engineFlag,
    "-synctex=1",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    relativeMain,
  ];
  let result;
  try {
    result = await runCommand("latexmk", args, workspacePath);
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (result.status !== 0) {
    return { ok: false, error: "latexmk failed", log: result.output };
  }
  return { ok: true, log: result.output };
};

module.exports = {
  resolvePdfPath,
  collectTexFiles,
  isStructuralLine,
  runBuild,
};

