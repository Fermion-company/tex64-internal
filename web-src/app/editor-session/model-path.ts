// Keep the workspace-relative key alongside the model. Its file URI is an
// absolute path for texlab, and Monaco URIs do not change on file renames.
const modelPaths = new WeakMap<object, string>();

export const rememberEditorModelPath = (model: unknown, path: string) => {
  if ((typeof model !== "object" || model === null) && typeof model !== "function") return;
  modelPaths.set(model as object, path);
};

export const getEditorModelPath = (model: unknown) => {
  if ((typeof model !== "object" || model === null) && typeof model !== "function") return null;
  return modelPaths.get(model as object) ?? null;
};
