const fs = require("fs");
const path = require("path");

module.exports = (SynctexService) => {
  SynctexService.prototype.forward = async function ({
    sourcePath,
    line,
    column,
    pdfPath,
    hintLine = null,
    hintColumn = null,
    registerHint = true,
  }) {
    const synctexPath = this.findSynctex();
    if (!synctexPath) {
      return { ok: false, error: "synctex が見つかりません。" };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDFが見つかりません。" };
    }
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: "対象のTeXファイルが見つかりません。" };
    }
    const target = `${line}:${column}:${sourcePath}`;
    const args = ["view", "-i", target, "-o", pdfPath];
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    let result;
    try {
      result = await this.runProcess(synctexPath, args, path.dirname(pdfPath), env);
    } catch (_error) {
      return { ok: false, error: "SyncTeX の解析に失敗しました。" };
    }
    if (result.status !== 0) {
      return { ok: false, error: "SyncTeX の解析に失敗しました。" };
    }
    const blocks = this.parseForwardBlocks(result.output);
    if (!blocks.length) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    const targetLine = Number.isFinite(line) ? line : null;
    const targetColumn = Number.isFinite(column) ? column : null;
    const selected = await this.selectForwardPoint({
      blocks,
      targetLine,
      targetColumn,
      sourcePath,
      synctexPath,
      pdfPath,
      cwd: path.dirname(pdfPath),
      env,
    });
    if (!selected) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    if (
      registerHint !== false &&
      Number.isFinite(selected.page) &&
      Number.isFinite(selected.x) &&
      Number.isFinite(selected.y)
    ) {
      this.registerForwardHint({
        pdfPath,
        page: selected.page,
        x: selected.x,
        y: selected.y,
        sourcePath,
        line: Number.isFinite(hintLine) ? hintLine : Number.isFinite(line) ? line : 1,
        column: Number.isFinite(hintColumn)
          ? hintColumn
          : Number.isFinite(column)
          ? column
          : 1,
      });
    }
    return { ok: true, ...selected };
  };

  SynctexService.prototype.parseForwardBlocks = function (output) {
    if (!output) {
      return [];
    }
    const blocks = [];
    const regex = /Output:[^\n]*\nPage:\d+[\s\S]*?(?=Output:|SyncTeX result end)/g;
    const matches = output.match(regex) ?? [];
    for (const block of matches) {
      const pageMatch = block.match(/Page:(\d+)/);
      const xMatch = block.match(/x:([+-]?\d+(?:\.\d+)?)/);
      const yMatch = block.match(/y:([+-]?\d+(?:\.\d+)?)/);
      if (!pageMatch || !xMatch || !yMatch) {
        continue;
      }
      const hMatch = block.match(/h:([+-]?\d+(?:\.\d+)?)/);
      const vMatch = block.match(/v:([+-]?\d+(?:\.\d+)?)/);
      const wMatch = block.match(/W:([+-]?\d+(?:\.\d+)?)/);
      const hSizeMatch = block.match(/H:([+-]?\d+(?:\.\d+)?)/);
      blocks.push({
        page: Number.parseInt(pageMatch[1], 10),
        x: Number.parseFloat(xMatch[1]),
        y: Number.parseFloat(yMatch[1]),
        h: hMatch ? Number.parseFloat(hMatch[1]) : null,
        v: vMatch ? Number.parseFloat(vMatch[1]) : null,
        width: wMatch ? Number.parseFloat(wMatch[1]) : null,
        height: hSizeMatch ? Number.parseFloat(hSizeMatch[1]) : null,
      });
    }
    return blocks;
  };

  SynctexService.prototype.buildForwardCandidates = function (block) {
    const candidates = [];
    const seen = new Set();
    const blockWidth = Number.isFinite(block.width) ? block.width : null;
    const rawH = Number.isFinite(block.height) ? block.height : null;
    const DEPTH_ESTIMATE = 3;
    const blockHeight = rawH !== null ? rawH + DEPTH_ESTIMATE : null;
    const blockX = Number.isFinite(block.h) ? block.h : block.x;
    const blockY =
      Number.isFinite(block.v) && rawH !== null
        ? block.v - rawH
        : block.y;
    const addCandidate = (x, y, geometryBias = 0) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const key = `${x}:${y}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ page: block.page, x, y, geometryBias, blockX, blockY, blockWidth, blockHeight });
    };
    addCandidate(block.x, block.y, 0);
    if (Number.isFinite(block.h) && Number.isFinite(block.v)) {
      addCandidate(block.h, block.v, 0.5);
    }
    if (Number.isFinite(block.width) && Number.isFinite(block.height)) {
      const centerX = block.x + block.width / 2;
      const centerY = block.y + block.height / 2;
      addCandidate(centerX, centerY, 0.75);
      const widthSign = Math.sign(block.width) || 1;
      const heightSign = Math.sign(block.height) || 1;
      const bumpX = widthSign * Math.min(2, Math.max(Math.abs(block.width) - 1, 0));
      const bumpY = heightSign * Math.max(Math.abs(block.height) - 1, 0);
      if (bumpX !== 0 || bumpY !== 0) {
        addCandidate(block.x + bumpX, block.y + bumpY, 1);
      }
    }
    return candidates;
  };

  SynctexService.prototype.selectForwardPoint = async function ({
    blocks,
    targetLine,
    targetColumn = null,
    sourcePath,
    synctexPath,
    pdfPath,
    cwd,
    env,
  }) {
    if (!blocks.length) {
      return null;
    }
    const fallback = blocks[0];
    const fallbackPoint = { page: fallback.page, x: fallback.x, y: fallback.y };
    if (!Number.isFinite(targetLine)) {
      return fallbackPoint;
    }
    // Fast path: single block — skip reverse verification (most common case)
    if (blocks.length === 1) {
      const candidates = this.buildForwardCandidates(fallback);
      return candidates[0] || fallbackPoint;
    }
    // Multi-block: verify first candidate per block only, skip stability measurement
    let bestScore = null;
    let bestResult = null;
    const pathPenalty = 1000000;
    const lineWeight = 100;
    const columnWeight = 1;
    const geometryWeight = 2;
    for (const block of blocks) {
      const candidates = this.buildForwardCandidates(block);
      const candidate = candidates[0];
      if (!candidate) {
        continue;
      }
      const reverse = await this.resolveReverseLine({
        synctexPath,
        pdfPath,
        cwd,
        env,
        point: candidate,
        preferredPath: sourcePath,
        targetLine,
        targetColumn,
      });
      if (!reverse || !Number.isFinite(reverse.line)) {
        continue;
      }
      const samePath = !sourcePath || this.isSamePath(reverse.path, sourcePath);
      const lineDiff = Math.abs(reverse.line - targetLine);
      const reverseColumn = Number.isFinite(reverse.column) ? reverse.column : 1;
      const columnDiff = Number.isFinite(targetColumn)
        ? Math.abs(reverseColumn - targetColumn)
        : 0;
      const geometryBias = Number.isFinite(candidate.geometryBias) ? candidate.geometryBias : 0;
      const score =
        lineDiff * lineWeight +
        columnDiff * columnWeight +
        geometryBias * geometryWeight +
        (samePath ? 0 : pathPenalty);
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        bestResult = {
          ...candidate,
          matchedPath: reverse.path,
          matchedLine: reverse.line,
          matchedColumn: Number.isFinite(reverse.column) ? reverse.column : 1,
          matchDiff: lineDiff,
          matchColumnDiff: Number.isFinite(targetColumn) ? columnDiff : null,
          sameSourcePath: samePath === true,
        };
      }
    }
    return bestResult || fallbackPoint;
  };

  SynctexService.prototype.measureForwardDistance = async function ({
    synctexPath,
    pdfPath,
    sourcePath,
    line,
    column,
    click,
    cwd,
    env,
  }) {
    const maxBoxWidth = 200;
    const maxBoxHeight = 60;
    const target = `${line}:${column}:${sourcePath}`;
    let result;
    try {
      result = await this.runProcess(synctexPath, ["view", "-i", target, "-o", pdfPath], cwd, env);
    } catch (_error) {
      return null;
    }
    if (result.status !== 0) {
      return null;
    }
    const blocks = this.parseForwardBlocks(result.output);
    if (!blocks.length) {
      return null;
    }
    let best = null;
    for (const block of blocks) {
      if (Number.isFinite(click.page) && block.page !== click.page) {
        continue;
      }
      if (
        Number.isFinite(block.width) &&
        Number.isFinite(block.height) &&
        block.width > 0 &&
        block.height > 0 &&
        block.width <= maxBoxWidth &&
        block.height <= maxBoxHeight
      ) {
        const left = Math.min(block.x, block.x + block.width);
        const right = Math.max(block.x, block.x + block.width);
        const top = Math.min(block.y, block.y + block.height);
        const bottom = Math.max(block.y, block.y + block.height);
        const dx = click.x < left ? left - click.x : click.x > right ? click.x - right : 0;
        const dy = click.y < top ? top - click.y : click.y > bottom ? click.y - bottom : 0;
        const dist = dx * dx + dy * dy;
        if (best === null || dist < best) {
          best = dist;
        }
        continue;
      }
      const points = [
        { x: block.x, y: block.y },
        Number.isFinite(block.h) && Number.isFinite(block.v) ? { x: block.h, y: block.v } : null,
      ].filter(Boolean);
      for (const point of points) {
        const dx = point.x - click.x;
        const dy = point.y - click.y;
        const dist = dx * dx + dy * dy;
        if (best === null || dist < best) {
          best = dist;
        }
      }
    }
    return best;
  };
};

