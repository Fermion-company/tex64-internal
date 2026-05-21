import test from "node:test";
import assert from "node:assert/strict";

import { LspClient, LspError } from "../Resources/web/app/lsp/lsp-client.js";

// A mock bridge that records outbound messages and lets the test inject inbound
// ones, standing in for the preload tex64Lsp transport.
const makeBridge = () => {
  const sent = [];
  let messageHandler = null;
  let statusHandler = null;
  return {
    sent,
    emit: (message) => messageHandler && messageHandler(message),
    emitStatus: (status) => statusHandler && statusHandler(status),
    bridge: {
      send: (message) => sent.push(message),
      onMessage: (handler) => {
        messageHandler = handler;
        return () => {
          messageHandler = null;
        };
      },
      onStatus: (handler) => {
        statusHandler = handler;
        return () => {
          statusHandler = null;
        };
      },
      getStatus: async () => ({ available: true, running: true }),
    },
  };
};

test("request resolves when a matching response arrives", async () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  const promise = client.request("textDocument/hover", { x: 1 });
  const out = mock.sent.at(-1);
  assert.equal(out.method, "textDocument/hover");
  assert.equal(out.jsonrpc, "2.0");
  assert.ok(out.id !== undefined);

  mock.emit({ jsonrpc: "2.0", id: out.id, result: { contents: "hi" } });
  const result = await promise;
  assert.deepEqual(result, { contents: "hi" });
});

test("request rejects with LspError on error response", async () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  const promise = client.request("bad/method");
  const id = mock.sent.at(-1).id;
  mock.emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });

  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof LspError);
    assert.equal(err.code, -32601);
    assert.equal(err.message, "nope");
    return true;
  });
});

test("notifications dispatch to registered handlers", () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  const received = [];
  const off = client.onNotification("textDocument/publishDiagnostics", (params) => {
    received.push(params);
  });

  mock.emit({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///a.tex", diagnostics: [] },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].uri, "file:///a.tex");

  off();
  mock.emit({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///b.tex" },
  });
  assert.equal(received.length, 1, "unsubscribed handler must not fire");
});

test("server→client request gets a response (handled and unhandled)", async () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  client.onRequest("workspace/configuration", () => [null]);
  mock.emit({ jsonrpc: "2.0", id: "cfg-1", method: "workspace/configuration", params: {} });
  await Promise.resolve();
  await Promise.resolve();
  const reply = mock.sent.find((m) => m.id === "cfg-1");
  assert.ok(reply, "a reply should be sent for the server request");
  assert.deepEqual(reply.result, [null]);

  // Unknown server request -> MethodNotFound error response.
  mock.emit({ jsonrpc: "2.0", id: "unk-1", method: "totally/unknown", params: {} });
  await Promise.resolve();
  const errReply = mock.sent.find((m) => m.id === "unk-1");
  assert.ok(errReply.error);
  assert.equal(errReply.error.code, -32601);
});

test("initialize stores capabilities and sends initialized", async () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  const promise = client.initialize({ rootUri: null, capabilities: {} });
  const initMsg = mock.sent.find((m) => m.method === "initialize");
  assert.ok(initMsg);
  mock.emit({
    jsonrpc: "2.0",
    id: initMsg.id,
    result: { capabilities: { hoverProvider: true, completionProvider: {} } },
  });
  await promise;

  assert.equal(client.isReady(), true);
  assert.equal(client.capabilities.hoverProvider, true);
  assert.ok(mock.sent.some((m) => m.method === "initialized"));
});

test("status 'stopped' rejects pending requests and clears readiness", async () => {
  const mock = makeBridge();
  const client = new LspClient(mock.bridge);

  const initPromise = client.initialize({ rootUri: null, capabilities: {} });
  const initId = mock.sent.find((m) => m.method === "initialize").id;
  mock.emit({ jsonrpc: "2.0", id: initId, result: { capabilities: {} } });
  await initPromise;
  assert.equal(client.isReady(), true);

  const pending = client.request("textDocument/definition", {});
  mock.emitStatus({ status: "stopped", detail: "exited" });

  await assert.rejects(pending, /stopped/);
  assert.equal(client.isReady(), false);
});
