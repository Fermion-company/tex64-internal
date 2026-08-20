const SUPPORTED_INTERNAL_VERSION_PREFIX = "0.108.";
const normalizeMode = (value) => {
    if (value === "math" || value === "text" || value === "latex") {
        return value;
    }
    return null;
};
const resolveMathfieldVersion = (mathfieldApi) => {
    var _a, _b;
    const globalScope = globalThis;
    const candidate = (_b = (mathfieldApi && typeof mathfieldApi.version === "string"
        ? mathfieldApi.version
        : (_a = globalScope === null || globalScope === void 0 ? void 0 : globalScope.MathLive) === null || _a === void 0 ? void 0 : _a.version)) !== null && _b !== void 0 ? _b : null;
    return typeof candidate === "string" ? candidate : null;
};
export const canUseMathfieldInternalApi = (mathfieldApi) => {
    const version = resolveMathfieldVersion(mathfieldApi);
    if (!version) {
        return true;
    }
    return version.startsWith(SUPPORTED_INTERNAL_VERSION_PREFIX);
};
const getInternalMathfield = (mathfieldApi) => {
    if (!canUseMathfieldInternalApi(mathfieldApi)) {
        return null;
    }
    const internal = mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi._mathfield;
    return internal && typeof internal === "object" ? internal : null;
};
export const getMathfieldInternalModel = (mathfieldApi) => {
    const internal = getInternalMathfield(mathfieldApi);
    const model = internal === null || internal === void 0 ? void 0 : internal.model;
    return model && typeof model === "object" ? model : null;
};
const getMathfieldInternalMenu = (mathfieldApi) => {
    const internal = getInternalMathfield(mathfieldApi);
    const menu = internal === null || internal === void 0 ? void 0 : internal.menu;
    return menu && typeof menu === "object" ? menu : null;
};
export const closeMathfieldInternalMenu = (mathfieldApi) => {
    var _a;
    const menu = getMathfieldInternalMenu(mathfieldApi);
    if (!menu || typeof menu.hide !== "function") {
        return false;
    }
    if (menu.state && menu.state !== "closed") {
        menu.hide();
        return true;
    }
    if ((_a = menu.element) === null || _a === void 0 ? void 0 : _a.isConnected) {
        menu.hide();
        return true;
    }
    return false;
};
export const getMathfieldModeAtOffset = (mathfieldApi, offset) => {
    const model = getMathfieldInternalModel(mathfieldApi);
    if (!model || typeof model.at !== "function") {
        return null;
    }
    try {
        const atom = model.at(offset);
        return normalizeMode(atom === null || atom === void 0 ? void 0 : atom.mode);
    }
    catch {
        return null;
    }
};
export const setMathfieldMode = (mathfieldApi, nextMode) => {
    const model = getMathfieldInternalModel(mathfieldApi);
    if (model) {
        try {
            model.mode = nextMode;
            return true;
        }
        catch {
            // fallback to public mode setter
        }
    }
    try {
        mathfieldApi.mode = nextMode;
    }
    catch {
        return false;
    }
    return normalizeMode(mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === nextMode;
};
export const isMathfieldSelectionPlaceholder = (mathfieldApi) => {
    const model = getMathfieldInternalModel(mathfieldApi);
    return Boolean(model === null || model === void 0 ? void 0 : model.selectionIsPlaceholder);
};
