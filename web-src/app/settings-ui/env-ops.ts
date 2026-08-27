import { createEnvStatusManager, type EnvStatusSummary } from "../settings-env.js";
import { TEX64_LINKS } from "../platform-links.js";
import type { SettingsUiRuntime } from "./runtime.js";
import type { SettingsAttentionOps } from "./attention.js";
import { openExternalUrl } from "./utils.js";
import { uiText } from "../i18n.js";
import {
  describeCoverage,
  describeDetection,
  INSTALL_VARIANT_LABELS,
  type TexEnvReport,
  type TexInstallVariant,
} from "../tex-env-report.js";

export type SettingsEnvOps = {
  checkEnvironmentStatus: () => void;
  handleEnvDetectResult: (payload: { report?: TexEnvReport | null; error?: string }) => void;
  updateEnvStatus: (command: string, available: boolean) => void;
  handleEnvInstallStart: (payload: { target?: string; variant?: string }) => void;
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
// build right now, and if not, what do I press?" New installs use the quick
// lightweight profile; an already-ready lightweight tree can be expanded to the
// complete package set from the same screen.
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
  const detailEl = document.getElementById("env-detail");
  const choiceEl = document.getElementById("env-choice");
  const lightBtn = document.getElementById("env-choice-light");

  let installing = false;
  // The structured detection report from the main process. Until it arrives the
  // screen falls back to the per-command summary, so a detection failure degrades
  // to the old single-button behaviour instead of an empty screen.
  let detection: TexEnvReport | null = null;

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

  const setDetail = (text: string) => {
    if (!(detailEl instanceof HTMLElement)) {
      return;
    }
    const value = typeof text === "string" ? text.trim() : "";
    detailEl.textContent = value;
    detailEl.classList.toggle("is-hidden", !value);
    detailEl.setAttribute("aria-hidden", value ? "false" : "true");
  };

  const setChoiceVisible = (visible: boolean) => {
    if (!(choiceEl instanceof HTMLElement)) {
      return;
    }
    choiceEl.classList.toggle("is-hidden", !visible);
    choiceEl.setAttribute("aria-hidden", visible ? "false" : "true");
  };

  const renderChoiceLabels = () => {
    for (const [variant, button] of [
      ["light", lightBtn],
    ] as Array<[TexInstallVariant, HTMLElement | null]>) {
      if (!(button instanceof HTMLElement)) {
        continue;
      }
      const labels = INSTALL_VARIANT_LABELS[variant];
      const badge = button.querySelector(".env-choice-badge");
      const title = button.querySelector(".env-choice-title");
      const detail = button.querySelector(".env-choice-detail");
      const size = button.querySelector(".env-choice-size");
      if (badge) {
        // Blank keeps the badge row's height so both cards' titles stay aligned.
        badge.textContent = labels.badge || "\u00a0";
      }
      if (title) {
        title.textContent = labels.title;
      }
      if (detail) {
        detail.textContent = labels.detail;
      }
      if (size) {
        size.textContent = labels.size;
      }
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

  const showInstalling = (variant: TexInstallVariant = "light") => {
    installing = true;
    setHeroState("installing");
    setHeroText(
      "Setting up your TeX environment…",
      variant === "full"
        ? uiText(
            "Downloading and installing the full TeX Live (several GB). This usually takes 30–60 minutes — you can keep working in the meantime.",
            "フルセットの TeX Live をダウンロード・導入中（数 GB）。通常 30〜60 分かかります。その間も作業を続けられます。"
          )
        : uiText(
            "Downloading a lightweight TeX environment. This usually takes 1–3 minutes.",
            "軽量な TeX 環境をダウンロードしています。通常 1〜3 分で完了します。"
          )
    );
    setSetupButton({ visible: false });
    setChoiceVisible(false);
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
      setChoiceVisible(false);
      setDetail("");
      return;
    }
    const detectionLine = [describeDetection(detection), describeCoverage(detection)]
      .filter(Boolean)
      .join("\n");
    setDetail(detectionLine);

    if (summary.runtimeReady) {
      setHeroState("ready");
      const optionalMissing = summary.missingRecommended.includes("latexindent");
      // A user who already had MacTeX should be told we are using *their* TeX
      // rather than being offered a multi-gigabyte download they do not need.
      const usingExisting = detection?.source === "system";
      setHeroText(
        "Your TeX environment is ready.",
        detection?.source === "managed" && detection?.managedVariant === "light"
          ? uiText(
              "You can build now. Missing packages will be installed automatically when needed.",
              "すぐにビルドできます。足りないパッケージは必要になったとき自動で追加します。"
            )
          : usingExisting
          ? uiText(
              "TeX64 found the TeX already installed on this computer and will use it as it is.",
              "この環境に既にある TeX を検出しました。そのまま使います。"
            )
          : optionalMissing
          ? "You can build, format, and use SyncTeX. (Optional: latexindent was not detected.)"
          : "You can build, format, and use SyncTeX right away."
      );
      setSetupButton({ visible: false });
      setInstallNote("");
      setChoiceVisible(false);
      // The lightweight profile remains usable indefinitely; users who prefer
      // an offline-complete tree can expand it in place.
      if (
        detection?.source === "managed" &&
        detection?.managedVariant === "light" &&
        setupBtn instanceof HTMLButtonElement
      ) {
        setSetupButton({
          visible: true,
          disabled: false,
          label: uiText("Install the full package set", "フルパッケージを追加導入"),
        });
        return;
      }
      // Their own TeX builds, but it is a thin one (BasicTeX, TinyTeX-0). We
      // cannot add packages to a tree we do not own, so the honest offer is to
      // install ours alongside it — their TeX stays exactly as it is.
      if (detection?.source === "system" && detection.recommendation.action === "expand") {
        setHeroText(
          "Your TeX environment is ready.",
          uiText(
            "It builds, but its package set is thin. TeX64 can install its own TeX Live alongside it — yours is left untouched.",
            "ビルドはできますが、パッケージが不足しています。TeX64 専用の TeX Live を別途導入できます（既存の TeX はそのままです）。"
          )
        );
        if (choiceEl instanceof HTMLElement) {
          renderChoiceLabels();
          setChoiceVisible(true);
        }
      }
      return;
    }
    setHeroState("missing");
    setHeroText(
      "TeX environment is not set up yet.",
      uiText(
        "TeX64 installs a lightweight TeX environment privately, without admin rights, and adds packages automatically when needed.",
        "TeX64 専用の場所に軽量な TeX 環境を管理者権限なしで導入し、必要なパッケージを自動で追加します。"
      )
    );
    // The choice replaces the old single button; the button stays as the fallback
    // for a renderer whose markup predates the choice block.
    if (choiceEl instanceof HTMLElement) {
      renderChoiceLabels();
      setChoiceVisible(true);
      setSetupButton({ visible: false });
    } else {
      setSetupButton({ visible: true, disabled: false, label: "Set up TeX environment" });
    }
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

  const { updateEnvStatus } = envManager;

  // Per-command availability answers "can I build"; the detection report answers
  // "with whose TeX, and how complete is it". Both are refreshed together.
  const checkEnvironmentStatus = () => {
    envManager.checkEnvironmentStatus();
    runtime.deps.postToNative({ type: "env:detect" }, true);
  };

  const handleEnvDetectResult = (payload: {
    report?: TexEnvReport | null;
    error?: string;
  }) => {
    detection = payload && payload.report ? payload.report : null;
    updateRuntimeSetupUi();
    runtime.deps.onRuntimeDetection?.(detection, runtime.state.runtimeStatusSummary);
  };

  const startInstall = (variant: TexInstallVariant) => {
    showInstalling(variant);
    runtime.deps.postToNative({ type: "env:install", target: "basictex", variant });
  };

  // The gate needs the variant on every packet (the estimate depends on it) but
  // the main process only names it on start, so it is remembered here.
  let installingVariant: TexInstallVariant = "light";

  const handleEnvInstallStart = (payload: { target?: string; variant?: string }) => {
    installingVariant = payload?.variant === "full" ? "full" : "light";
    showInstalling(installingVariant);
    runtime.deps.onRuntimeInstallEvent?.({ kind: "start", variant: installingVariant });
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
    runtime.deps.onRuntimeInstallEvent?.({
      kind: "result",
      variant: installingVariant,
      success,
      message: rawMessage,
    });
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
    runtime.deps.onRuntimeInstallEvent?.({
      kind: "progress",
      variant: installingVariant,
      percent,
      phase,
      current,
      total,
    });
  };

  if (setupBtn instanceof HTMLButtonElement) {
    setupBtn.addEventListener("click", () => {
      if (setupBtn.disabled) {
        return;
      }
      startInstall(
        detection?.source === "managed" && detection?.managedVariant === "light"
          ? "full"
          : "light"
      );
    });
  }

  if (lightBtn instanceof HTMLButtonElement) {
    lightBtn.addEventListener("click", () => startInstall("light"));
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
    handleEnvDetectResult,
    updateEnvStatus,
    handleEnvInstallStart,
    handleEnvInstallResult,
    handleEnvInstallProgress,
    updateRuntimeOnboardingUi,
    updateRuntimeSetupUi,
    getRuntimeStatusSummary,
  };
};
