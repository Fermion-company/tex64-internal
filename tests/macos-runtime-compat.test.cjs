const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Math OCR pins the last ONNX Runtime release with Intel Mac binaries", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
  );

  assert.equal(pkg.dependencies["onnxruntime-node"], "1.23.2");
  assert.equal(
    lock.packages[""].dependencies["onnxruntime-node"],
    "1.23.2"
  );
  assert.equal(
    lock.packages["node_modules/onnxruntime-node"].version,
    "1.23.2"
  );
});

test("each macOS release matrix loads ONNX Runtime from the packaged app", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const macJob = workflow
    .split("\n  build:\n")[1]
    ?.split("\n  windows:\n")[0];
  const smokeStep = macJob
    ?.split("- name: Smoke-test packaged ONNX Runtime")[1]
    ?.split("- name: Rebuild DMG (HFS+ background)")[0];

  assert.ok(smokeStep, "packaged ONNX Runtime smoke-test step must exist");
  assert.match(smokeStep, /matrix\.arch/u);
  assert.match(smokeStep, /Contents\/Resources\/app\.asar/u);
  assert.match(smokeStep, /ELECTRON_RUN_AS_NODE=1/u);
  assert.match(smokeStep, /TEX64_EXPECTED_ARCH="\$\{\{ matrix\.arch \}\}"/u);
  assert.match(smokeStep, /process\.arch !== expectedArch/u);
  assert.match(smokeStep, /require\.resolve\("onnxruntime-node"/u);
  assert.match(smokeStep, /require\(resolved\)/u);
  assert.match(smokeStep, /TEX64_ONNX_LOAD_OK/u);
});
