const path = require("path");
const fsp = require("fs/promises");

const {
  DEFAULT_CONFIG,
  FALLBACK_MIN_CONFIDENCE,
  PIX2TEX_EARLY_ACCEPT_SCORE,
  FALLBACK_EARLY_ACCEPT_CONFIDENCE,
} = require("./constants.cjs");
const { buildIdToToken, decodeTokens } = require("./tokenizer.cjs");
const { normalizeDecodedLatex, normalizeFallbackText } = require("./latex-normalize.cjs");
const {
  isSimpleFormula,
  looksLikeGarbage,
  isLikelyInvalidLatex,
  scoreLatexCandidate,
  normalizeFallbackImageCandidates,
  scoreFallbackCandidate,
  decodeImageDataUrl,
} = require("./scoring.cjs");
const {
  clamp,
  softmax,
  filterTopK,
  filterTopP,
  createRng,
  sampleFromProbs,
  buildDecodeCandidates,
} = require("./sampling.cjs");

class MathOcrService {
  constructor({ appPath, userDataPath, isPackaged, resourcesPath }) {
    this.appPath = appPath;
    this.userDataPath = userDataPath;
    this.isPackaged = isPackaged === true;
    this.resourcesPath = typeof resourcesPath === "string" ? resourcesPath : "";
    this.basePathCandidates = [];
    if (this.isPackaged && this.resourcesPath) {
      this.basePathCandidates.push(
        path.join(this.resourcesPath, "app.asar.unpacked", "Resources", "math-ocr")
      );
    }
    this.basePathCandidates.push(path.join(appPath, "Resources", "math-ocr"));
    this.basePath = this.basePathCandidates[0];
    this.config = null;
    this.idToToken = [];
    this.encoderSession = null;
    this.decoderSession = null;
    this.ort = null;
    this.loading = null;
    this.tesseractWorker = null;
    this.tesseractLoading = null;
  }

