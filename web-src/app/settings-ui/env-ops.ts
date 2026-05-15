import { createEnvStatusManager, type EnvStatusSummary } from "../settings-env.js";
import { TEX64_LINKS } from "../platform-links.js";
import type { SettingsUiRuntime } from "./runtime.js";
import type { SettingsAttentionOps } from "./attention.js";
import { openExternalUrl } from "./utils.js";

export type SettingsEnvOps = {
  checkEnvironmentStatus: () => void;
  updateEnvStatus: (command: string, available: boolean) => void;
  handleEnvInstallStart: (payload: { target?: string }) => void;
  handleEnvInstallResult: (payload: { target?: string; success?: boolean; message?: string }) => void;
  updateRuntimeOnboardingUi: () => void;
  updateRuntimeSetupUi: () => void;
  getRuntimeStatusSummary: () => EnvStatusSummary | null;
};

export const createSettingsEnvOps = (runtime: SettingsUiRuntime, attentionOps: SettingsAttentionOps): SettingsEnvOps => {
  const {
    settingsRuntimeInstallStatus,
    settingsRuntimeSetupStatus,
    settingsRuntimeOnboardingStatus,
    settingsRuntimeRunFirstBuild,
    settingsRuntimeOpenGettingStarted,
    settingsRuntimeOpenInstallDocs,
    settingsRuntimeOpenTexDocs,
    settingsEnvRefresh,
  } = runtime.context.dom;

  const resolveEnvInstallTargetLabel = (target: string) => {
    if (target === "basictex") {
      return "TeX64 managed TeX Live";
    }
    if (target === "latexmk") {
      return "latexmk";
    }
    if (target === "latexindent") {
      return "latexindent";
    }
    return target || "Runtime Environment";
  };

  const setRuntimeInstallStatus = (
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

  const resolveRuntimeMissingLabel = (key: string) => {
    if (key === "engine") {
      return "TeX Engine (lualatex / pdflatex / xelatex / uplatex)";
    }
    if (key === "latexmk") {
      return "latexmk";
    }
    if (key === "synctex") {
      return "synctex";
    }
    if (key === "latexindent") {
      return "latexindent";
    }
    return key;
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

  const hasCompletedFirstBuild = () => {
    try {
      return localStorage.getItem(runtime.keys.firstBuildCompletedKey) === "1";
    } catch {
      return false;
    }
  };

  const updateRuntimeOnboardingUi = () => {
    const summary = runtime.state.runtimeStatusSummary;
    const hasWorkspace = Boolean(runtime.deps.getWorkspaceRootKey());
    const firstBuildCompleted = hasCompletedFirstBuild();
    if (settingsRuntimeOnboardingStatus instanceof HTMLElement) {
      settingsRuntimeOnboardingStatus.classList.remove("is-warning", "is-success");
      if (!summary || !summary.hasAnyResult) {
        settingsRuntimeOnboardingStatus.textContent =
          "First time setup: 1) Checking the execution environment 2) Opening the workspace 3) Running the first build";
      } else if (firstBuildCompleted) {
        settingsRuntimeOnboardingStatus.classList.add("is-success");
        settingsRuntimeOnboardingStatus.textContent =
          "First-time setup complete: You can run Build at any time.";
      } else if (!summary.runtimeReady) {
        const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
        settingsRuntimeOnboardingStatus.classList.add("is-warning");
        settingsRuntimeOnboardingStatus.textContent =
          missing.length > 0
            ? `First time setup: 1/3 Missing runtime (${missing.join(", ")}). Click the "Install" button above.`
            : "First time setup: 1/3 Runtime is missing. Click the \"Install\" button above.";
      } else if (!hasWorkspace) {
        settingsRuntimeOnboardingStatus.classList.add("is-warning");
        settingsRuntimeOnboardingStatus.textContent = "First time setup: 2/3 Open your workspace.";
      } else {
        settingsRuntimeOnboardingStatus.classList.add("is-success");
        settingsRuntimeOnboardingStatus.textContent =
          "First time setup: 3/3 Run your first build.";
      }
    }

    if (settingsRuntimeRunFirstBuild instanceof HTMLButtonElement) {
      const canRunBuild = Boolean(summary?.runtimeReady && hasWorkspace);
      settingsRuntimeRunFirstBuild.disabled = !canRunBuild;
      settingsRuntimeRunFirstBuild.textContent = firstBuildCompleted ? "run build" : "run the first build";
    }
  };

  const updateRuntimeSetupUi = () => {
    if (!(settingsRuntimeSetupStatus instanceof HTMLElement)) {
      return;
    }
    const summary = runtime.state.runtimeStatusSummary;
    settingsRuntimeSetupStatus.classList.remove("is-warning", "is-success");
    if (!summary || !summary.hasAnyResult) {
      settingsRuntimeSetupStatus.textContent = "Checking the execution environment.";
      updateRuntimeOnboardingUi();
      return;
    }
    if (summary.runtimeReady) {
      settingsRuntimeSetupStatus.classList.add("is-success");
      if (summary.missingRecommended.includes("latexindent")) {
        settingsRuntimeSetupStatus.textContent =
          "Ready to start using (optional: latexindent not detected).";
      } else {
        settingsRuntimeSetupStatus.textContent = "Preparations for start of use are complete.";
      }
      updateRuntimeOnboardingUi();
      return;
    }
    settingsRuntimeSetupStatus.classList.add("is-warning");
    const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
    settingsRuntimeSetupStatus.textContent = `Missing: ${missing.join(", ")}. Please prepare the TeX environment and check again.`;
    updateRuntimeOnboardingUi();
  };

  const envBtns = Array.from(document.querySelectorAll<HTMLButtonElement>(".env-btn"));

  const handleEnvInstallStart = (payload: { target?: string }) => {
    const target =
      typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : "";
    if (!target) {
      setRuntimeInstallStatus("Installation has started.");
      return;
    }
    const label = resolveEnvInstallTargetLabel(target);
    setRuntimeInstallStatus(`${label} is being installed. This can take several minutes.`);
    envBtns
      .filter((btn) => btn.dataset.target === target)
      .forEach((btn) => {
        btn.textContent = "Installing...";
        btn.disabled = true;
      });
  };

  const handleEnvInstallResult = (payload: { target?: string; success?: boolean; message?: string }) => {
    const target =
      typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : "";
    const success = payload?.success === true;
    const rawMessage =
      typeof payload?.message === "string" && payload.message.trim() ? payload.message.trim() : "";
    const label = resolveEnvInstallTargetLabel(target);
    const message =
      rawMessage ||
      (success ? `${label} installation completed.` : `${label} installation failed.`);
    setRuntimeInstallStatus(message, success ? "success" : "error");
    checkEnvironmentStatus();
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

  envBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (!target) {
        return;
      }
      btn.textContent = "Installing...";
      btn.disabled = true;
      runtime.deps.postToNative({ type: "env:install", target });
    });
  });

  if (settingsEnvRefresh instanceof HTMLButtonElement) {
    settingsEnvRefresh.addEventListener("click", () => {
      checkEnvironmentStatus();
    });
  }

  if (settingsRuntimeOpenInstallDocs instanceof HTMLButtonElement) {
    settingsRuntimeOpenInstallDocs.addEventListener("click", () => {
      openExternalUrl(runtime, TEX64_LINKS.docsInstallMac);
    });
  }

  if (settingsRuntimeOpenGettingStarted instanceof HTMLButtonElement) {
    settingsRuntimeOpenGettingStarted.addEventListener("click", () => {
      openExternalUrl(runtime, TEX64_LINKS.docsGettingStarted);
    });
  }

  if (settingsRuntimeOpenTexDocs instanceof HTMLButtonElement) {
    settingsRuntimeOpenTexDocs.addEventListener("click", () => {
      openExternalUrl(runtime, TEX64_LINKS.docsTexDistribution);
    });
  }

  if (settingsRuntimeRunFirstBuild instanceof HTMLButtonElement) {
    settingsRuntimeRunFirstBuild.addEventListener("click", () => {
      if (settingsRuntimeRunFirstBuild.disabled) {
        return;
      }
      runtime.deps.onRequestFirstBuild?.();
    });
  }

  const getRuntimeStatusSummary = () =>
    runtime.state.runtimeStatusSummary ? { ...runtime.state.runtimeStatusSummary } : null;

  return {
    checkEnvironmentStatus,
    updateEnvStatus,
    handleEnvInstallStart,
    handleEnvInstallResult,
    updateRuntimeOnboardingUi,
    updateRuntimeSetupUi,
    getRuntimeStatusSummary,
  };
};
