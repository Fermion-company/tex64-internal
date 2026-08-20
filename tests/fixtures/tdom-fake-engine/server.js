// Minimal stand-in for tdom-core's server.js: /status for the readiness
// probe, /open and /edit mutating an in-memory source, /doc to inspect it.
// Records every request body so tests can assert the edit ranges the service
// actually sent. ESM, like the real engine.

import http from "node:http";

let source = "";
const edits = [];

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url === "/status") return res.end(JSON.stringify({ ok: true, mode: "structured" }));
  if (req.method === "GET" && req.url === "/doc") return res.end(JSON.stringify({ source, edits }));
  if (req.method === "POST" && req.url === "/open") {
    const body = JSON.parse((await readBody(req)) || "{}");
    source = typeof body.text === "string" ? body.text : "";
    edits.push({ kind: "open", text: source });
    return res.end(JSON.stringify({ source }));
  }
  if (req.method === "POST" && req.url === "/edit") {
    const body = JSON.parse((await readBody(req)) || "{}");
    source = source.slice(0, body.start) + body.text + source.slice(body.end);
    edits.push({ kind: "edit", start: body.start, end: body.end, text: body.text });
    return res.end(JSON.stringify({ source }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(process.env.PORT || 0), "127.0.0.1");
