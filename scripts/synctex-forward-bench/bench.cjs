const { SynctexService } = require("../../electron/services/synctex.cjs");

const {
  sleep,
  pathsEqual,
  isRetryableSynctexError,
  getForwardTargetDiff,
  isLowQualityForwardResult,
  isSkippableLine,
} = require("./utils.cjs");
const { buildSummary } = require("./report.cjs");

const executeForwardLikeApp = async (service, payload, options) => {
  const { sourcePath, targetLine, targetColumn, lineText, pdfPath } = payload;
  const attachRoundtripProbe = async (forwardResult, forwardLine) => {
    if (!forwardResult || forwardResult.ok !== true) {
      return forwardResult;
    }
    let reverseProbe = null;
    try {
      reverseProbe = await service.reverse({
        page: forwardResult.page,
        x: forwardResult.x,
        y: forwardResult.y,
        pdfPath,
        refineLines: 0,
        bypassHint: options.probeBypassHint,
        allowExpandedOffsets: false,
      });
    } catch {
      reverseProbe = null;
    }
    if (!reverseProbe?.ok) {
      return {
        ...forwardResult,
        roundtripSameSourcePath: false,
        roundtripDiff: Number.POSITIVE_INFINITY,
      };
    }
    const sameSourcePath = pathsEqual(reverseProbe.path, sourcePath);
    const roundtripDiff =
      sameSourcePath &&
      Number.isFinite(reverseProbe.line) &&
      Number.isFinite(forwardLine)
        ? Math.abs(reverseProbe.line - forwardLine)
        : Number.POSITIVE_INFINITY;
    return {
      ...forwardResult,
      roundtripPath: reverseProbe.path,
      roundtripLine: reverseProbe.line,
      roundtripSameSourcePath: sameSourcePath,
      roundtripDiff,
    };
  };
  const runForward = async (line, column) => {
    let attempts = 0;
    let retries = 0;
    let result = null;
    for (let attempt = 0; attempt < options.retryAttempts; attempt += 1) {
      if (attempt > 0) {
        retries += 1;
        await sleep(options.retryDelayMs);
      }
      attempts += 1;
      result = await service.forward({
        sourcePath,
        line: Number.isFinite(line) ? line : 1,
        column: Number.isFinite(column) ? column : 1,
        pdfPath,
        hintLine: targetLine,
        hintColumn: Number.isFinite(targetColumn) ? targetColumn : 1,
      });
      if (result.ok) {
        result = await attachRoundtripProbe(result, line);
      }
      if (result.ok || !isRetryableSynctexError(result.error)) {
        break;
      }
    }
    return { result, attempts, retries };
  };

  const preferBacktrack = isSkippableLine(lineText);
  let attempts = 0;
  let retries = 0;
  let mode = "direct";
  let usedLine = targetLine;
  let backtrackOffset = 0;
  let result = null;

  if (!preferBacktrack) {
    const direct = await runForward(targetLine, targetColumn);
    attempts += direct.attempts;
    retries += direct.retries;
    result = direct.result;
  } else {
    result = { ok: false, error: "skip" };
    mode = "skip-direct";
  }

  let bestLowQualitySuccess =
    result.ok && isLowQualityForwardResult(result, targetLine)
      ? {
          result,
          offset: 0,
          matchDiff: getForwardTargetDiff(result, targetLine),
        }
      : null;
  if (
    preferBacktrack ||
    (!result.ok && isRetryableSynctexError(result.error)) ||
    isLowQualityForwardResult(result, targetLine)
  ) {
    for (let offset = 1; offset <= options.backtrackMax; offset += 1) {
      const candidateLine = targetLine - offset;
      if (candidateLine < 1) {
        break;
      }
      const candidate = await runForward(candidateLine, targetColumn);
      attempts += candidate.attempts;
      retries += candidate.retries;
      if (candidate.result.ok) {
        const candidateLowQuality = isLowQualityForwardResult(
          candidate.result,
          targetLine
        );
        if (!candidateLowQuality) {
          result = { ...candidate.result, fallback: true };
          usedLine = candidateLine;
          mode = "backtrack";
          backtrackOffset = offset;
          break;
        }
        const candidateMatchDiff = getForwardTargetDiff(
          candidate.result,
          targetLine
        );
        const candidateScore = {
          result: { ...candidate.result, fallback: true },
          offset,
          matchDiff: candidateMatchDiff,
        };
        if (!bestLowQualitySuccess) {
          bestLowQualitySuccess = candidateScore;
          continue;
        }
        const currentSamePath = bestLowQualitySuccess.result.sameSourcePath === true;
        const nextSamePath = candidateScore.result.sameSourcePath === true;
        if (nextSamePath && !currentSamePath) {
          bestLowQualitySuccess = candidateScore;
          continue;
        }
        if (nextSamePath === currentSamePath) {
          if (candidateScore.matchDiff < bestLowQualitySuccess.matchDiff) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          if (
            candidateScore.matchDiff === bestLowQualitySuccess.matchDiff &&
            candidateScore.offset < bestLowQualitySuccess.offset
          ) {
            bestLowQualitySuccess = candidateScore;
          }
        }
        continue;
      }
      if (!isRetryableSynctexError(candidate.result.error)) {
        result = candidate.result;
        usedLine = candidateLine;
        mode = "backtrack-stop";
        backtrackOffset = offset;
        break;
      }
    }
  }

  if ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) {
    const maxForwardScan = 12;
    for (let offset = 1; offset <= maxForwardScan; offset += 1) {
      const candidateLine = targetLine + offset;
      const candidate = await runForward(candidateLine, targetColumn);
      attempts += candidate.attempts;
      retries += candidate.retries;
      if (
        candidate.result.ok &&
        !isLowQualityForwardResult(candidate.result, targetLine)
      ) {
        result = { ...candidate.result, fallback: true };
        usedLine = candidateLine;
        mode = "forward-scan";
        backtrackOffset = -offset;
        break;
      }
    }
  }

  if (
    ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) &&
    bestLowQualitySuccess?.result?.ok
  ) {
    result = bestLowQualitySuccess.result;
    if (bestLowQualitySuccess.offset > 0) {
      usedLine = targetLine - bestLowQualitySuccess.offset;
      mode = "backtrack";
      backtrackOffset = bestLowQualitySuccess.offset;
    }
  }

  if (!result.ok && options.fallbackToTop) {
    const top = await runForward(1, 1);
    attempts += top.attempts;
    retries += top.retries;
    usedLine = 1;
    mode = "top-fallback";
    if (top.result.ok) {
      result = { ...top.result, fallback: true };
    } else {
      result = top.result;
    }
  }

  return {
    result,
    mode,
    usedLine,
    backtrackOffset,
    attempts,
    retries,
    preferBacktrack,
  };
};

