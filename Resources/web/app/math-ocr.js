const DIVABLE = 32;
const MAX_WIDTH = 672;
const MAX_HEIGHT = 192;
const MIN_WIDTH = 32;
const MIN_HEIGHT = 32;
const NORMALIZE_MEAN = 0.7931;
const NORMALIZE_STD = 0.1738;
const loadImage = (dataUrl) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    image.src = dataUrl;
});
const createCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
};
const getImageData = (image) => {
    const canvas = createCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
};
const computePadData = (imageData) => {
    const { data, width, height } = imageData;
    let alphaMin = 255;
    let alphaMax = 0;
    const luminance = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
        const idx = i * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luminance[i] = l;
        if (a < alphaMin)
            alphaMin = a;
        if (a > alphaMax)
            alphaMax = a;
    }
    const useAlpha = alphaMin !== alphaMax;
    let min = Infinity;
    let max = -Infinity;
    const normalized = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
        const idx = i * 4;
        const raw = useAlpha ? 255 - data[idx + 3] : luminance[i];
        normalized[i] = raw;
        if (raw < min)
            min = raw;
        if (raw > max)
            max = raw;
    }
    const scale = max > min ? 255 / (max - min) : 0;
    let mean = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        const value = (normalized[i] - min) * scale;
        normalized[i] = value;
        mean += value;
    }
    mean /= normalized.length || 1;
    const threshold = 128;
    const gray = new Uint8ClampedArray(width * height);
    const dataOut = new Uint8ClampedArray(width * height);
    if (mean > threshold) {
        for (let i = 0; i < normalized.length; i += 1) {
            const value = normalized[i];
            dataOut[i] = value;
            gray[i] = value < threshold ? 255 : 0;
        }
    }
    else {
        for (let i = 0; i < normalized.length; i += 1) {
            const value = 255 - normalized[i];
            dataOut[i] = value;
            gray[i] = normalized[i] > threshold ? 255 : 0;
        }
    }
    return { dataOut, gray, width, height };
};
const computeBoundingBox = (gray, width, height) => {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
            if (gray[row + x] > 0) {
                if (x < minX)
                    minX = x;
                if (y < minY)
                    minY = y;
                if (x > maxX)
                    maxX = x;
                if (y > maxY)
                    maxY = y;
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
const canvasFromGray = (gray, width, height) => {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    const output = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i += 1) {
        const value = gray[i];
        const idx = i * 4;
        output.data[idx] = value;
        output.data[idx + 1] = value;
        output.data[idx + 2] = value;
        output.data[idx + 3] = 255;
    }
    ctx.putImageData(output, 0, 0);
    return canvas;
};
const padCanvas = (canvas) => {
    const targetWidth = Math.ceil(canvas.width / DIVABLE) * DIVABLE;
    const targetHeight = Math.ceil(canvas.height / DIVABLE) * DIVABLE;
    if (targetWidth === canvas.width && targetHeight === canvas.height) {
        return canvas;
    }
    const padded = createCanvas(targetWidth, targetHeight);
    const ctx = padded.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(canvas, 0, 0);
    return padded;
};
const enforceMinMax = (canvas) => {
    let { width, height } = canvas;
    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        const ratio = Math.max(width / MAX_WIDTH, height / MAX_HEIGHT);
        width = Math.max(1, Math.round(width / ratio));
        height = Math.max(1, Math.round(height / ratio));
        const scaled = createCanvas(width, height);
        const ctx = scaled.getContext("2d");
        if (!ctx) {
            throw new Error("キャンバスの初期化に失敗しました。");
        }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(canvas, 0, 0, width, height);
        canvas = scaled;
    }
    if (canvas.width < MIN_WIDTH || canvas.height < MIN_HEIGHT) {
        const targetWidth = Math.max(canvas.width, MIN_WIDTH);
        const targetHeight = Math.max(canvas.height, MIN_HEIGHT);
        const padded = createCanvas(targetWidth, targetHeight);
        const ctx = padded.getContext("2d");
        if (!ctx) {
            throw new Error("キャンバスの初期化に失敗しました。");
        }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(canvas, 0, 0);
        canvas = padded;
    }
    return canvas;
};
const preprocessImage = async (dataUrl) => {
    const image = await loadImage(dataUrl);
    const imageData = getImageData(image);
    const { dataOut, gray, width, height } = computePadData(imageData);
    const box = computeBoundingBox(gray, width, height);
    const cropped = new Uint8ClampedArray(box.width * box.height);
    for (let y = 0; y < box.height; y += 1) {
        const srcOffset = (box.y + y) * width + box.x;
        const dstOffset = y * box.width;
        cropped.set(dataOut.subarray(srcOffset, srcOffset + box.width), dstOffset);
    }
    let canvas = canvasFromGray(cropped, box.width, box.height);
    canvas = padCanvas(canvas);
    canvas = enforceMinMax(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    const finalData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const floatData = new Float32Array(canvas.width * canvas.height);
    for (let i = 0; i < canvas.width * canvas.height; i += 1) {
        const value = finalData[i * 4] / 255;
        floatData[i] = (value - NORMALIZE_MEAN) / NORMALIZE_STD;
    }
    return {
        data: floatData.buffer,
        width: canvas.width,
        height: canvas.height,
    };
};
export const recognizeMath = async (imageDataUrl) => {
    const bridge = window.tex64MathOcr;
    if (!(bridge === null || bridge === void 0 ? void 0 : bridge.run)) {
        throw new Error("数式OCRが利用できません。");
    }
    const payload = await preprocessImage(imageDataUrl);
    const result = await bridge.run(payload);
    const latex = typeof (result === null || result === void 0 ? void 0 : result.latex) === "string" ? result.latex.trim() : "";
    if (!latex) {
        throw new Error("OCR結果が空でした。");
    }
    return latex;
};
