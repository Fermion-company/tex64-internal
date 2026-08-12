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

export const encodeFigureBlock = (scene: Scene): string => {
  const code = generateTikz(scene).code;
  const body = `${code}\n`;
  const encoded = base64EncodeUtf8(JSON.stringify(scene));
  const chunks = encoded.match(/.{1,100}/g) || [""];
  return [`%% tex64-figure v1 h=${fnv1a32(body)}`, ...chunks.map((chunk) => `%% tex64-figure+ ${chunk}`), `${code}\n`].join("\n");
};

export const decodeFigureBlockAt = (lines: string[], cursorLine: number): { scene: Scene; startLine: number; endLine: number; detached: boolean } | null => {
  if (!Number.isInteger(cursorLine) || cursorLine < 0 || cursorLine >= lines.length) return null;
  let startLine = cursorLine;
  while (startLine >= 0 && !/^%% tex64-figure v1\b/.test(lines[startLine])) startLine--;
  if (startLine < 0) return null;
  for (let i = startLine + 1; i <= cursorLine; i++) if (/^%% tex64-figure v1\b/.test(lines[i])) return null;
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine] !== "\\end{tikzpicture}") {
    if (endLine > startLine && /^%% tex64-figure v1\b/.test(lines[endLine])) return null;
    endLine++;
  }
  if (endLine >= lines.length || cursorLine > endLine) return null;
  const header = /^%% tex64-figure v1 h=([0-9a-fA-F]{8})$/.exec(lines[startLine]);
  if (!header) return null;
  const chunks: string[] = [];
  let bodyStart = startLine + 1;
  while (bodyStart < endLine) {
    const match = /^%% tex64-figure\+ ([A-Za-z0-9+/=]*)$/.exec(lines[bodyStart]);
    if (!match) break;
    chunks.push(match[1]);
    bodyStart++;
  }
  if (!chunks.length) return null;
  let scene: Scene | null = null;
  try { scene = validateScene(JSON.parse(base64DecodeUtf8(chunks.join("")))); } catch { return null; }
  if (!scene) return null;
  const body = `${lines.slice(bodyStart, endLine + 1).join("\n")}\n`;
  return { scene, startLine, endLine, detached: fnv1a32(body) !== header[1].toLowerCase() };
};