const runSingleBenchmark = async ({ runIndex, options, workspacePath, pdfPath, cases }) => {
  const service = new SynctexService();
  const results = [];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const progressEvery = options.progressEvery;
    if (progressEvery > 0 && index > 0 && index % progressEvery === 0) {
      console.log(`[run ${runIndex}] progress ${index}/${cases.length}`);
    }
    const forwardLike = await executeForwardLikeApp(
      service,
      {
        sourcePath: item.sourcePath,
        targetLine: item.lineNumber,
        targetColumn: item.column,
        lineText: item.lineText,
        pdfPath,
      },
      options
    );

    const forwardOk = forwardLike.result?.ok === true;
    if (!forwardOk) {
      results.push({
        sourcePath: item.sourcePath,
        targetLine: item.lineNumber,
        targetColumn: item.column,
        usedLine: forwardLike.usedLine,
        mode: forwardLike.mode,
        attempts: forwardLike.attempts,
        retries: forwardLike.retries,
        fallbackUsed: forwardLike.result?.fallback === true || forwardLike.mode === "top-fallback",
        forwardOk: false,
        forwardError: forwardLike.result?.error ?? "unknown forward error",
        reverseOk: false,
        reverseError: null,
        reversePath: null,
        reverseLine: null,
        lineDiff: null,
        sameFile: false,
        pass: false,
        exact: false,
      });
      continue;
    }

    let reverseResult;
    try {
      reverseResult = await service.reverse({
        page: forwardLike.result.page,
        x: forwardLike.result.x,
        y: forwardLike.result.y,
        pdfPath,
        bypassHint: options.probeBypassHint,
      });
    } catch (error) {
      reverseResult = { ok: false, error: error?.message ?? String(error) };
    }
    const reverseOk = reverseResult?.ok === true;
    const sameFile = reverseOk && pathsEqual(reverseResult.path, item.sourcePath);
    const lineDiff =
      reverseOk && Number.isFinite(reverseResult.line)
        ? Math.abs(reverseResult.line - item.lineNumber)
        : null;
    const pass = Boolean(reverseOk && sameFile && lineDiff !== null && lineDiff <= options.lineTolerance);
    const exact = Boolean(reverseOk && sameFile && lineDiff === 0);

    results.push({
      sourcePath: item.sourcePath,
      targetLine: item.lineNumber,
      targetColumn: item.column,
      usedLine: forwardLike.usedLine,
      mode: forwardLike.mode,
      attempts: forwardLike.attempts,
      retries: forwardLike.retries,
      fallbackUsed: forwardLike.result?.fallback === true || forwardLike.mode === "top-fallback",
      forwardOk: true,
      forwardError: null,
      reverseOk,
      reverseError: reverseOk ? null : reverseResult?.error ?? "unknown reverse error",
      reversePath: reverseOk ? reverseResult.path : null,
      reverseLine: reverseOk ? reverseResult.line : null,
      lineDiff,
      sameFile,
      pass,
      exact,
      confidence: reverseOk ? reverseResult.confidence === true : false,
      scoreGap: reverseOk && Number.isFinite(reverseResult.scoreGap) ? reverseResult.scoreGap : null,
      distance: reverseOk && Number.isFinite(reverseResult.distance) ? reverseResult.distance : null,
    });
  }

  const summary = buildSummary(results);
  return { summary, cases: results };
};

module.exports = {
  executeForwardLikeApp,
  runSingleBenchmark,
};
