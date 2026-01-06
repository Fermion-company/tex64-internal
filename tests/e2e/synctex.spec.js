import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  openWorkspaceApp,
  workspaceRoot,
  repoRoot,
} from "./helpers.js";

test("synctex forward/reverse wiring", async () => {
  test.setTimeout(60000);
  const stubPath = path.join(
    repoRoot,
    "tests",
    "e2e",
    "fixtures",
    "bin",
    "synctex"
  );
  const { electronApp, page } = await openWorkspaceApp({
    TEX180_E2E_SYNCTEX_PATH: stubPath,
  });
  try {
    const pdfPath = path.join(workspaceRoot, "main.pdf");
    await fs.writeFile(pdfPath, "TEX180_E2E_DUMMY_PDF");

    const forwardPromise = page.evaluate(() =>
      new Promise((resolve) => {
        const off = window.tex180Bridge.onMessage((message) => {
          if (message?.type === "synctex:forwardResult") {
            off();
            resolve(message.payload);
          }
        });
        window.tex180Bridge.postMessage({
          type: "synctex:forward",
          path: "main.tex",
          line: 3,
          column: 5,
          pdfPath: "main.pdf",
        });
      })
    );

    const forwardResult = await forwardPromise;
    expect(forwardResult?.ok).toBe(true);

    const reversePromise = page.evaluate(() =>
      new Promise((resolve) => {
        const off = window.tex180Bridge.onMessage((message) => {
          if (message?.type === "synctex:reverseResult") {
            off();
            resolve(message.payload);
          }
        });
      })
    );

    await page.evaluate(() => {
      window.tex180Bridge.postMessage({
        type: "synctex:reverse",
        page: 1,
        x: 120,
        y: 240,
        pdfPath: "main.pdf",
      });
    });

    const reverseResult = await reversePromise;
    expect(reverseResult?.ok).toBe(true);
    expect(reverseResult?.path).toBe("main.tex");
    expect(reverseResult?.line).toBe(3);
    expect(reverseResult?.column).toBe(5);
  } finally {
    await electronApp.close();
  }
});
