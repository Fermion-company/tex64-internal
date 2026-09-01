const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DIR_NAME = "tex64-agent-sessions";
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_SESSION_BYTES = 8 * 1024 * 1024;

const normalizeInteger = (value, fallback) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
};

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(String(value ?? "")).digest("hex");

const ensureDirSync = (dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
};

const isJsonFile = (name) => typeof name === "string" && name.toLowerCase().endsWith(".json");

class AgentSessionsService {
  constructor({
    userDataPath,
    dirName = DEFAULT_DIR_NAME,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxSessionBytes = DEFAULT_MAX_SESSION_BYTES,
  } = {}) {
    this.dirPath = path.join(userDataPath || ".", dirName);
    this.maxSessions = Math.max(
      1,
      Math.min(100, normalizeInteger(maxSessions, DEFAULT_MAX_SESSIONS))
    );
    this.maxSessionBytes = Math.max(
      128 * 1024,
      normalizeInteger(maxSessionBytes, DEFAULT_MAX_SESSION_BYTES)
    );
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    this.queue = this.queue.then(task).catch(() => {});
    return this.queue;
  }

  resolveSessionPath(conversationId) {
    const normalized = typeof conversationId === "string" ? conversationId.trim() : "";
    const digest = sha256Hex(normalized || "default");
    return path.join(this.dirPath, `${digest.slice(0, 40)}.json`);
  }

  async writeJsonAtomic(targetPath, json) {
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, json, "utf8");
    try {
      await fsp.rename(tmpPath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "ENOTEMPTY") {
        await fsp.unlink(targetPath).catch(() => {});
        await fsp.rename(tmpPath, targetPath);
        return;
      }
      await fsp.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  async pruneIfNeeded() {
    let entries;
    try {
      entries = await fsp.readdir(this.dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries
      .filter((entry) => entry.isFile() && isJsonFile(entry.name))
      .map((entry) => path.join(this.dirPath, entry.name));
    if (files.length <= this.maxSessions) {
      return;
    }
    const stats = await Promise.all(
      files.map(async (file) => ({ file, stat: await fsp.stat(file).catch(() => null) }))
    );
    const sorted = stats
      .filter((entry) => entry.stat && entry.stat.isFile())
      .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
    const toDelete = sorted.slice(this.maxSessions).map((entry) => entry.file);
    await Promise.all(toDelete.map((file) => fsp.unlink(file).catch(() => {})));
  }

  saveSession(session) {
    if (!session || typeof session !== "object") {
      return Promise.resolve();
    }
    const conversationId =
      typeof session.conversationId === "string" && session.conversationId.trim()
        ? session.conversationId.trim()
        : "";
    if (!conversationId) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      ensureDirSync(this.dirPath);
      let json;
      try {
        json = JSON.stringify(session);
      } catch {
        return;
      }
      if (Buffer.byteLength(json, "utf8") > this.maxSessionBytes) {
        return;
      }
      const filePath = this.resolveSessionPath(conversationId);
      await this.writeJsonAtomic(filePath, `${json}\n`).catch(() => {});
      await this.pruneIfNeeded();
    });
  }

  deleteSession(conversationId) {
    const normalized =
      typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : "";
    if (!normalized) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const filePath = this.resolveSessionPath(normalized);
      await fsp.unlink(filePath).catch(() => {});
    });
  }

  loadSessions() {
    return this.enqueue(async () => {
      let entries;
      try {
        entries = await fsp.readdir(this.dirPath, { withFileTypes: true });
      } catch {
        return [];
      }
      const files = entries
        .filter((entry) => entry.isFile() && isJsonFile(entry.name))
        .map((entry) => path.join(this.dirPath, entry.name));
      const sessions = [];
      for (const file of files) {
        const parsed = await fsp
          .readFile(file, "utf8")
          .then((content) => JSON.parse(content))
          .catch(() => null);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        const conversationId =
          typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
        if (!conversationId) {
          continue;
        }
        sessions.push(parsed);
      }
      sessions.sort((a, b) => {
        const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
        const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
        return aUpdated - bUpdated;
      });
      return sessions;
    });
  }
}

module.exports = {
  AgentSessionsService,
  DEFAULT_DIR_NAME,
};

