const path = require("path");
const fsp = require("fs/promises");

const DEFAULT_CONFIG = {
  encoder: "encoder.onnx",
  decoder: "decoder.onnx",
  tokenizer: "tokenizer.json",
  encoderInput: "image",
  encoderOutput: "context",
  decoderInputTokens: "tokens",
  decoderInputContext: "context",
  decoderOutput: "logits",
  bosToken: 1,
  eosToken: 2,
  padToken: 0,
  maxSeqLen: 512,
  decodeStrategy: "top_k",
  filterThres: 0.9,
  topP: 0.9,
  temperature: 0.2,
  maxWidth: 672,
  maxHeight: 192,
  minWidth: 32,
  minHeight: 32,
};

const buildIdToToken = (tokenizer) => {
  const vocab = tokenizer?.model?.vocab ?? tokenizer?.vocab ?? {};
  const idToToken = [];
  Object.entries(vocab).forEach(([token, id]) => {
    const index = Number(id);
    if (!Number.isNaN(index)) {
      idToToken[index] = token;
    }
  });
  return idToToken;
};

const decodeTokens = (tokens, idToToken) => {
  const text = tokens.map((id) => idToToken[id] ?? "").join("");
  return text
    .replace(/\[PAD\]|\[BOS\]|\[EOS\]/g, "")
    .replace(/Ġ/g, " ")
    .trim();
};

const postProcessLatex = (value) => {
  if (!value) return "";
  const textReg = /(\\(?:operatorname|mathrm|text|mathbf)\s?\*? {.*?})/g;
  const matches = Array.from(value.matchAll(textReg)).map((match) =>
    match[1].replace(/ /g, "")
  );
  let result = value.replace(textReg, () => matches.shift() ?? "");
  const letter = "[a-zA-Z]";
  const noletter = "[\\W_\\^\\d]";
  while (true) {
    const prev = result;
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${letter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(${letter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    if (result === prev) {
      break;
    }
  }
  return result;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const softmax = (values) => {
  let max = -Infinity;
  values.forEach((value) => {
    if (value > max) max = value;
  });
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
};

const buildEntries = (logits) => {
  const entries = new Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) {
    entries[i] = { value: logits[i], index: i };
  }
  entries.sort((a, b) => b.value - a.value);
  return entries;
};

const filterTopK = (logits, thres) => {
  const entries = buildEntries(logits);
  const k = Math.max(1, Math.floor((1 - thres) * logits.length));
  const filtered = new Array(logits.length).fill(-Infinity);
  for (let i = 0; i < Math.min(k, entries.length); i += 1) {
    filtered[entries[i].index] = entries[i].value;
  }
  return filtered;
};

const filterTopP = (logits, thres) => {
  const entries = buildEntries(logits);
  const probs = softmax(entries.map((entry) => entry.value));
  const remove = new Array(entries.length).fill(false);
  const cutoff = 1 - thres;
  let cumulative = 0;
  for (let i = 0; i < entries.length; i += 1) {
    cumulative += probs[i];
    if (cumulative > cutoff) {
      remove[i] = true;
    }
  }
  for (let i = remove.length - 1; i >= 1; i -= 1) {
    remove[i] = remove[i - 1];
  }
  remove[0] = false;
  const filtered = new Array(logits.length).fill(-Infinity);
  for (let i = 0; i < entries.length; i += 1) {
    if (!remove[i]) {
      filtered[entries[i].index] = entries[i].value;
    }
  }
  return filtered;
};

const sampleFromProbs = (probs) => {
  const target = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i += 1) {
    cumulative += probs[i];
    if (target <= cumulative) {
      return i;
    }
  }
  return probs.length - 1;
};

class MathOcrService {
  constructor({ appPath }) {
    this.basePath = path.join(appPath, "Resources", "math-ocr");
    this.config = null;
    this.idToToken = [];
    this.encoderSession = null;
    this.decoderSession = null;
    this.ort = null;
    this.loading = null;
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
      const configPath = path.join(this.basePath, "config.json");
      const rawConfig = await fsp.readFile(configPath, "utf8").catch(() => null);
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
    })();
    await this.loading;
  }

  async recognize(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Math OCR payload is missing.");
    }
    const { data, width, height } = payload;
    if (!data || !width || !height) {
      throw new Error("Math OCR payload is invalid.");
    }
    await this.ensureLoaded();
    const config = this.config ?? DEFAULT_CONFIG;
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

    const imageTensor = new this.ort.Tensor(
      "float32",
      floatData,
      [1, 1, height, width]
    );
    const encoderFeeds = {
      [config.encoderInput]: imageTensor,
    };
    const encoderOutputs = await this.encoderSession.run(encoderFeeds);
    const context = encoderOutputs[config.encoderOutput];
    if (!context) {
      throw new Error("Math OCR encoder output is missing.");
    }

    const bosToken = config.bosToken;
    const eosToken = config.eosToken;
    const maxSeqLen = config.maxSeqLen;
    const tokens = [bosToken];

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
      const strategy = config.decodeStrategy || "greedy";
      const filterThres = clamp(
        Number.isFinite(config.filterThres) ? config.filterThres : config.topP ?? 0.9,
        0,
        1
      );
      const temperature =
        Number.isFinite(config.temperature) && config.temperature > 0
          ? config.temperature
          : 1;
      if (strategy === "top_k" || strategy === "top_p") {
        const slice = Array.from(logits.slice(offset, offset + vocabSize));
        const filtered =
          strategy === "top_k"
            ? filterTopK(slice, filterThres)
            : filterTopP(slice, filterThres);
        const scaled = filtered.map((value) => value / temperature);
        const probs = softmax(scaled);
        nextToken = sampleFromProbs(probs);
      } else {
        let maxValue = -Infinity;
        for (let i = 0; i < vocabSize; i += 1) {
          const value = logits[offset + i];
          if (value > maxValue) {
            maxValue = value;
            nextToken = i;
          }
        }
      }

      tokens.push(nextToken);
      if (nextToken === eosToken) {
        break;
      }
    }

    const decoded = decodeTokens(tokens, this.idToToken);
    const cleaned = postProcessLatex(decoded);
    return { latex: cleaned };
  }
}

module.exports = {
  MathOcrService,
};
