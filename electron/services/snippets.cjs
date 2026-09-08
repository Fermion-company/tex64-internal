"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite, fail } = require("./history-files.cjs");

class SnippetStore {
  constructor(directory) { this.file = path.join(directory, "snippets.json"); this.tail = Promise.resolve(); }
  async read() {
    try {
      const bytes = await fs.readFile(this.file);
      if (bytes.length > 4 * 1024 ** 2) throw fail("SNIPPETS_INVALID", "The snippet library is too large.");
      const data = JSON.parse(bytes.toString("utf8"));
      if (data.schema !== 1 || !Number.isSafeInteger(data.revision) || !Array.isArray(data.items)) throw new Error("Invalid snippet library");
      data.items.forEach(validateSnippet);
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, revision: 0, items: [] };
      throw error;
    }
  }
  change(action, request) {
    const result = this.tail.catch(() => {}).then(async () => {
      const data = await this.read();
      if (request.revision !== data.revision) throw fail("SNIPPETS_STALE", "The snippet library changed. Reload it before saving.");
      if (action === "save") {
        const item = { id: request.item?.id || crypto.randomUUID(), name: request.item?.name?.trim(), prefix: request.item?.prefix?.trim(), body: request.item?.body };
        validateSnippet(item);
        const index = data.items.findIndex((value) => value.id === item.id);
        if (request.item?.id && index < 0) throw fail("SNIPPETS_STALE", "This snippet was deleted. Reload the library.");
        if (data.items.some((value) => value.id !== item.id && value.prefix === item.prefix)) throw fail("SNIPPETS_DUPLICATE", "Another snippet already uses this prefix.");
        if (index >= 0) data.items[index] = item; else data.items.push(item);
      } else if (action === "delete") {
        if (!data.items.some((item) => item.id === request.id)) throw fail("SNIPPETS_STALE", "This snippet was already deleted.");
        data.items = data.items.filter((item) => item.id !== request.id);
      } else throw fail("INVALID_ACTION", "Unknown snippet operation.");
      data.revision++;
      const bytes = JSON.stringify(data);
      if (data.items.length > 500 || Buffer.byteLength(bytes) > 4 * 1024 ** 2) throw fail("SNIPPETS_LIMIT", "The snippet library is full.");
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, bytes);
      return data;
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
function validateSnippet(item) {
  if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 ||
      typeof item.prefix !== "string" || !/^\\?[A-Za-z0-9_-]{1,64}$/.test(item.prefix) || typeof item.body !== "string" || !item.body.trim() || item.body.length > 65536 || item.body.includes("\0")) {
    throw fail("SNIPPETS_INVALID", "Enter a name, a prefix (letters, digits, _ or -), and LaTeX content up to 64 KiB.");
  }
}
module.exports = { SnippetStore, validateSnippet };
