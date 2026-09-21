// Monaco's file URI is not an authority for the workspace path: Uri.file()
// turns a relative key such as content/ch16.tex into /content/ch16.tex. Keep
// the application path beside the model identity instead.
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
