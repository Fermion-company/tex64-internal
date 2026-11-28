const { writeProjectFile } = require("./project-file-writes.cjs");
const path = require("path");
const fsp = require("fs/promises");

class BlocksStore {
  async load(rootPath) {
    const blocksPath = path.join(rootPath, ".tex64", "blocks.json");
    const exists = await fsp.stat(blocksPath).then(() => true).catch(() => false);
    if (!exists) {
      return [];
    }
    const content = await fsp.readFile(blocksPath, "utf8");
    return JSON.parse(content);
  }

  async save(rootPath, blocks) {
    const directory = path.join(rootPath, ".tex64");
    await fsp.mkdir(directory, { recursive: true });
    const blocksPath = path.join(directory, "blocks.json");
    const payload = JSON.stringify(blocks, null, 2);
    await writeProjectFile(blocksPath, payload);
  }
}

module.exports = {
  BlocksStore,
};
