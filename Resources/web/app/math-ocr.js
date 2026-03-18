const TARGET_WIDTH = 384;
const TARGET_HEIGHT = 384;
const CONTRAST_FACTOR = 1.5;
const SHARPNESS_FACTOR = 1.5;
const NORMALIZE_MEAN = 0.5;
const NORMALIZE_STD = 0.5;
const CANDIDATE_EARLY_ACCEPT_SCORE = 90;
const MAX_PREPROCESS_PAYLOADS = 4;
const PIPELINE_TIMEOUT_MS = 10000;
const PHASE1_MAX_SEQ_LEN = 80;
const PHASE2_MAX_SEQ_LEN = 200;
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
const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const copyCanvas = (source) => {
    const clone = createCanvas(source.width, source.height);
    const ctx = clone.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    ctx.drawImage(source, 0, 0);
    return clone;
};
const fitCanvasWithPadding = (source, width, height, background = 255) => {
    const fitted = createCanvas(width, height);
    const ctx = fitted.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    ctx.fillStyle = `rgb(${background},${background},${background})`;
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / source.width, height / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const offsetX = Math.floor((width - drawWidth) / 2);
    const offsetY = Math.floor((height - drawHeight) / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, source.width, source.height, offsetX, offsetY, drawWidth, drawHeight);
    return fitted;
};
const enhanceCanvas = (canvas, contrast, sharpness) => {
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
        const idx = (x, y) => y * width + x;
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
const estimateContrast = (canvas) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return 0;
    }
    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    const count = width * height;
    if (count === 0)
        return 0;
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
const enhanceForOcr = (canvas) => {
    const contrast = estimateContrast(canvas);
    if (contrast < 10) {
        return enhanceCanvas(canvas, CONTRAST_FACTOR + 0.2, SHARPNESS_FACTOR + 0.1);
    }
    return canvas;
};
const computeOtsuThreshold = (gray) => {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 1) {
        histogram[gray[i]] += 1;
    }
    const total = gray.length || 1;
    let sum = 0;
    for (let i = 0; i < histogram.length; i += 1) {
        sum += i * histogram[i];
    }
    let sumBackground = 0;
    let weightBackground = 0;
    let maxVariance = -1;
    let bestThreshold = 128;
    for (let t = 0; t < histogram.length; t += 1) {
        weightBackground += histogram[t];
        if (weightBackground === 0)
            continue;
        const weightForeground = total - weightBackground;
        if (weightForeground === 0)
            break;
        sumBackground += t * histogram[t];
        const meanBackground = sumBackground / weightBackground;
        const meanForeground = (sum - sumBackground) / weightForeground;
        const diff = meanBackground - meanForeground;
        const variance = weightBackground * weightForeground * diff * diff;
        if (variance > maxVariance) {
            maxVariance = variance;
            bestThreshold = t;
        }
    }
    return bestThreshold;
};
const scoreMaskRatio = (ratio) => {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
        return -Infinity;
    }
    const target = 0.14;
    let score = -Math.abs(Math.log((ratio + 1e-6) / (target + 1e-6))) * 40;
    if (ratio < 0.003)
        score -= 80;
    if (ratio > 0.75)
        score -= 80;
    return score;
};
const buildMaskFromThreshold = (normalized, threshold, foregroundIsDark) => {
    const mask = new Uint8ClampedArray(normalized.length);
    let count = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        const value = normalized[i];
        const foreground = foregroundIsDark ? value <= threshold : value >= threshold;
        if (foreground) {
            mask[i] = 255;
            count += 1;
        }
    }
    return { mask, ratio: count / (normalized.length || 1) };
};
const denoiseMask = (mask, width, height, passes = 1) => {
    let current = mask;
    for (let pass = 0; pass < passes; pass += 1) {
        const next = new Uint8ClampedArray(current.length);
        for (let y = 0; y < height; y += 1) {
            const yMin = Math.max(0, y - 1);
            const yMax = Math.min(height - 1, y + 1);
            for (let x = 0; x < width; x += 1) {
                const xMin = Math.max(0, x - 1);
                const xMax = Math.min(width - 1, x + 1);
                let around = 0;
                for (let yy = yMin; yy <= yMax; yy += 1) {
                    const row = yy * width;
                    for (let xx = xMin; xx <= xMax; xx += 1) {
                        if (current[row + xx] > 0)
                            around += 1;
                    }
                }
                const idx = y * width + x;
                if (current[idx] > 0) {
                    next[idx] = around >= 3 ? 255 : 0;
                }
                else {
                    next[idx] = around >= 7 ? 255 : 0;
                }
            }
        }
        current = next;
    }
    return current;
};
const trimBoundingBoxByProjection = (mask, width, height, box) => {
    if (box.width <= 2 || box.height <= 2) {
        return box;
    }
    const rowCounts = new Uint32Array(box.height);
    const colCounts = new Uint32Array(box.width);
    for (let y = box.y; y < box.y + box.height; y += 1) {
        const row = y * width;
        for (let x = box.x; x < box.x + box.width; x += 1) {
            if (mask[row + x] > 0) {
                rowCounts[y - box.y] += 1;
                colCounts[x - box.x] += 1;
            }
        }
    }
    const minRow = Math.max(1, Math.round(box.width * 0.0035));
    const minCol = Math.max(1, Math.round(box.height * 0.0035));
    let top = 0;
    while (top < rowCounts.length && rowCounts[top] < minRow) {
        top += 1;
    }
    let bottom = rowCounts.length - 1;
    while (bottom >= top && rowCounts[bottom] < minRow) {
        bottom -= 1;
    }
    let left = 0;
    while (left < colCounts.length && colCounts[left] < minCol) {
        left += 1;
    }
    let right = colCounts.length - 1;
    while (right >= left && colCounts[right] < minCol) {
        right -= 1;
    }
    if (bottom < top || right < left) {
        return box;
    }
    return {
        x: box.x + left,
        y: box.y + top,
        width: Math.max(1, right - left + 1),
        height: Math.max(1, bottom - top + 1),
    };
};
const binarizeCanvas = (canvas, options = {}) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    let mean = 0;
    for (let i = 0; i < width * height; i += 1) {
        const idx = i * 4;
        const value = data[idx];
        gray[i] = value;
        mean += value;
    }
    mean /= gray.length || 1;
    const threshold = clampByte(computeOtsuThreshold(gray) + (Number.isFinite(options.thresholdOffset) ? options.thresholdOffset : 0));
    const backgroundIsBright = mean >= threshold;
    const invert = options.invert === true;
    for (let i = 0; i < gray.length; i += 1) {
        const idx = i * 4;
        const source = gray[i];
        let foreground = backgroundIsBright ? source < threshold : source > threshold;
        if (invert) {
            foreground = !foreground;
        }
        const value = foreground ? 0 : 255;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
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
const computeMaskData = (imageData) => {
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
        if (a < alphaMin)
            alphaMin = a;
        if (a > alphaMax)
            alphaMax = a;
    }
    const useAlpha = alphaMin !== alphaMax;
    const normalized = new Uint8ClampedArray(width * height);
    let min = 255;
    let max = 0;
    for (let i = 0; i < width * height; i += 1) {
        const raw = useAlpha ? 255 - data[i * 4 + 3] : luminance[i];
        if (raw < min)
            min = raw;
        if (raw > max)
            max = raw;
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
    const otsuThreshold = computeOtsuThreshold(normalized);
    const candidates = [
        buildMaskFromThreshold(normalized, otsuThreshold, true),
        buildMaskFromThreshold(normalized, otsuThreshold, false),
        buildMaskFromThreshold(normalized, 128, mean >= 128),
        buildMaskFromThreshold(normalized, 128, mean < 128),
    ];
    let bestMask = candidates[0];
    let bestScore = scoreMaskRatio(candidates[0].ratio);
    for (let i = 1; i < candidates.length; i += 1) {
        const score = scoreMaskRatio(candidates[i].ratio);
        if (score > bestScore) {
            bestMask = candidates[i];
            bestScore = score;
        }
    }
    const mask = denoiseMask(bestMask.mask, width, height, 1);
    return { mask, width, height };
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
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
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
const expandBoundingBox = (box, width, height, margin) => {
    const safeMargin = Math.max(0, Math.round(margin));
    const x = Math.max(0, box.x - safeMargin);
    const y = Math.max(0, box.y - safeMargin);
    const maxX = Math.min(width, box.x + box.width + safeMargin);
    const maxY = Math.min(height, box.y + box.height + safeMargin);
    return {
        x,
        y,
        width: Math.max(1, maxX - x),
        height: Math.max(1, maxY - y),
    };
};
const buildCropBoxes = (box, width, height) => {
    const fullArea = Math.max(1, width * height);
    const boxArea = box.width * box.height;
    if (boxArea / fullArea >= 0.94) {
        return [{ x: 0, y: 0, width, height }];
    }
    const minDim = Math.max(1, Math.min(box.width, box.height));
    const baseMargin = Math.min(96, Math.max(12, Math.round(minDim * 0.06)));
    const marginCandidates = [
        Math.round(baseMargin * 0.5),
        baseMargin,
        Math.round(baseMargin * 1.8),
    ];
    const seen = new Set();
    const boxes = [];
    for (const margin of marginCandidates) {
        const expanded = expandBoundingBox(box, width, height, margin);
        const key = `${expanded.x}:${expanded.y}:${expanded.width}:${expanded.height}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        boxes.push(expanded);
    }
    if (boxes.length === 0) {
        boxes.push({ x: 0, y: 0, width, height });
    }
    return boxes;
};
const extractCropCanvas = (image, box) => {
    const cropCanvas = createCanvas(box.width, box.height);
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) {
        throw new Error("キャンバスの初期化に失敗しました。");
    }
    cropCtx.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    return cropCanvas;
};
const canvasToPayload = (canvas, fallbackImageDataUrl) => {
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
    const payload = {
        data: floatData.buffer,
        width: canvas.width,
        height: canvas.height,
    };
    if (fallbackImageDataUrl) {
        payload.fallbackImageDataUrls = [fallbackImageDataUrl];
    }
    return payload;
};
const buildVariantCanvas = (source, variant) => {
    const work = copyCanvas(source);
    if (variant === "base") {
        enhanceForOcr(work);
    }
    else if (variant === "contrast") {
        enhanceCanvas(work, CONTRAST_FACTOR + 0.45, SHARPNESS_FACTOR + 0.25);
    }
    else if (variant === "binary") {
        enhanceCanvas(work, CONTRAST_FACTOR + 0.55, SHARPNESS_FACTOR + 0.35);
        binarizeCanvas(work);
    }
    else if (variant === "binary-soft") {
        enhanceCanvas(work, CONTRAST_FACTOR + 0.35, SHARPNESS_FACTOR + 0.2);
        binarizeCanvas(work, { thresholdOffset: 10 });
    }
    else {
        enhanceCanvas(work, CONTRAST_FACTOR + 0.55, SHARPNESS_FACTOR + 0.35);
        binarizeCanvas(work, { invert: true });
    }
    return fitCanvasWithPadding(work, TARGET_WIDTH, TARGET_HEIGHT, 255);
};
const preprocessImageVariants = async (dataUrl) => {
    const image = await loadImage(dataUrl);
    const imageData = getImageData(image);
    const { mask, width, height } = computeMaskData(imageData);
    const rawBox = computeBoundingBox(mask, width, height);
    const tightBox = trimBoundingBoxByProjection(mask, width, height, rawBox);
    const cropBoxes = buildCropBoxes(tightBox, width, height);
    const primaryVariants = [
        "base",
        "contrast",
        "binary",
    ];
    const secondaryVariants = ["base"];
    const payloads = [];
    for (let i = 0; i < cropBoxes.length; i += 1) {
        const cropCanvas = extractCropCanvas(image, cropBoxes[i]);
        const variants = i === 0 ? primaryVariants : secondaryVariants;
        for (const variant of variants) {
            const canvas = buildVariantCanvas(cropCanvas, variant);
            const includeFallback = variant === "contrast" ||
                variant === "binary" ||
                variant === "binary-soft" ||
                variant === "binary-invert";
            const fallbackImageDataUrl = includeFallback ? canvas.toDataURL("image/png") : undefined;
            payloads.push(canvasToPayload(canvas, fallbackImageDataUrl));
            if (payloads.length >= MAX_PREPROCESS_PAYLOADS) {
                return payloads;
            }
        }
    }
    if (payloads.length === 0) {
        const fallbackCanvas = fitCanvasWithPadding(extractCropCanvas(image, { x: 0, y: 0, width, height }), TARGET_WIDTH, TARGET_HEIGHT, 255);
        payloads.push(canvasToPayload(fallbackCanvas, fallbackCanvas.toDataURL("image/png")));
    }
    return payloads;
};
const countUnbalanced = (text, openChar, closeChar) => {
    let balance = 0;
    let penalty = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === openChar) {
            balance += 1;
        }
        else if (ch === closeChar) {
            if (balance > 0) {
                balance -= 1;
            }
            else {
                penalty += 1;
            }
        }
    }
    return penalty + balance;
};
const scoreLatexCandidate = (value) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const trimmed = value.trim();
    if (!trimmed) {
        return -1000;
    }
    let score = 100;
    if (trimmed.length < 2)
        score -= 40;
    if (trimmed.length > 260)
        score -= 80;
    if (((_a = trimmed.match(/[A-Za-z0-9]/g)) !== null && _a !== void 0 ? _a : []).length === 0)
        score -= 60;
    if (((_b = trimmed.match(/\\pi/g)) !== null && _b !== void 0 ? _b : []).length > 8)
        score -= 30;
    if (trimmed.includes("\\begin{array}"))
        score -= 10;
    if (trimmed.includes("<unk>") || trimmed.includes("�"))
        score -= 60;
    score -= countUnbalanced(trimmed, "{", "}") * 14;
    score -= countUnbalanced(trimmed, "(", ")") * 8;
    const leftCount = ((_c = trimmed.match(/\\left/g)) !== null && _c !== void 0 ? _c : []).length;
    const rightCount = ((_d = trimmed.match(/\\right/g)) !== null && _d !== void 0 ? _d : []).length;
    score -= Math.abs(leftCount - rightCount) * 10;
    if (/[\\](?:frac|sqrt|sum|int|lim|alpha|beta|gamma|theta|sin|cos|tan)\b/.test(trimmed)) {
        score += 8;
    }
    // Bonus for equation-like structure
    if (trimmed.includes("="))
        score += 3;
    if (trimmed.includes("^"))
        score += 2;
    if (trimmed.includes("_"))
        score += 2;
    // Penalty for degenerate output patterns
    if (/[+\-=]{3,}/.test(trimmed))
        score -= 15;
    // Repeated spacing commands
    const qquadCount = ((_e = trimmed.match(/\\qquad/g)) !== null && _e !== void 0 ? _e : []).length;
    if (qquadCount > 2)
        score -= qquadCount * 8;
    // Both-empty fraction
    if (/\\frac\{\s*\}\{\s*\}/.test(trimmed))
        score -= 30;
    // Penalty for very high ratio of backslashes to content (garbled commands)
    const backslashCount = ((_f = trimmed.match(/\\/g)) !== null && _f !== void 0 ? _f : []).length;
    const alphaCount = ((_g = trimmed.match(/[A-Za-z0-9]/g)) !== null && _g !== void 0 ? _g : []).length;
    if (alphaCount > 0 && backslashCount / alphaCount > 0.8)
        score -= 12;
    return score;
};
const recognizeMathInternal = async (imageDataUrl, onProgress) => {
    var _a;
    const bridgeWindow = window;
    const bridge = (_a = bridgeWindow.__tex64TestMathOcr) !== null && _a !== void 0 ? _a : bridgeWindow.tex64MathOcr;
    if (!(bridge === null || bridge === void 0 ? void 0 : bridge.run)) {
        throw new Error("数式OCRが利用できません。");
    }
    const pipelineStart = Date.now();
    const payloadVariants = await preprocessImageVariants(imageDataUrl);
    const totalSteps = payloadVariants.length;
    let bestLatex = "";
    let bestScore = -Infinity;
    let lastError = null;
    // Unified deadline from pipeline start (leave 2s buffer for post-processing)
    const deadline = pipelineStart + PIPELINE_TIMEOUT_MS - 2000;
    const tryPayload = async (payload, maxSeqLen, maxDecodeCandidates) => {
        try {
            const result = await bridge.run({
                ...payload,
                imageDataUrl,
                maxSeqLen,
                maxDecodeCandidates,
            });
            const latex = typeof (result === null || result === void 0 ? void 0 : result.latex) === "string" ? result.latex.trim() : "";
            if (!latex) {
                return false;
            }
            const score = scoreLatexCandidate(latex);
            if (score > bestScore) {
                bestLatex = latex;
                bestScore = score;
            }
            if (score >= CANDIDATE_EARLY_ACCEPT_SCORE) {
                return true;
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error("OCRに失敗しました。");
        }
        return false;
    };
    // Phase 1: fast path — first variant only, 1 decode candidate, short maxSeqLen
    if (payloadVariants.length > 0) {
        onProgress === null || onProgress === void 0 ? void 0 : onProgress(1, totalSteps);
        const accepted = await tryPayload(payloadVariants[0], PHASE1_MAX_SEQ_LEN, 1);
        if (accepted) {
            return bestLatex;
        }
    }
    // Phase 2: remaining variants with more decode candidates and longer maxSeqLen
    for (let i = 1; i < payloadVariants.length; i += 1) {
        if (Date.now() >= deadline) {
            break;
        }
        onProgress === null || onProgress === void 0 ? void 0 : onProgress(i + 1, totalSteps);
        const accepted = await tryPayload(payloadVariants[i], PHASE2_MAX_SEQ_LEN, 3);
        if (accepted) {
            return bestLatex;
        }
    }
    // If Phase 1 result was mediocre, also retry first variant with longer seq
    if (bestScore < CANDIDATE_EARLY_ACCEPT_SCORE && Date.now() < deadline) {
        await tryPayload(payloadVariants[0], PHASE2_MAX_SEQ_LEN, 3);
    }
    if (bestLatex) {
        return bestLatex;
    }
    if (lastError) {
        throw lastError;
    }
    throw new Error("OCR結果が空でした。");
};
export const recognizeMath = async (imageDataUrl, onProgress) => {
    return Promise.race([
        recognizeMathInternal(imageDataUrl, onProgress),
        new Promise((_, reject) => setTimeout(() => reject(new Error("OCRがタイムアウトしました。")), PIPELINE_TIMEOUT_MS)),
    ]);
};
