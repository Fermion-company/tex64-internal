"use client";

/** A desktop workspace session. `workspaceId` is stable; the generation is not. */
export type NativeWorkspaceIdentity = {
  workspaceId: string;
  workspaceRoot: string | null;
  workspaceGeneration: number;
};

export const EMPTY_WORKSPACE_IDENTITY: NativeWorkspaceIdentity = {
  workspaceId: "",
  workspaceRoot: null,
  workspaceGeneration: 0,
};

const finiteGeneration = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

export const normalizeWorkspaceMainFile = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
};

/** Reject absolute/traversing paths before putting them into a workspace URL. */
export const normalizeWorkspaceRelativePath = (value: unknown): string | null => {
  const normalized = normalizeWorkspaceMainFile(value);
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  return normalized;
};

/**
 * Reads the additive identity fields supplied by the desktop host.
 *
 * During a rolling upgrade an older host may omit them. In that case the root
 * itself is a stable, local-only fallback id and a root change advances a
 * client-side generation. Once the host fields are present they always win.
 */
export function workspaceIdentityFromHost(
  body: Record<string, unknown>,
  previous: NativeWorkspaceIdentity = EMPTY_WORKSPACE_IDENTITY,
): NativeWorkspaceIdentity {
  const hasRootPath = Object.prototype.hasOwnProperty.call(body, "rootPath");
  const workspaceRoot = hasRootPath
    ? typeof body.rootPath === "string" && body.rootPath.trim()
      ? body.rootPath
      : null
    : previous.workspaceRoot;
  const explicitGeneration = finiteGeneration(body.workspaceGeneration);
  const rootChanged = workspaceRoot !== previous.workspaceRoot;
  const workspaceGeneration =
    explicitGeneration ?? (rootChanged ? previous.workspaceGeneration + 1 : previous.workspaceGeneration);
  const explicitWorkspaceId =
    typeof body.workspaceId === "string" && body.workspaceId.trim()
      ? body.workspaceId.trim()
      : null;
  const workspaceId = workspaceRoot
    ? explicitWorkspaceId ??
      (!rootChanged && previous.workspaceId
        ? previous.workspaceId
        : `path:${workspaceRoot}`)
    : "";
  return { workspaceId, workspaceRoot, workspaceGeneration };
}

export const sameWorkspaceSession = (
  left: NativeWorkspaceIdentity,
  right: NativeWorkspaceIdentity,
): boolean =>
  left.workspaceId === right.workspaceId &&
  left.workspaceRoot === right.workspaceRoot &&
  left.workspaceGeneration === right.workspaceGeneration;

/** A late reply/event is usable only by the workspace session that requested it. */
export function replyMatchesWorkspace(
  body: Record<string, unknown>,
  expected: NativeWorkspaceIdentity,
): boolean {
  const generation = finiteGeneration(body.workspaceGeneration);
  if (generation !== null && generation !== expected.workspaceGeneration) return false;
  if (
    typeof body.workspaceId === "string" &&
    body.workspaceId.trim() &&
    body.workspaceId.trim() !== expected.workspaceId
  ) {
    return false;
  }
  return true;
}

export const workspaceStorageKey = (
  prefix: string,
  identity: NativeWorkspaceIdentity,
  mainFile?: string | null,
): string => {
  const workspacePart = encodeURIComponent(identity.workspaceId || identity.workspaceRoot || "none");
  const normalizedMain = normalizeWorkspaceMainFile(mainFile);
  return normalizedMain
    ? `${prefix}:${workspacePart}:${encodeURIComponent(normalizedMain)}`
    : `${prefix}:${workspacePart}`;
};

export const workspaceRequestFields = (identity: NativeWorkspaceIdentity) => ({
  workspaceId: identity.workspaceId,
  workspaceGeneration: identity.workspaceGeneration,
});
