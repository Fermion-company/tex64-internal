"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Separate from prunable UI history: a pending remote stop must survive a chat
// deletion, app crash and the UI's twenty-conversation retention limit.
class AgentsSessionStore {
  constructor(dirPath) {
    if (!dirPath) throw new Error("Managed sessions require a persistent data directory.");
    this.dirPath = dirPath;
  }

  key(workspace, conversationId) { return digest(JSON.stringify([workspace, conversationId])); }

  async acquire(key) {
    await fs.mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dirPath, `${key}.lock`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
        return async () => {
          const owner = JSON.parse(await fs.readFile(lock, "utf8").catch(() => "{}"));
          if (owner.token === token) await fs.unlink(lock);
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = JSON.parse(await fs.readFile(lock, "utf8"));
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw new Error("This managed conversation is already open in another active turn.");
        await fs.unlink(lock);
      }
    }
    throw new Error("Unable to acquire the managed conversation.");
  }

  async read(key) {
    try { return JSON.parse(await fs.readFile(path.join(this.dirPath, `${key}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async write(key, record) {
    await fs.mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    const target = path.join(this.dirPath, `${key}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async list() {
    let names;
    try { names = await fs.readdir(this.dirPath); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => ({ key: name.slice(0, -5), record: await this.read(name.slice(0, -5)) })));
  }
}

module.exports = { AgentsSessionStore, digest };
