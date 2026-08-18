import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  extractNodeLineRanges,
  renderDocumentToLatex,
  validateDocument,
  type DocumentModel,
} from "@/domain/document";
import { createLatexChildEnvironment } from "@/server/compiler/local-compiler";
import {
  RegionMapSchema,
  buildRegionMap,
  type NodeLineRange,
  type RegionMap,
} from "@/server/compiler/synctex-regions";

const execFileAsync = promisify(execFile);
const LUALATEX_PATH =
  process.env.TEX64_LUALATEX_PATH ??
  (process.platform === "darwin" ? "/Library/TeX/texbin/lualatex" : "lualatex");
const A4_WIDTH_BP = 595.28;
const A4_HEIGHT_BP = 841.89;

/** Test-local marker scanner; the production scanner lives with the renderer. */
function scanMarkerRanges(latex: string): NodeLineRange[] {
  const begins = new Map<string, number>();
  const ranges: NodeLineRange[] = [];
  latex.split("\n").forEach((line, index) => {
    const begin = /^%%T64B:(.+)$/.exec(line)?.[1];
    const end = /^%%T64E:(.+)$/.exec(line)?.[1];
    if (begin !== undefined) begins.set(begin, index + 1);
    else if (end !== undefined) {
      const beginLine = begins.get(end);
      if (beginLine !== undefined) ranges.push({ id: end, start: beginLine + 1, end: index });
    }
  });
  return ranges;
}

