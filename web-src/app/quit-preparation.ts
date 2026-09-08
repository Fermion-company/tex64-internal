export type QuitPreparationResult = {
  ok: boolean;
  phase?: "quiesce" | "save";
  error?: string;
};

type QuitPreparationInput = {
  quiesce: () => Promise<{ ok: boolean; error?: string }>;
  saveDirtyFiles: () => Promise<boolean>;
  getDirtyFileCount: () => number;
  freeze: () => void;
  maxSavePasses?: number;
};

/**
 * Stop native writers, drain every dirty Code buffer, and only then freeze the
 * renderer for final process teardown. A save pass can itself receive editor
 * input while waiting for native acknowledgements, so re-check the live dirty
 * set and repeat until it is empty in the same JS turn that freezes the UI.
 */
export const prepareRendererForQuit = async (
  input: QuitPreparationInput,
): Promise<QuitPreparationResult> => {
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
  for (let pass = 0; pass < maxSavePasses; pass += 1) {
    if (input.getDirtyFileCount() === 0) {
      input.freeze();
      return { ok: true };
    }
    let saved = false;
    try {
      saved = await input.saveDirtyFiles();
    } catch (error) {
      return {
        ok: false,
        phase: "save",
        error: error instanceof Error ? error.message : "Saving failed.",
      };
    }
    if (!saved) {
      return { ok: false, phase: "save", error: "Saving failed." };
    }
  }
  return {
    ok: false,
    phase: "save",
    error: "Files kept changing while the application was preparing to quit.",
  };
};
