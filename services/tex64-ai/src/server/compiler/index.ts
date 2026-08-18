import type { DocumentCompiler } from "./types";
import { LocalLatexCompiler } from "./local-compiler";
import { VercelSandboxCompiler } from "./sandbox-compiler";
import {
  hasVercelRuntimeSignal,
  isProductionRuntime,
  isTrustedLocalWorkflowRuntime,
} from "@/server/config/runtime-environment";

export * from "./types";
export * from "./safety";

type CompilerBackend = "local" | "sandbox";
type CompilerEnvironment = Partial<Pick<
  NodeJS.ProcessEnv,
  | "TEX64_COMPILER"
  | "NODE_ENV"
  | "WORKFLOW_TARGET_WORLD"
  | "TEX64_LOCAL_DEVELOPMENT"
  | "VERCEL"
  | "VERCEL_ENV"
  | "VERCEL_DEPLOYMENT_ID"
>>;

export function getDocumentCompiler(): DocumentCompiler {
  return selectCompilerBackend(process.env) === "sandbox"
    ? new VercelSandboxCompiler()
    : new LocalLatexCompiler();
}

/**
 * Workflow DevKit builds step modules with production-like transforms even
 * while its execution world is local. WORKFLOW_TARGET_WORLD is therefore the
 * authoritative signal; NODE_ENV alone would incorrectly require Sandbox in
 * `next dev`.
 */
export function selectCompilerBackend(environment: CompilerEnvironment): CompilerBackend {
  const requested = environment.TEX64_COMPILER ?? "auto";
  if (!new Set(["auto", "local", "sandbox"]).has(requested)) {
    throw new Error(`Unknown TEX64_COMPILER mode: ${requested}`);
  }

  const isVercelWorld = hasVercelRuntimeSignal(environment);
  const isLocalWorkflowWorld = isTrustedLocalWorkflowRuntime(environment);

  if (requested === "sandbox") return "sandbox";
  if (requested === "local") {
    if (isVercelWorld || (isProductionRuntime(environment) && !isLocalWorkflowWorld)) {
      throw new Error("Local LaTeX compilation is disabled in production.");
    }
    return "local";
  }

  if (isLocalWorkflowWorld) return "local";
  if (isProductionRuntime(environment)) return "sandbox";
  return "local";
}