async function compileWithSynctex(latex: string): Promise<{ synctex: Uint8Array | null; log: string }> {
  const workDir = await mkdtemp(path.join(tmpdir(), "tex64-synctex-test-"));
  const cachePath = path.join(workDir, ".texmf-cache");
  const configPath = path.join(workDir, ".texmf-config");
  try {
    await Promise.all([
      mkdir(cachePath, { recursive: true, mode: 0o700 }),
      mkdir(configPath, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(path.join(workDir, "main.tex"), latex, "utf8");
    try {
      await execFileAsync(
        LUALATEX_PATH,
        [
          "-synctex=1",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-no-shell-escape",
          `-output-directory=${workDir}`,
          "main.tex",
        ],
        {
          cwd: workDir,
          timeout: 55_000,
          maxBuffer: 32 * 1024 * 1024,
          killSignal: "SIGKILL",
          windowsHide: true,
          env: createLatexChildEnvironment({ workDir, cachePath, configPath }),
        },
      );
    } catch {
      const log = await readFile(path.join(workDir, "main.log"), "utf8").catch(() => "");
      return { synctex: null, log };
    }
    const synctex = await readFile(path.join(workDir, "main.synctex.gz"));
    return { synctex, log: "" };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function assertWithinA4(map: RegionMap): void {
  for (const node of map.nodes) {
    for (const rect of node.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(A4_WIDTH_BP);
      expect(rect.y + rect.height).toBeLessThanOrEqual(A4_HEIGHT_BP);
    }
  }
}

describe.skipIf(!existsSync(LUALATEX_PATH))("synctex regions from real lualatex output", () => {
  it("maps a multi-paragraph node across a page break", async () => {
    const filler =
      "Filler sentence that wraps across several typeset lines and steadily fills the page with plain text. ".repeat(
        4,
      );
    const spanningBody = Array.from({ length: 30 }, () => filler.trim()).join("\n\n");
    const latex = [
      String.raw`\documentclass[a4paper,11pt]{article}`,
      String.raw`\begin{document}`,
      "%%T64B:intro",
      "A short introductory paragraph before the long node.",
      "%%T64E:intro",
      "",
      "%%T64B:spanning",
      spanningBody,
      "%%T64E:spanning",
      String.raw`\end{document}`,
    ].join("\n");
    const ranges = scanMarkerRanges(latex);
    expect(ranges.map((range) => range.id)).toEqual(["intro", "spanning"]);

    const { synctex, log } = await compileWithSynctex(latex);
    expect(synctex, log.slice(-2_000)).not.toBeNull();
    if (synctex === null) return;

    const map = buildRegionMap({ synctex, ranges });
    expect(map).not.toBeNull();
    if (map === null) return;
    expect(RegionMapSchema.safeParse(map).success).toBe(true);
    assertWithinA4(map);

    const intro = map.nodes.find((node) => node.id === "intro");
    expect(intro?.rects.length).toBeGreaterThan(0);
    expect(intro?.rects.every((rect) => rect.page === 1)).toBe(true);

    const spanning = map.nodes.find((node) => node.id === "spanning");
    expect(spanning).toBeDefined();
    if (spanning === undefined) return;
    const pages = [...new Set(spanning.rects.map((rect) => rect.page))].sort((a, b) => a - b);
    expect(pages).toContain(1);
    expect(pages).toContain(2);
    pages.forEach((page, index) => expect(page).toBe(index + 1));

    const verticallyOrdered = [...spanning.rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    expect(spanning.rects).toEqual(verticallyOrdered);
  }, 60_000);

  it("maps Japanese ltjsarticle text and a numbered equation", async (context) => {
    const latex = [
      String.raw`\documentclass{ltjsarticle}`,
      String.raw`\begin{document}`,
      "%%T64B:ja-para",
      "これは日本語の段落です。LuaTeX-ja は和文グルーを全行に挿入するため、SyncTeX の記録には由来不明のタグや行番号が混入しますが、細粒度レコードの多数決によって正しいノードに解決されるはずです。さらに文章を長くして、確実に複数行へ折り返されるようにします。",
      "%%T64E:ja-para",
      "",
      "%%T64B:ja-eq",
      String.raw`\begin{equation}`,
      "E = mc^2",
      String.raw`\end{equation}`,
      "%%T64E:ja-eq",
      String.raw`\end{document}`,
    ].join("\n");
    const ranges = scanMarkerRanges(latex);
    expect(ranges.map((range) => range.id)).toEqual(["ja-para", "ja-eq"]);

    const { synctex, log } = await compileWithSynctex(latex);
    if (synctex === null && log.includes("ltjsarticle.cls") && /not found/i.test(log)) {
      context.skip();
      return;
    }
    expect(synctex, log.slice(-2_000)).not.toBeNull();
    if (synctex === null) return;

    const map = buildRegionMap({ synctex, ranges });
    expect(map).not.toBeNull();
    if (map === null) return;
    expect(RegionMapSchema.safeParse(map).success).toBe(true);
    assertWithinA4(map);

    const paragraph = map.nodes.find((node) => node.id === "ja-para");
    const equation = map.nodes.find((node) => node.id === "ja-eq");
    expect(paragraph?.rects.length).toBeGreaterThan(0);
    expect(equation?.rects.length).toBeGreaterThan(0);
    if (paragraph === undefined || equation === undefined) return;
    const lastParagraphRect = paragraph.rects[paragraph.rects.length - 1];
    const equationRect = equation.rects[0];
    expect(lastParagraphRect).toBeDefined();
    expect(equationRect).toBeDefined();
    if (lastParagraphRect === undefined || equationRect === undefined) return;
    expect(equationRect.page).toBeGreaterThanOrEqual(lastParagraphRect.page);
    if (equationRect.page === lastParagraphRect.page) {
      expect(equationRect.y).toBeGreaterThan(lastParagraphRect.y);
    }
  }, 90_000);
});

/**
 * The production pipeline, end to end: a real DocumentModel through
 * renderDocumentToLatex → extractNodeLineRanges → lualatex → buildRegionMap
 * with `sourceText` (blank-line \par aliasing enabled), asserting that EVERY
 * node reaches the map. The final paragraph is the one that regressed: TeX
 * attributes its records to the line where \par fires, and with no blank line
 * before \end{document} that line sits outside every range, so the node
 * collected zero in-range votes and silently vanished from the map.
 */
describe.skipIf(!existsSync(LUALATEX_PATH))("region map covers every rendered node", () => {
  function documentEndingInAParagraph(): DocumentModel {
    const id = (suffix: string) => `50000000-0000-4000-8000-0000000000${suffix}`;
    return validateDocument({
      schemaVersion: 1,
      id: id("01"),
      metadata: {
        title: "領域マップの網羅性",
        language: "ja",
        documentType: "report",
        authors: [],
        keywords: [],
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
      root: [id("10"), id("20")],
      nodes: [
        {
          id: id("10"),
          type: "section",
          title: [{ type: "text", text: "はじめに", marks: [] }],
          children: [id("11"), id("12")],
        },
        {
          id: id("11"),
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "冒頭の段落です。複数行に折り返るだけの長さを確保して、行ボックスが確実に生成されるようにしています。",
              marks: [],
            },
          ],
        },
        {
          id: id("12"),
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "節の最後の段落です。ここも十分な長さの本文を入れて、SyncTeX の記録が確実に残るようにしています。",
              marks: [],
            },
          ],
        },
        {
          id: id("20"),
          type: "section",
          title: [{ type: "text", text: "まとめ", marks: [] }],
          children: [id("21")],
        },
        {
          id: id("21"),
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "文書全体の最終段落です。この段落の par は文書末で発火するため、領域マップから落ちやすい位置にあります。",
              marks: [],
            },
          ],
        },
      ],
    });
  }

  it("includes the final paragraph of the document", async () => {
    const document = documentEndingInAParagraph();
    const latex = renderDocumentToLatex(document);
    const ranges = extractNodeLineRanges(latex);
    expect(ranges.length).toBeGreaterThan(0);

    const { synctex, log } = await compileWithSynctex(latex);
    expect(synctex, log.slice(-2_000)).not.toBeNull();
    if (synctex === null) return;

    const map = buildRegionMap({ synctex, ranges, sourceText: latex });
    expect(map).not.toBeNull();
    if (map === null) return;
    expect(RegionMapSchema.safeParse(map).success).toBe(true);
    assertWithinA4(map);

    const mapped = new Set(map.nodes.filter((node) => node.rects.length > 0).map((node) => node.id));
    const missing = [...new Set(ranges.map((range) => range.id))].filter((id) => !mapped.has(id));
    expect(missing).toEqual([]);
  }, 90_000);
});
