const fs = require("fs");
const path = require("path");

const appendLatexmkTrace = ({ command, args, cwd, result }) => {
  const tracePath = String(process.env.TEX64_LATEXMK_TRACE_FILE ?? "").trim();
  if (!tracePath || !path.isAbsolute(tracePath)) return;
  try {
    const header = JSON.stringify({
      at: new Date().toISOString(),
      command,
      args,
      cwd,
      status: result?.status ?? null,
      cancelled: result?.cancelled === true,
      timedOut: result?.timedOut === true,
    });
    fs.appendFileSync(tracePath, `${header}\n${result?.output ?? ""}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.warn("[build] Could not write latexmk trace:", error?.message ?? error);
  }
};

// TeX wraps its log at 79 columns, which cuts long file paths in two and leaves the
// problem list with half a path. A wide line keeps "path:line: message" whole.
const unwrapTexLog = (env) => {
  if (!env.max_print_line) env.max_print_line = "10000";
  return env;
};

const prependKpathseaSearchPath = (env, name, directories) => {
  const entries = directories
    .filter(Boolean)
    .map((directory) => `${path.resolve(directory).split(path.sep).join("/")}//`);
  const existing = typeof env[name] === "string" ? env[name] : "";
  // A trailing empty entry asks kpathsea to keep its built-in default paths.
  env[name] = [...new Set(entries), existing].join(path.delimiter);
};

// latexmk reads any argument that starts with "-" as an option, so a file
// named "-pdflatex=cmd;#.tex" (from an imported zip, say) would set its
// commands. Such a name goes as ./name.
const fileArgument = (fileName) => (String(fileName).startsWith("-") ? `./${fileName}` : fileName);

module.exports = (BuildService) => {
  BuildService.prototype.runLatexmk = async function (rootPath, mainFileName, engine, options = {}) {
    const latexmkPath = this.findLatexmk();
    if (!latexmkPath) {
      throw new Error("latexmk not found");
    }

    let engineFlag = "-lualatex";
    // `-pdfdvi` alone runs latex and dvipdf; upLaTeX's commands are named
    // here instead of relying on the user's own latexmkrc.
    const engineArgs = [];
    if (engine === "pdflatex") {
      engineFlag = "-pdf";
    } else if (engine === "xelatex") {
      engineFlag = "-xelatex";
    } else if (engine === "uplatex") {
      engineFlag = "-pdfdvi";
      engineArgs.push(
        "-latex=uplatex",
        "-e", "$bibtex=q/upbibtex %O %S/",
        "-e", "$dvipdf=q/dvipdfmx %O -o %D %S/",
        "-e", "$makeindex=q/mendex %O -o %D %S/",
      );
    }

    const args = [];
    args.push("-g");
    const outDir =
      typeof options?.outDir === "string" && options.outDir.trim() ? options.outDir.trim() : null;
    const hasExplicitOutDirArg = options?.hasExplicitOutDirArg === true;
    if (!hasExplicitOutDirArg && outDir) {
      args.push(`-outdir=${outDir}`);
    }
    args.push(
      engineFlag,
      ...engineArgs,
      "-synctex=1",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      ...(Array.isArray(options?.extraArgs) ? options.extraArgs : []),
      fileArgument(mainFileName)
    );
    const env = unwrapTexLog({ ...process.env });
    env.PATH = this.extendPath(env.PATH);
    if (options?.stagedOutput === true) {
      const sourceDir = path.dirname(path.resolve(rootPath, mainFileName));
      prependKpathseaSearchPath(env, "TEXINPUTS", [sourceDir, rootPath]);
      prependKpathseaSearchPath(env, "BIBINPUTS", [sourceDir, rootPath]);
      prependKpathseaSearchPath(env, "BSTINPUTS", [sourceDir, rootPath]);
    }
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
    appendLatexmkTrace({ command: latexmkPath, args, cwd: rootPath, result });
    return result;
  };

  BuildService.prototype.runLatexmkClean = async function (
    rootPath,
    mainFileName,
    options = {}
  ) {
    const latexmkPath = this.findLatexmk();
    if (!latexmkPath) {
      throw new Error("latexmk not found");
    }
    const args = [];
    args.push(options.deep === true ? "-C" : "-c");
    const outDir =
      typeof options?.outDir === "string" && options.outDir.trim() ? options.outDir.trim() : null;
    const hasExplicitOutDirArg = options?.hasExplicitOutDirArg === true;
    if (!hasExplicitOutDirArg && outDir) {
      args.push(`-outdir=${outDir}`);
    }
    args.push(...(Array.isArray(options?.extraArgs) ? options.extraArgs : []), fileArgument(mainFileName));
    const env = unwrapTexLog({ ...process.env });
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
    return result;
  };
};
