/**
 * The microphone, shared by the composer's dictation and the editor's voice
 * edit. It records a clip with MediaRecorder and hands it over as base64;
 * what happens to the words is the caller's business.
 */
export const MAX_CLIP_MS = 180000;
const MIN_CLIP_MS = 400;
const TICK_MS = 250;
export const isVoiceRecordingSupported = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices) && typeof MediaRecorder !== "undefined";
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
    let recorder = null;
    let stream = null;
    let chunks = [];
    let startedAt = 0;
    let clock = null;
    const releaseStream = () => {
        stream === null || stream === void 0 ? void 0 : stream.getTracks().forEach((track) => track.stop());
        stream = null;
    };
    const stopClock = () => {
        if (clock !== null) {
            window.clearInterval(clock);
            clock = null;
        }
    };
    const finishRecording = async () => {
        const durationMs = Date.now() - startedAt;
        const mimeType = (recorder === null || recorder === void 0 ? void 0 : recorder.mimeType) || pickMimeType() || "audio/webm";
        recorder = null;
        stopClock();
        releaseStream();
        const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
        chunks = [];
        if (durationMs < MIN_CLIP_MS || blob.size < 200) {
            handlers.onError("short");
            return;
        }
        let data = "";
        try {
            data = await blobToBase64(blob);
        }
        catch {
            data = "";
        }
        if (!data) {
            handlers.onError("failed");
            return;
        }
        handlers.onClip({ data, mimeType, durationMs });
    };
    const start = async () => {
        if (recorder)
            return;
        let media;
        try {
            media = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        catch {
            handlers.onError("denied");
            return;
        }
        const mimeType = pickMimeType();
        let created;
        try {
            created = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
        }
        catch {
            media.getTracks().forEach((track) => track.stop());
            handlers.onError("failed");
            return;
        }
        stream = media;
        recorder = created;
        chunks = [];
        startedAt = Date.now();
        created.ondataavailable = (event) => {
            if (event.data && event.data.size > 0)
                chunks.push(event.data);
        };
        created.onstop = () => {
            void finishRecording();
        };
        created.start(TICK_MS);
        handlers.onStart();
        clock = window.setInterval(() => {
            const elapsed = Date.now() - startedAt;
            handlers.onTick(elapsed);
            if (elapsed >= MAX_CLIP_MS)
                stop();
        }, TICK_MS);
    };
    const stop = () => {
        if (!recorder)
            return;
        try {
            recorder.stop();
        }
        catch {
            recorder = null;
            chunks = [];
            stopClock();
            releaseStream();
            handlers.onError("short");
        }
    };
    return {
        start,
        stop,
        isRecording: () => recorder !== null,
    };
};
