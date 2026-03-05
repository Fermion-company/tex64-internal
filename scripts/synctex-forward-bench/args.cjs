const path = require("path");

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseArgs = (argv) => {
  const options = {
    workspace: path.resolve(process.cwd(), "test-workspace"),
    pdf: null,
    main: "main.tex",
    sources: [],
    sourceDirs: [],
    includeSkippable: false,
    includeStructural: false,
    maxCases: 0,
    repeat: 1,
    retryAttempts: 3,
    retryDelayMs: 200,
    backtrackMax: 160,
    fallbackToTop: true,
    lineTolerance: 1,
    strict: false,
    minPassRate: null,
    minExactRate: null,
    maxForwardFailRate: null,
    maxReverseFailRate: null,
    maxFallbackRate: null,
    build: false,
    buildEngine: "lualatex",
    jsonOut: null,
    printFailures: 25,
    progressEvery: 50,
    probeBypassHint: true,
  };

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--workspace") {
      options.workspace = path.resolve(args.shift() ?? options.workspace);
      continue;
    }
    if (token === "--pdf") {
      options.pdf = args.shift() ?? options.pdf;
      continue;
    }
    if (token === "--main") {
      options.main = args.shift() ?? options.main;
      continue;
    }
    if (token === "--source") {
      const next = args.shift();
      if (next) {
        options.sources.push(next);
      }
      continue;
    }
    if (token === "--source-dir") {
      const next = args.shift();
      if (next) {
        options.sourceDirs.push(next);
      }
      continue;
    }
    if (token === "--include-skippable") {
      options.includeSkippable = true;
      continue;
    }
    if (token === "--include-structural-lines") {
      options.includeStructural = true;
      continue;
    }
    if (token === "--max-cases") {
      options.maxCases = Math.max(0, toNonNegativeInt(args.shift(), options.maxCases));
      continue;
    }
    if (token === "--repeat") {
      options.repeat = Math.max(1, toPositiveInt(args.shift(), options.repeat));
      continue;
    }
    if (token === "--retry-attempts") {
      options.retryAttempts = Math.max(1, toPositiveInt(args.shift(), options.retryAttempts));
      continue;
    }
    if (token === "--retry-delay-ms") {
      options.retryDelayMs = Math.max(0, toNonNegativeInt(args.shift(), options.retryDelayMs));
      continue;
    }
    if (token === "--backtrack-max") {
      options.backtrackMax = Math.max(0, toNonNegativeInt(args.shift(), options.backtrackMax));
      continue;
    }
    if (token === "--no-fallback-to-top") {
      options.fallbackToTop = false;
      continue;
    }
    if (token === "--line-tolerance") {
      options.lineTolerance = Math.max(0, toNonNegativeInt(args.shift(), options.lineTolerance));
      continue;
    }
    if (token === "--strict") {
      options.strict = true;
      continue;
    }
    if (token === "--min-pass-rate") {
      options.minPassRate = toNumber(args.shift(), options.minPassRate);
      continue;
    }
    if (token === "--min-exact-rate") {
      options.minExactRate = toNumber(args.shift(), options.minExactRate);
      continue;
    }
    if (token === "--max-forward-fail-rate") {
      options.maxForwardFailRate = toNumber(args.shift(), options.maxForwardFailRate);
      continue;
    }
    if (token === "--max-reverse-fail-rate") {
      options.maxReverseFailRate = toNumber(args.shift(), options.maxReverseFailRate);
      continue;
    }
    if (token === "--max-fallback-rate") {
      options.maxFallbackRate = toNumber(args.shift(), options.maxFallbackRate);
      continue;
    }
    if (token === "--build") {
      options.build = true;
      continue;
    }
    if (token === "--build-engine") {
      options.buildEngine = args.shift() ?? options.buildEngine;
      continue;
    }
    if (token === "--json-out") {
      options.jsonOut = args.shift() ?? options.jsonOut;
      continue;
    }
    if (token === "--print-failures") {
      options.printFailures = Math.max(0, toNonNegativeInt(args.shift(), options.printFailures));
      continue;
    }
    if (token === "--progress-every") {
      options.progressEvery = Math.max(0, toNonNegativeInt(args.shift(), options.progressEvery));
      continue;
    }
    if (token === "--probe-with-hint") {
      options.probeBypassHint = false;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelpAndExit(0);
    }
    console.error(`[synctex-bench] unknown option: ${token}`);
    printHelpAndExit(1);
  }

  if (options.strict) {
    if (options.minPassRate === null) {
      options.minPassRate = 0.995;
    }
    if (options.minExactRate === null) {
      options.minExactRate = 0.75;
    }
    if (options.maxForwardFailRate === null) {
      options.maxForwardFailRate = 0.01;
    }
    if (options.maxReverseFailRate === null) {
      options.maxReverseFailRate = 0.01;
    }
    if (options.maxFallbackRate === null) {
      options.maxFallbackRate = 0.05;
    }
  }

  return options;
};

const printHelpAndExit = (statusCode) => {
  const help = `
Usage:
  node scripts/synctex-forward-bench.cjs [options]

Options:
  --workspace <path>          Workspace root (default: ./test-workspace)
  --pdf <path>                PDF path (workspace-relative or absolute)
  --main <path>               Main TeX for --build (default: main.tex)
  --source <path>             TeX source to test (repeatable). If omitted, all .tex are tested.
  --source-dir <path>         Directory to test recursively (repeatable).
  --include-skippable         Include empty/comment lines as targets.
  --include-structural-lines  Include preamble and \\input/\\include lines.
  --max-cases <n>             Limit tested line count (0 = no limit)
  --repeat <n>                Repeat benchmark runs
  --retry-attempts <n>        Forward retry attempts on retryable errors (default: 3)
  --retry-delay-ms <n>        Delay between retries in ms (default: 200)
  --backtrack-max <n>         Max lines to backtrack (default: 160)
  --no-fallback-to-top        Disable top-line fallback
  --line-tolerance <n>        Allowed round-trip line delta (default: 1)
  --build                     Run latexmk before each run
  --build-engine <engine>     Build engine flag: lualatex|pdflatex|xelatex|uplatex
  --strict                    Enable quality gate defaults
  --min-pass-rate <0..1>      Gate: minimum pass rate
  --min-exact-rate <0..1>     Gate: minimum exact rate
  --max-forward-fail-rate <0..1> Gate: max forward fail rate
  --max-reverse-fail-rate <0..1> Gate: max reverse fail rate
  --max-fallback-rate <0..1>  Gate: max fallback rate
  --json-out <path>           Write detailed JSON result
  --print-failures <n>        Print first n failed cases (default: 25)
  --progress-every <n>        Progress log interval by case count (default: 50)
  --probe-with-hint           Use forward hint cache in quality probes (default: off)
`;
  process.stdout.write(help.trimStart());
  process.stdout.write("\n");
  process.exit(statusCode);
};

module.exports = { parseArgs };

