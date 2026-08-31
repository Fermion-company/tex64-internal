const path = require("path");

const prependKpathseaSearchPath = (env, name, directories) => {
  const entries = directories
    .filter(Boolean)
    .map((directory) => `${path.resolve(directory).split(path.sep).join("/")}//`);
  const existing = typeof env[name] === "string" ? env[name] : "";
  // A trailing empty entry asks kpathsea to keep its built-in default paths.
  env[name] = [...new Set(entries), existing].join(path.delimiter);
};

module.exports = (BuildService) => {
  BuildService.prototype.runLatexmk = async function (rootPath, mainFileName, engine, options = {}) {
    const latexmkPath = this.findLatexmk();
    if (!latexmkPath) {
      throw new Error("latexmk not found");
    }

    let engineFlag = "-lualatex";
    if (engine === "pdflatex") {
      engineFlag = "-pdf";
    } else if (engine === "xelatex") {
      engineFlag = "-xelatex";
    } else if (engine === "uplatex") {
      engineFlag = "-pdfdvi"; // Basic support for uplatex via DVI
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
      "-synctex=1",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      ...(Array.isArray(options?.extraArgs) ? options.extraArgs : []),
      mainFileName
    );
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    if (options?.stagedOutput === true) {
      const sourceDir = path.dirname(path.resolve(rootPath, mainFileName));
      prependKpathseaSearchPath(env, "TEXINPUTS", [sourceDir, rootPath]);
      prependKpathseaSearchPath(env, "BIBINPUTS", [sourceDir, rootPath]);
      prependKpathseaSearchPath(env, "BSTINPUTS", [sourceDir, rootPath]);
    }
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
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
    args.push(...(Array.isArray(options?.extraArgs) ? options.extraArgs : []), mainFileName);
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(latexmkPath, args, rootPath, env);
    return result;
  };
};
