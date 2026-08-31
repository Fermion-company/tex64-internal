import { describe, expect, it } from "vitest";

import {
  buildTargetFromEvent,
  decodeNativePdf,
  existingPdfForDocument,
  nativePdfReplyMatches,
  nativePdfRequestKey,
  selectWorkspacePdfPage,
} from "@/lib/client/use-workspace-pdf";
import {
  EMPTY_WORKSPACE_IDENTITY,
  normalizeWorkspaceRelativePath,
  replyMatchesWorkspace,
  workspaceIdentityFromHost,
  workspaceStorageKey,
} from "@/lib/client/workspace-identity";
import { workspaceTargetFromHost } from "@/lib/client/use-native-workspace";

describe("native workspace identity", () => {
  it("uses host identity fields and advances a legacy generation only on root change", () => {
    const first = workspaceIdentityFromHost({ rootPath: "/a" }, EMPTY_WORKSPACE_IDENTITY);
    expect(first).toEqual({
      workspaceId: "path:/a",
      workspaceRoot: "/a",
      workspaceGeneration: 1,
    });
    expect(workspaceIdentityFromHost({ rootPath: "/a" }, first)).toEqual(first);
    expect(workspaceIdentityFromHost({ rootPath: "/b" }, first).workspaceGeneration).toBe(2);
    expect(
      workspaceIdentityFromHost(
        { rootPath: "/b", workspaceId: "stable-b", workspaceGeneration: 42 },
        first,
      ),
    ).toEqual({
      workspaceId: "stable-b",
      workspaceRoot: "/b",
      workspaceGeneration: 42,
    });
  });

  it("keeps the current workspace session for additive partial refresh events", () => {
    const current = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    expect(workspaceIdentityFromHost({ files: ["main.tex"] }, current)).toEqual(current);
    expect(
      workspaceIdentityFromHost(
        { workspaceGeneration: 7, workspaceId: "workspace-a" },
        current,
      ),
    ).toEqual(current);
    expect(workspaceIdentityFromHost({ rootPath: null }, current)).toEqual({
      workspaceId: "",
      workspaceRoot: null,
      workspaceGeneration: 8,
    });
  });

  it("uses only Code's configured build root as AI's target", () => {
    const identity = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    expect(
      workspaceTargetFromHost(
        {
          rootName: "research",
          rootFile: "paper/thesis.tex",
          files: ["main.tex", "notes/main.tex", "paper/thesis.tex"],
        },
        identity,
      ),
    ).toEqual({
      id: "workspace-a:paper%2Fthesis.tex",
      name: "research",
      mainFile: "paper/thesis.tex",
    });
    expect(
      workspaceTargetFromHost(
        { files: ["main.tex", "notes/main.tex"] },
        identity,
      ),
    ).toBeNull();
  });

  it("rejects replies from another root generation", () => {
    const expected = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    expect(replyMatchesWorkspace({ workspaceGeneration: 7, workspaceId: "workspace-a" }, expected)).toBe(true);
    expect(replyMatchesWorkspace({ workspaceGeneration: 6, workspaceId: "workspace-a" }, expected)).toBe(false);
    expect(replyMatchesWorkspace({ workspaceGeneration: 7, workspaceId: "workspace-b" }, expected)).toBe(false);
  });

  it("separates persisted PDF state by workspace and exact main file", () => {
    const a = { workspaceId: "a", workspaceRoot: "/a", workspaceGeneration: 1 };
    const b = { workspaceId: "b", workspaceRoot: "/b", workspaceGeneration: 1 };
    expect(workspaceStorageKey("pdf", a, "book/main.tex")).not.toBe(
      workspaceStorageKey("pdf", b, "book/main.tex"),
    );
    expect(workspaceStorageKey("pdf", a, "book/main.tex")).not.toBe(
      workspaceStorageKey("pdf", a, "notes/main.tex"),
    );
  });

  it("rejects traversal and correlates a PDF by targetFile, not output folder", () => {
    expect(normalizeWorkspaceRelativePath("../outside.pdf")).toBeNull();
    expect(normalizeWorkspaceRelativePath("C:\\outside.pdf")).toBeNull();
    expect(normalizeWorkspaceRelativePath("build/book.pdf")).toBe("build/book.pdf");
    expect(
      buildTargetFromEvent({
        targetFile: "book/thesis.tex",
        pdfPath: "build/thesis.pdf",
      }),
    ).toBe("book/thesis.tex");
  });

  it("binds native PDF bytes to the exact workspace generation and document", () => {
    const expected = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    const pdfBase64 = Buffer.from("%PDF-1.7\n").toString("base64");
    const reply = {
      ok: true,
      workspaceId: "workspace-a",
      workspaceGeneration: 7,
      documentMainFile: "book/main.tex",
      path: "book/main.pdf",
      byteSize: 9,
      mimeType: "application/pdf",
      base64: pdfBase64,
    };
    expect(
      nativePdfReplyMatches(reply, expected, "book/main.tex", "book/main.pdf"),
    ).toBe(true);
    expect(
      nativePdfReplyMatches(
        { ...reply, workspaceGeneration: 6 },
        expected,
        "book/main.tex",
        "book/main.pdf",
      ),
    ).toBe(false);
    expect(
      nativePdfReplyMatches(
        { ...reply, documentMainFile: "notes/main.tex" },
        expected,
        "book/main.tex",
        "book/main.pdf",
      ),
    ).toBe(false);
    expect(
      nativePdfReplyMatches(
        { ...reply, path: "notes/main.pdf" },
        expected,
        "book/main.tex",
        "book/main.pdf",
      ),
    ).toBe(false);
    expect(Array.from(decodeNativePdf(pdfBase64, 9)).slice(0, 5)).toEqual([
      0x25,
      0x50,
      0x44,
      0x46,
      0x2d,
    ]);
    expect(() => decodeNativePdf(Buffer.from("not pdf").toString("base64"), 7)).toThrow(
      /not a PDF/,
    );
  });

  it("changes the native PDF load key across generations and build requests", () => {
    const page = {
      path: "book/main.pdf",
      stamp: 10,
      mainFile: "book/main.tex",
      requestId: "build-a",
    };
    const first = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    expect(nativePdfRequestKey(first, "book/main.tex", page)).not.toBe(
      nativePdfRequestKey(
        { ...first, workspaceGeneration: 8 },
        "book/main.tex",
        page,
      ),
    );
    expect(nativePdfRequestKey(first, "book/main.tex", page)).not.toBe(
      nativePdfRequestKey(first, "book/main.tex", {
        ...page,
        requestId: "build-b",
      }),
    );
  });

  it("shows an existing last-good PDF when the first AI-mode build fails", () => {
    const page = selectWorkspacePdfPage({
      currentMainFile: "main.tex",
      currentBuild: {
        building: false,
        failure: "main.tex:3: usepackage before documentclass",
        page: null,
        requestId: "ai-build-failed",
      },
      lastBuilt: null,
      rememberedPath: null,
      workspaceFiles: ["main.tex", "main.pdf", "main.log"],
    });

    expect(page).toEqual({
      path: "main.pdf",
      stamp: 0,
      mainFile: "main.tex",
      requestId: null,
    });
    const identity = {
      workspaceId: "workspace-a",
      workspaceRoot: "/a",
      workspaceGeneration: 7,
    };
    expect(nativePdfRequestKey(identity, "main.tex", page!)).toContain("main.pdf");
  });

  it("never guesses a last-good PDF outside the document folder", () => {
    expect(
      existingPdfForDocument("paper/main.tex", [
        "draft/main.pdf",
        "archive/main.pdf",
      ]),
    ).toBeNull();
    expect(
      existingPdfForDocument("paper/main.tex", [
        "output/main.pdf",
        "archive/other.pdf",
      ]),
    ).toBeNull();
    expect(
      existingPdfForDocument("paper/main.tex", [
        "../outside/main.pdf",
        "paper/main.pdf",
      ]),
    ).toBe("paper/main.pdf");
  });

  it("falls back from a stale remembered outDir to the existing sibling", () => {
    expect(
      selectWorkspacePdfPage({
        currentMainFile: "main.tex",
        currentBuild: {
          building: false,
          failure: "build failed",
          page: null,
          requestId: "ai-build-failed",
        },
        lastBuilt: null,
        rememberedPath: "out/main.pdf",
        workspaceFiles: ["main.tex", "main.pdf"],
      })?.path,
    ).toBe("main.pdf");
    expect(
      selectWorkspacePdfPage({
        currentMainFile: "main.tex",
        currentBuild: null,
        lastBuilt: null,
        rememberedPath: "out/main.pdf",
        workspaceFiles: null,
      })?.path,
    ).toBe("out/main.pdf");
  });
});
