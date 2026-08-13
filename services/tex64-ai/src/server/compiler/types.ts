export type CompileDiagnostic = {
  severity: "warning" | "error";
  code: string;
  message: string;
  line?: number;
};

export type CompileRequest = {
  userId: string;
  documentId: string;
  revision: number;
  latex: string;
};

export type CompileResult = {
  pdf: Uint8Array;
  engine: "local-lualatex" | "vercel-sandbox";
  durationMs: number;
  pageCount: number;
  diagnostics: CompileDiagnostic[];
  /**
   * Raw SyncTeX output (.synctex.gz bytes) for the PDF element map.
   * Best-effort: absent when the engine produced none; never fails a compile.
   */
  synctex?: Uint8Array;
};

export interface DocumentCompiler {
  compile(request: CompileRequest): Promise<CompileResult>;
}

export class CompileFailure extends Error {
  readonly diagnostics: CompileDiagnostic[];

  constructor(message: string, diagnostics: CompileDiagnostic[]) {
    super(message);
    this.name = "CompileFailure";
    this.diagnostics = diagnostics;
  }
}
