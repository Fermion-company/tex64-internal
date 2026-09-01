// Desktop currently ships the Code workspace only. Keep this compatibility
// module so older callers and stored mode values deterministically fall back
// to Code while the separate AI workspace remains disabled.

export type AppMode = "code";

export const APP_MODE_STORAGE_KEY = "tex64.appMode.v1";

export const parseAppMode = (raw: string | null): AppMode | null => {
  if (raw === "code") return raw;
  return null;
};

// Old AI and Pro selections both migrate to the only shipped workspace.
export const resolveInitialAppMode = (_storedMode: string | null): AppMode => "code";

type AppModeDeps = {
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

  const applyMode = (next: AppMode) => {
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
