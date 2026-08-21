"use strict";

const registerTdomEngineHandlers = ({ ipcMain, getTdomEngineService, getPdfWindowManager }) => {
  const result = async (operation) => {
    try { return await operation(); }
    catch (error) { return { ok: false, error: error?.message || String(error) }; }
  };
  ipcMain.handle("tex64:tdom:start", () => result(() => getTdomEngineService().start()));
  ipcMain.handle("tex64:tdom:status", () => getTdomEngineService().getStatus());
  ipcMain.handle("tex64:tdom:stop", () => result(() => getTdomEngineService().stop()));
  ipcMain.handle("tex64:tdom:push", (_event, payload) => result(() => getTdomEngineService().push(payload)));
  // The separate PDF window is main-owned; the renderer only flips its live
  // state and the window re-applies it whenever it (re)opens.
  ipcMain.handle("tex64:tdom:window-live", (_event, payload) =>
    result(async () => {
      getPdfWindowManager?.()?.setLive(payload?.url ?? null, {
        generation: Number(payload?.generation) || 0,
        show: payload?.show === true,
        hide: payload?.hide === true,
        ...(Object.hasOwn(payload ?? {}, "error") ? { error: payload.error } : {}),
      });
      return { ok: true };
    }));
};

module.exports = { registerTdomEngineHandlers };
