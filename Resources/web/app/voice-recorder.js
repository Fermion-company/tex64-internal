/**
 * The microphone, shared by the composer's dictation and the editor's voice
 * edit. It records a clip with MediaRecorder and hands it over as base64;
 * what happens to the words is the caller's business.
 */
export const voiceRecorderMessage = {
    denied: "mic_denied",
    unavailable: "mic_unavailable",
    interrupted: "mic_interrupted",
    failed: "mic_recording_failed",
    short: "mic_empty",
};
export const MAX_CLIP_MS = 180000;
const MIN_CLIP_MS = 400;
const TICK_MS = 250;
export const isVoiceRecordingSupported = () => { var _a; return typeof navigator !== "undefined" && typeof ((_a = navigator.mediaDevices) === null || _a === void 0 ? void 0 : _a.getUserMedia) === "function" && typeof MediaRecorder !== "undefined"; };
const pickMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const candidate of candidates) {
        try {
            if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate))
                return candidate;
        }
        catch {
            // try the next one
        }
    }
    return "";
};
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(blob);
});
export const formatVoiceClock = (ms) => {
    const total = Math.floor(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
};
export const createVoiceRecorder = (handlers) => {
    // Each request owns its stream and clip until it completes. A cancellation
    // can arrive during permission, capture, or conversion to base64.
    let current = null;
    const cancel = () => {
        const session = current;
        current = null;
        session === null || session === void 0 ? void 0 : session.release();
    };
    const stop = () => {
        const session = current;
        const recorder = session === null || session === void 0 ? void 0 : session.recorder;
        if (!recorder || recorder.state === "inactive")
            return;
        session.stopRequested = true;
        try {
            recorder.stop();
        }
        catch {
            cancel();
            handlers.onError("failed");
        }
    };
    const start = async () => {
        var _a;
        if (current)
            return;
        const session = { recorder: null, stopRequested: false, release: () => { } };
        current = session;
        const fail = (error) => {
            if (current !== session)
                return;
            cancel();
            handlers.onError(error);
        };
        let media;
        try {
            media = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        catch (error) {
            const reason = error === null || error === void 0 ? void 0 : error.name;
            if (reason === "NotAllowedError" || reason === "SecurityError")
                fail("denied");
            else if (reason === "NotFoundError" || reason === "NotReadableError" || reason === "OverconstrainedError")
                fail("unavailable");
            else
                fail("failed");
            return;
        }
        const tracks = media.getTracks();
        if (current !== session) {
            tracks.forEach((track) => track.stop());
            return;
        }
        const chunks = [];
        const startedAt = Date.now();
        let clock = null;
        const interrupted = () => fail("interrupted");
        session.release = () => {
            var _a;
            if (clock !== null)
                window.clearInterval(clock);
            const recorder = session.recorder;
            if (recorder) {
                recorder.ondataavailable = null;
                recorder.onstop = null;
                recorder.onerror = null;
                if (recorder.state !== "inactive") {
                    try {
                        recorder.stop();
                    }
                    catch { }
                }
            }
            session.recorder = null;
            for (const track of tracks) {
                (_a = track.removeEventListener) === null || _a === void 0 ? void 0 : _a.call(track, "ended", interrupted);
                track.stop();
            }
            session.release = () => { };
        };
        try {
            const mime = pickMimeType();
            const recorder = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media);
            session.recorder = recorder;
            recorder.ondataavailable = (event) => {
                var _a;
                if ((_a = event.data) === null || _a === void 0 ? void 0 : _a.size)
                    chunks.push(event.data);
            };
            recorder.onerror = interrupted;
            for (const track of tracks)
                (_a = track.addEventListener) === null || _a === void 0 ? void 0 : _a.call(track, "ended", interrupted);
            recorder.onstop = async () => {
                if (!session.stopRequested) {
                    interrupted();
                    return;
                }
                const durationMs = Date.now() - startedAt;
                const mimeType = recorder.mimeType || mime || "audio/webm";
                session.release();
                const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
                if (durationMs < MIN_CLIP_MS || blob.size < 200) {
                    fail("short");
                    return;
                }
                const data = await blobToBase64(blob).catch(() => "");
                if (current !== session)
                    return;
                if (!data) {
                    fail("failed");
                    return;
                }
                current = null;
                handlers.onClip({ data, mimeType, durationMs });
            };
            recorder.start(TICK_MS);
        }
        catch {
            fail("failed");
            return;
        }
        clock = window.setInterval(() => {
            const elapsed = Date.now() - startedAt;
            handlers.onTick(elapsed);
            if (elapsed >= MAX_CLIP_MS)
                stop();
        }, TICK_MS);
        handlers.onStart();
    };
    return { start, stop, cancel, isRecording: () => Boolean(current === null || current === void 0 ? void 0 : current.recorder), isBusy: () => current !== null };
};
