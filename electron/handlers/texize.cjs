"use strict";

const path = require("path");

const TEXIZE_WORKSPACE_ASSETS_DIR = "assets/texize";

const resolveTexizeWorkspaceAssets = (workspace) => {
  if (!workspace?.getRootPath?.()) return null;
  return {
    absoluteDir: workspace.resolvePath(TEXIZE_WORKSPACE_ASSETS_DIR),
    relativeDir: TEXIZE_WORKSPACE_ASSETS_DIR,
  };
};

const rewriteTexizeAssetPaths = (tex, assetsRelativeDir) => {
  if (typeof tex !== "string" || !assetsRelativeDir) return tex;
  const prefix = assetsRelativeDir.replace(/\\/g, "/").replace(/\/$/, "");
  const daemonAssetsPrefix = path.posix.basename(prefix);
  return tex.replace(/(\\includegraphics(?:\s*\[[^\]]*\])?\s*\{)([^}]+)(\})/g, (match, open, rawPath, close) => {
    let assetPath = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!assetPath || path.posix.isAbsolute(assetPath) || assetPath === prefix || assetPath.startsWith(`${prefix}/`)) {
      return match;
    }
    if (assetPath === ".." || assetPath.startsWith("../") || /^[a-z][a-z0-9+.-]*:/i.test(assetPath)) {
      return match;
    }
    if (assetPath.startsWith(`${daemonAssetsPrefix}/`)) {
      assetPath = assetPath.slice(daemonAssetsPrefix.length + 1);
    }
    return `${open}${prefix}/${assetPath}${close}`;
  });
};

const registerTexizeHandlers = ({ ipcMain, getTexizeService, workspace }) => {
  ipcMain.handle("tex64:texize:snippet", async (_event, payload) => {
    const workspaceAssets = resolveTexizeWorkspaceAssets(workspace);
    const response = await getTexizeService().snippet(workspaceAssets
      ? { ...payload, assetsDir: workspaceAssets.absoluteDir }
      : payload);
    if (workspaceAssets && response && typeof response.tex === "string") {
      return { ...response, tex: rewriteTexizeAssetPaths(response.tex, workspaceAssets.relativeDir) };
    }
    return response;
  });
  ipcMain.handle("tex64:texize:status", async () => {
    return getTexizeService().getStatus();
  });
};

module.exports = {
  registerTexizeHandlers,
  resolveTexizeWorkspaceAssets,
  rewriteTexizeAssetPaths,
  TEXIZE_WORKSPACE_ASSETS_DIR,
};
