"use strict";

const parseHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const isAllowedAiWebviewSource = (value, { packaged, expectedOrigin }) => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return false;
  if (!packaged) return true;
  return (
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    Boolean(expectedOrigin) &&
    parsed.origin === expectedOrigin
  );
};

const hardenAiWebviewPreferences = (webPreferences, preloadPath) => {
  webPreferences.preload = preloadPath;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
};

const sameOrigin = (value, expectedOrigin) => {
  const parsed = parseHttpUrl(value);
  return parsed !== null && parsed.origin === expectedOrigin;
};

const denyPermissions = (session) => {
  session?.setPermissionCheckHandler?.(() => false);
  session?.setPermissionRequestHandler?.(
    (_webContents, _permission, callback) => callback(false),
  );
  session?.setDevicePermissionHandler?.(() => false);
};

const secureAiWebviewContents = (
  contents,
  { initialUrl, packaged, expectedOrigin },
) => {
  if (!isAllowedAiWebviewSource(initialUrl, { packaged, expectedOrigin })) {
    return false;
  }
  const initialOrigin = new URL(initialUrl).origin;
  const preventCrossOriginNavigation = (event, targetUrl) => {
    if (!sameOrigin(targetUrl, initialOrigin)) event.preventDefault();
  };

  contents.on("will-navigate", preventCrossOriginNavigation);
  contents.on("will-redirect", preventCrossOriginNavigation);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  denyPermissions(contents.session);
  return true;
};

module.exports = {
  denyPermissions,
  hardenAiWebviewPreferences,
  isAllowedAiWebviewSource,
  parseHttpUrl,
  secureAiWebviewContents,
};
