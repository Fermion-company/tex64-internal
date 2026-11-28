import {
  normalizeLegacyEnvMarkers,
  shouldWrapAligned,
  stripMathLivePlaceholders,
  unwrapAligned,
  wrapAligned,
} from "../input-ui-latex-format.js";
import type { BlockInputRuntime } from "./runtime.js";

export type MathValueOps = {
  normalizeMathValueForOutput: (value: string) => string;
  prepareMathValueForField: (value: string) => { value: string; wrapped: boolean };
};

export const createMathValueOps = (runtime: BlockInputRuntime): MathValueOps => {
  const normalizeMathValueForOutput = (value: string) => {
    const resolved = runtime.state.mathFieldWrapped ? unwrapAligned(value).value : value;
    // Matrix dimensions come from explicit TeX row and cell separators.
    // Adjacent braced groups can all belong to one mathematical cell.
    return stripMathLivePlaceholders(normalizeLegacyEnvMarkers(resolved));
  };

  const prepareMathValueForField = (value: string) => {
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
