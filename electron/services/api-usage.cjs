const path = require("path");
const fsp = require("fs/promises");
const lockfile = require("proper-lockfile");
const { atomicWrite } = require("./history-files.cjs");

const DEFAULT_STATE = {
  currency: "USD",
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalRequests: 0,
  totalCostUsd: 0,
  lastUpdatedAt: null,
  byModel: {},
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const parseNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const formatUsd = (value) => {
  const amount = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
};

class ApiUsageService {
  constructor({ userDataPath, getPricing }) {
    this.filePath = path.join(userDataPath, "tex64-api-usage.json");
    this.pending = Promise.resolve();
    this.getPricing = typeof getPricing === "function" ? getPricing : async () => null;
  }

  async load() {
    // Always from disk: another TeX64 process adds to the same totals.
    let stored;
    try {
      stored = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return clone(DEFAULT_STATE);
      throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
        (stored.byModel !== undefined && (!stored.byModel || typeof stored.byModel !== "object" || Array.isArray(stored.byModel)))) {
      throw new Error("Invalid local API usage history.");
    }
    return { ...clone(DEFAULT_STATE), ...stored };
  }

  update(transform) {
    const operation = this.pending.then(async () => {
      const pricing = await this.resolvePricing();
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const release = await lockfile.lock(this.filePath, {
        realpath: false,
        stale: 5000,
        retries: { retries: 30, minTimeout: 20, maxTimeout: 250, randomize: true },
      });
      try {
        const state = await transform(pricing);
        await atomicWrite(this.filePath, JSON.stringify(state, null, 2));
        return this.snapshot(state, pricing);
      } finally {
        await release();
      }
    });
    // Do not keep the last model ledger alive through a settled Promise.
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  whenIdle() {
    return this.pending;
  }

  async resolvePricing() {
    const settings = (await this.getPricing()) || {};
    const envInput = parseNumber(process.env.TEX64_LLM_INPUT_USD_PER_MILLION);
    const envOutput = parseNumber(process.env.TEX64_LLM_OUTPUT_USD_PER_MILLION);
    const inputPerMillion =
      envInput ??
      parseNumber(settings.costInputPerMillion) ??
      0;
    const outputPerMillion =
      envOutput ??
      parseNumber(settings.costOutputPerMillion) ??
      0;
    return {
      currency: "USD",
      inputPerMillion,
      outputPerMillion,
    };
  }

  async recordUsage({ model, promptTokens, outputTokens, totalTokens, source }) {
    return this.update(async (pricing) => {
      const state = await this.load();
      const inputTokens = Number.isFinite(promptTokens) ? promptTokens : 0;
      const outTokens = Number.isFinite(outputTokens) ? outputTokens : 0;
      const total =
        Number.isFinite(totalTokens) ? totalTokens : inputTokens + outTokens;
      const inputCost =
        (inputTokens / 1_000_000) * (pricing.inputPerMillion || 0);
      const outputCost =
        (outTokens / 1_000_000) * (pricing.outputPerMillion || 0);
      const cost = inputCost + outputCost;

      state.totalInputTokens += inputTokens;
      state.totalOutputTokens += outTokens;
      state.totalTokens += total;
      state.totalRequests += 1;
      state.totalCostUsd += cost;
      state.currency = pricing.currency || "USD";
      state.lastUpdatedAt = Date.now();

      const modelKey = model || "unknown";
      const modelEntry = state.byModel[modelKey] || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalRequests: 0,
        lastSource: null,
      };
      modelEntry.inputTokens += inputTokens;
      modelEntry.outputTokens += outTokens;
      modelEntry.totalTokens += total;
      modelEntry.totalCostUsd += cost;
      modelEntry.totalRequests += 1;
      modelEntry.lastSource = source || modelEntry.lastSource;
      state.byModel[modelKey] = modelEntry;

      return state;
    });
  }

  async getSnapshot() {
    await this.pending;
    const [state, pricing] = await Promise.all([this.load(), this.resolvePricing()]);
    return this.snapshot(state, pricing);
  }

  snapshot(state, pricing) {
    return {
      ...state,
      pricing,
      formattedTotalCostUsd: formatUsd(state.totalCostUsd),
    };
  }

  async reset() {
    return this.update(() => clone(DEFAULT_STATE));
  }
}

module.exports = { ApiUsageService };
