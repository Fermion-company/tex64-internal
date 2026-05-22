import { createEnvStatusManager, type EnvStatusSummary } from "../settings-env.js";
import { TEX64_LINKS } from "../platform-links.js";
import type { SettingsUiRuntime } from "./runtime.js";
import type { SettingsAttentionOps } from "./attention.js";
import { openExternalUrl } from "./utils.js";
import { uiText } from "../i18n.js";

export type SettingsEnvOps = {
  checkEnvironmentStatus: () => void;
  updateEnvStatus: (command: string, available: boolean) => void;
  handleEnvInstallStart: (payload: { target?: string }) => void;
  handleEnvInstallResult: (payload: { target?: string; success?: boolean; message?: string }) => void;
  handleEnvInstallProgress: (payload: {
    phase?: string;
    current?: number | null;
    total?: number | null;
    percent?: number | null;
  }) => void;
  updateRuntimeOnboardingUi: () => void;
  updateRuntimeSetupUi: () => void;
  getRuntimeStatusSummary: () => EnvStatusSummary | null;
};

type HeroState = "checking" | "missing" | "installing" | "ready";

// The full-screen Environment screen answers one question for the user: "can I
// build right now, and if not, what do I press?" Under the hood every install
// target funnels to the same managed TeX Live install, so the screen exposes a
// single status + one setup button, with the per-tool detection tucked away.
export const createSettingsEnvOps = (
  runtime: SettingsUiRuntime,
  attentionOps: SettingsAttentionOps
): SettingsEnvOps => {
  const {
    settingsRuntimeSetupStatus,
    settingsRuntimeInstallStatus,
    settingsRuntimeOpenTexDocs,
  } = runtime.context.dom;

  const heroEl = document.getElementById("env-hero");
  const heroSubEl = document.getElementById("env-hero-sub");
  const setupBtn = document.getElementById("settings-env-setup");
  const progressEl = document.getElementById("env-progress");
  const progressFill = document.getElementById("env-progress-fill");
  const progressLabel = document.getElementById("env-progress-label");

  let installing = false;

  const setHeroState = (state: HeroState) => {
    if (!(heroEl instanceof HTMLElement)) {
      return;
    }
    heroEl.classList.remove("is-checking", "is-missing", "is-installing", "is-ready");
    heroEl.classList.add(`is-${state}`);
  };

  const setHeroText = (title: string, sub: string) => {
    if (settingsRuntimeSetupStatus instanceof HTMLElement) {
      settingsRuntimeSetupStatus.textContent = title;
    }
    if (heroSubEl instanceof HTMLElement) {
      heroSubEl.textContent = sub;
    }
  };

  const setSetupButton = (opts: { visible: boolean; disabled?: boolean; label?: string }) => {
    if (!(setupBtn instanceof HTMLButtonElement)) {
      return;
    }
    setupBtn.classList.toggle("is-hidden", !opts.visible);
    setupBtn.disabled = Boolean(opts.disabled);
    if (typeof opts.label === "string") {
      setupBtn.textContent = opts.label;
    }
  };

  const setInstallNote = (
    message: string,
    tone: "neutral" | "success" | "error" = "neutral"
  ) => {
    if (!(settingsRuntimeInstallStatus instanceof HTMLElement)) {
      return;
    }
    const text = typeof message === "string" ? message.trim() : "";
    const isVisible = Boolean(text);
    settingsRuntimeInstallStatus.textContent = text;
    settingsRuntimeInstallStatus.classList.toggle("is-hidden", !isVisible);
    settingsRuntimeInstallStatus.setAttribute("aria-hidden", isVisible ? "false" : "true");
    settingsRuntimeInstallStatus.classList.toggle("is-success", tone === "success");
    settingsRuntimeInstallStatus.classList.toggle("is-error", tone === "error");
  };

  const phaseLabel = (phase: string): string => {
    switch (phase) {
      case "download":
        return uiText("Downloading installer…", "インストーラをダウンロード中…");
      case "extract":
        return uiText("Preparing installer…", "インストーラを準備中…");
      case "texlive":
        return uiText("Installing TeX Live…", "TeX Live をインストール中…");
      case "packages":
        return uiText("Installing packages…", "パッケージをインストール中…");
      case "finalize":
        return uiText("Finishing up…", "仕上げ中…");
      default:
        return uiText("Setting up…", "セットアップ中…");
    }
  };

  const showProgress = (visible: boolean) => {
    if (progressEl instanceof HTMLElement) {
      progressEl.classList.toggle("is-hidden", !visible);
      progressEl.setAttribute("aria-hidden", visible ? "false" : "true");
    }
  };

  // Width + text are set directly from JS (not a CSS animation), so the bar keeps
  // advancing even under prefers-reduced-motion.
  const setProgress = (percent: number | null, label: string) => {
    if (progressFill instanceof HTMLElement && typeof percent === "number") {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      progressFill.style.width = `${clamped}%`;
    }
    if (progressLabel instanceof HTMLElement) {
      progressLabel.textContent = label;
    }
  };

  const hasPromptedRuntimeSetup = () => {
    try {
      return localStorage.getItem(runtime.keys.runtimeSetupPromptedKey) === "1";
    } catch {
      return false;
    }
  };

  const markRuntimeSetupPrompted = () => {
    try {
      localStorage.setItem(runtime.keys.runtimeSetupPromptedKey, "1");
    } catch {
      // ignore storage failures
    }
  };

  const maybePromptRuntimeSetup = (summary: EnvStatusSummary | null) => {
    if (!summary || !summary.hasAnyResult || summary.runtimeReady) {
      runtime.state.runtimeSetupPromptInFlight = false;
      return;
    }
    if (runtime.state.runtimeSetupPromptInFlight || hasPromptedRuntimeSetup()) {
      return;
    }
    runtime.state.runtimeSetupPromptInFlight = true;
    markRuntimeSetupPrompted();
    runtime.deps.onRuntimeSetupNeeded?.(summary);
  };

  const showInstalling = () => {
    installing = true;
    setHeroState("installing");
    setHeroText(
      "Setting up your TeX environment…",
      "Downloading and installing the full TeX Live (several GB). This usually takes 30–60 minutes — you can keep working in the meantime."
    );
    setSetupButton({ visible: true, disabled: true, label: "Setting up…" });
    setInstallNote("");
    showProgress(true);
    setProgress(2, uiText("Starting…", "開始しています…"));
  };

  const updateRuntimeSetupUi = () => {
    // While an install is in flight the hero is owned by the install handlers;
    // intermediate status sweeps must not flip it back to "checking".
    if (installing) {
      return;
    }
    showProgress(false);
    const summary = runtime.state.runtimeStatusSummary;
    if (!summary || !summary.hasAnyResult) {
      setHeroState("checking");
      setHeroText("Checking your TeX environment…", "This only takes a moment.");
      setSetupButton({ visible: false });
      return;
    }
    if (summary.runtimeReady) {
      setHeroState("ready");
      const optionalMissing = summary.missingRecommended.includes("latexindent");
      setHeroText(
        "Your TeX environment is ready.",
        optionalMissing
          ? "You can build, format, and use SyncTeX. (Optional: latexindent was not detected.)"
          : "You can build, format, and use SyncTeX right away."
      );
      setSetupButton({ visible: false });
      setInstallNote("");
      return;
    }
    setHeroState("missing");
    setHeroText(
      "TeX environment is not set up yet.",
      "Press the button below and TeX64 will install everything you need automatically."
    );
    setSetupButton({ visible: true, disabled: false, label: "Set up TeX environment" });
  };

  // The single environment screen is fully driven by the status summary, so the
  // former onboarding stepper is now a thin alias kept for existing callers.
  const updateRuntimeOnboardingUi = () => {
    updateRuntimeSetupUi();
  };

  const envManager = createEnvStatusManager({
    postToNative: runtime.deps.postToNative,
    envCheckTargets: runtime.config.envCheckTargets,
    envDisplayTargets: runtime.config.envDisplayTargets,
    texEngineCommands: runtime.config.texEngineCommands,
    onStatusSummaryChange: (summary) => {
      runtime.state.runtimeStatusSummary = summary;
      updateRuntimeSetupUi();
      attentionOps.syncUpdateAttentionUi();
      maybePromptRuntimeSetup(summary);
    },
  });

  const { checkEnvironmentStatus, updateEnvStatus } = envManager;

  const handleEnvInstallStart = (_payload: { target?: string }) => {
    showInstalling();
  };

  const handleEnvInstallResult = (payload: {
    target?: string;
    success?: boolean;
    message?: string;
  }) => {
    installing = false;
    showProgress(false);
    const success = payload?.success === true;
    const rawMessage =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "";
    if (success) {
      setInstallNote(rawMessage || "TeX environment installed successfully.", "success");
    } else {
      setInstallNote(
        rawMessage || "Setup did not finish. Please try again, or open the guide.",
        "error"
      );
    }
    // Re-detect so the hero + component badges reflect the new reality.
    checkEnvironmentStatus();
  };

  const handleEnvInstallProgress = (payload: {
    phase?: string;
    current?: number | null;
    total?: number | null;
    percent?: number | null;
  }) => {
    installing = true;
    setHeroState("installing");
    showProgress(true);
    const phase = typeof payload?.phase === "string" ? payload.phase : "";
    const current = typeof payload?.current === "number" ? payload.current : null;
    const total = typeof payload?.total === "number" ? payload.total : null;
    let label = phaseLabel(phase);
    if (current && total) {
      label += ` (${current}/${total})`;
    }
    const percent = typeof payload?.percent === "number" ? payload.percent : null;
    setProgress(percent, label);
  };

  if (setupBtn instanceof HTMLButtonElement) {
    setupBtn.addEventListener("click", () => {
      if (setupBtn.disabled) {
        return;
      }
      showInstalling();
      runtime.deps.postToNative({ type: "env:install", target: "basictex" });
    });
  }

  if (settingsRuntimeOpenTexDocs instanceof HTMLButtonElement) {
    settingsRuntimeOpenTexDocs.addEventListener("click", () => {
      openExternalUrl(runtime, TEX64_LINKS.docsTexDistribution);
    });
  }

  const getRuntimeStatusSummary = () =>
    runtime.state.runtimeStatusSummary ? { ...runtime.state.runtimeStatusSummary } : null;

  return {
    checkEnvironmentStatus,
    updateEnvStatus,
    handleEnvInstallStart,
    handleEnvInstallResult,
    handleEnvInstallProgress,
    updateRuntimeOnboardingUi,
    updateRuntimeSetupUi,
    getRuntimeStatusSummary,
  };
};
