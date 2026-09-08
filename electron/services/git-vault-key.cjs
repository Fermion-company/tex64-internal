"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const unavailable = () => Object.assign(new Error("Gitの退避データを保護できません。キーチェーンを利用できる状態で再試行してください。"), { code: "GIT_PROTECTION_UNAVAILABLE" });

// safeStorage wraps the random vault key with the operating system's secret
// store. The key is never placed in the project, IPC, logs or Git arguments.
async function getGitVaultKey({ directory, safeStorage }) {
  if (!safeStorage?.isEncryptionAvailable?.()) throw unavailable();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "key.enc");
  const read = async () => {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw unavailable();
    try {
      const value = safeStorage.decryptString(await fs.readFile(target));
      if (!/^[a-f0-9]{64}$/.test(value)) throw unavailable();
      return Buffer.from(value, "hex");
    } catch { throw unavailable(); }
  };
  try { return await read(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = crypto.randomBytes(32);
  let encrypted;
  try { encrypted = safeStorage.encryptString(key.toString("hex")); } catch { key.fill(0); throw unavailable(); }
  const temporary = path.join(directory, `.key-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
    // Do not overwrite a concurrently published key; every vault must keep
    // using the first durable key, including after another process starts.
    try { await fs.link(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const parent = await fs.open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return await read();
  } finally {
    key.fill(0);
    await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { getGitVaultKey };
