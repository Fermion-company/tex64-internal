/**
 * Ask Axiom by voice: speak a short instruction in the editor and it goes
 * to Axiom at once, with the selection (or the paragraph around the cursor)
 * as its context. Axiom's edit then takes the usual diff / apply path.
 *
 * The command toggles recording. While it runs, a small pill floats at the
 * end of the selection with the elapsed time and a send control (■), and the
 * range that will be sent is held: the composer chip shows it, and a
 * later change of selection does not move it. The command again or the
 * send control sends; Esc discards. The clip is transcribed by the host
 * (`agent:transcribe`, like the composer microphone) and the words are
 * sent as they are. When nothing was heard the pill says so for a moment
 * and nothing is sent.
 *
 * An edit belongs to the editor, file and workspace it was started in. If
 * the editor shows another file, closes, or the workspace changes before
 * the words are back, the edit ends there and nothing is sent; a microphone
 * granted late or a clip read late is let go when it arrives.
 */

import { aiText } from "./ai-i18n.js";
import { getUiLocale, uiText } from "./i18n.js";
import { createVoiceRecorder, formatVoiceClock, isVoiceRecordingSupported } from "./voice-recorder.js";
import type { VoiceInstructionSelection } from "./ai-chat-ui.js";

type VoiceEditDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  /** The range the recording is about (null clears it). */
  holdSelection: (selection: VoiceInstructionSelection | null) => void;
  /** Opens the Axiom tab and sends the words; the held range is the context. */
  sendInstruction: (text: string) => void;
  /** The open workspace; the words are sent only into the one they were spoken in. */
  getWorkspaceRootKey?: () => string | null;
};

/** What the pill did when it went away: the Ask button returns on "hidden" only. */
export type VoicePillState = "shown" | "hidden" | "sent";

type EditorFile = {
  getFilePath: () => string | null;
  isDirty: () => boolean;
  onPillChange?: (state: VoicePillState) => void;
};

export type VoiceEditController = {
  attachEditor: (monaco: any, editor: any, file: EditorFile) => void;
  /** True for the transcriptions this controller asked for. */
  ownsRequest: (requestId: unknown) => boolean;
  handleTranscribeResult: (payload: { requestId?: string; ok?: boolean; text?: string; error?: string; code?: string }) => void;
  /** Ends the voice edit under way, if any, without sending (the workspace changed). */
  cancel: () => void;
};

const REQUEST_PREFIX = "voice-edit-";
const CONTEXT_KEY = "tex64VoiceRecording";
// Esc discards the recording only when no overlay is waiting for it.
const ESCAPE_WHEN = `${CONTEXT_KEY} && !suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !renameInputVisible && !inSnippetMode`;
const FAILURE_MS = 3000;

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty?: () => boolean };

const isTexPath = (path: string | null) => typeof path === "string" && path.endsWith(".tex");

