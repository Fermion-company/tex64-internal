import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDocument, listDocuments, patchDocument, startRun } from "@/lib/client/api";

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

  it("sends one stable idempotency key in the run header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        run: {
          id: "60fb684e-3000-49c9-9de5-80f89c6bfa9d",
          documentId: "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
          prompt: "注意機構について書いて",
          stage: "understanding",
          status: "running",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await startRun("1c7ae46f-7266-46c4-bd07-c2722d3cbacf", {
      prompt: "注意機構について書いて",
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headerKey = new Headers(init.headers).get("Idempotency-Key");
    const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
    expect(headerKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body.idempotencyKey).toBe(headerKey);
  });

  it("retries a lost run response with the same logical request key", async () => {
    const response = Response.json({
      run: {
        id: "60fb684e-3000-49c9-9de5-80f89c6bfa9d",
        documentId: "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
        prompt: "続けて",
        stage: "understanding",
        status: "running",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    const requestKey = "9cda9ec8-d091-4d89-b777-a8a56e293d88";
    const result = await startRun(
      "1c7ae46f-7266-46c4-bd07-c2722d3cbacf",
      { prompt: "続けて" },
      requestKey,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(requestKey);
      expect(JSON.parse(String(init.body))).toMatchObject({ idempotencyKey: requestKey });
    }
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
      versions: [],
      runs: [],
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
