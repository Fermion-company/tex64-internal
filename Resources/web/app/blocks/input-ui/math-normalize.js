import { normalizeLegacyEnvMarkers, normalizeMatrixSyntax, shouldWrapAligned, unwrapAligned, wrapAligned, } from "../input-ui-latex-format.js";
export const createMathValueOps = (runtime) => {
    const normalizeMathValueForOutput = (value) => {
        const resolved = runtime.state.mathFieldWrapped ? unwrapAligned(value).value : value;
        return normalizeMatrixSyntax(normalizeLegacyEnvMarkers(resolved));
    };
    const prepareMathValueForField = (value) => {
        if (!value) {
            return { value, wrapped: false };
        }
        const normalizedLegacy = normalizeLegacyEnvMarkers(value);
        const wrapped = shouldWrapAligned(normalizedLegacy);
        const withAlignedWrapper = wrapped ? wrapAligned(normalizedLegacy) : normalizedLegacy;
        return { value: withAlignedWrapper, wrapped };
    };
    return { normalizeMathValueForOutput, prepareMathValueForField };
};
