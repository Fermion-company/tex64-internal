import type { BridgeWindow } from "./types.js";

const TARGET_WIDTH = 384;
const TARGET_HEIGHT = 384;
const CONTRAST_FACTOR = 1.5;
const SHARPNESS_FACTOR = 1.5;
const NORMALIZE_MEAN = 0.5;
const NORMALIZE_STD = 0.5;

type MathOcrPayload = {
  data: ArrayBuffer;
  width: number;
  height: number;
  imageDataUrl?: string;
};

const loadImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    image.src = dataUrl;
  });

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const resizeCanvas = (canvas: HTMLCanvasElement, width: number, height: number) => {
  if (canvas.width === width && canvas.height === height) {
    return canvas;
  }
  const resized = createCanvas(width, height);
  const ctx = resized.getContext("2d");
  if (!ctx) {
    throw new Error("キャンバスの初期化に失敗しました。");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);
  return resized;
};

const enhanceCanvas = (
  canvas: HTMLCanvasElement,
  contrast: number,
  sharpness: number
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("キャンバスの初期化に失敗しました。");
  }
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const count = width * height;
  let mean = 0;
  for (let i = 0; i < count; i += 1) {
    mean += data[i * 4];
  }
  mean /= count || 1;
  const adjusted = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const value = data[i * 4];
    adjusted[i] = mean + contrast * (value - mean);
  }
  const amount = Math.max(0, sharpness - 1);
  let output = adjusted;
  if (amount > 0) {
    const sharpened = new Float32Array(count);
    const idx = (x: number, y: number) => y * width + x;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const center = adjusted[idx(x, y)];
        const left = adjusted[idx(Math.max(0, x - 1), y)];
        const right = adjusted[idx(Math.min(width - 1, x + 1), y)];
        const up = adjusted[idx(x, Math.max(0, y - 1))];
        const down = adjusted[idx(x, Math.min(height - 1, y + 1))];
        const kernelValue = 5 * center - left - right - up - down;
        sharpened[idx(x, y)] = center + amount * (kernelValue - center);
      }
    }
    output = sharpened;
  }
  for (let i = 0; i < count; i += 1) {
    const value = clampByte(output[i]);
    const idx = i * 4;
    data[idx] = value;
    data[idx + 1] = value;
    data[idx + 2] = value;
    data[idx + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
};

const estimateContrast = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return 0;
  }
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const count = width * height;
  if (count === 0) return 0;
  let mean = 0;
  for (let i = 0; i < count; i += 1) {
    mean += data[i * 4];
  }
  mean /= count;
  let variance = 0;
  for (let i = 0; i < count; i += 1) {
    const diff = data[i * 4] - mean;
    variance += diff * diff;
  }
  variance /= count;
  return Math.sqrt(variance);
};

const enhanceForOcr = (canvas: HTMLCanvasElement) => {
  const contrast = estimateContrast(canvas);
  if (contrast < 10) {
    return enhanceCanvas(canvas, CONTRAST_FACTOR + 0.2, SHARPNESS_FACTOR + 0.1);
  }
  return canvas;
};

const getImageData = (image: HTMLImageElement) => {
  const canvas = createCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("キャンバスの初期化に失敗しました。");
  }
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

const computeMaskData = (imageData: ImageData) => {
  const { data, width, height } = imageData;
  let alphaMin = 255;
  let alphaMax = 0;
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[i] = clampByte(l);
    if (a < alphaMin) alphaMin = a;
    if (a > alphaMax) alphaMax = a;
  }
  const useAlpha = alphaMin !== alphaMax;
  const normalized = new Uint8ClampedArray(width * height);
  let min = 255;
  let max = 0;
  for (let i = 0; i < width * height; i += 1) {
    const raw = useAlpha ? 255 - data[i * 4 + 3] : luminance[i];
    if (raw < min) min = raw;
    if (raw > max) max = raw;
    normalized[i] = raw;
  }
  const scale = max > min ? 255 / (max - min) : 0;
  let mean = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const value = scale > 0 ? (normalized[i] - min) * scale : 0;
    const clamped = clampByte(value);
    normalized[i] = clamped;
    mean += clamped;
  }
  mean /= normalized.length || 1;

  const threshold = 128;
  const mask = new Uint8ClampedArray(width * height);
  if (mean > threshold) {
    for (let i = 0; i < normalized.length; i += 1) {
      const value = normalized[i];
      mask[i] = value < threshold ? 255 : 0;
    }
  } else {
    for (let i = 0; i < normalized.length; i += 1) {
      const value = normalized[i];
      mask[i] = value > threshold ? 255 : 0;
    }
  }
  return { mask, width, height };
};

const computeBoundingBox = (gray: Uint8ClampedArray, width: number, height: number) => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[row + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) {
    return { x: 0, y: 0, width, height };
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

const expandBoundingBox = (
  box: { x: number; y: number; width: number; height: number },
  width: number,
  height: number
) => {
  const baseMargin = Math.round(Math.min(box.width, box.height) * 0.06);
  const margin = Math.min(64, Math.max(12, baseMargin));
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  const maxX = Math.min(width, box.x + box.width + margin);
  const maxY = Math.min(height, box.y + box.height + margin);
  return {
    x,
    y,
    width: Math.max(1, maxX - x),
    height: Math.max(1, maxY - y),
  };
};


const preprocessImage = async (dataUrl: string): Promise<MathOcrPayload> => {
  const image = await loadImage(dataUrl);
  const imageData = getImageData(image);
  const { mask, width, height } = computeMaskData(imageData);
  const rawBox = computeBoundingBox(mask, width, height);
  const box = expandBoundingBox(rawBox, width, height);
  let canvas = createCanvas(box.width, box.height);
  const cropCtx = canvas.getContext("2d");
  if (!cropCtx) {
    throw new Error("キャンバスの初期化に失敗しました。");
  }
  cropCtx.drawImage(
    image,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    box.width,
    box.height
  );
  canvas = enhanceForOcr(canvas);
  canvas = resizeCanvas(canvas, TARGET_WIDTH, TARGET_HEIGHT);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("キャンバスの初期化に失敗しました。");
  }
  const finalData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelCount = canvas.width * canvas.height;
  const floatData = new Float32Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i += 1) {
    const idx = i * 4;
    const r = finalData[idx] / 255;
    const g = finalData[idx + 1] / 255;
    const b = finalData[idx + 2] / 255;
    floatData[i] = (r - NORMALIZE_MEAN) / NORMALIZE_STD;
    floatData[i + pixelCount] = (g - NORMALIZE_MEAN) / NORMALIZE_STD;
    floatData[i + pixelCount * 2] = (b - NORMALIZE_MEAN) / NORMALIZE_STD;
  }
  return {
    data: floatData.buffer,
    width: canvas.width,
    height: canvas.height,
  };
};

export const recognizeMath = async (imageDataUrl: string) => {
  const bridge = (window as BridgeWindow).tex64MathOcr;
  if (!bridge?.run) {
    throw new Error("数式OCRが利用できません。");
  }
  const payload = await preprocessImage(imageDataUrl);
  const result = await bridge.run({ ...payload, imageDataUrl });
  const latex = typeof result?.latex === "string" ? result.latex.trim() : "";
  if (!latex) {
    throw new Error("OCR結果が空でした。");
  }
  return latex;
};