  async ensureLoaded() {
    if (this.encoderSession && this.decoderSession) {
      return;
    }
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      let rawConfig = null;
      for (const candidateBasePath of this.basePathCandidates) {
        const configPath = path.join(candidateBasePath, "config.json");
        rawConfig = await fsp.readFile(configPath, "utf8").catch(() => null);
        if (rawConfig) {
          this.basePath = candidateBasePath;
          break;
        }
      }
      if (!rawConfig) {
        throw new Error(
          "Math OCR model is not installed. See Resources/math-ocr/README.md."
        );
      }
      const parsed = JSON.parse(rawConfig);
      this.config = { ...DEFAULT_CONFIG, ...parsed };
      this.ort = require("onnxruntime-node");

      const tokenizerPath = path.join(this.basePath, this.config.tokenizer);
      const tokenizer = JSON.parse(await fsp.readFile(tokenizerPath, "utf8"));
      this.idToToken = buildIdToToken(tokenizer);

      const encoderPath = path.join(this.basePath, this.config.encoder);
      const decoderPath = path.join(this.basePath, this.config.decoder);
      this.encoderSession = await this.ort.InferenceSession.create(encoderPath, {
        executionProviders: ["cpu"],
      });
      this.decoderSession = await this.ort.InferenceSession.create(decoderPath, {
        executionProviders: ["cpu"],
      });
      const decoderOutput = this.decoderSession.outputMetadata?.find(
        (meta) => meta?.name === this.config.decoderOutput
      );
      if (decoderOutput?.shape && decoderOutput.shape.length < 2) {
        throw new Error(
          "Math OCR decoder.onnx is incompatible (training wrapper export detected). Re-export with scripts/pix2tex/export-onnx.py."
        );
      }
    })();
    await this.loading;
  }

  async ensureTesseractWorker() {
    if (this.tesseractWorker) {
      return this.tesseractWorker;
    }
    if (this.tesseractLoading) {
      await this.tesseractLoading;
      return this.tesseractWorker;
    }
    this.tesseractLoading = (async () => {
      const { createWorker } = require("tesseract.js");
      const langPath = path.join(
        this.appPath,
        "Resources",
        "web",
        "tesseract",
        "tessdata"
      );
      const worker = await createWorker("eng", undefined, {
        langPath,
        gzip: true,
        errorHandler: () => {},
        logger: () => {},
      });
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=+-*/()^_{}",
        tessedit_pageseg_mode: "7",
      });
      this.tesseractWorker = worker;
    })();
    await this.tesseractLoading;
    this.tesseractLoading = null;
    return this.tesseractWorker;
  }

  async recognizeFallback(imageDataUrl) {
    if (!imageDataUrl) {
      return { text: "", confidence: null };
    }
    const worker = await this.ensureTesseractWorker();
    if (!worker) {
      return { text: "", confidence: null };
    }
    const decoded = decodeImageDataUrl(imageDataUrl);
    const imageInput = decoded ?? imageDataUrl;
    const result = await worker.recognize(imageInput);
    const text = normalizeFallbackText(result?.data?.text ?? "");
    const confidence =
      typeof result?.data?.confidence === "number" ? result.data.confidence : null;
    return { text, confidence };
  }

  async runEncoder(floatData, width, height, config) {
    const channels = Number.isFinite(config.channels) ? config.channels : 1;
    const imageTensor = new this.ort.Tensor(
      "float32",
      floatData,
      [1, channels, height, width]
    );
    const encoderFeeds = {
      [config.encoderInput]: imageTensor,
    };
    const encoderOutputs = await this.encoderSession.run(encoderFeeds);
    const context = encoderOutputs[config.encoderOutput];
    if (!context) {
      throw new Error("Math OCR encoder output is missing.");
    }
    return context;
  }

  async decodeWithContext(context, config, width, height, decodeCandidate) {
    const bosToken = config.bosToken;
    const decoderStartToken = Number.isFinite(config.decoderStartToken)
      ? config.decoderStartToken
      : bosToken;
    const eosToken = config.eosToken;
    const maxSeqLen = config.maxSeqLen;
    const minTokens = Math.max(5, Math.round(width / 90));
    const seedOffset = Number.isFinite(decodeCandidate?.seedOffset)
      ? decodeCandidate.seedOffset
      : 0;
    const rng = createRng((width * 1000 + height + seedOffset) >>> 0);
    const strategy = decodeCandidate?.strategy || config.decodeStrategy || "greedy";
    const filterThres = clamp(
      Number.isFinite(decodeCandidate?.filterThres)
        ? decodeCandidate.filterThres
        : Number.isFinite(config.filterThres)
          ? config.filterThres
          : config.topP ?? 0.9,
      0,
      1
    );
    const temperature =
      Number.isFinite(decodeCandidate?.temperature) && decodeCandidate.temperature > 0
        ? decodeCandidate.temperature
        : Number.isFinite(config.temperature) && config.temperature > 0
          ? config.temperature
          : 1;

    const tokens = [decoderStartToken];
    for (let step = 0; step < maxSeqLen; step += 1) {
      const trimmed = tokens.slice(-maxSeqLen);
      const tokenTensor = new this.ort.Tensor(
        "int64",
        BigInt64Array.from(trimmed.map((value) => BigInt(value))),
        [1, trimmed.length]
      );
      const decoderFeeds = {
        [config.decoderInputTokens]: tokenTensor,
        [config.decoderInputContext]: context,
      };
      const decoderOutputs = await this.decoderSession.run(decoderFeeds);
      const logitsTensor = decoderOutputs[config.decoderOutput];
      if (!logitsTensor?.data) {
        throw new Error("Math OCR decoder output is missing.");
      }
      const logits = logitsTensor.data;
      const vocabSize = logits.length / trimmed.length;
      const offset = (trimmed.length - 1) * vocabSize;
      let nextToken = 0;

      if (strategy === "top_k" || strategy === "top_p") {
        const slice = Array.from(logits.slice(offset, offset + vocabSize));
        const filtered =
          strategy === "top_k"
            ? filterTopK(slice, filterThres)
            : filterTopP(slice, filterThres);
        const scaled = filtered.map((value) => value / temperature);
        const probs = softmax(scaled);
        nextToken = sampleFromProbs(probs, rng);
      } else {
        let maxValue = -Infinity;
        let secondValue = -Infinity;
        let maxIndex = 0;
        let secondIndex = 0;
        for (let i = 0; i < vocabSize; i += 1) {
          const value = logits[offset + i];
          if (value > maxValue) {
            secondValue = maxValue;
            secondIndex = maxIndex;
            maxValue = value;
            maxIndex = i;
          } else if (value > secondValue) {
            secondValue = value;
            secondIndex = i;
          }
        }
        nextToken = maxIndex;
        if (nextToken === eosToken && tokens.length < minTokens && secondIndex !== eosToken) {
          nextToken = secondIndex;
        }
      }

      tokens.push(nextToken);
      if (nextToken === eosToken) {
        break;
      }
    }

    const decoded = decodeTokens(tokens, this.idToToken);
    return normalizeDecodedLatex(decoded);
  }

  async recognize(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Math OCR payload is missing.");
    }
    const { data, width, height, imageDataUrl, fallbackImageDataUrls } = payload;
    if (!data || !width || !height) {
      throw new Error("Math OCR payload is invalid.");
    }
    const floatData = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : data instanceof Float32Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
          : null;
    if (!floatData) {
      throw new Error("Math OCR input buffer is invalid.");
    }

    let config = DEFAULT_CONFIG;
    let latex = "";
    let pix2texError = null;

    try {
      await this.ensureLoaded();
      config = this.config ?? DEFAULT_CONFIG;
    } catch (error) {
      pix2texError =
        error instanceof Error ? error : new Error("Math OCR model initialization failed.");
    }

    if (!pix2texError) {
      try {
        const context = await this.runEncoder(floatData, width, height, config);
        const decodeCandidates = buildDecodeCandidates(config);
        let bestCandidate = { latex: "", score: -Infinity, invalid: true };
        let firstDecodeError = null;
        const seenDecoded = new Set();

        for (const candidate of decodeCandidates) {
          try {
            const decodedLatex = await this.decodeWithContext(
              context,
              config,
              width,
              height,
              candidate
            );
            const normalizedLatex = normalizeDecodedLatex(
              typeof decodedLatex === "string" ? decodedLatex : ""
            );
            const trimmed = normalizedLatex.trim();
            if (!trimmed || seenDecoded.has(trimmed)) {
              continue;
            }
            seenDecoded.add(trimmed);
            const score = scoreLatexCandidate(trimmed);
            const invalid = isLikelyInvalidLatex(trimmed);
            if (
              score > bestCandidate.score ||
              (score === bestCandidate.score && bestCandidate.invalid && !invalid)
            ) {
              bestCandidate = { latex: trimmed, score, invalid };
            }
            if (!invalid && score >= PIX2TEX_EARLY_ACCEPT_SCORE) {
              break;
            }
          } catch (error) {
            if (!firstDecodeError) {
              firstDecodeError =
                error instanceof Error ? error : new Error("Math OCR decode failed.");
            }
          }
        }

        latex = bestCandidate.latex;
        if (!latex && firstDecodeError) {
          throw firstDecodeError;
        }
      } catch (error) {
        pix2texError = error instanceof Error ? error : new Error("Math OCR failed.");
      }
    }

    const fallbackImageCandidates = normalizeFallbackImageCandidates(
      imageDataUrl,
      fallbackImageDataUrls
    );
    const shouldTryFallback =
      fallbackImageCandidates.length > 0 &&
      (pix2texError || !latex || looksLikeGarbage(latex) || isLikelyInvalidLatex(latex));

    if (shouldTryFallback) {
      let bestFallback = { text: "", confidence: null, score: -Infinity };
      for (const candidateImage of fallbackImageCandidates) {
        const fallback = await this.recognizeFallback(candidateImage).catch(() => ({
          text: "",
          confidence: null,
        }));
        const fallbackText = fallback.text;
        if (!fallbackText) {
          continue;
        }
        const fallbackConfidence = fallback.confidence;
        const fallbackScore = scoreFallbackCandidate(fallbackText, fallbackConfidence);
        if (fallbackScore > bestFallback.score) {
          bestFallback = {
            text: fallbackText,
            confidence: fallbackConfidence,
            score: fallbackScore,
          };
        }
        if (
          isSimpleFormula(fallbackText) &&
          typeof fallbackConfidence === "number" &&
          fallbackConfidence >= FALLBACK_EARLY_ACCEPT_CONFIDENCE
        ) {
          break;
        }
      }
      const fallbackText = bestFallback.text;
      const fallbackConfidence = bestFallback.confidence;
      const confidentEnough =
        typeof fallbackConfidence === "number" &&
        fallbackConfidence >= FALLBACK_MIN_CONFIDENCE;
      const fallbackAddsScript =
        (fallbackText.includes("^") && !latex.includes("^")) ||
        (fallbackText.includes("_") && !latex.includes("_"));
      const shouldPreferFallback =
        !latex ||
        pix2texError ||
        looksLikeGarbage(latex) ||
        isLikelyInvalidLatex(latex) ||
        (fallbackAddsScript && fallbackText.length >= latex.length);
      if (
        fallbackText &&
        confidentEnough &&
        isSimpleFormula(fallbackText) &&
        shouldPreferFallback
      ) {
        return { latex: fallbackText };
      }
    }

    if (pix2texError && !latex) {
      throw pix2texError;
    }
    if (!latex) {
      throw new Error("Math OCR result was empty.");
    }
    return { latex };
  }
}

module.exports = {
  MathOcrService,
};
