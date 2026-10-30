/**
 * Ask Axiom by voice: speak a short instruction in the editor and it goes
 * to Axiom at once, with the selection (or the paragraph around the cursor)
 * as its context. Axiom's edit then takes the usual diff / apply path.
 *
 * The command toggles recording. While it runs, a small pill floats at the
 * end of the selection with the elapsed time and a stop control, and the
 * range that will be sent is held: the composer chip shows it, and a
 * later change of selection does not move it. The command again or the
 * stop control sends; Esc discards. The clip is transcribed by the host
 * (`agent:transcribe`, like the composer microphone) and the words are
 * sent as they are. When nothing was heard the pill says so for a moment
 * and nothing is sent.
 */
import { aiText } from "./ai-i18n.js";
import { getUiLocale, uiText } from "./i18n.js";
import { createVoiceRecorder, formatVoiceClock, isVoiceRecordingSupported } from "./voice-recorder.js";
const REQUEST_PREFIX = "voice-edit-";
const CONTEXT_KEY = "tex64VoiceRecording";
// Esc discards the recording only when no overlay is waiting for it.
const ESCAPE_WHEN = `${CONTEXT_KEY} && !suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !renameInputVisible && !inSnippetMode`;
const FAILURE_MS = 3000;
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
    let failureTimer = null;
    const removePill = (state) => {
        var _a, _b, _c, _d;
        if (!session)
            return;
        const ended = session;
        session = null;
        if (failureTimer !== null) {
            window.clearTimeout(failureTimer);
            failureTimer = null;
        }
        (_a = ended.decorations) === null || _a === void 0 ? void 0 : _a.clear();
        if (ended.shown)
            (_c = (_b = ended.editor).removeContentWidget) === null || _c === void 0 ? void 0 : _c.call(_b, ended.widget);
        ended.setRecordingKey(false);
        ended.node.classList.remove("is-recording", "is-transcribing", "is-failed");
        (_d = ended.onPillChange) === null || _d === void 0 ? void 0 : _d.call(ended, state);
    };
    // The pill stays a moment with the reason, then goes; nothing is sent.
    const failInPill = (message) => {
        var _a, _b, _c, _d, _e;
        deps.holdSelection(null);
        if (!session)
            return;
        session.node.classList.remove("is-recording", "is-transcribing");
        session.node.classList.add("is-failed");
        session.timeEl.textContent = message;
        session.stopEl.hidden = true;
        session.setRecordingKey(false);
        if (session.shown)
            (_b = (_a = session.editor).layoutContentWidget) === null || _b === void 0 ? void 0 : _b.call(_a, session.widget);
        else {
            session.shown = true;
            (_c = session.onPillChange) === null || _c === void 0 ? void 0 : _c.call(session, "shown");
            (_e = (_d = session.editor).addContentWidget) === null || _e === void 0 ? void 0 : _e.call(_d, session.widget);
        }
        failureTimer = window.setTimeout(() => {
            failureTimer = null;
            removePill("hidden");
        }, FAILURE_MS);
    };
    const recorder = createVoiceRecorder({
        onStart: () => {
            var _a, _b, _c;
            if (!session)
                return;
            session.node.classList.add("is-recording");
            session.timeEl.textContent = "0:00";
            (_a = session.onPillChange) === null || _a === void 0 ? void 0 : _a.call(session, "shown");
            (_c = (_b = session.editor).addContentWidget) === null || _c === void 0 ? void 0 : _c.call(_b, session.widget);
            session.shown = true;
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
                failInPill(aiText("mic_failed"));
            }
        },
        onError: (code) => {
            failInPill(aiText(code === "denied" ? "mic_denied" : code === "short" ? "mic_empty" : "mic_failed"));
        },
    });
    const handleTranscribeResult = (payload) => {
        if (!pendingRequestId || (payload === null || payload === void 0 ? void 0 : payload.requestId) !== pendingRequestId)
            return;
        pendingRequestId = null;
        if (payload.ok && typeof payload.text === "string" && payload.text.trim()) {
            removePill("sent");
            deps.sendInstruction(payload.text.trim());
            return;
        }
        // The host's reasons are English; the reader gets the one-line forms.
        failInPill(aiText(payload.code === "empty" ? "mic_empty" : "mic_failed"));
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
        // The pill: a dot, the elapsed time, and a stop control. Monaco sets
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
        stopEl.title = uiText("Stop", "止める");
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
                return { selection: null, range: null, anchor };
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
            if (!isTexPath(file.getFilePath()))
                return;
            if (!isVoiceRecordingSupported())
                return;
            const snapshot = snapshotSelection();
            if (!snapshot)
                return;
            node.classList.remove("is-recording", "is-transcribing", "is-failed");
            stopEl.hidden = false;
            position = snapshot.anchor;
            // The held range stays visible while it is spoken about.
            const decorations = snapshot.range && typeof editor.createDecorationsCollection === "function"
                ? editor.createDecorationsCollection([
                    { range: snapshot.range, options: { className: "ai-voice-range", isWholeLine: false } },
                ])
                : null;
            session = { editor, widget, setRecordingKey, onPillChange: file.onPillChange, node, timeEl, stopEl, decorations, shown: false };
            deps.holdSelection(snapshot.selection);
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
        const discard = () => {
            if (!recorder.isRecording())
                return;
            recorder.cancel();
            deps.holdSelection(null);
            removePill("hidden");
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
        (_c = editor.addCommand) === null || _c === void 0 ? void 0 : _c.call(editor, KeyCode.Escape, discard, ESCAPE_WHEN);
        (_d = editor.onDidChangeModel) === null || _d === void 0 ? void 0 : _d.call(editor, () => {
            if ((session === null || session === void 0 ? void 0 : session.editor) === editor && recorder.isRecording())
                discard();
        });
    };
    return {
        attachEditor,
        ownsRequest: (requestId) => typeof requestId === "string" && requestId.startsWith(REQUEST_PREFIX),
        handleTranscribeResult,
    };
};
