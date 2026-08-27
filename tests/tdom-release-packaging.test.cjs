"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("release workflow vendors a pinned TDOM engine for both platforms", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8"
  );

  assert.match(workflow, /TDOM_ENGINE_COMMIT:\s+[0-9a-f]{40}/);
  assert.equal(
    (workflow.match(/name: Vendor pinned TDOM engine/g) || []).length,
    2,
    "macOS and Windows release jobs must both vendor the engine"
  );
  assert.equal(
    (workflow.match(/npm run -s tdom:sync/g) || []).length,
    2,
    "both release packages must sync the pinned engine before packaging"
  );
});
