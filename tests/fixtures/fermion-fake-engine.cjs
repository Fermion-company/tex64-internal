"use strict";

const http = require("node:http");
const port = Number(process.env.PORT || 4633);
let source = "fixture";
let rev = 0;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/doc") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ backend: "fake", source, rev }));
  }
  if (req.method === "POST" && req.url === "/edit") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const edit = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ rev: ++rev, source }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/") return res.end("fermion fixture");
  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
