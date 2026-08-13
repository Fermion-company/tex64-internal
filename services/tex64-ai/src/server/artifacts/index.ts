import type { ArtifactStore } from "./types";
import { BlobArtifactStore } from "./blob-artifact-store";
import { LocalArtifactStore } from "./local-artifact-store";
import {
  hasVercelRuntimeSignal,
  isProductionRuntime,
  isTrustedLocalWorkflowRuntime,
} from "@/server/config/runtime-environment";

export * from "./types";
export * from "./verification";
export * from "./release";

type ArtifactBackend = "local" | "blob";
type ArtifactEnvironment = Partial<Pick<
  NodeJS.ProcessEnv,
  | "NODE_ENV"
  | "WORKFLOW_TARGET_WORLD"
  | "TEX64_LOCAL_DEVELOPMENT"
  | "VERCEL"
  | "VERCEL_ENV"
  | "VERCEL_DEPLOYMENT_ID"
  | "BLOB_READ_WRITE_TOKEN"
>>;

export function getArtifactStore(): ArtifactStore {
  const backend = selectArtifactBackend(process.env);
  const hasBlobCredentials = Boolean(
    hasVercelRuntimeSignal(process.env) ||
      process.env.BLOB_READ_WRITE_TOKEN?.trim(),
  );
  if (backend === "blob" && !hasBlobCredentials) {
    throw new Error("Vercel Blob credentials are required in hosted production.");
  }
  return backend === "blob" ? new BlobArtifactStore() : new LocalArtifactStore();
}

/** Keep local Workflow runs on disk even when step code is production-transformed. */
export function selectArtifactBackend(environment: ArtifactEnvironment): ArtifactBackend {
  if (isTrustedLocalWorkflowRuntime(environment)) return "local";
  if (isProductionRuntime(environment)) return "blob";
  return "local";
}
