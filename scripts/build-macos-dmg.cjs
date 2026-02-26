#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);

const readOption = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
};

const hasFlag = (name) => args.includes(name);

const exec = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { stdio: "inherit", ...options });

const execText = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { stdio: "pipe", encoding: "utf8", ...options });

const requireMacOs = () => {
  if (process.platform !== "darwin") {
    console.error("ERROR: macOS is required to build a DMG.");
    process.exit(1);
  }
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const safeUnlink = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch {}
};

const resolvePython = () => {
  try {
    return execText("which", ["python3"]).trim();
  } catch {
    return "python3";
  }
};

const parseAttachResult = (text) => {
  const lines = String(text || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let device = null;
  let volumePath = null;
  for (const line of lines) {
    const devMatch = line.match(/^(\/dev\/\S+)/);
    if (!devMatch) continue;
    const mountIndex = line.indexOf("/Volumes/");
    if (mountIndex < 0) continue;
    const dev = devMatch[1];
    const mount = line.slice(mountIndex).trim();
    if (dev.startsWith("/dev/") && mount.startsWith("/Volumes/")) {
      device = dev;
      volumePath = mount;
    }
  }

  return { device, volumePath };
};

const quotePythonString = (value) => {
  const text = String(value ?? "");
  return (
    "'" +
    text
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n") +
    "'"
  );
};

const main = () => {
  requireMacOs();

  const appPath = readOption("--app");
  if (!appPath) {
    console.error("Usage: node scripts/build-macos-dmg.cjs --app <path-to-TeX64.app> --out <out.dmg>");
    process.exit(1);
  }

  const outPath = readOption("--out");
  if (!outPath) {
    console.error("ERROR: --out is required.");
    process.exit(1);
  }

  const volumeName = readOption("--volumeName") || "TeX64";
  const background1x = readOption("--background1x") || path.join("assets", "dmg", "background.png");
  const background2x =
    readOption("--background2x") || path.join("assets", "dmg", "background@2x.png");

  const iconSize = Number.parseInt(readOption("--iconSize", "104"), 10);
  const iconTextSize = Number.parseInt(readOption("--iconTextSize", "12"), 10);

  const windowWidth = Number.parseInt(readOption("--windowWidth", "640"), 10);
  const windowHeight = Number.parseInt(readOption("--windowHeight", "420"), 10);
  const windowX = Number.parseInt(readOption("--windowX", "400"), 10);
  const windowY = Number.parseInt(readOption("--windowY", "510"), 10);

  const appIconX = Number.parseInt(readOption("--appIconX", "180"), 10);
  const appIconY = Number.parseInt(readOption("--appIconY", "160"), 10);
  const applicationsIconX = Number.parseInt(readOption("--applicationsIconX", "460"), 10);
  const applicationsIconY = Number.parseInt(readOption("--applicationsIconY", "160"), 10);
  const extraMb = Number.parseInt(readOption("--extraMb", "160"), 10);

  const dryRun = hasFlag("--dry-run");

  const absAppPath = path.resolve(appPath);
  if (!fs.existsSync(absAppPath)) {
    console.error(`ERROR: app not found: ${absAppPath}`);
    process.exit(1);
  }
  if (!absAppPath.endsWith(".app")) {
    console.error(`ERROR: --app must point to a .app bundle: ${absAppPath}`);
    process.exit(1);
  }

  const absOutPath = path.resolve(outPath);
  ensureDir(path.dirname(absOutPath));

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-dmg-"));
  const stageDmg = path.join(tmpBase, "stage.dmg");

  const srcFolder = path.dirname(absAppPath);

  // Stage (read-write) DMG — use HFS+ to match common DMG installers with background art.
  if (!dryRun) {
    safeUnlink(stageDmg);
    exec("hdiutil", [
      "create",
      "-srcfolder",
      srcFolder,
      "-volname",
      volumeName,
      "-anyowners",
      "-nospotlight",
      "-format",
      "UDRW",
      "-fs",
      "HFS+",
      "-fsargs",
      "-c c=64,a=16,e=16",
      stageDmg,
    ]);

    // Ensure enough free space for background art, links, and Finder metadata.
    // `hdiutil create -srcfolder` can create a volume that's too tight.
    let folderKiB = 0;
    try {
      const duOut = execText("du", ["-sk", srcFolder]).trim();
      folderKiB = Number.parseInt(duOut.split(/\s+/)[0] || "0", 10) || 0;
    } catch {
      folderKiB = 0;
    }
    const desiredMb = Math.max(Math.ceil(folderKiB / 1024) + Math.max(extraMb, 32), 200);
    exec("hdiutil", ["resize", "-size", `${desiredMb}m`, stageDmg]);
  }

  let device = null;
  let volumePath = null;
  try {
    const attachResult = dryRun
      ? ""
      : execText("hdiutil", ["attach", "-noverify", "-noautoopen", "-readwrite", stageDmg]);
    ({ device, volumePath } = parseAttachResult(attachResult));

    if (!dryRun && (!device || !volumePath)) {
      console.error(attachResult.trimEnd());
      console.error("ERROR: Failed to mount stage DMG.");
      process.exit(1);
    }

    if (!dryRun) {
      // Applications link
      const applicationsLink = path.join(volumePath, "Applications");
      if (!fs.existsSync(applicationsLink)) {
        exec("ln", ["-s", "/Applications", applicationsLink]);
      }

      // Background (Retina TIFF)
      const backgroundDir = path.join(volumePath, ".background");
      ensureDir(backgroundDir);
      const backgroundTiff = path.join(backgroundDir, "1.tiff");
      safeUnlink(backgroundTiff);
      exec("tiffutil", [
        "-cathidpicheck",
        path.resolve(background1x),
        path.resolve(background2x),
        "-out",
        backgroundTiff,
      ]);

      // Finder layout (.DS_Store)
      const python = resolvePython();
      const iconLocations = [
        `${quotePythonString(path.basename(absAppPath))}: (${appIconX}, ${appIconY})`,
        `${quotePythonString("Applications")}: (${applicationsIconX}, ${applicationsIconY})`,
      ].join(",\n");

      const env = {
        ...process.env,
        PYTHONIOENCODING: "utf8",
        volumePath,
        iconSize: String(iconSize),
        iconTextSize: String(iconTextSize),
        backgroundFile: backgroundTiff,
        windowX: String(windowX),
        windowY: String(windowY),
        windowWidth: String(windowWidth),
        windowHeight: String(windowHeight),
        iconLocations,
      };

      const dmgVendorDir = path.resolve("node_modules", "dmg-builder", "vendor");
      const dmgbuildCore = path.join(dmgVendorDir, "dmgbuild", "core.py");
      exec(python, [dmgbuildCore], {
        env,
        cwd: dmgVendorDir,
      });
    }
  } finally {
    if (!dryRun && device) {
      try {
        exec("hdiutil", ["detach", "-quiet", device]);
      } catch {}
    }
  }

  if (dryRun) {
    console.log("Dry run complete.");
    console.log(`- stage: ${stageDmg}`);
    console.log(`- out:   ${absOutPath}`);
    return;
  }

  // Convert to a compressed DMG (final artifact).
  const tmpOutBase = path.join(tmpBase, "out");
  safeUnlink(tmpOutBase);
  safeUnlink(`${tmpOutBase}.dmg`);
  exec("hdiutil", [
    "convert",
    stageDmg,
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "-o",
    tmpOutBase,
  ]);

  const converted = fs.existsSync(`${tmpOutBase}.dmg`) ? `${tmpOutBase}.dmg` : tmpOutBase;
  if (!fs.existsSync(converted)) {
    console.error("ERROR: DMG conversion output missing.");
    process.exit(1);
  }

  safeUnlink(absOutPath);
  fs.renameSync(converted, absOutPath);

  // Optional: internet-enable (kept off by default; can be surprising for users).
  if (hasFlag("--internet-enable")) {
    exec("hdiutil", ["internet-enable", "-yes", absOutPath]);
  }

  console.log(`OK: DMG created: ${absOutPath}`);
};

main();

