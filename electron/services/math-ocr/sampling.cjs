const { MAX_DECODE_CANDIDATES } = require("./constants.cjs");

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

const createRng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const sampleFromProbs = (probs, rng = Math.random) => {
  const target = rng();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i += 1) {
    cumulative += probs[i];
    if (target <= cumulative) {
      return i;
    }
  }
  return probs.length - 1;
};

const buildDecodeCandidates = (config) => {
  const candidates = [];
  const seen = new Set();
  const baseFilter = clamp(
    Number.isFinite(config.filterThres) ? config.filterThres : config.topP ?? 0.9,
    0,
    1
  );
  const baseTemp =
    Number.isFinite(config.temperature) && config.temperature > 0 ? config.temperature : 1;
  const baseStrategy = config.decodeStrategy || "greedy";
  const push = (strategy, filterThres, temperature, seedOffset) => {
    const key = `${strategy}:${filterThres.toFixed(4)}:${temperature.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ strategy, filterThres, temperature, seedOffset });
  };

  push(baseStrategy, baseFilter, baseTemp, 0);
  push("greedy", clamp(baseFilter, 0.82, 0.99), 1, 5);
  if (baseStrategy !== "greedy") {
    push("greedy", baseFilter, 1, 11);
  }
  push(
    "top_p",
    clamp(baseFilter + 0.04, 0.85, 0.995),
    clamp(baseTemp + 0.1, 0.75, 1.6),
    37
  );
  push(
    "top_p",
    clamp(baseFilter - 0.04, 0.78, 0.98),
    clamp(baseTemp - 0.1, 0.65, 1.25),
    53
  );
  push(
    "top_p",
    clamp(baseFilter + 0.07, 0.9, 0.998),
    clamp(baseTemp + 0.24, 0.9, 1.95),
    67
  );
  push(
    "top_k",
    clamp(baseFilter + 0.03, 0.88, 0.995),
    clamp(baseTemp + 0.2, 0.8, 1.8),
    71
  );
  push(
    "top_k",
    clamp(baseFilter - 0.03, 0.8, 0.98),
    clamp(baseTemp + 0.04, 0.72, 1.4),
    89
  );
  return candidates.slice(0, MAX_DECODE_CANDIDATES);
};

module.exports = {
  clamp,
  softmax,
  filterTopK,
  filterTopP,
  createRng,
  sampleFromProbs,
  buildDecodeCandidates,
};

