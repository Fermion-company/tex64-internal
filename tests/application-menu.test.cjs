const test = require("node:test");
const assert = require("node:assert/strict");

const { createApplicationMenuTemplate } = require("../electron/app-menu.cjs");

test("application menu exposes standard file actions and shortcuts", () => {
  const commands = [];
  const template = createApplicationMenuTemplate({
    appName: "TeX64",
    isMac: true,
    sendCommand: (command) => commands.push(command),
  });

  assert.equal(template[0].label, "TeX64");
  const fileMenu = template.find((item) => item.label === "File");
  assert.ok(fileMenu);

  const actionable = fileMenu.submenu.filter((item) => item.command || item.click);
  const byLabel = new Map(actionable.map((item) => [item.label, item]));
  assert.equal(byLabel.get("New File").accelerator, "CmdOrCtrl+N");
  assert.equal(byLabel.get("Open Folder…").accelerator, "CmdOrCtrl+O");
  assert.equal(byLabel.get("Save").accelerator, "CmdOrCtrl+S");
  assert.equal(byLabel.get("Build").accelerator, "CmdOrCtrl+Enter");

  byLabel.get("New File").click();
  byLabel.get("Build").click();
  assert.deepEqual(commands, ["file:new", "document:build"]);
});
