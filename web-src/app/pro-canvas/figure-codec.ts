import { Scene, validateScene } from "./scene.js";
import { generateTikz } from "./tikz-generate.js";

declare const Buffer: any;

export const fnv1a32 = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const base64EncodeUtf8 = (text: string): string => {
  if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const base64DecodeUtf8 = (b64: string): string => {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const base64EncodeBytes = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64DecodeBytes = (b64: string): Uint8Array => {
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const lzssCompress = (input: Uint8Array): Uint8Array => {
  const out: number[] = [], n = input.length, chains = new Map<number, number[]>();
  let i = 0;
  while (i < n) {
    const flagIndex = out.length; out.push(0);
    let flags = 0;
    for (let bit = 0; bit < 8 && i < n; bit++) {
      let bestLen = 0, bestOff = 0;
      const key3 = () => input[i] << 16 | input[i + 1] << 8 | input[i + 2];
      if (i + 2 < n) {
        const chain = chains.get(key3());
        if (chain) for (let c = chain.length - 1, tried = 0; c >= 0 && tried < 64; c--, tried++) {
          const pos = chain[c], off = i - pos;
          if (off > 4096) break;
          let len = 0;
          while (len < 18 && i + len < n && input[pos + len] === input[i + len]) len++;
          if (len > bestLen) { bestLen = len; bestOff = off; if (len === 18) break; }
        }
      }
      const remember = () => { if (i + 2 < n) { const key = key3(); let chain = chains.get(key); if (!chain) chains.set(key, chain = []); chain.push(i); } };
      if (bestLen >= 3) { const token = (bestOff - 1) << 4 | (bestLen - 3); out.push(token >> 8 & 255, token & 255); for (let k = 0; k < bestLen; k++) { remember(); i++; } }
      else { flags |= 1 << bit; remember(); out.push(input[i]); i++; }
    }
    out[flagIndex] = flags;
  }
  return Uint8Array.from(out);
};

export const lzssDecompress = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const flags = data[i++];
    for (let bit = 0; bit < 8 && i < data.length; bit++) {
      if (flags >> bit & 1) out.push(data[i++]);
      else { const token = data[i] << 8 | data[i + 1]; i += 2; const start = out.length - ((token >> 4) + 1), len = (token & 15) + 3; for (let k = 0; k < len; k++) out.push(out[start + k]); }
    }
  }
  return Uint8Array.from(out);
};

/** 図ブロックの先頭にある、シーン実体を積んだ 1 行。 */
export const isFigureHeaderLine = (line: string): boolean => /^%% tex64-figure v[12]\b/.test(line);

export const encodeFigureBlock = (scene: Scene): string => {
  const code = generateTikz(scene).code.split("\n").filter((line) => !/^% requires(?::|\s|$)/.test(line)).join("\n");
  const body = `${code}\n`;
  const json = JSON.stringify(scene, (_key, value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value);
  const encoded = base64EncodeBytes(lzssCompress(new TextEncoder().encode(json)));
  return `%% tex64-figure v2 h=${fnv1a32(body)} ${encoded}\n${code}\n`;
};

export const decodeFigureBlockAt = (lines: string[], cursorLine: number): { scene: Scene; startLine: number; endLine: number; detached: boolean } | null => {
  if (!Number.isInteger(cursorLine) || cursorLine < 0 || cursorLine >= lines.length) return null;
  let startLine = cursorLine;
  while (startLine >= 0 && !isFigureHeaderLine(lines[startLine])) startLine--;
  if (startLine < 0) return null;
  for (let i = startLine + 1; i <= cursorLine; i++) if (isFigureHeaderLine(lines[i])) return null;
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine] !== "\\end{tikzpicture}") {
    if (endLine > startLine && isFigureHeaderLine(lines[endLine])) return null;
    endLine++;
  }
  if (endLine >= lines.length) return null;
  const v2 = /^%% tex64-figure v2 h=([0-9a-f]{8}) ([A-Za-z0-9+/=]+)$/.exec(lines[startLine]);
  const v1 = /^%% tex64-figure v1 h=([0-9a-fA-F]{8})$/.exec(lines[startLine]);
  if (!v1 && !v2) return null;
  let bodyStart = startLine + 1;
  let scene: Scene | null = null;
  if (v2) {
    try { scene = validateScene(JSON.parse(new TextDecoder().decode(lzssDecompress(base64DecodeBytes(v2[2]))))); } catch { return null; }
  } else {
    const chunks: string[] = [];
    while (bodyStart < endLine) {
      const match = /^%% tex64-figure\+ ([A-Za-z0-9+/=]*)$/.exec(lines[bodyStart]);
      if (!match) break;
      chunks.push(match[1]);
      bodyStart++;
    }
    if (!chunks.length) return null;
    try { scene = validateScene(JSON.parse(base64DecodeUtf8(chunks.join("")))); } catch { return null; }
  }
  if (!scene) return null;
  if (scene.outputWidth?.mode === "relative" && lines[endLine + 1]?.trim() === "}") endLine += 1;
  if (cursorLine > endLine) return null;
  const body = `${lines.slice(bodyStart, endLine + 1).join("\n")}\n`;
  return { scene, startLine, endLine, detached: fnv1a32(body) !== (v2?.[1] || v1![1].toLowerCase()) };
};
