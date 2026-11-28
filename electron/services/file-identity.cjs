"use strict";

const fs = require("node:fs");
const path = require("node:path");

// On macOS the JavaScript realpath implementation can keep the caller's case
// or Unicode spelling. The native implementation returns the directory entry.
const realpath = fs.realpathSync.native ?? fs.realpathSync;

const canonicalPath = (filename, { allowDanglingLinks = false } = {}) => {
  let current = path.resolve(filename);
  const missing = [];
  for (;;) {
    try {
      return path.join(realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (!["ENOENT", "ENOTDIR"].includes(error.code) || parent === current) throw error;
      // A dangling link has no resolved target to use as an identity.
      try {
        const stat = fs.lstatSync(current);
        if (!allowDanglingLinks || !stat.isSymbolicLink()) throw error;
      } catch (statError) {
        if (statError === error || !["ENOENT", "ENOTDIR"].includes(statError.code)) throw statError;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
};

const fileIdentity = (workspace, filename) => canonicalPath(workspace.resolvePath(filename));

const relativeIdentity = (root, filename) =>
  path.relative(canonicalPath(root), filename).split(path.sep).join("/");

module.exports = { canonicalPath, fileIdentity, relativeIdentity };
