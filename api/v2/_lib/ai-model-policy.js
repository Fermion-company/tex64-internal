import { ApiError } from "./http.js";

export const AXIOM_STANDARD_MODEL = "Axiom1.0";
export const AXIOM_PRO_MODEL = "Axiom1.0-pro";

const PUBLIC_MODELS = new Set([AXIOM_STANDARD_MODEL, AXIOM_PRO_MODEL]);

/**
 * Resolve the public Axiom model to the provider model kept on the server.
 * Provider model ids must never be accepted from, or returned to, the app.
 */
export const resolveAxiomModel = ({ requestedModel, subscription, config }) => {
  const publicModel =
    typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (!PUBLIC_MODELS.has(publicModel)) {
    throw new ApiError(
      "MODEL_NOT_SUPPORTED",
      "The selected Axiom model is not supported.",
      400
    );
  }
  if (publicModel === AXIOM_PRO_MODEL && subscription?.plan !== "pro") {
    throw new ApiError(
      "MODEL_PLAN_REQUIRED",
      "Axiom 1.0 Pro requires the Pro plan.",
      403
    );
  }

  const configuredModel =
    publicModel === AXIOM_PRO_MODEL
      ? config?.axiomProModel
      : config?.axiomStandardModel;
  const upstreamModel =
    typeof configuredModel === "string" ? configuredModel.trim() : "";
  if (!upstreamModel) {
    throw new ApiError(
      "LLM_NOT_CONFIGURED",
      "The selected Axiom model is not configured on the server.",
      503
    );
  }
  return { publicModel, upstreamModel };
};

export const maskAxiomResponseModel = (value, publicModel) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return { ...value, model: publicModel };
};
