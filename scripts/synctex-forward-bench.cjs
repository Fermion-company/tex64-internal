#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { parseArgs } = require("./synctex-forward-bench/args.cjs");
const { findColumn, isSkippableLine } = require("./synctex-forward-bench/utils.cjs");
const {
  resolvePdfPath,
  collectTexFiles,
  isStructuralLine,
  runBuild,
} = require("./synctex-forward-bench/workspace.cjs");
const {
  safeRate,
  evaluateGate,
  printRunSummary,
  printFailures,
} = require("./synctex-forward-bench/report.cjs");
const { runSingleBenchmark } = require("./synctex-forward-bench/bench.cjs");

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const workspacePath = options.workspace;
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`workspace not found: ${workspacePath}`);
  }

  const pdfPath = resolvePdfPath(workspacePath, options.pdf);
  if (!pdfPath) {
    throw new Error("pdf not found. specify --pdf or build once to create main.pdf.");
  }

  const sourceFiles = collectTexFiles(workspacePath, options.sources, options.sourceDirs);
  if (sourceFiles.length === 0) {
    throw new Error("no .tex files found.");
  }

  const sourceLines = [];
  for (const sourcePath of sourceFiles) {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const beginDocIndex = lines.findIndex((line) => /\\begin\{document\}/.test(line));
    lines.forEach((lineText, index) => {
      const inPreamble = beginDocIndex >= 0 && index < beginDocIndex;
      const structural = inPreamble || isStructuralLine(lineText);
      sourceLines.push({
        sourcePath,
        lineNumber: index + 1,
        lineText,
        column: findColumn(lineText),
        structural,
      });
    });
  }

  const candidateCases = sourceLines.filter((item) => {
    if (!options.includeSkippable && isSkippableLine(item.lineText)) {
      return false;
    }
    if (!options.includeStructural && item.structural) {
      return false;
    }
    return true;
  });
  const cases =
    options.maxCases > 0 ? candidateCases.slice(0, options.maxCases) : candidateCases;
  if (cases.length === 0) {
    throw new Error("no candidate lines to test.");
  }

  console.log(`[synctex-bench] workspace=${workspacePath}`);
  console.log(`[synctex-bench] pdf=${pdfPath}`);
  console.log(
    `[synctex-bench] sources=${sourceFiles.length} candidates=${cases.length} repeat=${options.repeat}`
  );

  const runs = [];
  let hasGateFailure = false;
  for (let runIndex = 1; runIndex <= options.repeat; runIndex += 1) {
    if (options.build) {
      console.log(`[run ${runIndex}] build start`);
      const buildResult = await runBuild(workspacePath, options.main, options.buildEngine);
      if (!buildResult.ok) {
        console.error(`[run ${runIndex}] build failed: ${buildResult.error}`);
        if (buildResult.log) {
          console.error(buildResult.log);
        }
        process.exit(1);
      }
      console.log(`[run ${runIndex}] build done`);
    }
    const benchmark = await runSingleBenchmark({
      runIndex,
      options,
      workspacePath,
      pdfPath,
      cases,
    });
    printRunSummary(runIndex, benchmark.summary);
    printFailures(benchmark.cases, options.printFailures, workspacePath);
    const gateFailures = evaluateGate(benchmark.summary, options);
    if (gateFailures.length > 0) {
      hasGateFailure = true;
      console.error(`[run ${runIndex}] gate failed`);
      gateFailures.forEach((item) => console.error(`  - ${item}`));
    }
    runs.push({
      runIndex,
      summary: benchmark.summary,
      gateFailures,
      cases: benchmark.cases,
    });
  }

  const aggregate = {
    runs: runs.length,
    averagePassRate: safeRate(
      runs.reduce((acc, run) => acc + run.summary.passRate, 0),
      runs.length
    ),
    averageExactRate: safeRate(
      runs.reduce((acc, run) => acc + run.summary.exactRate, 0),
      runs.length
    ),
    worstPassRate: runs.reduce(
      (acc, run) => Math.min(acc, run.summary.passRate),
      Number.POSITIVE_INFINITY
    ),
    worstExactRate: runs.reduce(
      (acc, run) => Math.min(acc, run.summary.exactRate),
      Number.POSITIVE_INFINITY
    ),
  };

  console.log(
    `[aggregate] avgPass=${aggregate.averagePassRate.toFixed(4)} avgExact=${aggregate.averageExactRate.toFixed(
      4
    )} worstPass=${aggregate.worstPassRate.toFixed(4)} worstExact=${aggregate.worstExactRate.toFixed(4)}`
  );

  if (options.jsonOut) {
    const jsonPath = path.isAbsolute(options.jsonOut)
      ? options.jsonOut
      : path.join(workspacePath, options.jsonOut);
    const payload = {
      generatedAt: new Date().toISOString(),
      options: {
        ...options,
        workspace: workspacePath,
        pdf: pdfPath,
      },
      sourceFiles: sourceFiles.map((sourcePath) => path.relative(workspacePath, sourcePath)),
      runs,
      aggregate,
    };
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[synctex-bench] wrote ${jsonPath}`);
  }

  if (hasGateFailure) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(`[synctex-bench] ${error?.message ?? String(error)}`);
  process.exit(1);
});

