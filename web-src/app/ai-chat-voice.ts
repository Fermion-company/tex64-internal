/**
 * Voice input for the composer: press the microphone, speak, press again.
 * The clip goes to the host, which has it transcribed, and the words land
 * in the composer at the cursor. Nothing is sent until the reader presses
 * send.
 */

import { aiText } from "./ai-i18n.js";
import { getUiLocale, setLocalizedAttribute } from "./i18n.js";
import { createVoiceRecorder, formatVoiceClock, isVoiceRecordingSupported } from "./voice-recorder.js";

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

export const createVoiceController = (deps: VoiceControllerDeps): VoiceController => {
  const { aiMic, aiMicTimer, aiInput, postToNative, notify, onTextInserted } = deps;
  const button = aiMic instanceof HTMLButtonElement ? aiMic : null;
  const timerEl = aiMicTimer instanceof HTMLElement ? aiMicTimer : null;
  const input = aiInput instanceof HTMLTextAreaElement ? aiInput : null;

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
    const source = recorder.isRecording() ? "Stop and transcribe" : "Dictate";
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

  const recorder = createVoiceRecorder({
    onStart: () => {
      notify("");
      setState("recording");
    },
    onTick: (elapsed) => {
      if (timerEl) timerEl.textContent = formatVoiceClock(elapsed);
    },
    onClip: (clip) => {
      setState("transcribing");
      notify(aiText("mic_transcribing"));
      const requestId = `voice-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      pendingRequestId = requestId;
      const posted = postToNative(
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
        setState("idle");
        notify(aiText("mic_failed"));
      }
    },
    onError: (code) => {
      if (code === "short") {
        setState("idle");
        return;
      }
      if (code === "denied") {
        notify(aiText("mic_denied"));
        return;
      }
      // The clip could not be read after recording: the button has to leave
      // its recording look as well.
      setState("idle");
      notify(aiText("mic_failed"));
    },
  });

  const toggle = () => {
    if (recorder.isRecording()) recorder.stop();
    else if (!pendingRequestId && isVoiceRecordingSupported()) void recorder.start();
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
    isBusy: () => recorder.isRecording() || pendingRequestId !== null,
    handleTranscribeResult,
    syncLabels,
  };
};
