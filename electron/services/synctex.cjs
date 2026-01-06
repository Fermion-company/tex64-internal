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
    const parsed = this.parseForwardResult(result.output);
    if (!parsed) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    return { ok: true, ...parsed };
  }

  async reverse({ page, x, y, pdfPath }) {
    const synctexPath = this.findSynctex();
    if (!synctexPath) {
      return { ok: false, error: "synctex が見つかりません。" };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDFが見つかりません。" };
    }
    const target = `${page}:${x}:${y}:${pdfPath}`;
    const args = ["edit", "-o", target];
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
    const parsed = this.parseReverseResult(result.output);
    if (!parsed) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    return { ok: true, ...parsed };
  }

  parseForwardResult(output) {
    const pageMatch = output.match(/Page:(\d+)/);
    if (!pageMatch) {
      return null;
    }
    const xMatch = output.match(/x:([+-]?\d+(?:\.\d+)?)/);
    const yMatch = output.match(/y:([+-]?\d+(?:\.\d+)?)/);
    return {
      page: Number.parseInt(pageMatch[1], 10),
      x: xMatch ? Number.parseFloat(xMatch[1]) : 0,
      y: yMatch ? Number.parseFloat(yMatch[1]) : 0,
    };
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
