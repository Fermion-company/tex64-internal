export type QuitPreparationResult = {
  ok: boolean;
  phase?: "quiesce" | "save";
  error?: string;
};

type QuitPreparationInput = {
  quiesce: () => Promise<{ ok: boolean; error?: string }>;
  saveDirtyFiles: () => Promise<boolean>;
  getDirtyFileCount: () => number;
  /** Writes the shared (collaboration) documents held in main; false: not all. */
  drainShared?: () => Promise<boolean>;
  freeze: () => void;
  /** A message while an IME composition is still open: quit waits for it. */
  getCompositionError?: () => string | null;
  maxSavePasses?: number;
};

/**
 * Stop native writers, drain every dirty Code buffer and then the shared
 * documents (a peer's edit to a file this window never opened has no buffer
 * here), and only then freeze the renderer for final process teardown. A save
 * pass or the drain can itself receive editor input while waiting for native
 * acknowledgements, so re-check the live dirty set and repeat until it is
 * empty in the same JS turn that freezes the UI. An IME composition still
 * open (its text is not in the buffer yet) cancels with its own message.
 */
export const prepareRendererForQuit = async (
  input: QuitPreparationInput,
): Promise<QuitPreparationResult> => {
  const pendingInput = input.getCompositionError?.();
  if (pendingInput) return { ok: false, phase: "save", error: pendingInput };
  let quiet: { ok: boolean; error?: string };
  try {
    quiet = await input.quiesce();
  } catch (error) {
    return {
      ok: false,
      phase: "quiesce",
      error: error instanceof Error ? error.message : "Could not stop active work.",
    };
  }
  if (!quiet.ok) {
    return { ok: false, phase: "quiesce", error: quiet.error };
  }

  const maxSavePasses = Math.max(1, Math.floor(input.maxSavePasses ?? 100));
  let savePasses = 0;
  try {
    while (true) {
      const compositionError = input.getCompositionError?.();
      if (compositionError) return { ok: false, phase: "save", error: compositionError };
      if (input.getDirtyFileCount() > 0) {
        if (savePasses >= maxSavePasses) break;
        savePasses++;
        if (!await input.saveDirtyFiles()) return { ok: false, phase: "save", error: "Saving failed." };
        continue;
      }
      // Shared changes can be pending even for files the editor never opened.
      let drained = true;
      try {
        drained = (await input.drainShared?.()) ?? true;
      } catch {
        drained = false;
      }
      if (!drained) return { ok: false, phase: "save" };
      if (input.getDirtyFileCount() > 0 || input.getCompositionError?.()) continue;
      input.freeze();
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, phase: "save", error: error instanceof Error ? error.message : "Saving failed." };
  }
  return {
    ok: false,
    phase: "save",
    error: "Files kept changing while the application was preparing to quit.",
  };
};
