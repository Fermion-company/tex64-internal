"use strict";

const { isHttpUrl } = require("../services/ai-web.cjs");

const registerAiWebHandlers = ({ ipcMain, shell, getAiWebService }) => {
  ipcMain.handle("tex64:aiWeb:getConfig", async () => {
    try {
      return await getAiWebService().getConfig();
    } catch (error) {
      return { ok: false, error: error?.message || "AI web config failed." };
    }
  });

  ipcMain.handle("tex64:aiWeb:openExternal", async (_event, payload) => {
    const url = typeof payload?.url === "string" ? payload.url.trim() : "";
    if (!isHttpUrl(url)) {
      return { ok: false, error: "Only http(s) URLs can be opened." };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "openExternal failed." };
    }
  });
};

module.exports = { registerAiWebHandlers };
