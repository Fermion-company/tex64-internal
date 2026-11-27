"use strict";

const fs = require("node:fs");
const path = require("node:path");

// These are the names emitted by electron-builder and the Windows preview
// workflow. Notarization inputs, detached signatures and unrecognized files
// must remain available to their owner.
function isReleasePackage(name) {
  return /^TeX64-\d+\.\d+\.\d+(?:[-+][\w.+-]+)?-(?:mac-(?:arm64|x64|universal)\.(?:zip|dmg)|(?:unsigned-preview-)?win-(?:arm64|x64|ia32)\.(?:exe|msi))$/i.test(name);
}

function previousOutputs(directory, isKnown) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`Expected an output directory: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const file = path.join(directory, entry.name);
    if (!entry.isFile() || !isKnown(entry.name, file)) {
      throw new Error(`Existing file is not a recognized release output: ${file}`);
    }
    return file;
  });
}

function isChecksums(name, file) {
  if (name !== "checksums-sha256.txt") return false;
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  return lines.every(line => {
    const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(line);
    return match && isReleasePackage(match[2]);
  });
}

function isUpdateFeed(name, file) {
  if (name !== "stable.json") return false;
  try {
    const feed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof feed?.latestVersion === "string" && typeof feed.channel === "string" && Array.isArray(feed.artifacts);
  } catch {
    return false;
  }
}

function prepareReleaseDirectories(root = process.cwd()) {
  const release = path.join(root, "release");
  const update = path.join(root, "update");
  // Check both directories before modifying either, then remove only the
  // files inspected above. A newly arrived unrelated file is never removed.
  const files = [
    ...previousOutputs(release, (name, file) => isReleasePackage(name) || isChecksums(name, file)),
    ...previousOutputs(update, isUpdateFeed),
  ];
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(update, { recursive: true });
  for (const file of files) fs.unlinkSync(file);
}

module.exports = { prepareReleaseDirectories, isReleasePackage };
