import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  MAX_PDF_ARTIFACT_BYTES,
  assertNoBlankPdfPages,
  assertNoBlockingTypesettingDiagnostics,
  assertSafeGeneratedLatex,
  assertValidPdfArtifact,
  parseLatexDiagnostics,
  parsePdfPageCount,
} from "./safety";
import { CompileFailure, type CompileRequest, type CompileResult, type DocumentCompiler } from "./types";

const execFileAsync = promisify(execFile);
const COMPILE_TIMEOUT_MS = 45_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
export class LocalLatexCompiler implements DocumentCompiler {
  async compile(request: CompileRequest): Promise<CompileResult> {
    assertSafeGeneratedLatex(request.latex);
    const startedAt = Date.now();
    const workDir = await mkdtemp(path.join(tmpdir(), "tex64-ai-compile-"));
    const sourcePath = path.join(workDir, "main.tex");
    const cachePath = path.join(workDir, ".texmf-cache");
    const configPath = path.join(workDir, ".texmf-config");

    try {
      await Promise.all([
        mkdir(cachePath, { recursive: true, mode: 0o700 }),
        mkdir(configPath, { recursive: true, mode: 0o700 }),
      ]);
      await writeFile(sourcePath, request.latex, { encoding: "utf8", mode: 0o600 });
      let output = "";
      let finalPassOutput = "";

      for (let pass = 0; pass < 2; pass += 1) {
        try {
          const result = await execFileAsync(
            resolveLatexExecutable(),
            [
              "-no-shell-escape",
              "-interaction=nonstopmode",
              "-halt-on-error",
              "-file-line-error",
              "-synctex=1",
              `-output-directory=${workDir}`,
              "main.tex",
            ],
            {
              cwd: workDir,
              timeout: COMPILE_TIMEOUT_MS,
              maxBuffer: MAX_LOG_BYTES,
              killSignal: "SIGKILL",
              windowsHide: true,
              env: createLatexChildEnvironment({
                workDir,
                cachePath,
                configPath,
              }),
            },
          );
          finalPassOutput = `${result.stdout}\n${result.stderr}\n`;
          output = appendBoundedOutput(output, finalPassOutput);
        } catch (error) {
          const detail = readProcessOutput(error);
          const diagnostics = parseLatexDiagnostics(`${output}\n${detail}`);
          throw new CompileFailure(
            "文書を整形できませんでした。内容を見直して再試行します。",
            diagnostics.length > 0
              ? diagnostics
              : [{ severity: "error", code: "compile_failed", message: "文書の整形に失敗しました。" }],
          );
        }
      }

      const finalDiagnostics =
        assertNoBlockingTypesettingDiagnostics(finalPassOutput);
      const pdfPath = path.join(workDir, "main.pdf");
      const pdf = await readGeneratedPdf(pdfPath);
      assertValidPdfArtifact(pdf);
      const pageCount = await readPdfPageCount({
        pdfPath,
        workDir,
        cachePath,
        configPath,
      });
      await inspectPdfText({
        pdfPath,
        pageCount,
        workDir,
        cachePath,
        configPath,
      });
      const synctex = await readOptionalSynctex(
        path.join(workDir, "main.synctex.gz"),
      );
      return {
        pdf,
        engine: "local-lualatex",
        durationMs: Date.now() - startedAt,
        pageCount,
        diagnostics: finalDiagnostics.filter(
          (item) => item.severity === "warning",
        ),
        ...(synctex ? { synctex } : {}),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function inspectPdfText(input: {
  pdfPath: string;
  pageCount: number;
  workDir: string;
  cachePath: string;
  configPath: string;
}): Promise<void> {
  try {
    const result = await execFileAsync(
      "pdftotext",
      ["-layout", input.pdfPath, "-"],
      {
        cwd: input.workDir,
        timeout: 10_000,
        maxBuffer: MAX_LOG_BYTES,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: createLatexChildEnvironment({
          workDir: input.workDir,
          cachePath: input.cachePath,
          configPath: input.configPath,
        }),
      },
    );
    assertNoBlankPdfPages(result.stdout, input.pageCount);
  } catch (error) {
    if (error instanceof CompileFailure) throw error;
    throw new CompileFailure("PDFの本文を確認できませんでした。", [
      {
        severity: "error",
        code: "pdf_text_inspection_failed",
        message: "完成した文書の各ページを確認できませんでした。",
      },
    ]);
  }
}

async function readPdfPageCount(input: {
  pdfPath: string;
  workDir: string;
  cachePath: string;
  configPath: string;
}): Promise<number> {
  try {
    const result = await execFileAsync("pdfinfo", [input.pdfPath], {
      cwd: input.workDir,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: createLatexChildEnvironment({
        workDir: input.workDir,
        cachePath: input.cachePath,
        configPath: input.configPath,
      }),
    });
    return parsePdfPageCount(result.stdout);
  } catch (error) {
    if (error instanceof CompileFailure) throw error;
    throw new CompileFailure("PDFのページ構成を確認できませんでした。", [
      {
        severity: "error",
        code: "pdf_inspection_failed",
        message: "完成した文書のページ構成を確認できませんでした。",
      },
    ]);
  }
}

type LatexChildEnvironmentInput = {
  workDir: string;
  cachePath: string;
  configPath: string;
  parentEnvironment?: NodeJS.ProcessEnv;
};

/** Explicit allowlist: provider keys, database URLs, and session secrets are never inherited. */
export function createLatexChildEnvironment({
  workDir,
  cachePath,
  configPath,
  parentEnvironment = process.env,
}: LatexChildEnvironmentInput): NodeJS.ProcessEnv {
  return {
    PATH: parentEnvironment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: "946684800",
    FORCE_SOURCE_DATE: "1",
    openout_any: "p",
    shell_escape: "f",
    TEXMFCACHE: cachePath,
    TEXMFVAR: cachePath,
    TEXMFCONFIG: configPath,
  };
}

function resolveLatexExecutable(environment = process.env): string {
  return (
    environment.TEX64_LUALATEX_PATH ??
    (process.platform === "darwin" ? "/Library/TeX/texbin/lualatex" : "lualatex")
  );
}

async function readGeneratedPdf(pdfPath: string): Promise<Buffer> {
  try {
    const metadata = await stat(pdfPath);
    if (!metadata.isFile()) throw new Error("Generated PDF is not a regular file.");
    if (metadata.size > MAX_PDF_ARTIFACT_BYTES) {
      throw new CompileFailure("生成されたPDFが上限を超えました。", [
        {
          severity: "error",
          code: "artifact_too_large",
          message: "完成した文書が大きすぎます。",
        },
      ]);
    }
    return await readFile(pdfPath);
  } catch (error) {
    if (error instanceof CompileFailure) throw error;
    throw new CompileFailure("PDFを生成できませんでした。", [
      {
        severity: "error",
        code: "missing_artifact",
        message: "完成した文書を取得できませんでした。",
      },
    ]);
  }
}

const MAX_SYNCTEX_BYTES = 16 * 1024 * 1024;

async function readOptionalSynctex(
  synctexPath: string,
): Promise<Uint8Array | undefined> {
  try {
    const metadata = await stat(synctexPath);
    if (!metadata.isFile() || metadata.size > MAX_SYNCTEX_BYTES) return undefined;
    return await readFile(synctexPath);
  } catch {
    return undefined;
  }
}

function readProcessOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return [candidate.stdout?.toString(), candidate.stderr?.toString(), candidate.message]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, MAX_LOG_BYTES);
}

function appendBoundedOutput(current: string, next: string): string {
  if (current.length >= MAX_LOG_BYTES) return current;
  return `${current}${next}`.slice(0, MAX_LOG_BYTES);
}
