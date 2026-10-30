/**
 * Voice edit: speak a short instruction in the editor and it goes to Axiom
 * at once, with the selection (or the paragraph around the cursor) as its
 * context. Axiom's edit then takes the usual diff / apply path.
 *
 * The command toggles recording. While it runs, a small pill floats at the
 * end of the selection with the elapsed time and a stop control; the
 * command again, the stop control or Esc ends it. The clip is transcribed
 * by the host (`agent:transcribe`, like the composer microphone) and the
 * words are sent as they are. Nothing is sent when nothing was heard.
 */

import { aiText } from "./ai-i18n.js";
import { getUiLocale, uiText } from "./i18n.js";
import { showEditorNotice } from "./editor-notice.js";
import { createVoiceRecorder, formatVoiceClock, isVoiceRecordingSupported } from "./voice-recorder.js";
import type { VoiceInstructionSelection } from "./ai-chat-ui.js";

type VoiceEditDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  /** Opens the Axiom tab and sends the words with the selection as context. */
  sendInstruction: (text: string, selection: VoiceInstructionSelection | null) => void;
};

type EditorFile = {
  getFilePath: () => string | null;
  isDirty: () => boolean;
  /** The pill takes the Ask button's place while it is up. */
  onPillChange?: (shown: boolean) => void;
};

export type VoiceEditController = {
  attachEditor: (monaco: any, editor: any, file: EditorFile) => void;
  /** True for the transcriptions this controller asked for. */
  ownsRequest: (requestId: unknown) => boolean;
  handleTranscribeResult: (payload: { requestId?: string; ok?: boolean; text?: string; error?: string; code?: string }) => void;
};

const REQUEST_PREFIX = "voice-edit-";
const CONTEXT_KEY = "tex64VoiceRecording";
const NOTICE_OWNER = "voice-edit";

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty?: () => boolean };

const isTexPath = (path: string | null) => typeof path === "string" && path.endsWith(".tex");

/** The blank-line delimited paragraph around a line; null on a blank line. */
const paragraphAround = (model: any, lineNumber: number) => {
  const lineCount: number = model.getLineCount();
  const isBlank = (line: number) => /^\s*$/.test(model.getLineContent(line));
  if (lineNumber < 1 || lineNumber > lineCount || isBlank(lineNumber)) return null;
  let start = lineNumber;
  while (start > 1 && !isBlank(start - 1)) start -= 1;
  let end = lineNumber;
  while (end < lineCount && !isBlank(end + 1)) end += 1;
  return {
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: end,
    endColumn: model.getLineMaxColumn(end),
  } as Range;
};

