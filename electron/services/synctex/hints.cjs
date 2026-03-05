module.exports = (SynctexService) => {
  SynctexService.prototype.registerForwardHint = function ({
    pdfPath,
    page,
    x,
    y,
    sourcePath,
    line,
    column,
  }) {
    if (
      !Number.isFinite(page) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(line) ||
      line < 1 ||
      !pdfPath ||
      !sourcePath
    ) {
      return;
    }
    const now = Date.now();
    const normalizedPdf = this.normalizeComparePath(pdfPath);
    const normalizedSource = this.normalizeComparePath(sourcePath);
    if (!normalizedPdf || !normalizedSource) {
      return;
    }
    const normalizedPage = Math.floor(page);
    this.cleanupForwardHints(now);
    // Keep only the newest hint per pdf/page to avoid stale same-page hits
    // stealing reverse matches after a fresh forward sync.
    this.forwardHints = this.forwardHints.filter(
      (hint) => !(hint.pdfPath === normalizedPdf && hint.page === normalizedPage)
    );
    this.forwardHints.unshift({
      pdfPath: normalizedPdf,
      sourcePath: normalizedSource,
      page: normalizedPage,
      x,
      y,
      line: Math.floor(line),
      column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
      timestamp: now,
    });
    const maxHints = 400;
    if (this.forwardHints.length > maxHints) {
      this.forwardHints.length = maxHints;
    }
  };

  SynctexService.prototype.cleanupForwardHints = function (now = Date.now()) {
    const maxAgeMs = 30000;
    this.forwardHints = this.forwardHints.filter((hint) => now - hint.timestamp <= maxAgeMs);
  };

  SynctexService.prototype.findForwardHint = function ({ pdfPath, page, x, y }) {
    if (!pdfPath || !Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const normalizedPdf = this.normalizeComparePath(pdfPath);
    if (!normalizedPdf) {
      return null;
    }
    const now = Date.now();
    this.cleanupForwardHints(now);
    const maxHintAgeMs = 8000;
    const maxDx = 240;
    const maxDy = 26;
    const targetPage = Math.floor(page);
    const recentSamePage = this.forwardHints.filter((hint) => {
      if (hint.page !== targetPage) {
        return false;
      }
      const ageMs = now - hint.timestamp;
      return ageMs <= maxHintAgeMs;
    });
    const pickBest = (hints, { allowAnyPdf = false, dxLimit = maxDx, dyLimit = maxDy } = {}) => {
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const hint of hints) {
        if (!allowAnyPdf && hint.pdfPath !== normalizedPdf) {
          continue;
        }
        const ageMs = now - hint.timestamp;
        const dx = Math.abs(hint.x - x);
        const dy = Math.abs(hint.y - y);
        if (dx > dxLimit || dy > dyLimit) {
          continue;
        }
        const score = dy * 1000 + dx + ageMs * 0.01;
        if (score < bestScore) {
          best = hint;
          bestScore = score;
        }
      }
      return best;
    };
    let best = pickBest(recentSamePage, {
      allowAnyPdf: false,
      dxLimit: maxDx,
      dyLimit: maxDy,
    });
    if (!best) {
      // Fallback for cases where viewer path normalization differs between windows.
      best = pickBest(recentSamePage, {
        allowAnyPdf: true,
        dxLimit: 40,
        dyLimit: 40,
      });
    }
    if (this.debugHints) {
      const sample = recentSamePage
        .slice(0, 5)
        .map((hint) => ({
          pdfPath: hint.pdfPath,
          line: hint.line,
          x: hint.x,
          y: hint.y,
          ageMs: now - hint.timestamp,
          dx: Math.abs(hint.x - x),
          dy: Math.abs(hint.y - y),
        }));
      // eslint-disable-next-line no-console
      console.error(
        `[synctex-hint] page=${targetPage} x=${x} y=${y} matched=${best ? best.line : "none"} sample=${JSON.stringify(sample)}`
      );
    }
    return best;
  };

  SynctexService.prototype.findRecentPageHint = function ({
    page,
    x,
    y,
    maxAgeMs = 4000,
    maxDx = 40,
    maxDy = 40,
  }) {
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const now = Date.now();
    this.cleanupForwardHints(now);
    const targetPage = Math.floor(page);
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const hint of this.forwardHints) {
      if (!hint || hint.page !== targetPage) {
        continue;
      }
      const ageMs = now - hint.timestamp;
      if (ageMs > maxAgeMs) {
        continue;
      }
      const dx = Math.abs(hint.x - x);
      const dy = Math.abs(hint.y - y);
      if (dx > maxDx || dy > maxDy) {
        continue;
      }
      const score = dy * 1000 + dx + ageMs * 0.01;
      if (score < bestScore) {
        best = hint;
        bestScore = score;
      }
    }
    return best;
  };
};

