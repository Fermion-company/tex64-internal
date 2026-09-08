"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { getGitVaultKey } = require("../electron/services/git-vault-key.cjs");

test("vault keys remain stable across concurrent creation and reopen, without plaintext fallback", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-vault-key-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const wrapping = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", wrapping, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: bytes => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", wrapping, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const keys = await Promise.all(Array.from({ length: 4 }, () => getGitVaultKey({ directory, safeStorage })));
  assert.equal(keys[0].length, 32);
  for (const key of keys) assert.deepEqual(key, keys[0]);
  assert.deepEqual(await getGitVaultKey({ directory, safeStorage }), keys[0]);
  const encrypted = await fs.readFile(path.join(directory, "key.enc"));
  assert.equal(encrypted.includes(keys[0]), false);
  assert.equal(encrypted.includes(keys[0].toString("hex")), false);
  await assert.rejects(getGitVaultKey({ directory, safeStorage: { isEncryptionAvailable: () => false } }), { code: "GIT_PROTECTION_UNAVAILABLE" });
  await fs.writeFile(path.join(directory, "key.enc"), "damaged");
  await assert.rejects(getGitVaultKey({ directory, safeStorage }), { code: "GIT_PROTECTION_UNAVAILABLE" });
  assert.equal(await fs.readFile(path.join(directory, "key.enc"), "utf8"), "damaged");
});