const HEADING_LINE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[\[{]/;

/**
 * The blank-line delimited paragraph around a line; null on a blank line.
 * Heading lines at its top are left out (the body under the heading is the
 * paragraph), unless the cursor is on one of them.
 */
const paragraphAround = (model: any, lineNumber: number) => {
  const lineCount: number = model.getLineCount();
  const isBlank = (line: number) => /^\s*$/.test(model.getLineContent(line));
  if (lineNumber < 1 || lineNumber > lineCount || isBlank(lineNumber)) return null;
  let start = lineNumber;
  while (start > 1 && !isBlank(start - 1)) start -= 1;
  let end = lineNumber;
  while (end < lineCount && !isBlank(end + 1)) end += 1;
  while (start < lineNumber && HEADING_LINE.test(model.getLineContent(start))) start += 1;
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
    setRecordingKey: (value: boolean) => void;
    onPillChange?: (state: VoicePillState) => void;
    node: HTMLElement;
    timeEl: HTMLElement;
    stopEl: HTMLButtonElement;
    decorations: { clear: () => void } | null;
    shown: boolean;
  };
  let session: Session | null = null;
  let pendingRequestId: string | null = null;
  let failureTimer: number | null = null;
  // One voice edit, from the microphone request to the words sent: the
  // editor, file and workspace it was started on. After each wait (the
  // microphone, reading the clip, the transcription) it goes on only while
  // it is still `current` and its editor still shows that file of that
  // workspace.
  type Operation = { editor: any; model: unknown; workspaceRoot: string | null };
  let current: Operation | null = null;
  // The edit the microphone works for, from start() until its clip or error
  // is in. It can outlive `current`: a microphone still being granted and a
  // clip still being read cannot be called back, so they are turned away
  // when they arrive, and no new recording starts before then.
  let recorderOp: Operation | null = null;

  const workspaceRoot = () => deps.getWorkspaceRootKey?.() ?? null;
  const isLive = (op: Operation | null) =>
    op !== null && op === current && op.editor.getModel?.() === op.model && workspaceRoot() === op.workspaceRoot;

  const removePill = (state: Exclude<VoicePillState, "shown">) => {
    if (!session) return;
    const ended = session;
    session = null;
    if (failureTimer !== null) {
      window.clearTimeout(failureTimer);
      failureTimer = null;
    }
    ended.decorations?.clear();
    if (ended.shown) ended.editor.removeContentWidget?.(ended.widget);
    ended.setRecordingKey(false);
    ended.node.classList.remove("is-recording", "is-transcribing", "is-failed");
    ended.onPillChange?.(state);
  };

  // The pill stays a moment with the reason, then goes; nothing is sent.
  const failInPill = (message: string) => {
    current = null;
    deps.holdSelection(null);
    if (!session) return;
    session.node.classList.remove("is-recording", "is-transcribing");
    session.node.classList.add("is-failed");
    session.timeEl.textContent = message;
    session.stopEl.hidden = true;
    session.setRecordingKey(false);
    if (session.shown) session.editor.layoutContentWidget?.(session.widget);
    else {
      session.shown = true;
      session.onPillChange?.("shown");
      session.editor.addContentWidget?.(session.widget);
    }
    failureTimer = window.setTimeout(() => {
      failureTimer = null;
      removePill("hidden");
    }, FAILURE_MS);
  };

  const recorder = createVoiceRecorder({
    onStart: () => {
      // A microphone granted after its edit ended is let go once start() returns.
      if (!session || !isLive(recorderOp)) return;
      session.node.classList.add("is-recording");
      session.timeEl.textContent = "0:00";
      session.onPillChange?.("shown");
      session.editor.addContentWidget?.(session.widget);
      session.shown = true;
      session.setRecordingKey(true);
    },
    onTick: (elapsed) => {
      if (session) session.timeEl.textContent = formatVoiceClock(elapsed);
    },
    onClip: (clip) => {
      const op = recorderOp;
      recorderOp = null;
      // A clip read after its edit ended goes nowhere.
      if (!stillLive(op) || !session) return;
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
        failInPill(aiText("mic_failed"));
      }
    },
    onError: (code) => {
      const op = recorderOp;
      recorderOp = null;
      if (!stillLive(op)) return;
      failInPill(aiText(code === "denied" ? "mic_denied" : code === "short" ? "mic_empty" : "mic_failed"));
    },
  });

  // Drops the recording of an edit that has ended. A microphone still being
  // granted, or a clip still being read, cannot be stopped from here.
  const dropRecording = () => {
    if (!recorderOp || !recorder.isRecording()) return;
    recorderOp = null;
    recorder.cancel();
  };

  // Ends the edit under way without sending: the recording is dropped, the
  // held range let go and the pill removed. A transcription still on its way
  // no longer matches and is ignored.
  const abandon = () => {
    const op = current;
    current = null;
    pendingRequestId = null;
    dropRecording();
    if (op) deps.holdSelection(null);
    removePill("hidden");
  };

  // isLive, and an edit that went stale without being told (its editor shows
  // another file, the workspace changed) is ended here.
  const stillLive = (op: Operation | null) => {
    if (isLive(op)) return true;
    if (op && op === current) abandon();
    return false;
  };

  const handleTranscribeResult: VoiceEditController["handleTranscribeResult"] = (payload) => {
    if (!pendingRequestId || payload?.requestId !== pendingRequestId) return;
    pendingRequestId = null;
    // The words go only into the file and workspace they were spoken in.
    if (!stillLive(current)) return;
    if (payload.ok && typeof payload.text === "string" && payload.text.trim()) {
      current = null;
      removePill("sent");
      deps.sendInstruction(payload.text.trim());
      return;
    }
    // The host's reasons are English; the reader gets the one-line forms.
    failInPill(aiText(payload.code === "empty" ? "mic_empty" : "mic_failed"));
  };

  const attachEditor: VoiceEditController["attachEditor"] = (monaco, editor, file) => {
    const KeyMod = monaco?.KeyMod;
    const KeyCode = monaco?.KeyCode;
    const preference = monaco?.editor?.ContentWidgetPositionPreference;
    if (!KeyMod || !KeyCode || typeof editor?.addAction !== "function") return;

    const recordingKey = editor.createContextKey?.(CONTEXT_KEY, false);
    const setRecordingKey = (value: boolean) => recordingKey?.set?.(value);

    // The pill: a dot, the elapsed time, and the send control. Monaco sets
    // display:block on the widget node, so the row is laid out one level in.
    const node = document.createElement("div");
    node.className = "ai-voice-pill";
    const row = document.createElement("span");
    row.className = "ai-voice-pill-row";
    const dot = document.createElement("span");
    dot.className = "ai-voice-pill-dot";
    dot.setAttribute("aria-hidden", "true");
    const timeEl = document.createElement("span");
    timeEl.className = "ai-voice-pill-time";
    const stopEl = document.createElement("button");
    stopEl.type = "button";
    stopEl.className = "ai-voice-pill-stop";
    stopEl.title = uiText("Send", "送信");
    stopEl.setAttribute("aria-label", stopEl.title);
    stopEl.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
    row.append(dot, timeEl, stopEl);
    node.appendChild(row);
    node.addEventListener("mousedown", (event) => {
      // Keep the editor selection and focus.
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

    const snapshotSelection = (): { selection: VoiceInstructionSelection | null; range: Range | null; anchor: { lineNumber: number; column: number } } | null => {
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
      if (!range) return { selection: null, range: null, anchor };
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
        range,
        anchor,
      };
    };

    const start = () => {
      if (!isTexPath(file.getFilePath())) return;
      if (!isVoiceRecordingSupported()) return;
      const snapshot = snapshotSelection();
      if (!snapshot) return;
      node.classList.remove("is-recording", "is-transcribing", "is-failed");
      stopEl.hidden = false;
      position = snapshot.anchor;
      // The held range stays visible while it is spoken about.
      const decorations =
        snapshot.range && typeof editor.createDecorationsCollection === "function"
          ? editor.createDecorationsCollection([
              { range: snapshot.range, options: { className: "ai-voice-range", isWholeLine: false } },
            ])
          : null;
      session = { editor, widget, setRecordingKey, onPillChange: file.onPillChange, node, timeEl, stopEl, decorations, shown: false };
      const op: Operation = { editor, model: editor.getModel?.(), workspaceRoot: workspaceRoot() };
      current = op;
      recorderOp = op;
      deps.holdSelection(snapshot.selection);
      void recorder.start().then(() => {
        // The microphone answered after the edit ended: let it go again.
        if (recorderOp === op && !stillLive(op)) dropRecording();
      });
    };

    const toggle = () => {
      if (recorder.isRecording()) {
        // A recording being dropped is left to end on its own.
        if (recorderOp) recorder.stop();
        return;
      }
      if (pendingRequestId || session || recorderOp) return;
      start();
    };

    const discard = () => {
      if (recorder.isRecording() && recorderOp) abandon();
    };

    editor.addAction({
      id: "tex64.voice-edit",
      label: uiText("Ask Axiom by voice", "Axiom に声で聞く"),
      keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyV],
      contextMenuGroupId: "9_ai",
      contextMenuOrder: 1.5,
      precondition: "editorLangId == latex",
      run: () => {
        toggle();
      },
    });
    editor.addCommand?.(KeyCode.Escape, discard, ESCAPE_WHEN);
    // Another file in this editor, or the editor going away, ends its voice
    // edit at whatever step it has reached.
    const endHere = () => {
      if (session?.editor === editor) abandon();
    };
    editor.onDidChangeModel?.(endHere);
    editor.onDidDispose?.(endHere);
  };

  return {
    attachEditor,
    ownsRequest: (requestId) => typeof requestId === "string" && requestId.startsWith(REQUEST_PREFIX),
    handleTranscribeResult,
    cancel: () => abandon(),
  };
};
