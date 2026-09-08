import {
  LATEX_FILE_EXTENSIONS,
  getFileExtension,
  isEditableTextFilePath,
} from "../files.js";
import type { EditorGroupState } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";
import type { EditorSessionCoreOps } from "./core-ops.js";

const LANGUAGE_ID_ALIASES: Record<string, string> = {
  jsonc: "json", json5: "json",
  toml: "ini", conf: "ini", env: "ini", editorconfig: "ini",
  gitignore: "ini", gitattributes: "ini",
  zsh: "shell", fish: "shell",
  sass: "scss",
  vue: "html", svelte: "html", astro: "html", erb: "html",
  mm: "objective-c",
};

export type EditorSessionBufferOps = {
  getLanguageIdForPath: (path: string) => string;
  setEditorLanguage: (group: EditorGroupState, path: string) => void;
  clearEditorView: (group: EditorGroupState) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  handleCompositionEnd: (group: EditorGroupState) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  restoreViewState: (group: EditorGroupState, path: string) => void;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
};

export const createEditorSessionBufferOps = (
  runtime: EditorSessionRuntime,
  coreOps: EditorSessionCoreOps
): EditorSessionBufferOps => {
  let languageLookup: Map<string, string> | null = null;
  let registeredLanguageIds: Set<string> | null = null;

  const getLanguageIdForPath = (path: string) => {
    const ext = getFileExtension(path);
    if (ext === "bib") {
      return "bibtex";
    }
    if (LATEX_FILE_EXTENSIONS.has(ext)) {
      return "latex";
    }
    const monacoApi = runtime.deps.getMonacoApi() as {
      languages?: {
        getLanguages?: () => Array<{
          id: string;
          extensions?: string[];
          filenames?: string[];
        }>;
      };
    } | null;
    const languages = monacoApi?.languages?.getLanguages?.();
    if (!languages) {
      return "plaintext";
    }
    if (!languageLookup) {
      languageLookup = new Map<string, string>();
      registeredLanguageIds = new Set<string>();
      languages.forEach((language) => {
        registeredLanguageIds?.add(language.id);
        language.extensions?.forEach((extension) => {
          languageLookup?.set(`ext:${extension.toLowerCase()}`, language.id);
        });
        language.filenames?.forEach((filename) => {
          languageLookup?.set(`name:${filename}`, language.id);
        });
      });
    }
    const basename = path.split("/").pop() ?? path;
    const directMatch = languageLookup.get(`ext:.${ext.toLowerCase()}`) ??
      languageLookup.get(`name:${basename}`);
    if (directMatch) {
      return directMatch;
    }
    const alias = LANGUAGE_ID_ALIASES[ext.toLowerCase()] ??
      LANGUAGE_ID_ALIASES[basename.toLowerCase().replace(/^\./, "")];
    return alias && registeredLanguageIds?.has(alias) ? alias : "plaintext";
  };

  const setEditorLanguage = (group: EditorGroupState, path: string) => {
    const monacoApi = runtime.deps.getMonacoApi();
    if (!monacoApi || !group.editor) {
      return;
    }
    if (!isEditableTextFilePath(path)) {
      return;
    }
    const editor = group.editor as { getModel?: () => unknown };
    if (!editor.getModel) {
      return;
    }
    const model = editor.getModel();
    const monacoApiAny = monacoApi as {
      editor?: { setModelLanguage?: (model: unknown, languageId: string) => void };
    };
    const languageId = getLanguageIdForPath(path);
    if (model && monacoApiAny.editor?.setModelLanguage) {
      monacoApiAny.editor.setModelLanguage(model, languageId);
    }
  };

  const getEmptyEditorModel = () => {
    const monacoApi = runtime.deps.getMonacoApi();
    if (!monacoApi) {
      return null;
    }
    if (runtime.emptyEditorModel) {
      return runtime.emptyEditorModel;
    }
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    runtime.emptyEditorModel = monacoApiAny.editor.createModel("", "plaintext") as any;
    return runtime.emptyEditorModel;
  };

  const clearEditorView = (group: EditorGroupState) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { setModel?: (model: unknown) => void };
    const emptyModel = getEmptyEditorModel();
    if (emptyModel && editor.setModel) {
      editor.setModel(emptyModel as unknown);
    }
  };

  const scheduleAfterComposition = (group: EditorGroupState, action: () => void) => {
    if (!group.isComposing) {
      action();
      return;
    }
    // Blur will trigger compositionend which handles recovery
    group.pendingCompositionAction = action;
    const input = group.editorHost?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    input?.blur();
  };

  const handleCompositionEnd = (group: EditorGroupState) => {
    if (!group.pendingCompositionAction) {
      return;
    }
    const action = group.pendingCompositionAction;
    group.pendingCompositionAction = null;
    requestAnimationFrame(() => {
      action();
    });
  };

  const updateDirtyState = (path: string, content: string, savedContent?: string) => {
    const wasDirty = runtime.dirtyFiles.has(path);
    const entry = runtime.monacoModels.get(path);
    const groupSavedContent = Array.from(Object.values(runtime.editorGroups)).find(
      (group) => group.currentFilePath === path && group.currentFileSavedContent
    )?.currentFileSavedContent;
    const baseSaved = savedContent ?? entry?.savedContent ?? groupSavedContent;
    if (baseSaved === undefined) {
      // No saved reference exists — treat content itself as saved baseline
      // but do NOT overwrite an existing entry.savedContent.
      if (entry && entry.savedContent === undefined) {
        entry.savedContent = content;
      }
      runtime.dirtyFiles.delete(path);
    } else {
      if (entry) {
        entry.savedContent = baseSaved;
      }
      if (content !== baseSaved) {
        runtime.dirtyFiles.add(path);
      } else {
        runtime.dirtyFiles.delete(path);
      }
    }
    coreOps.forEachEditorGroup((group) => {
      if (group.currentFilePath === path) {
        group.isDirty = runtime.dirtyFiles.has(path);
      }
    });
    if (wasDirty !== runtime.dirtyFiles.has(path)) window.dispatchEvent(new Event("tex64:dirty-state-changed"));
  };

  const storeViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { saveViewState?: () => unknown };
    if (!editor.saveViewState) {
      return;
    }
    const viewState = editor.saveViewState();
    if (viewState) {
      group.viewStates.set(path, viewState);
    }
  };

  const restoreViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const viewState = group.viewStates.get(path);
    if (!viewState) {
      return;
    }
    const editor = group.editor as { restoreViewState?: (state: unknown) => void };
    editor.restoreViewState?.(viewState);
  };

  const cacheCurrentBuffer = (group: EditorGroupState) => {
    if (
      !group.currentFilePath ||
      !group.editor ||
      !isEditableTextFilePath(group.currentFilePath)
    ) {
      return;
    }
    const editor = group.editor as { getValue: () => string };
    const content = editor.getValue();
    updateDirtyState(group.currentFilePath, content);
    storeViewState(group, group.currentFilePath);
  };

  return {
    getLanguageIdForPath,
    setEditorLanguage,
    clearEditorView,
    scheduleAfterComposition,
    handleCompositionEnd,
    updateDirtyState,
    restoreViewState,
    cacheCurrentBuffer,
  };
};
