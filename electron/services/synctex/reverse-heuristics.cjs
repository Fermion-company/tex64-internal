module.exports = (SynctexService) => {
  SynctexService.prototype.pickBestReverseResult = function ({
    entries,
    preferredPath,
    targetLine,
    targetColumn = null,
  }) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return null;
    }
    let pool = entries;
    if (preferredPath) {
      const samePathEntries = entries.filter((entry) => this.isSamePath(entry.path, preferredPath));
      if (samePathEntries.length > 0) {
        pool = samePathEntries;
      }
    }
    if (!Number.isFinite(targetLine) && !Number.isFinite(targetColumn)) {
      return pool[0];
    }
    let selected = pool[0];
    const scoreFor = (entry) => {
      const lineScore = Number.isFinite(targetLine) ? Math.abs(entry.line - targetLine) : 0;
      const entryColumn = Number.isFinite(entry.column) ? entry.column : 1;
      const columnScore = Number.isFinite(targetColumn) ? Math.abs(entryColumn - targetColumn) : 0;
      return lineScore * 100 + columnScore;
    };
    let bestScore = scoreFor(selected);
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = pool[index];
      const score = scoreFor(candidate);
      if (score < bestScore) {
        selected = candidate;
        bestScore = score;
        continue;
      }
      if (score > bestScore) {
        continue;
      }
      if (candidate.line < selected.line) {
        selected = candidate;
        continue;
      }
      if (candidate.line > selected.line) {
        continue;
      }
      const selectedColumn = Number.isFinite(selected.column) ? selected.column : 1;
      const candidateColumn = Number.isFinite(candidate.column) ? candidate.column : 1;
      if (candidateColumn < selectedColumn) {
        selected = candidate;
      }
    }
    return selected;
  };

  SynctexService.prototype.getDominantReversePath = function (
    candidates,
    minGap = 3,
    dominanceRatio = 1.8
  ) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }
    const pathTotals = new Map();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.path !== "string") {
        continue;
      }
      const normalizedPath = this.normalizeComparePath(candidate.path);
      if (!normalizedPath) {
        continue;
      }
      const count = Number.isFinite(candidate.count) && candidate.count > 0 ? candidate.count : 1;
      pathTotals.set(normalizedPath, (pathTotals.get(normalizedPath) ?? 0) + count);
    }
    const ranked = Array.from(pathTotals.entries())
      .map(([path, total]) => ({ path, total }))
      .sort((left, right) => {
        if (right.total !== left.total) {
          return right.total - left.total;
        }
        return 0;
      });
    if (ranked.length < 2) {
      return null;
    }
    const winner = ranked[0];
    const runner = ranked[1];
    if (winner.total >= runner.total + minGap && winner.total >= runner.total * dominanceRatio) {
      return winner.path;
    }
    return null;
  };

  SynctexService.prototype.getMedianLine = function (candidates) {
    const lines = Array.from(new Set(candidates.map((candidate) => candidate.line))).sort(
      (a, b) => a - b
    );
    if (!lines.length) {
      return null;
    }
    const middle = Math.floor(lines.length / 2);
    if (lines.length % 2 === 1) {
      return lines[middle];
    }
    return (lines[middle - 1] + lines[middle]) / 2;
  };

  SynctexService.prototype.isBetterReverseTie = function (candidate, current, medianLine) {
    if (medianLine !== null) {
      const candidateDistance = Math.abs(candidate.line - medianLine);
      const currentDistance = Math.abs(current.line - medianLine);
      if (candidateDistance !== currentDistance) {
        return candidateDistance < currentDistance;
      }
    }
    if (candidate.count !== current.count) {
      return candidate.count > current.count;
    }
    return candidate.line < current.line;
  };

  SynctexService.prototype.isReverseConfidence = function (best, second) {
    if (!best || !Number.isFinite(best.distance)) {
      return false;
    }
    const maxDistance = 3600;
    const minScoreGap = 5;
    const minCount = 2;
    if (best.distance > maxDistance) {
      return false;
    }
    if (best.candidate.count < minCount) {
      return false;
    }
    if (!second) {
      return true;
    }
    return second.score - best.score >= minScoreGap;
  };
};

