// Orchestrates the renderer-side LSP integration: probes the texlab binary,
// runs the initialize handshake, then wires document sync, providers, and
// diagnostics. Returns null (LSP disabled) when texlab isn't available or the
// handshake fails — the editor keeps working without language-server features.
import { LspClient } from "./lsp-client.js";
import { LspDocumentSync } from "./lsp-document-sync.js";
import { registerLspProviders, registerDiagnostics } from "./lsp-providers.js";
import { editorSettings } from "../editor-settings/editor-settings-store.js";
// texlab configuration derived from feature flags. chktex requires the chktex
// binary (ships with TeX Live); texlab silently no-ops if it's missing.
const buildTexlabConfig = () => ({
    chktex: {
        onOpenAndSave: editorSettings.isEnabled("lint.chktex"),
        onEdit: false,
    },
});
const clientCapabilities = () => ({
    textDocument: {
        synchronization: { didSave: true, dynamicRegistration: false },
        completion: {
            completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: false,
            },
        },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        rename: { prepareSupport: false },
        formatting: {},
        publishDiagnostics: { relatedInformation: true },
    },
    workspace: {
        workspaceFolders: true,
        configuration: true,
    },
});
export const setupLsp = async (monaco, deps) => {
    const bridge = window.tex64Lsp;
    if (!bridge) {
        console.warn("[lsp] tex64Lsp bridge unavailable; LSP disabled");
        return null;
    }
    const status = await bridge.getStatus().catch(() => ({ available: false, running: false }));
    if (!status.available) {
        console.info("[lsp] texlab binary not found; LSP features disabled (run: npm run texlab:fetch)");
        return null;
    }
    const client = new LspClient(bridge);
    // Minimal handlers for server→client requests texlab may issue, so it doesn't
    // stall waiting for a reply.
    client.onRequest("workspace/configuration", (params) => {
        const items = Array.isArray(params === null || params === void 0 ? void 0 : params.items) ? params.items : [];
        return items.map(() => buildTexlabConfig());
    });
    client.onRequest("client/registerCapability", () => null);
    client.onRequest("client/unregisterCapability", () => null);
    client.onRequest("window/workDoneProgress/create", () => null);
    client.onRequest("workspace/semanticTokens/refresh", () => null);
    client.onRequest("workspace/diagnostic/refresh", () => null);
    const rootPath = deps.getWorkspaceRoot();
    const rootUri = rootPath ? monaco.Uri.file(rootPath).toString() : null;
    try {
        await client.initialize({
            processId: null,
            clientInfo: { name: "TeX64" },
            rootUri,
            workspaceFolders: rootUri ? [{ uri: rootUri, name: "workspace" }] : null,
            capabilities: clientCapabilities(),
            initializationOptions: buildTexlabConfig(),
        });
    }
    catch (error) {
        console.warn("[lsp] initialize failed; LSP disabled", error);
        return null;
    }
    const docSync = new LspDocumentSync(monaco, client);
    docSync.start();
    docSync.openPending();
    const providerDisposables = registerLspProviders(monaco, client);
    // Always registered; the diagnostics flag is checked at publish time so it can
    // be toggled live.
    const disposeDiagnostics = registerDiagnostics(monaco, client, "texlab");
    console.info("[lsp] texlab ready");
    return {
        client,
        docSync,
        dispose: () => {
            providerDisposables.forEach((d) => d.dispose());
            disposeDiagnostics();
            docSync.dispose();
        },
    };
};
