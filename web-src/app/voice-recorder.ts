/**
 * The microphone, shared by the composer's dictation and the editor's voice
 * edit. It records a clip with MediaRecorder and hands it over as base64;
 * what happens to the words is the caller's business.
 */

export type VoiceClip = {
  /** Base64 audio, without the data: prefix. */
  data: string;
  mimeType: string;
  durationMs: number;
};

/**
 * "denied": the microphone was not granted. "failed": the recorder could not
 * start or the clip could not be read. "unavailable" or "interrupted"
 * indicate a missing device or lost input. "short": the clip was too brief to
 * be speech and was dropped.
 */
export type VoiceRecorderError = "denied" | "unavailable" | "interrupted" | "failed" | "short";

export const voiceRecorderMessage = {
  denied: "mic_denied",
  unavailable: "mic_unavailable",
  interrupted: "mic_interrupted",
  failed: "mic_recording_failed",
  short: "mic_empty",
} as const;

export type VoiceRecorderHandlers = {
  onStart: () => void;
  onTick: (elapsedMs: number) => void;
  onClip: (clip: VoiceClip) => void;
  onError: (code: VoiceRecorderError) => void;
};

export type VoiceRecorder = {
  start: () => Promise<void>;
  /** Ends the recording; the clip arrives through onClip. */
  stop: () => void;
  /** Ends the recording and drops the clip: no onClip, no onError. */
  cancel: () => void;
  isRecording: () => boolean;
  isBusy: () => boolean;
};

export const MAX_CLIP_MS = 180_000;
const MIN_CLIP_MS = 400;
const TICK_MS = 250;

export const isVoiceRecordingSupported = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";

const pickMimeType = () => {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const candidate of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // try the next one
    }
  }
  return "";
};

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(blob);
  });

export const formatVoiceClock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const createVoiceRecorder = (handlers: VoiceRecorderHandlers): VoiceRecorder => {
  // Each request owns its stream and clip until it completes. A cancellation
  // can arrive during permission, capture, or conversion to base64.
  let current: { recorder: MediaRecorder | null; stopRequested: boolean; release: () => void } | null = null;

  const cancel = () => {
    const session = current;
    current = null;
    session?.release();
  };

  const stop = () => {
    const session = current;
    const recorder = session?.recorder;
    if (!recorder || recorder.state === "inactive") return;
    session.stopRequested = true;
    try {
      recorder.stop();
    } catch {
      cancel();
      handlers.onError("failed");
    }
  };

  const start = async () => {
    if (current) return;
    const session = { recorder: null as MediaRecorder | null, stopRequested: false, release: () => {} };
    current = session;
    const fail = (error: VoiceRecorderError) => {
      if (current !== session) return;
      cancel();
      handlers.onError(error);
    };

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const reason = (error as Error)?.name;
      if (reason === "NotAllowedError" || reason === "SecurityError") fail("denied");
      else if (reason === "NotFoundError" || reason === "NotReadableError" || reason === "OverconstrainedError") fail("unavailable");
      else fail("failed");
      return;
    }
    const tracks = media.getTracks();
    if (current !== session) {
      tracks.forEach((track) => track.stop());
      return;
    }

    const chunks: Blob[] = [];
    const startedAt = Date.now();
    let clock: number | null = null;
    const interrupted = () => fail("interrupted");
    session.release = () => {
      if (clock !== null) window.clearInterval(clock);
      const recorder = session.recorder;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          try { recorder.stop(); } catch {}
        }
      }
      session.recorder = null;
      for (const track of tracks) {
        track.removeEventListener?.("ended", interrupted);
        track.stop();
      }
      session.release = () => {};
    };

    try {
      const mime = pickMimeType();
      const recorder = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media);
      session.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = interrupted;
      for (const track of tracks) track.addEventListener?.("ended", interrupted);
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
        if (current !== session) return;
        if (!data) {
          fail("failed");
          return;
        }
        current = null;
        handlers.onClip({ data, mimeType, durationMs });
      };
      recorder.start(TICK_MS);
    } catch {
      fail("failed");
      return;
    }
    clock = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      handlers.onTick(elapsed);
      if (elapsed >= MAX_CLIP_MS) stop();
    }, TICK_MS);
    handlers.onStart();
  };

  return { start, stop, cancel, isRecording: () => Boolean(current?.recorder), isBusy: () => current !== null };
};
