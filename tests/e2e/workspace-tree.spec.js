import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot } from "./helpers.js";

test("existing workspace shows file tree and filters ignored folders", async () => {
  test.setTimeout(90000);
  const nodeModulesPath = path.join(workspaceRoot, "node_modules");
  const gitPath = path.join(workspaceRoot, ".git");
  await fs.mkdir(nodeModulesPath, { recursive: true });
  await fs.writeFile(path.join(nodeModulesPath, "ignored.txt"), "ignored");
  await fs.mkdir(gitPath, { recursive: true });
  await fs.writeFile(path.join(gitPath, "config"), "ignored");

  const { electronApp, page } = await openWorkspaceApp();
  try {
    await expect(page.locator("#workspace-label")).toHaveText(/test-workspace/);
    await expect(page.locator('button.file-item[data-path="main.tex"]')).toHaveCount(1);
    await expect(page.locator('summary:has-text("notes")')).toHaveCount(1);
    await expect(page.locator('summary:has-text("sections")')).toHaveCount(1);
    await expect(page.locator('summary:has-text("node_modules")')).toHaveCount(0);
    await expect(page.locator('summary:has-text(".git")')).toHaveCount(0);
  } finally {
    await electronApp.close();
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
    await fs.rm(gitPath, { recursive: true, force: true });
  }
});
