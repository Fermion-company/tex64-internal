/**
 * Voice input for the composer: press the microphone, speak, press again.
 * The clip goes to the host, which has it transcribed, and the words land
 * in the composer at the cursor. Nothing is sent until the reader presses
 * send.
 */

import { aiText } from "./ai-i18n.js";
import { getUiLocale, setLocalizedAttribute } from "./i18n.js";

type VoiceControllerDeps = {
  aiMic: Element | null | undefined;
  aiMicTimer: Element | null | undefined;
  aiInput: Element | null | undefined;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  /** A one-line notice for the reader (empty string clears it). */
  notify: (message: string) => void;
  onTextInserted?: () => void;
};

export type VoiceController = {
  toggle: () => void;
  isBusy: () => boolean;
  handleTranscribeResult: (payload: { requestId?: string; ok?: boolean; text?: string; error?: string; code?: string }) => void;
  syncLabels: () => void;
};

const MAX_CLIP_MS = 180_000;
const MIN_CLIP_MS = 400;

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

const formatClock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const createVoiceController = (deps: VoiceControllerDeps): VoiceController => {
  const { aiMic, aiMicTimer, aiInput, postToNative, notify, onTextInserted } = deps;
  const button = aiMic instanceof HTMLButtonElement ? aiMic : null;
  const timerEl = aiMicTimer instanceof HTMLElement ? aiMicTimer : null;
  const input = aiInput instanceof HTMLTextAreaElement ? aiInput : null;

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let clock: number | null = null;
  let pendingRequestId: string | null = null;

  if (!button || !input || typeof navigator === "undefined" || !navigator.mediaDevices) {
    if (button) button.hidden = true;
    return {
      toggle: () => {},
      isBusy: () => false,
      handleTranscribeResult: () => {},
      syncLabels: () => {},
    };
  }

  const syncLabels = () => {
    const source = recorder !== null ? "Stop and transcribe" : "Dictate";
    setLocalizedAttribute(button, "title", source);
    setLocalizedAttribute(button, "aria-label", source);
  };

  const setState = (state: "idle" | "recording" | "transcribing") => {
    button.classList.toggle("is-recording", state === "recording");
    button.classList.toggle("is-transcribing", state === "transcribing");
    button.disabled = state === "transcribing";
    if (timerEl) {
      timerEl.textContent = state === "recording" ? "0:00" : "";
      timerEl.hidden = state !== "recording";
    }
    syncLabels();
  };

  const releaseStream = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const stopClock = () => {
    if (clock !== null) {
      window.clearInterval(clock);
      clock = null;
    }
  };

  const insertText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    input.setRangeText(`${needsSpace ? " " : ""}${trimmed}`, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    onTextInserted?.();
  };

  const finishRecording = async () => {
    const durationMs = Date.now() - startedAt;
    const mimeType = recorder?.mimeType || pickMimeType() || "audio/webm";
    recorder = null;
    stopClock();
    releaseStream();
    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    chunks = [];
    if (durationMs < MIN_CLIP_MS || blob.size < 200) {
      setState("idle");
      return;
    }
    setState("transcribing");
    notify(aiText("mic_transcribing"));
    let data = "";
    try {
      data = await blobToBase64(blob);
    } catch {
      data = "";
    }
    if (!data) {
      setState("idle");
      notify(aiText("mic_failed"));
      return;
    }
    const requestId = `voice-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    pendingRequestId = requestId;
    const posted = postToNative(
      {
        type: "agent:transcribe",
        requestId,
        data,
        mimeType,
        durationMs,
        language: getUiLocale(),
      },
      true,
    );
    if (!posted) {
      pendingRequestId = null;
      setState("idle");
      notify(aiText("mic_failed"));
    }
  };

  const start = async () => {
    if (recorder || pendingRequestId) return;
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      notify(aiText("mic_denied"));
      return;
    }
    const mimeType = pickMimeType();
    let created: MediaRecorder;
    try {
      created = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
    } catch {
      media.getTracks().forEach((track) => track.stop());
      notify(aiText("mic_failed"));
      return;
    }
    stream = media;
    recorder = created;
    chunks = [];
    startedAt = Date.now();
    created.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    created.onstop = () => {
      void finishRecording();
    };
    created.start(250);
    notify("");
    setState("recording");
    clock = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (timerEl) timerEl.textContent = formatClock(elapsed);
      if (elapsed >= MAX_CLIP_MS) stop();
    }, 250);
  };

  const stop = () => {
    if (!recorder) return;
    try {
      recorder.stop();
    } catch {
      recorder = null;
      stopClock();
      releaseStream();
      setState("idle");
    }
  };

  const toggle = () => {
    if (recorder) stop();
    else void start();
  };

  const handleTranscribeResult = (payload: { requestId?: string; ok?: boolean; text?: string; error?: string; code?: string }) => {
    if (!pendingRequestId || payload?.requestId !== pendingRequestId) return;
    pendingRequestId = null;
    setState("idle");
    if (payload.ok && typeof payload.text === "string" && payload.text.trim()) {
      notify("");
      insertText(payload.text);
      return;
    }
    notify(payload.code === "empty" ? aiText("mic_empty") : typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : aiText("mic_failed"));
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    toggle();
  });
  setState("idle");

  return {
    toggle,
    isBusy: () => recorder !== null || pendingRequestId !== null,
    handleTranscribeResult,
    syncLabels,
  };
};
