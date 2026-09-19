// Monaco's file URI is not an authority for the workspace path: Uri.file()
// turns a relative key such as content/ch16.tex into /content/ch16.tex. Keep
// the application path beside the model identity instead.
const modelPaths = new WeakMap<object, string>();

export const rememberEditorModelPath = (model: unknown, path: string) => {
  if ((typeof model !== "object" || model === null) && typeof model !== "function") return;
  modelPaths.set(model as object, path);
};

export const getEditorModelPath = (model: unknown) => {
  if ((typeof model !== "object" || model === null) && typeof model !== "function") return null;
  return modelPaths.get(model as object) ?? null;
};
