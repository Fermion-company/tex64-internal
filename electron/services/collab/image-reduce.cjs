"use strict";

// A smaller copy of a PNG or JPEG that is over the collaboration file limit,
// for sharing: same format, fewer pixels (and, for JPEG, a lower quality),
// and the resolution metadata scaled with the pixels so that LaTeX gives the
// image the same physical size (\includegraphics[scale=…] reads it). The
// owner's own file is never touched. See docs/collab-relay.md.

const fsp = require("node:fs/promises");

// pdfTeX / LuaTeX place an image without resolution metadata at 72 dpi.
const DEFAULT_DPI = 72;
const INCHES_PER_METER = 39.37007874015748;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngChunks = (buffer) => {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) break;
    chunks.push({ type, start: offset, end: offset + 12 + length, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
};

// Pixels per meter (x, y) of a PNG, from pHYs when it states meters.
const pngDensity = (buffer) => {
  const phys = pngChunks(buffer)?.find((chunk) => chunk.type === "pHYs" && chunk.data.length === 9);
  if (phys && phys.data[8] === 1) return { x: phys.data.readUInt32BE(0), y: phys.data.readUInt32BE(4) };
  return { x: DEFAULT_DPI * INCHES_PER_METER, y: DEFAULT_DPI * INCHES_PER_METER };
};

// `reduced` with a pHYs chunk of `original`'s density times `scale`.
const scalePngDensity = (reduced, original, scale) => {
  const chunks = pngChunks(reduced);
  if (!chunks) return reduced;
  const density = pngDensity(original);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(Math.max(1, Math.round(density.x * scale)), 0);
  data.writeUInt32BE(Math.max(1, Math.round(density.y * scale)), 4);
  data[8] = 1;
  const typeAndData = Buffer.concat([Buffer.from("pHYs", "latin1"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  const parts = [PNG_SIGNATURE];
  let placed = false;
  for (const item of chunks) {
    if (item.type === "pHYs") continue;
    if (!placed && item.type === "IDAT") {
      parts.push(chunk);
      placed = true;
    }
    parts.push(reduced.subarray(item.start, item.end));
  }
  return placed ? Buffer.concat(parts) : reduced;
};

// The JFIF APP0 segment right after SOI: { offset, units, x, y } or null.
const jfif = (buffer) => {
  if (buffer.length < 20 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  if (buffer[2] !== 0xff || buffer[3] !== 0xe0) return null;
  if (buffer.toString("latin1", 6, 11) !== "JFIF\0") return null;
  return { offset: 2, length: buffer.readUInt16BE(4), units: buffer[13], x: buffer.readUInt16BE(14), y: buffer.readUInt16BE(16) };
};

// Dots per inch (x, y) of a JPEG, from JFIF when it states inches or cm.
const jpegDensity = (buffer) => {
  const header = jfif(buffer);
  if (header && header.units === 1 && header.x && header.y) return { x: header.x, y: header.y };
  if (header && header.units === 2 && header.x && header.y) return { x: header.x * 2.54, y: header.y * 2.54 };
  return { x: DEFAULT_DPI, y: DEFAULT_DPI };
};

// `reduced` with a JFIF density in dots per inch of `original`'s times `scale`.
const scaleJpegDensity = (reduced, original, scale) => {
  if (reduced.length < 4 || reduced[0] !== 0xff || reduced[1] !== 0xd8) return reduced;
  const density = jpegDensity(original);
  const x = Math.min(65535, Math.max(1, Math.round(density.x * scale)));
  const y = Math.min(65535, Math.max(1, Math.round(density.y * scale)));
  const header = jfif(reduced);
  if (header) {
    const out = Buffer.from(reduced);
    out[13] = 1;
    out.writeUInt16BE(x, 14);
    out.writeUInt16BE(y, 16);
    return out;
  }
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");
  app0[9] = 1;
  app0[10] = 1;
  app0[11] = 1;
  app0.writeUInt16BE(x, 12);
  app0.writeUInt16BE(y, 14);
  return Buffer.concat([reduced.subarray(0, 2), app0, reduced.subarray(2)]);
};

const REDUCIBLE = new Set(["png", "jpg", "jpeg"]);

// A reducer over Electron's nativeImage: ({ path, extension, maxBytes }) →
// Buffer under maxBytes, or null when the image cannot be read or made small
// enough.
const createImageReducer = (nativeImage) => async ({ path: file, extension, maxBytes }) => {
  const kind = String(extension || "").toLowerCase().replace(/^\./, "");
  if (!REDUCIBLE.has(kind)) return null;
  let original;
  try {
    original = await fsp.readFile(file);
  } catch {
    return null;
  }
  // From the bytes, not the path: a name like fig@2x.png would otherwise be
  // read at a scale factor of 2.
  const image = nativeImage.createFromBuffer(original);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const jpeg = kind !== "png";
  let scale = 1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    const resized = w === width && h === height ? image : image.resize({ width: w, height: h, quality: "best" });
    const encoded = jpeg ? resized.toJPEG(attempt === 0 ? 92 : 85) : resized.toPNG();
    if (encoded.length <= maxBytes) {
      return jpeg ? scaleJpegDensity(encoded, original, w / width) : scalePngDensity(encoded, original, w / width);
    }
    scale *= Math.min(0.9, Math.sqrt(maxBytes / encoded.length) * 0.97);
  }
  return null;
};

module.exports = {
  REDUCIBLE,
  createImageReducer,
  scalePngDensity,
  scaleJpegDensity,
  pngDensity,
  jpegDensity,
  crc32,
};
