// Keep the workspace-relative key alongside the model. Its file URI is an
// absolute path for texlab, and Monaco URIs do not change on file renames.
const modelPaths = new WeakMap();
export const rememberEditorModelPath = (model, path) => {
    if ((typeof model !== "object" || model === null) && typeof model !== "function")
        return;
    modelPaths.set(model, path);
};
export const getEditorModelPath = (model) => {
    var _a;
    if ((typeof model !== "object" || model === null) && typeof model !== "function")
        return null;
    return (_a = modelPaths.get(model)) !== null && _a !== void 0 ? _a : null;
};
