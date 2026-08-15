import fsp from "node:fs/promises";
import path from "node:path";

const GLOBAL_STATE_KEY = "__TEX64_PLATFORM_V2_STATE__";

const clone = (value) => JSON.parse(JSON.stringify(value));

const DEFAULT_STATE = Object.freeze({
  version: 1,
  users: {},
  usersByEmail: {},
  subscriptions: {},
  usage: {},
  authRequests: {},
  refreshTokens: {},
  processedSubscriptionEvents: {},
  subscriptionEventOrders: {},
});

const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeState = (value) => {
  const source = toObject(value);
  return {
    version: 1,
    users: toObject(source.users),
    usersByEmail: toObject(source.usersByEmail),
    subscriptions: toObject(source.subscriptions),
    usage: toObject(source.usage),
    authRequests: toObject(source.authRequests),
    refreshTokens: toObject(source.refreshTokens),
    processedSubscriptionEvents: toObject(source.processedSubscriptionEvents),
    subscriptionEventOrders: toObject(source.subscriptionEventOrders),
  };
};

const ensureGlobalMemoryState = () => {
  if (!globalThis[GLOBAL_STATE_KEY]) {
    globalThis[GLOBAL_STATE_KEY] = clone(DEFAULT_STATE);
  }
  return globalThis[GLOBAL_STATE_KEY];
};

const readStateFile = async (filePath) => {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return clone(DEFAULT_STATE);
    }
    return normalizeState(JSON.parse(raw));
  } catch {
    return clone(DEFAULT_STATE);
  }
};

const writeStateFile = async (filePath, state) => {
  const directoryPath = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fsp.mkdir(directoryPath, { recursive: true });
  await fsp.writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
  await fsp.chmod(filePath, 0o600).catch(() => {});
};

export const loadPlatformState = async (config) => {
  const memoryState = ensureGlobalMemoryState();
  if (typeof config?.stateFilePath !== "string" || !config.stateFilePath.trim()) {
    return clone(memoryState);
  }
  const fileState = await readStateFile(config.stateFilePath.trim());
  globalThis[GLOBAL_STATE_KEY] = clone(fileState);
  return clone(fileState);
};

export const savePlatformState = async (config, state) => {
  const normalized = normalizeState(state);
  globalThis[GLOBAL_STATE_KEY] = clone(normalized);
  if (typeof config?.stateFilePath !== "string" || !config.stateFilePath.trim()) {
    return;
  }
  await writeStateFile(config.stateFilePath.trim(), normalized);
};
