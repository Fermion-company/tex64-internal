import { describe, expect, it } from "vitest";

import {
  pageMetadata,
  parsePageRequest,
} from "@/server/http/pagination";

describe("HTTP pagination", () => {
  it("parses bounded limit and offset values", () => {
    expect(
      parsePageRequest(new Request("https://example.test/api/documents?limit=25&offset=50")),
    ).toEqual({ limit: 25, offset: 50 });
    expect(
      parsePageRequest(new Request("https://example.test/api/documents")),
    ).toEqual({ limit: 100, offset: 0 });
  });

  it.each([
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=invalid",
    "offset=-1",
    "offset=10001",
  ])("rejects unsupported query %s", (query) => {
    expect(() =>
      parsePageRequest(new Request(`https://example.test/api/documents?${query}`)),
    ).toThrow();
  });

  it("only exposes a usable next offset", () => {
    expect(pageMetadata({ limit: 25, offset: 50 }, 25)).toEqual({
      limit: 25,
      offset: 50,
      nextOffset: 75,
    });
    expect(pageMetadata({ limit: 25, offset: 50 }, 10).nextOffset).toBeNull();
    expect(
      pageMetadata({ limit: 100, offset: 10_000 }, 100).nextOffset,
    ).toBeNull();
  });
});
