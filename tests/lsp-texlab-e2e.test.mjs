import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TexlabService } from "../electron/services/texlab/service.cjs";
import { LspClient } from "../Resources/web/app/lsp/lsp-client.js";

const REPO_ROOT = path.join(import.meta.dirname, "..");

// End-to-end: the real compiled renderer LspClient drives the real bundled
// texlab through a bridge wrapping the transport service (no Electron/monaco).
// Proves the full protocol path — handshake, didOpen, completion, symbols.
const makeBridge = (service) => {
  const messageHandlers = new Set();
  const statusHandlers = new Set();
  service.setHandlers({
    onMessage: (m) => messageHandlers.forEach((h) => h(m)),
    onStatus: (status, detail) => statusHandlers.forEach((h) => h({ status, detail })),
  });
  return {
    send: (m) => service.send(m),
    onMessage: (h) => {
      messageHandlers.add(h);
      return () => messageHandlers.delete(h);
    },
    onStatus: (h) => {
      statusHandlers.add(h);
      return () => statusHandlers.delete(h);
    },
    getStatus: async () => ({ available: service.isAvailable(), running: service.isRunning() }),
  };
};

const SAMPLE = `\\documentclass{article}
\\begin{document}
\\section{Intro}
\\label{sec:intro}
See \\ref{}.
\\end{document}
`;

test("texlab e2e: initialize, didOpen, completion + documentSymbol", async (t) => {
  const service = new TexlabService({ appPath: REPO_ROOT, isPackaged: false });
  if (!service.isAvailable()) {
    t.skip("texlab binary not installed (run: npm run texlab:fetch)");
    return;
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-lsp-"));
  const filePath = path.join(workdir, "main.tex");
  fs.writeFileSync(filePath, SAMPLE, "utf8");
  const uri = pathToFileURL(filePath).toString();
  const rootUri = pathToFileURL(workdir).toString();

  const client = new LspClient(makeBridge(service));
  client.onRequest("workspace/configuration", (params) =>
    (params?.items ?? []).map(() => ({}))
  );
  client.onRequest("window/workDoneProgress/create", () => null);
  client.onRequest("client/registerCapability", () => null);

  try {
    await client.initialize({
      processId: null,
      clientInfo: { name: "tex64-test" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
      },
      initializationOptions: {},
    });

    assert.equal(client.isReady(), true);
    assert.ok(client.capabilities.completionProvider, "texlab advertises completion");
    assert.ok(client.capabilities.documentSymbolProvider, "texlab advertises symbols");

    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "latex", version: 1, text: SAMPLE },
    });

    // Give texlab a moment to index the freshly opened document.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Document symbols: expect the section to show up.
    const symbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    assert.ok(Array.isArray(symbols) && symbols.length > 0, "documentSymbol returns entries");
    const flatNames = JSON.stringify(symbols);
    assert.ok(flatNames.includes("Intro"), `expected section "Intro" in symbols: ${flatNames}`);

    // Completion inside \ref{}: texlab should suggest the sec:intro label.
    // Line 4 (0-based) is "See \ref{}." — caret between { and }.
    const completion = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 4, character: 9 },
    });
    const items = Array.isArray(completion) ? completion : completion?.items ?? [];
    assert.ok(items.length > 0, "completion returned items inside \\ref{}");
    const labels = items.map((i) => i.label);
    assert.ok(
      labels.some((l) => String(l).includes("sec:intro")),
      `expected the sec:intro label in completion, got: ${JSON.stringify(labels).slice(0, 300)}`
    );

    // Group-1 additions: folding ranges should cover the document environment.
    const folding = await client.request("textDocument/foldingRange", {
      textDocument: { uri },
    });
    assert.ok(
      Array.isArray(folding) && folding.length > 0,
      "foldingRange returned ranges for the document"
    );

    // documentHighlight on the \label should return at least one occurrence.
    const highlights = await client.request("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 3, character: 8 },
    });
    assert.ok(Array.isArray(highlights), "documentHighlight returned an array");
  } finally {
    client.request("shutdown").catch(() => {});
    service.send({ jsonrpc: "2.0", method: "exit" });
    service.shutdown();
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
