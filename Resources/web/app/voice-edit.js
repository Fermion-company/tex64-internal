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
const REQUEST_PREFIX = "voice-edit-";
const CONTEXT_KEY = "tex64VoiceRecording";
const NOTICE_OWNER = "voice-edit";
const isTexPath = (path) => typeof path === "string" && path.endsWith(".tex");
/** The blank-line delimited paragraph around a line; null on a blank line. */
const paragraphAround = (model, lineNumber) => {
    const lineCount = model.getLineCount();
    const isBlank = (line) => /^\s*$/.test(model.getLineContent(line));
    if (lineNumber < 1 || lineNumber > lineCount || isBlank(lineNumber))
        return null;
    let start = lineNumber;
    while (start > 1 && !isBlank(start - 1))
        start -= 1;
    let end = lineNumber;
    while (end < lineCount && !isBlank(end + 1))
        end += 1;
    return {
        startLineNumber: start,
        startColumn: 1,
        endLineNumber: end,
        endColumn: model.getLineMaxColumn(end),
    };
};
export const createVoiceEditController = (deps) => {
    let session = null;
    let pendingRequestId = null;
    const notice = (message) => {
        showEditorNotice(null, message, { tone: "error", owner: NOTICE_OWNER });
    };
    const removePill = () => {
        var _a, _b, _c;
        if (!session)
            return;
        const ended = session;
        session = null;
        (_b = (_a = ended.editor).removeContentWidget) === null || _b === void 0 ? void 0 : _b.call(_a, ended.widget);
        ended.setRecordingKey(false);
        (_c = ended.onPillChange) === null || _c === void 0 ? void 0 : _c.call(ended, false);
    };
    const recorder = createVoiceRecorder({
        onStart: () => {
            var _a, _b, _c;
            if (!session)
                return;
            session.node.classList.add("is-recording");
            session.timeEl.textContent = "0:00";
            (_a = session.onPillChange) === null || _a === void 0 ? void 0 : _a.call(session, true);
            (_c = (_b = session.editor).addContentWidget) === null || _c === void 0 ? void 0 : _c.call(_b, session.widget);
            session.setRecordingKey(true);
        },
        onTick: (elapsed) => {
            if (session)
                session.timeEl.textContent = formatVoiceClock(elapsed);
        },
        onClip: (clip) => {
            var _a, _b;
            if (!session)
                return;
            session.node.classList.remove("is-recording");
            session.node.classList.add("is-transcribing");
            session.timeEl.textContent = aiText("mic_transcribing");
            session.stopEl.hidden = true;
            session.setRecordingKey(false);
            (_b = (_a = session.editor).layoutContentWidget) === null || _b === void 0 ? void 0 : _b.call(_a, session.widget);
            const requestId = `${REQUEST_PREFIX}${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
            pendingRequestId = requestId;
            const posted = deps.postToNative({
                type: "agent:transcribe",
                requestId,
                data: clip.data,
                mimeType: clip.mimeType,
                durationMs: clip.durationMs,
                language: getUiLocale(),
            }, true);
            if (!posted) {
                pendingRequestId = null;
                removePill();
                notice(aiText("mic_failed"));
            }
        },
        onError: (code) => {
            removePill();
            if (code === "short")
                notice(aiText("mic_empty"));
            else
                notice(aiText(code === "denied" ? "mic_denied" : "mic_failed"));
        },
    });
    const handleTranscribeResult = (payload) => {
        var _a;
        if (!pendingRequestId || (payload === null || payload === void 0 ? void 0 : payload.requestId) !== pendingRequestId)
            return;
        pendingRequestId = null;
        const selection = (_a = session === null || session === void 0 ? void 0 : session.selection) !== null && _a !== void 0 ? _a : null;
        removePill();
        if (payload.ok && typeof payload.text === "string" && payload.text.trim()) {
            deps.sendInstruction(payload.text.trim(), selection);
            return;
        }
        notice(payload.code === "empty"
            ? aiText("mic_empty")
            : typeof payload.error === "string" && payload.error.trim()
                ? payload.error.trim()
                : aiText("mic_failed"));
    };
    const attachEditor = (monaco, editor, file) => {
        var _a, _b, _c, _d;
        const KeyMod = monaco === null || monaco === void 0 ? void 0 : monaco.KeyMod;
        const KeyCode = monaco === null || monaco === void 0 ? void 0 : monaco.KeyCode;
        const preference = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _a === void 0 ? void 0 : _a.ContentWidgetPositionPreference;
        if (!KeyMod || !KeyCode || typeof (editor === null || editor === void 0 ? void 0 : editor.addAction) !== "function")
            return;
        const recordingKey = (_b = editor.createContextKey) === null || _b === void 0 ? void 0 : _b.call(editor, CONTEXT_KEY, false);
        const setRecordingKey = (value) => { var _a; return (_a = recordingKey === null || recordingKey === void 0 ? void 0 : recordingKey.set) === null || _a === void 0 ? void 0 : _a.call(recordingKey, value); };
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
        let position = null;
        const widget = {
            getId: () => "tex64.voice-edit-pill",
            getDomNode: () => node,
            getPosition: () => position
                ? { position, preference: preference ? [preference.BELOW, preference.ABOVE] : [2, 1] }
                : null,
        };
        const snapshotSelection = () => {
            var _a, _b, _c, _d;
            const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
            const path = file.getFilePath();
            if (!model || !path)
                return null;
            const current = (_b = editor.getSelection) === null || _b === void 0 ? void 0 : _b.call(editor);
            const cursor = (_d = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor)) !== null && _d !== void 0 ? _d : { lineNumber: 1, column: 1 };
            const hasSelection = current && !(typeof current.isEmpty === "function" ? current.isEmpty() : true);
            const range = hasSelection ? current : paragraphAround(model, cursor.lineNumber);
            const anchor = hasSelection
                ? { lineNumber: current.endLineNumber, column: current.endColumn }
                : { lineNumber: cursor.lineNumber, column: cursor.column };
            if (!range)
                return { selection: null, anchor };
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
            if (!isTexPath(file.getFilePath()))
                return;
            if (!isVoiceRecordingSupported()) {
                notice(aiText("mic_failed"));
                return;
            }
            const snapshot = snapshotSelection();
            if (!snapshot)
                return;
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
            if (pendingRequestId || session)
                return;
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
        (_c = editor.addCommand) === null || _c === void 0 ? void 0 : _c.call(editor, KeyCode.Escape, () => recorder.stop(), CONTEXT_KEY);
        (_d = editor.onDidChangeModel) === null || _d === void 0 ? void 0 : _d.call(editor, () => {
            if ((session === null || session === void 0 ? void 0 : session.editor) === editor && recorder.isRecording())
                recorder.stop();
        });
    };
    return {
        attachEditor,
        ownsRequest: (requestId) => typeof requestId === "string" && requestId.startsWith(REQUEST_PREFIX),
        handleTranscribeResult,
    };
};
