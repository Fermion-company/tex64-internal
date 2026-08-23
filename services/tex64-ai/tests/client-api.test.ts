import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDocument, listDocuments, patchDocument, sendMessage } from "@/lib/client/api";

beforeEach(() => {
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout,
    crypto: globalThis.crypto,
    setTimeout: globalThis.setTimeout,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("real client API boundary", () => {
  it("reports an unavailable API instead of fabricating demo documents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(listDocuments()).resolves.toEqual({
      data: null,
      source: "remote",
      ok: false,
      error: "unavailable",
    });
  });

  it("rejects incomplete API payloads instead of treating them as saved data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ document: {} })));

    await expect(
      patchDocument("1c7ae46f-7266-46c4-bd07-c2722d3cbacf", {
        baseRevision: 1,
        title: "更新",
      }),
    ).resolves.toEqual({
      data: null,
      source: "remote",
      ok: false,
      error: "invalid_response",
    });
  });

  it("streams turn frames to the caller", async () => {
    const frames = [
      '{"type":"tool","name":"read_document","state":"start"}',
      '{"type":"text","delta":"書きました"}',
      '{"type":"done","status":"completed"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n`));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );

    const seen: unknown[] = [];
    const result = await sendMessage(
      "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
      { prompt: "注意機構について書いて" },
      (frame) => seen.push(frame),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      { type: "tool", name: "read_document", state: "start" },
      { type: "text", delta: "書きました" },
      { type: "done", status: "completed" },
    ]);
  });

  it("reports an aborted turn as a normal outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    await expect(
      sendMessage(
        "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
        { prompt: "止めて" },
        () => {},
        controller.signal,
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses the document creation key again when the first response is lost", async () => {
    const document = {
      id: "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
      title: "注意機構",
      kind: "paper",
      status: "draft",
      updatedAt: "2026-08-07T00:00:00.000Z",
      preview: "",
      revision: 1,
      blocks: [],
      elements: [],
      versions: [],
      messages: [],
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(Response.json({ document }));
    vi.stubGlobal("fetch", fetchMock);

    const requestKey = "80bfe834-17dd-4b9f-bd48-bf678aba157c";
    const result = await createDocument(
      { prompt: "注意機構について", kind: "paper" },
      requestKey,
    );

    expect(result).toMatchObject({ ok: true, data: document });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(requestKey);
    }
  });
});
