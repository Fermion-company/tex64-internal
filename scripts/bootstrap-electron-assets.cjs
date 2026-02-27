#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const projectRoot = process.cwd();

const execInherit = (command, args, options = {}) => {
  execFileSync(command, args, { stdio: "inherit", ...options });
};

const fileExists = async (filePath) => {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
};

const ensureDir = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const writeFileIfMissing = async (filePath, content, encoding = "utf8") => {
  if (await fileExists(filePath)) {
    return false;
  }
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, content, encoding);
  return true;
};

const resolvePath = (...parts) => path.resolve(projectRoot, ...parts);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPngFile = async (filePath) => {
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(PNG_MAGIC.length);
      await handle.read(buffer, 0, buffer.length, 0);
      return buffer.equals(PNG_MAGIC);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`;

const DEFAULT_LICENSE_TEXT = `Copyright (c) 2026 TeX64 contributors.
All rights reserved.

This repository and its contents are proprietary unless a separate written
license grants additional rights.

No permission is granted to use, copy, modify, merge, publish, distribute,
sublicense, or sell this software except as expressly authorized in writing.
`;

const ensureEntitlements = async () => {
  const createdMain = await writeFileIfMissing(
    resolvePath("build", "entitlements.mac.plist"),
    ENTITLEMENTS_PLIST
  );
  const createdInherit = await writeFileIfMissing(
    resolvePath("build", "entitlements.mac.inherit.plist"),
    ENTITLEMENTS_PLIST
  );
  if (createdMain || createdInherit) {
    console.log("Created macOS entitlements plists.");
  }
};

const ensureLicense = async () => {
  const created = await writeFileIfMissing(
    resolvePath("LICENSE"),
    DEFAULT_LICENSE_TEXT
  );
  if (created) {
    console.log("Created LICENSE.");
  }
};

const ensureMacIcons = async () => {
  if (process.platform !== "darwin") {
    return;
  }

  const sourceJpg = resolvePath("Resources", "web", "assets", "icon.jpg");
  if (!(await fileExists(sourceJpg))) {
    console.error(`ERROR: icon source not found: ${sourceJpg}`);
    process.exit(1);
  }

  const iconDir = resolvePath("Resources", "icons");
  await ensureDir(iconDir);

  const pngPath = resolvePath("Resources", "icons", "tex64.png");
  if (!(await fileExists(pngPath)) || !(await isPngFile(pngPath))) {
    execInherit("sips", ["-s", "format", "png", "-Z", "1024", sourceJpg, "--out", pngPath]);
  }

  const iconsetDir = resolvePath("Resources", "icons", "tex64.iconset");
  const icnsPath = resolvePath("Resources", "icons", "tex64.icns");
  if (await fileExists(icnsPath)) {
    return;
  }

  await ensureDir(iconsetDir);

  const sizes = [
    { name: "icon_16x16.png", size: 16 },
    { name: "icon_16x16@2x.png", size: 32 },
    { name: "icon_32x32.png", size: 32 },
    { name: "icon_32x32@2x.png", size: 64 },
    { name: "icon_128x128.png", size: 128 },
    { name: "icon_128x128@2x.png", size: 256 },
    { name: "icon_256x256.png", size: 256 },
    { name: "icon_256x256@2x.png", size: 512 },
    { name: "icon_512x512.png", size: 512 },
    { name: "icon_512x512@2x.png", size: 1024 },
  ];

  for (const { name, size } of sizes) {
    const outPath = path.join(iconsetDir, name);
    if ((await fileExists(outPath)) && (await isPngFile(outPath))) {
      continue;
    }
    execInherit("sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(size),
      String(size),
      sourceJpg,
      "--out",
      outPath,
    ]);
  }

  execInherit("iconutil", ["--convert", "icns", "--output", icnsPath, iconsetDir]);
};

const main = async () => {
  await ensureEntitlements();
  await ensureLicense();
  await ensureMacIcons();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
