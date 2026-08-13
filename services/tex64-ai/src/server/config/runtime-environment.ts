export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function hasVercelRuntimeSignal(environment: RuntimeEnvironment): boolean {
  return (
    environment.VERCEL === "1" ||
    Boolean(environment.VERCEL_ENV?.trim()) ||
    Boolean(environment.VERCEL_DEPLOYMENT_ID?.trim()) ||
    environment.WORKFLOW_TARGET_WORLD === "vercel"
  );
}

/**
 * Workflow's local world production-transforms step modules during development.
 * Only the repository's `npm run dev` script sets the explicit development
 * marker; a bare `WORKFLOW_TARGET_WORLD=local` is never trusted.
 */
export function isTrustedLocalWorkflowRuntime(
  environment: RuntimeEnvironment,
): boolean {
  return (
    environment.WORKFLOW_TARGET_WORLD === "local" &&
    environment.TEX64_LOCAL_DEVELOPMENT === "true" &&
    !hasVercelRuntimeSignal(environment)
  );
}

export function isProductionRuntime(environment: RuntimeEnvironment): boolean {
  if (hasVercelRuntimeSignal(environment)) return true;
  if (isTrustedLocalWorkflowRuntime(environment)) return false;
  return environment.NODE_ENV === "production";
}
