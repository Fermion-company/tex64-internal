const path = require("node:path");
const fsp = require("node:fs/promises");
const lockfile = require("proper-lockfile");
const { atomicWrite } = require("./history-files.cjs");

class BlocksStore {
  constructor() {
    this.pending = new Map();
  }

  async load(rootPath) {
    const file = path.join(rootPath, ".tex64", "blocks.json");
    let content;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const blocks = JSON.parse(content);
      if (Array.isArray(blocks)) return blocks;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw Object.assign(new Error("Invalid formula insertion history."), { code: "BLOCK_HISTORY_INVALID" });
  }

  append(rootPath, entry) {
    // Keep insertion order within a window, even when another window holds the lock.
    const previous = this.pending.get(rootPath) ?? Promise.resolve();
    const append = previous.catch(() => {}).then(() => this.appendLocked(rootPath, entry));
    this.pending.set(rootPath, append);
    return append.finally(() => {
      if (this.pending.get(rootPath) === append) this.pending.delete(rootPath);
    });
  }

  async appendLocked(rootPath, entry) {
    const directory = path.join(rootPath, ".tex64");
    const file = path.join(directory, "blocks.json");
    await fsp.mkdir(directory, { recursive: true });
    const release = await lockfile.lock(file, {
      realpath: false,
      stale: 5000,
      retries: { retries: 30, minTimeout: 20, maxTimeout: 250, randomize: true },
    });
    try {
      const blocks = await this.load(rootPath);
      blocks.push(entry);
      await atomicWrite(file, JSON.stringify(blocks, null, 2));
    } finally {
      await release();
    }
  }

  async whenIdle() {
    await Promise.allSettled(this.pending.values());
  }
}

module.exports = { BlocksStore };
