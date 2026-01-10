import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/ai-chat.js";

const makeRes = () => {
  const headers = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader: (key, value) => {
      headers[key] = value;
    },
    end: (body = "") => {
      res.body = body;
      res.ended = true;
    },
  };
  return res;
};

const makeReq = ({ method = "POST", body } = {}) => ({
  method,
  body,
});

test("ai proxy rejects non-POST requests", async () => {
  const req = makeReq({ method: "GET" });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, "Method Not Allowed");
});

test("ai proxy requires GEMINI_API_KEY", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const req = makeReq({ method: "POST", body: { contents: [] } });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, "GEMINI_API_KEY is not set");
  if (previousKey !== undefined) {
    process.env.GEMINI_API_KEY = previousKey;
  }
});

test("ai proxy returns upstream response", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
  });

  const req = makeReq({
    method: "POST",
    body: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(res.body), { candidates: [{ content: { parts: [] } }] });

  globalThis.fetch = previousFetch;
  if (previousKey !== undefined) {
    process.env.GEMINI_API_KEY = previousKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
});
