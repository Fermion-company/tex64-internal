const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class SynctexService {
  async forward({ sourcePath, line, column, pdfPath }) {
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
    const selected = await this.selectForwardPoint({
      blocks,
      targetLine,
      synctexPath,
      pdfPath,
      cwd: path.dirname(pdfPath),
      env,
    });
    if (!selected) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    return { ok: true, ...selected };
  }

  async reverse({ page, x, y, pdfPath }) {
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
    const candidates = await this.collectReverseCandidates({
      page,
      x,
      y,
      pdfPath,
      synctexPath,
      cwd,
      env,
    });
    if (!candidates.length) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    const selected = await this.selectReverseCandidate({
      candidates,
      click: { page, x, y },
      synctexPath,
      pdfPath,
      cwd,
      env,
    });
    if (!selected) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    return { ok: true, ...selected };
  }

  parseForwardBlocks(output) {
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
  }

  buildForwardCandidates(block) {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const key = `${x}:${y}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ page: block.page, x, y });
    };
    addCandidate(block.x, block.y);
    if (Number.isFinite(block.h) && Number.isFinite(block.v)) {
      addCandidate(block.h, block.v);
    }
    if (Number.isFinite(block.width) && Number.isFinite(block.height)) {
      const bumpX = Math.min(2, Math.max(block.width - 1, 0));
      const bumpY = Math.max(block.height - 1, 0);
      if (bumpX > 0 || bumpY > 0) {
        addCandidate(block.x + bumpX, block.y + bumpY);
      }
    }
    return candidates;
  }

  async resolveReverseLine({ synctexPath, pdfPath, cwd, env, point }) {
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
    const parsed = this.parseReverseResult(result.output);
    if (!parsed || !Number.isFinite(parsed.line)) {
      return null;
    }
    return parsed.line;
  }

  async selectForwardPoint({ blocks, targetLine, synctexPath, pdfPath, cwd, env }) {
    if (!blocks.length) {
      return null;
    }
    const fallback = blocks[0];
    const fallbackPoint = { page: fallback.page, x: fallback.x, y: fallback.y };
    if (!Number.isFinite(targetLine)) {
      return fallbackPoint;
    }
    let bestScore = null;
    const bestCandidates = [];
    for (const block of blocks) {
      const candidates = this.buildForwardCandidates(block);
      for (const candidate of candidates) {
        const line = await this.resolveReverseLine({
          synctexPath,
          pdfPath,
          cwd,
          env,
          point: candidate,
        });
        if (!Number.isFinite(line)) {
          continue;
        }
        const score = Math.abs(line - targetLine);
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          bestCandidates.length = 0;
          bestCandidates.push(candidate);
        } else if (score === bestScore) {
          bestCandidates.push(candidate);
        }
      }
    }
    if (!bestCandidates.length) {
      return fallbackPoint;
    }
    if (bestCandidates.length === 1) {
      return bestCandidates[0];
    }
    let selected = bestCandidates[0];
    let bestStability = -1;
    for (const candidate of bestCandidates) {
      const stability = await this.measureForwardStability({
        candidate,
        targetLine,
        synctexPath,
        pdfPath,
        cwd,
        env,
      });
      if (stability > bestStability) {
        bestStability = stability;
        selected = candidate;
      }
    }
    return selected;
  }

  async measureForwardStability({ candidate, targetLine, synctexPath, pdfPath, cwd, env }) {
    const offsets = [-4, 0, 4];
    let hits = 0;
    for (const dx of offsets) {
      for (const dy of offsets) {
        const line = await this.resolveReverseLine({
          synctexPath,
          pdfPath,
          cwd,
          env,
          point: { page: candidate.page, x: candidate.x + dx, y: candidate.y + dy },
        });
        if (Number.isFinite(line) && Math.abs(line - targetLine) <= 1) {
          hits += 1;
        }
      }
    }
    return hits;
  }

  buildReverseOffsets() {
    return [-8, -4, 0, 4, 8];
  }

  async collectReverseCandidates({ page, x, y, pdfPath, synctexPath, cwd, env }) {
    const offsets = this.buildReverseOffsets();
    const candidates = new Map();
    for (const dx of offsets) {
      for (const dy of offsets) {
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
        const parsed = this.parseReverseResult(result.output);
        if (!parsed) {
          continue;
        }
        const key = `${parsed.path}:${parsed.line}:${parsed.column ?? 1}`;
        const existing = candidates.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          candidates.set(key, { ...parsed, count: 1 });
        }
      }
    }
    return Array.from(candidates.values());
  }

  async selectReverseCandidate({ candidates, click, synctexPath, pdfPath, cwd, env }) {
    if (!candidates.length) {
      return null;
    }
    const distanceEpsilon = 1e-3;
    const medianLine = this.getMedianLine(candidates);
    const medianWeight = 1;
    const countWeight = 4;
    const scoredCandidates = [];
    for (const candidate of candidates) {
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
      const score = distance + medianDiff * medianWeight - candidate.count * countWeight;
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
  }

  getMedianLine(candidates) {
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
  }

  isBetterReverseTie(candidate, current, medianLine) {
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
  }

  isReverseConfidence(best, second) {
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
  }

  async measureForwardDistance({
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
        const dx =
          click.x < left ? left - click.x : click.x > right ? click.x - right : 0;
        const dy =
          click.y < top ? top - click.y : click.y > bottom ? click.y - bottom : 0;
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
  }

  parseReverseResult(output) {
    const inputMatch = output.match(/Input:(.+)/);
    const lineMatch = output.match(/Line:(\d+)/);
    if (!inputMatch || !lineMatch) {
      return null;
    }
    const columnMatch = output.match(/Column:(\d+)/);
    return {
      path: inputMatch[1].trim(),
      line: Number.parseInt(lineMatch[1], 10),
      column: columnMatch ? Number.parseInt(columnMatch[1], 10) : 1,
    };
  }

  async runProcess(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, env });
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(err);
      });
      proc.on("close", (code) => {
        resolve({ output, status: code ?? 1 });
      });
    });
  }

  extendPath(existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (process.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (process.platform === "win32") {
      extra.push(
        "C:\\texlive\\2024\\bin\\windows",
        "C:\\texlive\\2023\\bin\\windows",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64"
      );
    }
    const parts = [...extra, base].filter(Boolean);
    return parts.join(path.delimiter);
  }

  findSynctex() {
    const override = process.env.TEX180_E2E_SYNCTEX_PATH;
    if (override && fs.existsSync(override)) {
      return override;
    }
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/synctex",
        "/usr/local/bin/synctex",
        "/opt/homebrew/bin/synctex",
        "/usr/bin/synctex"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\synctex.exe",
        "C:\\texlive\\2023\\bin\\windows\\synctex.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\synctex.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\synctex.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "synctex.exe" : "synctex";
      candidates.push(path.join(entry, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

module.exports = { SynctexService };
