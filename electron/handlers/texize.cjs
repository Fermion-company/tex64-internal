"use strict";

const registerTexizeHandlers = ({ ipcMain, getTexizeService }) => {
  ipcMain.handle("tex64:texize:snippet", async (_event, payload) => {
    return getTexizeService().snippet(payload);
  });
  ipcMain.handle("tex64:texize:status", async () => {
    return getTexizeService().getStatus();
  });
};

module.exports = { registerTexizeHandlers };
