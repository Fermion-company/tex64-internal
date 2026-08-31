const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SynctexService } = require("../electron/services/synctex/service.cjs");

test("source-line scoring sees edits instead of keeping a stale cache", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-synctex-cache-"));
  const sourcePath = path.join(directory, "main.tex");
  try {
    fs.writeFileSync(sourcePath, "alpha\n", "utf8");
    const service = new SynctexService();
    assert.equal(service.getSourceLine(sourcePath, 1), "alpha");

    fs.writeFileSync(sourcePath, "bravo\n", "utf8");
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(sourcePath, future, future);
    assert.equal(service.getSourceLine(sourcePath, 1), "bravo");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
