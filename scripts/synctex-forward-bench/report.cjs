const path = require("path");

const safeRate = (numerator, denominator) =>
  denominator <= 0 ? 0 : Math.max(0, Math.min(1, numerator / denominator));

const buildSummary = (cases) => {
  const total = cases.length;
  const roundtripOk = cases.filter((item) => item.pass).length;
  const exact = cases.filter((item) => item.exact).length;
  const forwardFailed = cases.filter((item) => !item.forwardOk).length;
  const reverseFailed = cases.filter((item) => item.forwardOk && !item.reverseOk).length;
  const fallbackUsed = cases.filter((item) => item.fallbackUsed).length;
  return {
    total,
    roundtripOk,
    exact,
    forwardFailed,
    reverseFailed,
    fallbackUsed,
    passRate: safeRate(roundtripOk, total),
    exactRate: safeRate(exact, total),
    forwardFailRate: safeRate(forwardFailed, total),
    reverseFailRate: safeRate(reverseFailed, total),
    fallbackRate: safeRate(fallbackUsed, total),
  };
};

const evaluateGate = (summary, options) => {
  const failures = [];
  const assertMin = (value, threshold, label) => {
    if (!Number.isFinite(threshold) || threshold === null) {
      return;
    }
    if (value < threshold) {
      failures.push(`${label}: ${value.toFixed(4)} < ${threshold.toFixed(4)}`);
    }
  };
  const assertMax = (value, threshold, label) => {
    if (!Number.isFinite(threshold) || threshold === null) {
      return;
    }
    if (value > threshold) {
      failures.push(`${label}: ${value.toFixed(4)} > ${threshold.toFixed(4)}`);
    }
  };
  assertMin(summary.passRate, options.minPassRate, "passRate");
  assertMin(summary.exactRate, options.minExactRate, "exactRate");
  assertMax(summary.forwardFailRate, options.maxForwardFailRate, "forwardFailRate");
  assertMax(summary.reverseFailRate, options.maxReverseFailRate, "reverseFailRate");
  assertMax(summary.fallbackRate, options.maxFallbackRate, "fallbackRate");
  return failures;
};

const printRunSummary = (runIndex, summary) => {
  const head = `[run ${runIndex}]`;
  console.log(
    `${head} total=${summary.total} pass=${summary.roundtripOk} exact=${summary.exact} ` +
      `forwardFail=${summary.forwardFailed} reverseFail=${summary.reverseFailed} ` +
      `fallback=${summary.fallbackUsed}`
  );
  console.log(
    `${head} rates pass=${summary.passRate.toFixed(4)} exact=${summary.exactRate.toFixed(
      4
    )} ` +
      `forwardFail=${summary.forwardFailRate.toFixed(4)} reverseFail=${summary.reverseFailRate.toFixed(
        4
      )} fallback=${summary.fallbackRate.toFixed(4)}`
  );
};

const printFailures = (cases, limit, workspacePath) => {
  if (limit <= 0) {
    return;
  }
  const failed = cases.filter((item) => !item.pass);
  if (failed.length === 0) {
    return;
  }
  console.log(`[failures] showing first ${Math.min(limit, failed.length)} of ${failed.length}`);
  for (const item of failed.slice(0, limit)) {
    const relative = path.relative(workspacePath, item.sourcePath);
    const detail =
      item.forwardOk && item.reverseOk
        ? `reverse=${item.reversePath}:${item.reverseLine} diff=${item.lineDiff}`
        : !item.forwardOk
        ? `forwardError=${item.forwardError}`
        : `reverseError=${item.reverseError}`;
    console.log(
      `  - ${relative}:${item.targetLine}:${item.targetColumn} mode=${item.mode} ` +
        `usedLine=${item.usedLine} ${detail}`
    );
  }
};

module.exports = {
  safeRate,
  buildSummary,
  evaluateGate,
  printRunSummary,
  printFailures,
};

