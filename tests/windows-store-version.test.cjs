"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mapSourceVersionToStoreVersion,
  resolveStoreVersion,
  validateStoreVersion,
} = require("../scripts/windows-store-version.cjs");

test("maps source versions to monotonic AppX-compatible Store versions", () => {
  assert.equal(mapSourceVersionToStoreVersion("0.1.19"), "1.1.19");
  assert.equal(mapSourceVersionToStoreVersion("1.0.0"), "2.0.0");
  assert.ok(
    mapSourceVersionToStoreVersion("0.2.0").localeCompare(
      mapSourceVersionToStoreVersion("0.1.99"),
      undefined,
      { numeric: true },
    ) > 0,
  );
});

test("allows an explicit valid Store version override", () => {
  assert.equal(
    resolveStoreVersion({ sourceVersion: "0.1.19", explicitVersion: "7.12.34" }),
    "7.12.34",
  );
});

test("rejects invalid or Store-incompatible versions", () => {
  assert.throws(() => mapSourceVersionToStoreVersion("0.1.19-beta.1"), /stable three-part version/);
  assert.throws(() => validateStoreVersion("0.9.0"), /major must be at least 1/);
  assert.throws(() => validateStoreVersion("1.65536.0"), /greater than 65535/);
});
