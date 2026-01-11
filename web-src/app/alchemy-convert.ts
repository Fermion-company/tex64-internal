import type { AppContext } from "./context.js";
import type { EditorSessionApi } from "./editor-session.js";
import type { IssuesStatus, IssueItem } from "./types.js";
import { formatSnippetForInsert } from "./blocks/format.js";
import { buildTextSnippet } from "./snippet-builders.js";
import { recognizeImage } from "./ocr.js";

export type AlchemySettings = {
  ocrLanguage: string;
};

type AlchemyConvertDeps = {
  editorSession: EditorSessionApi;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  getMonacoApi: () => Record<string, unknown> | null;
  onSettingsChange?: (settings: AlchemySettings) => void;
  onCaptureRequest?: () => void;
};

export type AlchemyConvertApi = {
  setSettings: (settings: Partial<AlchemySettings>) => void;
  getSettings: () => AlchemySettings;
  handleCaptureImage: (imageDataUrl: string) => void;
  setStatus: (message: string) => void;
};

const ensureSelectValue = (select: HTMLSelectElement | null, value: string) => {
  if (!select) return;
  const options = Array.from(select.options);
  if (!options.some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = value;
};

export const initAlchemyConvert = (
  context: AppContext,
  deps: AlchemyConvertDeps
): AlchemyConvertApi => {
  const {
    alchemyPanel,
    alchemySettingsButton,
    alchemySettings,
    alchemyCaptureButton,
    alchemyStatusLine,
    alchemyOcrLanguage,
  } = context.dom;

  let settingsOpen = false;
  let busy = false;

  const setStatus = (message: string) => {
    if (alchemyStatusLine instanceof HTMLElement) {
      alchemyStatusLine.textContent = message;
    }
  };

  const setBusy = (value: boolean) => {
    busy = value;
    if (alchemyCaptureButton instanceof HTMLButtonElement) {
      alchemyCaptureButton.disabled = value;
    }
  };

  const getSettings = (): AlchemySettings => ({
    ocrLanguage:
      (alchemyOcrLanguage instanceof HTMLSelectElement && alchemyOcrLanguage.value) ||
      "jpn+eng",
  });

  const setSettings = (settings: Partial<AlchemySettings>) => {
    if (settings.ocrLanguage) {
      ensureSelectValue(alchemyOcrLanguage as HTMLSelectElement | null, settings.ocrLanguage);
    }
  };

  const emitSettingsChange = () => {
    deps.onSettingsChange?.(getSettings());
  };

  const insertSnippet = (snippet: string) => {
    const activeGroup = deps.editorSession.getActiveGroup();
    if (
      !activeGroup.editor ||
      !activeGroup.currentFilePath ||
      !activeGroup.currentFilePath.endsWith(".tex")
    ) {
      deps.updateIssues(1, "貼り付けは .tex ファイルで行ってください。", "error", [
        { severity: "error", message: "貼り付けは .tex ファイルで行ってください。" },
      ]);
      return false;
    }
    const editor = activeGroup.editor as {
      executeEdits?: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus?: () => void;
      getPosition?: () => { lineNumber: number; column: number } | null;
      getSelection?: () => {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      } | null;
      getModel?: () => {
        getLineContent?: (lineNumber: number) => string;
      };
    };
    const monaco = deps.getMonacoApi() as {
      Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    if (!monaco?.Range) {
      deps.updateIssues(1, "エディタの準備が完了していません。", "error", [
        { severity: "error", message: "エディタの準備が完了していません。" },
      ]);
      return false;
    }
    const selection = editor.getSelection?.();
    const position = editor.getPosition?.() ?? { lineNumber: 1, column: 1 };
    const insertPosition = selection
      ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
      : position;
    const model = editor.getModel?.();
    const formatted = formatSnippetForInsert(snippet, model, insertPosition);
    const range = selection
      ? new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        )
      : new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column
        );
    editor.executeEdits?.("alchemy-capture-insert", [
      { range, text: formatted, forceMoveMarkers: true },
    ]);
    editor.focus?.();
    return true;
  };

  const handleCaptureImage = (imageDataUrl: string) => {
    if (busy) return;
    if (!imageDataUrl) {
      setStatus("キャプチャ画像がありません。");
      return;
    }
    setBusy(true);
    setStatus("OCR中...");
    const settings = getSettings();
    recognizeImage(imageDataUrl, { language: settings.ocrLanguage || "eng" })
      .then((result) => {
        const text = result.text?.trim() ?? "";
        if (!text) {
          const message = "OCR結果が空でした。";
          deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
          setStatus(message);
          return;
        }
        const snippet = buildTextSnippet(text, "plain");
        if (!snippet) {
          const message = "変換結果がありません。";
          deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
          setStatus(message);
          return;
        }
        const ok = insertSnippet(snippet);
        if (!ok) {
          setStatus("挿入に失敗しました。");
          return;
        }
        setStatus("挿入しました。");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "OCRに失敗しました。";
        deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        setStatus(message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (alchemySettingsButton instanceof HTMLElement) {
    alchemySettingsButton.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      if (alchemySettings instanceof HTMLElement) {
        alchemySettings.classList.toggle("is-open", settingsOpen);
        alchemySettings.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
      }
    });
  }

  if (alchemyOcrLanguage instanceof HTMLSelectElement) {
    alchemyOcrLanguage.addEventListener("change", emitSettingsChange);
  }

  if (alchemyCaptureButton instanceof HTMLElement) {
    alchemyCaptureButton.addEventListener("click", () => {
      setStatus("ウィンドウを選択してください。");
      deps.onCaptureRequest?.();
    });
  }

  if (alchemyPanel instanceof HTMLElement) {
    alchemyPanel.classList.toggle("is-open", true);
  }

  return {
    setSettings,
    getSettings,
    handleCaptureImage,
    setStatus,
  };
};
