const fs = require("fs");
const path = require("path");

module.exports = (SynctexService) => {
  SynctexService.prototype.reverse = async function ({
    page,
    x,
    y,
    pdfPath,
    refineLines = 3,
    bypassHint = false,
    allowExpandedOffsets = true,
  }) {
    const synctexPath = this.findSynctex();
    if (!synctexPath) {
      return { ok: false, error: "synctex が見つかりません。" };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDFが見つかりません。" };
    }
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const cwd = path.dirname(pdfPath);
    const normalizedPdfForHint = this.normalizeComparePath(pdfPath);
    const hintCandidateCount = this.forwardHints.filter((hint) => {
      if (!hint || hint.page !== Math.floor(page)) {
        return false;
      }
      if (!normalizedPdfForHint) {
        return true;
      }
      return hint.pdfPath === normalizedPdfForHint;
    }).length;
    const hintPreview = this.forwardHints
      .filter((hint) => hint && hint.page === Math.floor(page))
      .slice(0, 3)
      .map((hint) => ({
        line: hint.line,
        x: hint.x,
        y: hint.y,
        ageMs: Date.now() - hint.timestamp,
        dx: Math.abs(hint.x - x),
        dy: Math.abs(hint.y - y),
      }));
    if (!bypassHint) {
      const hint = this.findForwardHint({
        pdfPath,
        page,
        x,
        y,
      });
      if (hint) {
        return {
          ok: true,
          path: hint.sourcePath,
          line: hint.line,
          column: hint.column,
          confidence: true,
          scoreGap: null,
          distance: 0,
          hinted: true,
          hintCandidateCount,
          hintPreview,
        };
      }
      const recentHint = this.findRecentPageHint({ page, x, y });
      if (recentHint) {
        return {
          ok: true,
          path: recentHint.sourcePath,
          line: recentHint.line,
          column: recentHint.column,
          confidence: true,
          scoreGap: null,
          distance: 0,
          hinted: true,
          hintCandidateCount,
          hintPreview,
        };
      }
    }
    let candidates = await this.collectReverseCandidates({
      page,
      x,
      y,
      pdfPath,
      synctexPath,
      cwd,
      env,
      expanded: false,
    });
    if (allowExpandedOffsets && candidates.length < 3) {
      const expandedCandidates = await this.collectReverseCandidates({
        page,
        x,
        y,
        pdfPath,
        synctexPath,
        cwd,
        env,
        expanded: true,
      });
      candidates = this.mergeReverseCandidates(candidates, expandedCandidates);
    }
    if (!candidates.length) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    let selected = await this.selectReverseCandidate({
      candidates,
      click: { page, x, y },
      synctexPath,
      pdfPath,
      cwd,
      env,
    });
    if (allowExpandedOffsets && (!selected || selected.confidence !== true)) {
      const expandedCandidates = await this.collectReverseCandidates({
        page,
        x,
        y,
        pdfPath,
        synctexPath,
        cwd,
        env,
        expanded: true,
      });
      const mergedCandidates = this.mergeReverseCandidates(candidates, expandedCandidates);
      if (mergedCandidates.length > 0) {
        const rescored = await this.selectReverseCandidate({
          candidates: mergedCandidates,
          click: { page, x, y },
          synctexPath,
          pdfPath,
          cwd,
          env,
        });
        if (this.shouldPreferReverseSelection(rescored, selected)) {
          selected = rescored;
        }
      }
    }
    if (!selected) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    const range = Number.isFinite(refineLines)
      ? Math.min(10, Math.max(0, Math.floor(refineLines)))
      : 0;
    if (range > 0) {
      selected = await this.refineReverseCandidate({
        candidate: selected,
        click: { page, x, y },
        synctexPath,
        pdfPath,
        cwd,
        env,
        range,
      });
    }
    return { ok: true, ...selected, hinted: false, hintCandidateCount, hintPreview };
  };

  SynctexService.prototype.refineReverseCandidate = async function ({
    candidate,
    click,
    synctexPath,
    pdfPath,
    cwd,
    env,
    range,
  }) {
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    const sourcePath = candidate.path;
    const baseLine = candidate.line;
    const baseColumn = Number.isFinite(candidate.column) ? candidate.column : 1;
    if (!sourcePath || !Number.isFinite(baseLine) || baseLine < 1) {
      return candidate;
    }
    const startLine = Math.max(1, baseLine - range);
    const endLine = baseLine + range;
    let bestLine = baseLine;
    let bestDistance = Number.isFinite(candidate.distance) ? candidate.distance : null;
    let bestScore = Number.isFinite(bestDistance)
      ? bestDistance + this.getReverseLinePenalty({ sourcePath, line: baseLine })
      : Number.POSITIVE_INFINITY;
    for (let line = startLine; line <= endLine; line += 1) {
      let distance = null;
      const columns = this.getRefineColumns({ sourcePath, line, baseColumn });
      for (const column of columns) {
        const measured = await this.measureForwardDistance({
          synctexPath,
          pdfPath,
          sourcePath,
          line,
          column,
          click,
          cwd,
          env,
        });
        if (!Number.isFinite(measured)) {
          continue;
        }
        if (!Number.isFinite(distance) || measured < distance) {
          distance = measured;
        }
      }
      if (!Number.isFinite(distance)) {
        continue;
      }
      const score = distance + this.getReverseLinePenalty({ sourcePath, line });
      if (!Number.isFinite(bestScore) || score < bestScore) {
        bestScore = score;
        bestDistance = distance;
        bestLine = line;
      }
    }
    if (!Number.isFinite(bestScore)) {
      return candidate;
    }
    if (bestLine === baseLine) {
      if (Number.isFinite(bestDistance)) {
        return { ...candidate, distance: bestDistance };
      }
      return candidate;
    }
    return {
      ...candidate,
      line: bestLine,
      distance: Number.isFinite(bestDistance) ? bestDistance : candidate.distance ?? null,
      refined: true,
    };
  };

  SynctexService.prototype.resolveReverseLine = async function ({
    synctexPath,
    pdfPath,
    cwd,
    env,
    point,
    preferredPath = null,
    targetLine = null,
    targetColumn = null,
  }) {
    const target = `${point.page}:${point.x}:${point.y}:${pdfPath}`;
    let result;
    try {
      result = await this.runProcess(synctexPath, ["edit", "-o", target], cwd, env);
    } catch (_error) {
      return null;
    }
    if (result.status !== 0) {
      return null;
    }
    const entries = this.parseReverseResults(result.output, cwd);
    const parsed = this.pickBestReverseResult({
      entries,
      preferredPath,
      targetLine,
      targetColumn,
    });
    if (!parsed || !Number.isFinite(parsed.line) || parsed.line < 1) {
      return null;
    }
    return parsed;
  };

  SynctexService.prototype.estimateReverseOffsetMax = function ({ x, y }) {
    const magnitude = Math.max(Math.abs(Number(x)), Math.abs(Number(y)));
    if (!Number.isFinite(magnitude)) {
      return 120;
    }
    if (magnitude >= 6000) {
      return 220;
    }
    if (magnitude >= 3500) {
      return 180;
    }
    if (magnitude >= 1800) {
      return 140;
    }
    return 120;
  };

  SynctexService.prototype.buildReverseOffsets = function ({ x, y, expanded = false } = {}) {
    const xOffsets = new Set([
      -72,
      -56,
      -40,
      -32,
      -24,
      -16,
      -8,
      -4,
      0,
      4,
      8,
      16,
      24,
      32,
      40,
      56,
      72,
    ]);
    const yOffsets = new Set([-12, -8, -4, 0, 4, 8, 12]);
    if (expanded) {
      yOffsets.add(-2);
      yOffsets.add(2);
      yOffsets.add(-6);
      yOffsets.add(6);
      const max = this.estimateReverseOffsetMax({ x, y });
      for (let delta = 80; delta <= max; delta += 8) {
        xOffsets.add(delta);
        xOffsets.add(-delta);
      }
      const verticalMax = Math.min(48, Math.max(16, Math.floor(max / 3)));
      for (let delta = 16; delta <= verticalMax; delta += 4) {
        yOffsets.add(delta);
        yOffsets.add(-delta);
      }
    }
    return {
      xOffsets: Array.from(xOffsets).sort((a, b) => a - b),
      yOffsets: Array.from(yOffsets).sort((a, b) => a - b),
    };
  };

  SynctexService.prototype.collectReverseCandidates = async function ({
    page,
    x,
    y,
    pdfPath,
    synctexPath,
    cwd,
    env,
    expanded = false,
  }) {
    const { xOffsets, yOffsets } = this.buildReverseOffsets({ x, y, expanded });
    const candidates = new Map();
    for (const dx of xOffsets) {
      for (const dy of yOffsets) {
        const target = `${page}:${x + dx}:${y + dy}:${pdfPath}`;
        let result;
        try {
          result = await this.runProcess(synctexPath, ["edit", "-o", target], cwd, env);
        } catch (_error) {
          continue;
        }
        if (result.status !== 0) {
          continue;
        }
        const parsed = this.parseReverseResult(result.output, cwd);
        if (!parsed) {
          continue;
        }
        const normalizedPath = this.normalizeComparePath(parsed.path) ?? parsed.path;
        const key = `${normalizedPath}:${parsed.line}:${parsed.column ?? 1}`;
        const existing = candidates.get(key);
        const offsetDistance = Math.abs(dx) + Math.abs(dy);
        if (existing) {
          existing.count += 1;
          if (offsetDistance === 0) {
            existing.exactHit = true;
          }
          if (!Number.isFinite(existing.minOffsetDistance) || offsetDistance < existing.minOffsetDistance) {
            existing.minOffsetDistance = offsetDistance;
          }
        } else {
          candidates.set(key, {
            ...parsed,
            count: 1,
            exactHit: offsetDistance === 0,
            minOffsetDistance: offsetDistance,
          });
        }
      }
    }
    return Array.from(candidates.values());
  };

  SynctexService.prototype.mergeReverseCandidates = function (primary, secondary) {
    const merged = new Map();
    const add = (candidate) => {
      if (!candidate || !candidate.path || !Number.isFinite(candidate.line)) {
        return;
      }
      const normalizedPath = this.normalizeComparePath(candidate.path) ?? candidate.path;
      const column = Number.isFinite(candidate.column) && candidate.column >= 1 ? candidate.column : 1;
      const count = Number.isFinite(candidate.count) && candidate.count > 0 ? candidate.count : 1;
      const exactHit = candidate.exactHit === true;
      const minOffsetDistance = Number.isFinite(candidate.minOffsetDistance)
        ? candidate.minOffsetDistance
        : Number.POSITIVE_INFINITY;
      const key = `${normalizedPath}:${candidate.line}:${column}`;
      const existing = merged.get(key);
      if (existing) {
        existing.count += count;
        existing.exactHit = existing.exactHit === true || exactHit;
        if (minOffsetDistance < existing.minOffsetDistance) {
          existing.minOffsetDistance = minOffsetDistance;
        }
        return;
      }
      merged.set(key, {
        ...candidate,
        column,
        count,
        exactHit,
        minOffsetDistance,
      });
    };
    for (const candidate of Array.isArray(primary) ? primary : []) {
      add(candidate);
    }
    for (const candidate of Array.isArray(secondary) ? secondary : []) {
      add(candidate);
    }
    return Array.from(merged.values());
  };

  SynctexService.prototype.shouldPreferReverseSelection = function (next, current) {
    if (!next) {
      return false;
    }
    if (!current) {
      return true;
    }
    if (next.confidence === true && current.confidence !== true) {
      return true;
    }
    if (current.confidence === true && next.confidence !== true) {
      return false;
    }
    const nextDistance = Number.isFinite(next.distance) ? next.distance : Number.POSITIVE_INFINITY;
    const currentDistance = Number.isFinite(current.distance) ? current.distance : Number.POSITIVE_INFINITY;
    if (nextDistance !== currentDistance) {
      return nextDistance < currentDistance;
    }
    const nextGap = Number.isFinite(next.scoreGap) ? next.scoreGap : -1;
    const currentGap = Number.isFinite(current.scoreGap) ? current.scoreGap : -1;
    if (nextGap !== currentGap) {
      return nextGap > currentGap;
    }
    const nextCount = Number.isFinite(next.count) ? next.count : 0;
    const currentCount = Number.isFinite(current.count) ? current.count : 0;
    if (nextCount !== currentCount) {
      return nextCount > currentCount;
    }
    return next.line < current.line;
  };

  SynctexService.prototype.selectReverseCandidate = async function ({
    candidates,
    click,
    synctexPath,
    pdfPath,
    cwd,
    env,
  }) {
    if (!candidates.length) {
      return null;
    }
    const dominantPath = this.getDominantReversePath(candidates);
    const selectionPool = dominantPath
      ? candidates.filter((candidate) => {
          if (!candidate || typeof candidate.path !== "string") {
            return false;
          }
          return this.normalizeComparePath(candidate.path) === dominantPath;
        })
      : candidates;
    const pooledCandidates = selectionPool.length > 0 ? selectionPool : candidates;
    const exactCandidates = pooledCandidates.filter((candidate) => candidate?.exactHit === true);
    const activeCandidates = exactCandidates.length > 0 ? exactCandidates : pooledCandidates;
    const distanceEpsilon = 1e-3;
    const medianLine = this.getMedianLine(candidates);
    const medianWeight = 0;
    const countWeight = 4;
    const offsetWeight = 12;
    const scoredCandidates = [];
    for (const candidate of activeCandidates) {
      const distance = await this.measureForwardDistance({
        synctexPath,
        pdfPath,
        sourcePath: candidate.path,
        line: candidate.line,
        column: candidate.column ?? 1,
        click,
        cwd,
        env,
      });
      if (!Number.isFinite(distance)) {
        continue;
      }
      const medianDiff = medianLine === null ? 0 : Math.abs(candidate.line - medianLine);
      const offsetPenalty = Number.isFinite(candidate.minOffsetDistance)
        ? candidate.minOffsetDistance * offsetWeight
        : 0;
      const linePenalty = this.getReverseLinePenalty({
        sourcePath: candidate.path,
        line: candidate.line,
      });
      const score =
        distance +
        linePenalty +
        medianDiff * medianWeight +
        offsetPenalty -
        candidate.count * countWeight;
      scoredCandidates.push({ candidate, distance, score });
    }
    if (!scoredCandidates.length) {
      const fallback = candidates.reduce(
        (prev, next) => (next.count > prev.count ? next : prev),
        candidates[0]
      );
      return { ...fallback, confidence: false, scoreGap: null, distance: null };
    }
    scoredCandidates.sort((a, b) => {
      const scoreDiff = a.score - b.score;
      if (Math.abs(scoreDiff) > distanceEpsilon) {
        return scoreDiff;
      }
      if (this.isBetterReverseTie(a.candidate, b.candidate, medianLine)) {
        return -1;
      }
      if (this.isBetterReverseTie(b.candidate, a.candidate, medianLine)) {
        return 1;
      }
      return 0;
    });
    const best = scoredCandidates[0];
    const second = scoredCandidates.length > 1 ? scoredCandidates[1] : null;
    const scoreGap = second ? second.score - best.score : null;
    const confidence = this.isReverseConfidence(best, second);
    return {
      ...best.candidate,
      confidence,
      scoreGap: Number.isFinite(scoreGap) ? scoreGap : null,
      distance: best.distance,
    };
  };
};

