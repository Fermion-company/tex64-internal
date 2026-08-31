"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cleanStagedState,
  outputDir,
  sanitizedBuildEnvironment,
} = require("../scripts/prepare-ai-native-bundle.cjs");

test("staging removes local documents, artifacts, and dotenv files", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-ai-stage-test-"));
  try {
    for (const name of [".artifacts", ".data", "node_modules"]) {
      fs.mkdirSync(path.join(temporary, name));
    }
    fs.writeFileSync(path.join(temporary, ".env.local"), "SECRET=value\n");
    cleanStagedState(temporary);
    assert.equal(fs.existsSync(path.join(temporary, ".artifacts")), false);
    assert.equal(fs.existsSync(path.join(temporary, ".data")), false);
    assert.equal(fs.existsSync(path.join(temporary, ".env.local")), false);
    assert.equal(fs.existsSync(path.join(temporary, "node_modules")), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("native AI build environment does not inherit service credentials", () => {
  const previous = {
    NEXT_PUBLIC_TEX64_TEST_VALUE: process.env.NEXT_PUBLIC_TEX64_TEST_VALUE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.OPENAI_API_KEY = "must-not-enter-the-build";
  process.env.NEXT_PUBLIC_TEX64_TEST_VALUE = "must-not-enter-the-client";
  try {
    const environment = sanitizedBuildEnvironment();
    assert.equal(environment.OPENAI_API_KEY, "");
    assert.equal(environment.NEXT_PUBLIC_TEX64_TEST_VALUE, "");
    assert.equal(environment.NODE_ENV, "production");
    assert.equal(environment.TEX64_LOCAL_DEVELOPMENT, "false");
    assert.ok(environment.PATH, "the build still needs its toolchain environment");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("both desktop platforms package the staged standalone server once", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const outputRelative = path
    .relative(path.join(__dirname, ".."), outputDir)
    .split(path.sep)
    .join("/");
  assert.match(packageJson.scripts["dist:prep"], /ai-native:prepare/);
  for (const platform of ["mac", "win"]) {
    const resources = packageJson.build[platform].extraResources;
    assert.deepEqual(
      resources.filter(
        (resource) =>
          resource.from === path.dirname(outputRelative) &&
          resource.filter?.includes(`${path.basename(outputRelative)}/**/*`),
      ),
      [
        {
          from: path.dirname(outputRelative),
          to: ".",
          filter: [`${path.basename(outputRelative)}/**/*`],
        },
      ],
      `${platform} must copy the server and runtime dependencies once`,
    );
  }
});
