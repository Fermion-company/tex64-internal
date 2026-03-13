const path = require("path");
const fsp = require("fs/promises");

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
    this.state = null;
    this.getPricing = typeof getPricing === "function" ? getPricing : async () => null;
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    const stored = await fsp
      .readFile(this.filePath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(() => null);
    this.state = {
      ...clone(DEFAULT_STATE),
      ...(stored && typeof stored === "object" ? stored : {}),
    };
    return clone(this.state);
  }

  async save() {
    if (!this.state) {
      return;
    }
    const payload = JSON.stringify(this.state, null, 2);
    await fsp.writeFile(this.filePath, payload, "utf8");
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
    const state = await this.load();
    const pricing = await this.resolvePricing();
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

    this.state = state;
    await this.save();
    return this.getSnapshot();
  }

  async getSnapshot() {
    const state = await this.load();
    const pricing = await this.resolvePricing();
    return {
      ...clone(state),
      pricing,
      formattedTotalCostUsd: formatUsd(state.totalCostUsd),
    };
  }

  async reset() {
    this.state = clone(DEFAULT_STATE);
    await this.save();
    return this.getSnapshot();
  }
}

module.exports = { ApiUsageService };
