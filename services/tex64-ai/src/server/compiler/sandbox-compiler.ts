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

const COMPILE_TIMEOUT_MS = 45_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SYNCTEX_BYTES = 16 * 1024 * 1024;
const SANDBOX_ROOT = "/vercel/sandbox";

export class VercelSandboxCompiler implements DocumentCompiler {
  readonly image: string;

  constructor(image = process.env.TEX64_SANDBOX_IMAGE) {
    if (!image?.trim()) {
      throw new Error("TEX64_SANDBOX_IMAGE is required for isolated production compilation.");
    }
    this.image = image.trim();
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    assertSafeGeneratedLatex(request.latex);
    const startedAt = Date.now();
    // The Sandbox client probes local CLI paths at module initialization.
    // Load it only inside the runtime step so Next.js page-data collection
    // never executes that Node-specific initialization.
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.create({
      image: this.image,
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: 2 },
      timeout: 120_000,
      tags: {
        service: "tex64-ai",
        purpose: "typeset",
      },
    });

    try {
      await Promise.all([
        sandbox.mkDir(`${SANDBOX_ROOT}/.texmf-cache`),
        sandbox.mkDir(`${SANDBOX_ROOT}/.texmf-config`),
      ]);
      await sandbox.writeFiles([
        { path: `${SANDBOX_ROOT}/main.tex`, content: request.latex, mode: 0o600 },
      ]);
      let output = "";
      let finalPassOutput = "";
      for (let pass = 0; pass < 2; pass += 1) {
        const command = await sandbox.runCommand({
          cmd: "lualatex",
          args: [
            "-no-shell-escape",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-synctex=1",
            `-output-directory=${SANDBOX_ROOT}`,
            "main.tex",
          ],
          cwd: SANDBOX_ROOT,
          env: {
            openout_any: "p",
            shell_escape: "f",
            HOME: SANDBOX_ROOT,
            TMPDIR: SANDBOX_ROOT,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            TZ: "UTC",
            SOURCE_DATE_EPOCH: "946684800",
            FORCE_SOURCE_DATE: "1",
            TEXMFCACHE: `${SANDBOX_ROOT}/.texmf-cache`,
            TEXMFVAR: `${SANDBOX_ROOT}/.texmf-cache`,
            TEXMFCONFIG: `${SANDBOX_ROOT}/.texmf-config`,
          },
          timeoutMs: COMPILE_TIMEOUT_MS,
        });
        const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
        finalPassOutput = `${stdout}\n${stderr}\n`;
        output = appendBoundedOutput(output, finalPassOutput);
        if (command.exitCode !== 0) {
          const diagnostics = parseLatexDiagnostics(output);
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
      const sizeCommand = await sandbox.runCommand({
        cmd: "stat",
        args: ["-c", "%s", "main.pdf"],
        cwd: SANDBOX_ROOT,
        timeoutMs: 5_000,
      });
      const sizeOutput = (await sizeCommand.stdout()).trim();
      const byteSize = Number(sizeOutput);
      if (
        sizeCommand.exitCode !== 0 ||
        !Number.isSafeInteger(byteSize) ||
        byteSize < 0
      ) {
        throw missingArtifactFailure();
      }
      if (byteSize > MAX_PDF_ARTIFACT_BYTES) {
        throw new CompileFailure("生成されたPDFが上限を超えました。", [
          {
            severity: "error",
            code: "artifact_too_large",
            message: "完成した文書が大きすぎます。",
          },
        ]);
      }

      const infoCommand = await sandbox.runCommand({
        cmd: "pdfinfo",
        args: ["main.pdf"],
        cwd: SANDBOX_ROOT,
        timeoutMs: 5_000,
      });
      if (infoCommand.exitCode !== 0) {
        throw missingArtifactFailure();
      }
      const pageCount = parsePdfPageCount(await infoCommand.stdout());

      const textCommand = await sandbox.runCommand({
        cmd: "pdftotext",
        args: ["-layout", "main.pdf", "-"],
        cwd: SANDBOX_ROOT,
        timeoutMs: 10_000,
      });
      if (textCommand.exitCode !== 0) {
        throw pdfTextInspectionFailure();
      }
      assertNoBlankPdfPages(await textCommand.stdout(), pageCount);

      const pdf = await sandbox.readFileToBuffer({ path: `${SANDBOX_ROOT}/main.pdf` });
      if (!pdf) {
        throw missingArtifactFailure();
      }
      assertValidPdfArtifact(pdf);

      // Best-effort: the element map degrades to none when SyncTeX is absent
      // or implausibly large (same 16 MiB bound as the local compiler).
      const synctexRead = await sandbox
        .readFileToBuffer({ path: `${SANDBOX_ROOT}/main.synctex.gz` })
        .catch(() => undefined);
      const synctex =
        synctexRead && synctexRead.byteLength <= MAX_SYNCTEX_BYTES
          ? synctexRead
          : undefined;

      return {
        pdf,
        engine: "vercel-sandbox",
        durationMs: Date.now() - startedAt,
        pageCount,
        diagnostics: finalDiagnostics.filter(
          (item) => item.severity === "warning",
        ),
        ...(synctex ? { synctex } : {}),
      };
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  }
}

function appendBoundedOutput(current: string, next: string): string {
  if (current.length >= MAX_LOG_BYTES) return current;
  return `${current}${next}`.slice(0, MAX_LOG_BYTES);
}

function missingArtifactFailure(): CompileFailure {
  return new CompileFailure("PDFを生成できませんでした。", [
    {
      severity: "error",
      code: "missing_artifact",
      message: "完成した文書を取得できませんでした。",
    },
  ]);
}

function pdfTextInspectionFailure(): CompileFailure {
  return new CompileFailure("PDFの本文を確認できませんでした。", [
    {
      severity: "error",
      code: "pdf_text_inspection_failed",
      message: "完成した文書の各ページを確認できませんでした。",
    },
  ]);
}