export const createVoiceEditController = (deps: VoiceEditDeps): VoiceEditController => {
  type Session = {
    editor: any;
    widget: { getId: () => string; getDomNode: () => HTMLElement; getPosition: () => unknown };
    selection: VoiceInstructionSelection | null;
    setRecordingKey: (value: boolean) => void;
    onPillChange?: (shown: boolean) => void;
    timeEl: HTMLElement;
    stopEl: HTMLButtonElement;
    node: HTMLElement;
  };
  let session: Session | null = null;
  let pendingRequestId: string | null = null;

  const notice = (message: string) => {
    showEditorNotice(null, message, { tone: "error", owner: NOTICE_OWNER });
  };

  const removePill = () => {
    if (!session) return;
    const ended = session;
    session = null;
    ended.editor.removeContentWidget?.(ended.widget);
    ended.setRecordingKey(false);
    ended.onPillChange?.(false);
  };

  const recorder = createVoiceRecorder({
    onStart: () => {
      if (!session) return;
      session.node.classList.add("is-recording");
      session.timeEl.textContent = "0:00";
      session.onPillChange?.(true);
      session.editor.addContentWidget?.(session.widget);
      session.setRecordingKey(true);
    },
    onTick: (elapsed) => {
      if (session) session.timeEl.textContent = formatVoiceClock(elapsed);
    },
    onClip: (clip) => {
      if (!session) return;
      session.node.classList.remove("is-recording");
      session.node.classList.add("is-transcribing");
      session.timeEl.textContent = aiText("mic_transcribing");
      session.stopEl.hidden = true;
      session.setRecordingKey(false);
      session.editor.layoutContentWidget?.(session.widget);
      const requestId = `${REQUEST_PREFIX}${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      pendingRequestId = requestId;
      const posted = deps.postToNative(
        {
          type: "agent:transcribe",
          requestId,
          data: clip.data,
          mimeType: clip.mimeType,
          durationMs: clip.durationMs,
          language: getUiLocale(),
        },
        true,
      );
      if (!posted) {
        pendingRequestId = null;
        removePill();
        notice(aiText("mic_failed"));
      }
    },
    onError: (code) => {
      removePill();
      if (code === "short") notice(aiText("mic_empty"));
      else notice(aiText(code === "denied" ? "mic_denied" : "mic_failed"));
    },
  });

  const handleTranscribeResult: VoiceEditController["handleTranscribeResult"] = (payload) => {
    if (!pendingRequestId || payload?.requestId !== pendingRequestId) return;
    pendingRequestId = null;
    const selection = session?.selection ?? null;
    removePill();
    if (payload.ok && typeof payload.text === "string" && payload.text.trim()) {
      deps.sendInstruction(payload.text.trim(), selection);
      return;
    }
    notice(
      payload.code === "empty"
        ? aiText("mic_empty")
        : typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : aiText("mic_failed"),
    );
  };

  const attachEditor: VoiceEditController["attachEditor"] = (monaco, editor, file) => {
    const KeyMod = monaco?.KeyMod;
    const KeyCode = monaco?.KeyCode;
    const preference = monaco?.editor?.ContentWidgetPositionPreference;
    if (!KeyMod || !KeyCode || typeof editor?.addAction !== "function") return;

    const recordingKey = editor.createContextKey?.(CONTEXT_KEY, false);
    const setRecordingKey = (value: boolean) => recordingKey?.set?.(value);

    // The pill: a dot, the elapsed time, and a stop control.
    const node = document.createElement("div");
    node.className = "ai-voice-pill";
    const dot = document.createElement("span");
    dot.className = "ai-voice-pill-dot";
    dot.setAttribute("aria-hidden", "true");
    const timeEl = document.createElement("span");
    timeEl.className = "ai-voice-pill-time";
    const stopEl = document.createElement("button");
    stopEl.type = "button";
    stopEl.className = "ai-voice-pill-stop";
    stopEl.title = uiText("Stop", "止める");
    stopEl.setAttribute("aria-label", stopEl.title);
    stopEl.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
    node.append(dot, timeEl, stopEl);
    node.addEventListener("mousedown", (event) => {
      // Keep the editor selection: it is what Axiom receives.
      event.preventDefault();
      event.stopPropagation();
    });
    stopEl.addEventListener("click", (event) => {
      event.preventDefault();
      recorder.stop();
    });

    let position: { lineNumber: number; column: number } | null = null;
    const widget = {
      getId: () => "tex64.voice-edit-pill",
      getDomNode: () => node,
      getPosition: () =>
        position
          ? { position, preference: preference ? [preference.BELOW, preference.ABOVE] : [2, 1] }
          : null,
    };

    const snapshotSelection = (): { selection: VoiceInstructionSelection | null; anchor: { lineNumber: number; column: number } } | null => {
      const model = editor.getModel?.();
      const path = file.getFilePath();
      if (!model || !path) return null;
      const current = editor.getSelection?.() as Range | null;
      const cursor = editor.getPosition?.() ?? { lineNumber: 1, column: 1 };
      const hasSelection = current && !(typeof current.isEmpty === "function" ? current.isEmpty() : true);
      const range = hasSelection ? current : paragraphAround(model, cursor.lineNumber);
      const anchor = hasSelection
        ? { lineNumber: current.endLineNumber, column: current.endColumn }
        : { lineNumber: cursor.lineNumber, column: cursor.column };
      if (!range) return { selection: null, anchor };
      return {
        selection: {
          path,
          text: model.getValueInRange(range),
          isDirty: file.isDirty(),
          startLine: range.startLineNumber,
          startColumn: range.startColumn,
          endLine: range.endLineNumber,
          endColumn: range.endColumn,
        },
        anchor,
      };
    };

    const start = () => {
      if (!isTexPath(file.getFilePath())) return;
      if (!isVoiceRecordingSupported()) {
        notice(aiText("mic_failed"));
        return;
      }
      const snapshot = snapshotSelection();
      if (!snapshot) return;
      node.classList.remove("is-recording", "is-transcribing");
      stopEl.hidden = false;
      position = snapshot.anchor;
      session = { editor, widget, selection: snapshot.selection, setRecordingKey, onPillChange: file.onPillChange, timeEl, stopEl, node };
      void recorder.start();
    };

    const toggle = () => {
      if (recorder.isRecording()) {
        recorder.stop();
        return;
      }
      if (pendingRequestId || session) return;
      start();
    };

    editor.addAction({
      id: "tex64.voice-edit",
      label: uiText("Voice edit", "音声で編集を指示"),
      keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyV],
      contextMenuGroupId: "9_ai",
      contextMenuOrder: 1.5,
      precondition: "editorLangId == latex",
      run: () => {
        toggle();
      },
    });
    editor.addCommand?.(KeyCode.Escape, () => recorder.stop(), CONTEXT_KEY);
    editor.onDidChangeModel?.(() => {
      if (session?.editor === editor && recorder.isRecording()) recorder.stop();
    });
  };

  return {
    attachEditor,
    ownsRequest: (requestId) => typeof requestId === "string" && requestId.startsWith(REQUEST_PREFIX),
    handleTranscribeResult,
  };
};
