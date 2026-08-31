// The desktop product exposes the Code editor and the paper-first AI workspace.
// Both surfaces share the same project files, build pipeline, and billing state.

export type AppMode = "code" | "ai";

export const APP_MODE_STORAGE_KEY = "tex64.appMode.v1";

export const parseAppMode = (raw: string | null): AppMode | null => {
  if (raw === "code" || raw === "ai") return raw;
  return null;
};

export const resolveInitialAppMode = (storedMode: string | null): AppMode =>
  parseAppMode(storedMode) ?? "code";

export type AppModeTransitionResult = {
  ok: boolean;
  phase?: "quiesce" | "save";
  error?: string;
};

/** Stop every workspace writer before Code persists its final buffers. */
export const prepareCodeWorkspaceHandoff = async (input: {
  quiesce: () => Promise<{ ok: boolean; error?: string }>;
  saveCode: () => Promise<boolean>;
}): Promise<AppModeTransitionResult> => {
  const quiet = await input.quiesce();
  if (!quiet.ok) return { ok: false, phase: "quiesce", error: quiet.error };
  if (!(await input.saveCode())) return { ok: false, phase: "save" };
  return { ok: true };
};

/**
 * Hands one workspace between the two surfaces. Stop every writer first;
 * only then persist Code's buffers, so the old agent cannot overwrite the
 * state AI mode receives after the save completes.
 */
export const prepareAppModeTransition = async (input: {
  next: AppMode;
  previous: AppMode | null;
  quiesce: () => Promise<{ ok: boolean; error?: string }>;
  saveCode: () => Promise<boolean>;
}): Promise<AppModeTransitionResult> => {
  if (input.previous === null) return { ok: true };
  if (input.next === "ai") {
    return prepareCodeWorkspaceHandoff(input);
  }
  const quiet = await input.quiesce();
  if (!quiet.ok) return { ok: false, phase: "quiesce", error: quiet.error };
  return { ok: true };
};

type AppModeDeps = {
  beforeModeChange?: (
    mode: AppMode,
    previous: AppMode | null,
  ) => boolean | Promise<boolean>;
  onModeChange: (mode: AppMode, previous: AppMode | null) => void;
  initialMode: AppMode;
};

export type AppModeApi = {
  getMode: () => AppMode;
  setMode: (mode: AppMode) => void;
};

export const initAppModeUi = (deps: AppModeDeps): AppModeApi => {
  const switcher = document.getElementById("mode-switcher");
  let mode: AppMode | null = null;
  let transitionVersion = 0;
  let pendingMode: AppMode | null = null;

  const commitMode = (next: AppMode) => {
    if (mode === next) return;
    const previous = mode;
    mode = next;
    document.documentElement.dataset.appMode = next;
    try {
      localStorage.setItem(APP_MODE_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; mode switching still works in-session.
    }
    switcher
      ?.querySelectorAll<HTMLButtonElement>("[data-app-mode-tab]")
      .forEach((tab) => {
        const active = tab.dataset.appModeTab === next;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      });
    deps.onModeChange(next, previous);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const applyMode = (next: AppMode) => {
    // Do not run quiesce/save twice for a double click. These operations own
    // filesystem handoff and must stay serialized even if the visual switch
    // has subsequently been cancelled.
    if (pendingMode === next) return;
    transitionVersion += 1;
    const version = transitionVersion;
    // Clicking the still-selected tab cancels an in-flight transition to the
    // other mode. Without advancing the version here, a late approval could
    // switch the UI after the user had explicitly chosen to stay put.
    if (mode === next) {
      switcher?.removeAttribute("aria-busy");
      return;
    }
    let approval: boolean | Promise<boolean>;
    try {
      approval = deps.beforeModeChange?.(next, mode) ?? true;
    } catch {
      return;
    }
    if (typeof approval === "boolean") {
      if (approval) commitMode(next);
      return;
    }
    pendingMode = next;
    switcher?.setAttribute("aria-busy", "true");
    void approval
      .then((allowed) => {
        if (allowed && version === transitionVersion) commitMode(next);
      })
      .catch(() => {})
      .finally(() => {
        if (pendingMode === next) pendingMode = null;
        if (version === transitionVersion) switcher?.removeAttribute("aria-busy");
      });
  };

  switcher
    ?.querySelectorAll<HTMLButtonElement>("[data-app-mode-tab]")
    .forEach((tab) => {
      tab.addEventListener("click", () => {
        const next = parseAppMode(tab.dataset.appModeTab ?? null);
        if (next) applyMode(next);
      });
    });
  // Roving arrow-key focus within the tablist.
  switcher?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = Array.from(
      switcher.querySelectorAll<HTMLButtonElement>("[data-app-mode-tab]")
    );
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const next = tabs[(current + delta + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });

  applyMode(deps.initialMode);

  return {
    getMode: () => mode ?? "code",
    setMode: (next) => applyMode(next),
  };
};
