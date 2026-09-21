import { readMathFieldValue } from "../input-ui-math-field.js";
import { normalizeLegacyEnvMarkers, shouldWrapAligned, stripEmptyAlignedRows, unwrapAligned } from "../input-ui-latex-format.js";
import { attachMathfieldController } from "../../../math/wysiwyg/field-controller.js";
export const createBlockMathfieldEventsOps = (runtime, deps) => ({
    attachMathFieldEvents(mathfield) {
        const syncMathFieldValue = () => {
            try {
                const rawValue = normalizeLegacyEnvMarkers(readMathFieldValue(mathfield));
                if (runtime.state.mathFieldWrapped) {
                    const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
                    if (didUnwrap) {
                        const trimmed = stripEmptyAlignedRows(unwrapped);
                        runtime.state.currentMathValue = trimmed !== unwrapped ? trimmed : unwrapped;
                        return;
                    }
                    runtime.state.mathFieldWrapped = false;
                }
                runtime.state.mathFieldWrapped = shouldWrapAligned(rawValue);
                runtime.state.currentMathValue = rawValue;
            }
            catch {
                // Ensure we never lose the current value due to a processing error.
                // readMathFieldValue already has its own fallbacks, so this is a last-resort guard.
            }
        };
        mathfield.addEventListener("input", syncMathFieldValue);
        mathfield.addEventListener("change", syncMathFieldValue);
        if (runtime.state.mathWysiwygApi)
            attachMathfieldController(mathfield, runtime.state.mathWysiwygApi, deps.insertMathKey, () => mathfield.blur());
    },
});
