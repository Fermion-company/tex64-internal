"use strict";

const createApplicationMenuTemplate = ({
  appName = "TeX64",
  isMac = process.platform === "darwin",
  sendCommand = () => {},
} = {}) => {
  const commandItem = (label, command, accelerator) => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => sendCommand(command),
  });

  const template = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        commandItem("Settings…", "settings:open", "CmdOrCtrl+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        commandItem("New File", "file:new", "CmdOrCtrl+N"),
        { type: "separator" },
        commandItem("New Project…", "project:new", "CmdOrCtrl+Shift+N"),
        commandItem("Open Folder…", "project:open", "CmdOrCtrl+O"),
        { type: "separator" },
        commandItem("Save", "file:save", "CmdOrCtrl+S"),
        commandItem("Build", "document:build", "CmdOrCtrl+Enter"),
        { type: "separator" },
        { role: isMac ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  );

  return template;
};

module.exports = { createApplicationMenuTemplate };
