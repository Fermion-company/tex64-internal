"use strict";

const readline = require("node:readline");

process.stdout.write(`${JSON.stringify({ ready: true, version: "fake-1.0" })}\n`);

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "shutdown") {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true })}\n`, () => process.exit(0));
    return;
  }
  if (request.op === "ping") {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true })}\n`);
    return;
  }
  if (request.image_b64 === "timeout") return;
  if (request.image_b64 === "crash") {
    setTimeout(() => process.exit(23), 10);
    return;
  }
  const respond = () => process.stdout.write(`${JSON.stringify({
    id: request.id,
    ok: true,
    tex: `tex:${request.image_b64}`,
    assets: request.assets_dir ? ["assets/figure.png"] : [],
    translate: request.translate || null,
    pid: process.pid,
  })}\n`);
  setTimeout(respond, request.image_b64 === "wait-for-ready" ? 20 : 0);
});
