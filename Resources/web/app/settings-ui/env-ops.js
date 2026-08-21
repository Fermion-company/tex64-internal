import { createEnvStatusManager } from "../settings-env.js";
import { TEX64_LINKS } from "../platform-links.js";
import { openExternalUrl } from "./utils.js";
import { uiText } from "../i18n.js";
import { describeCoverage, describeDetection, INSTALL_VARIANT_LABELS, } from "../tex-env-report.js";
// The full-screen Environment screen answers one question for the user: "can I
// build right now, and if not, what do I press?" Under the hood every install
// target funnels to the same managed TeX Live install, so the screen exposes a
// single status + one setup button, with the per-tool detection tucked away.
export const createSettingsEnvOps = (runtime, attentionOps) => {
    const { settingsRuntimeSetupStatus, settingsRuntimeInstallStatus, settingsRuntimeOpenTexDocs, } = runtime.context.dom;
    const heroEl = document.getElementById("env-hero");
    const heroSubEl = document.getElementById("env-hero-sub");
    const setupBtn = document.getElementById("settings-env-setup");
    const progressEl = document.getElementById("env-progress");
    const progressFill = document.getElementById("env-progress-fill");
    const progressLabel = document.getElementById("env-progress-label");
    const detailEl = document.getElementById("env-detail");
    const choiceEl = document.getElementById("env-choice");
    const fullBtn = document.getElementById("env-choice-full");
    let installing = false;
    // The structured detection report from the main process. Until it arrives the
    // screen falls back to the per-command summary, so a detection failure degrades
    // to the old single-button behaviour instead of an empty screen.
    let detection = null;
    const setHeroState = (state) => {
        if (!(heroEl instanceof HTMLElement)) {
            return;
        }
        heroEl.classList.remove("is-checking", "is-missing", "is-installing", "is-ready");
        heroEl.classList.add(`is-${state}`);
    };
    const setHeroText = (title, sub) => {
        if (settingsRuntimeSetupStatus instanceof HTMLElement) {
            settingsRuntimeSetupStatus.textContent = title;
        }
        if (heroSubEl instanceof HTMLElement) {
            heroSubEl.textContent = sub;
        }
    };
    const setSetupButton = (opts) => {
        if (!(setupBtn instanceof HTMLButtonElement)) {
            return;
        }
        setupBtn.classList.toggle("is-hidden", !opts.visible);
        setupBtn.disabled = Boolean(opts.disabled);
        if (typeof opts.label === "string") {
            setupBtn.textContent = opts.label;
        }
    };
    const setInstallNote = (message, tone = "neutral") => {
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
    const phaseLabel = (phase) => {
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
    const showProgress = (visible) => {
        if (progressEl instanceof HTMLElement) {
            progressEl.classList.toggle("is-hidden", !visible);
            progressEl.setAttribute("aria-hidden", visible ? "false" : "true");
        }
    };
    // Width + text are set directly from JS (not a CSS animation), so the bar keeps
    // advancing even under prefers-reduced-motion.
    const setProgress = (percent, label) => {
        if (progressFill instanceof HTMLElement && typeof percent === "number") {
            const clamped = Math.max(0, Math.min(100, Math.round(percent)));
            progressFill.style.width = `${clamped}%`;
        }
        if (progressLabel instanceof HTMLElement) {
            progressLabel.textContent = label;
        }
    };
    const setDetail = (text) => {
        if (!(detailEl instanceof HTMLElement)) {
            return;
        }
        const value = typeof text === "string" ? text.trim() : "";
        detailEl.textContent = value;
        detailEl.classList.toggle("is-hidden", !value);
        detailEl.setAttribute("aria-hidden", value ? "false" : "true");
    };
    const setChoiceVisible = (visible) => {
        if (!(choiceEl instanceof HTMLElement)) {
            return;
        }
        choiceEl.classList.toggle("is-hidden", !visible);
        choiceEl.setAttribute("aria-hidden", visible ? "false" : "true");
    };
    const renderChoiceLabels = () => {
        for (const [variant, button] of [
            ["full", fullBtn],
        ]) {
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
        }
        catch {
            return false;
        }
    };
    const markRuntimeSetupPrompted = () => {
        try {
            localStorage.setItem(runtime.keys.runtimeSetupPromptedKey, "1");
        }
        catch {
            // ignore storage failures
        }
    };
    const maybePromptRuntimeSetup = (summary) => {
        var _a, _b;
        if (!summary || !summary.hasAnyResult || summary.runtimeReady) {
            runtime.state.runtimeSetupPromptInFlight = false;
            return;
        }
        if (runtime.state.runtimeSetupPromptInFlight || hasPromptedRuntimeSetup()) {
            return;
        }
        runtime.state.runtimeSetupPromptInFlight = true;
        markRuntimeSetupPrompted();
        (_b = (_a = runtime.deps).onRuntimeSetupNeeded) === null || _b === void 0 ? void 0 : _b.call(_a, summary);
    };
    const showInstalling = (_variant = "full") => {
        installing = true;
        setHeroState("installing");
        setHeroText("Setting up your TeX environment…", uiText("Downloading and installing the full TeX Live (several GB). This usually takes 30–60 minutes — you can keep working in the meantime.", "フルセットの TeX Live をダウンロード・導入中（数 GB）。通常 30〜60 分かかります。その間も作業を続けられます。"));
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
            const usingExisting = (detection === null || detection === void 0 ? void 0 : detection.source) === "system";
            setHeroText("Your TeX environment is ready.", usingExisting
                ? uiText("TeX64 found the TeX already installed on this computer and will use it as it is.", "この環境に既にある TeX を検出しました。そのまま使います。")
                : optionalMissing
                    ? "You can build, format, and use SyncTeX. (Optional: latexindent was not detected.)"
                    : "You can build, format, and use SyncTeX right away.");
            setSetupButton({ visible: false });
            setInstallNote("");
            setChoiceVisible(false);
            // Retired development builds may have left a partial managed tree. Offer
            // the in-place scheme-full upgrade until its marker is rewritten.
            if ((detection === null || detection === void 0 ? void 0 : detection.source) === "managed" &&
                (detection === null || detection === void 0 ? void 0 : detection.managedVariant) === "light" &&
                setupBtn instanceof HTMLButtonElement) {
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
            if ((detection === null || detection === void 0 ? void 0 : detection.source) === "system" && detection.recommendation.action === "expand") {
                setHeroText("Your TeX environment is ready.", uiText("It builds, but its package set is thin. TeX64 can install its own TeX Live alongside it — yours is left untouched.", "ビルドはできますが、パッケージが不足しています。TeX64 専用の TeX Live を別途導入できます（既存の TeX はそのままです）。"));
                if (choiceEl instanceof HTMLElement) {
                    renderChoiceLabels();
                    setChoiceVisible(true);
                }
            }
            return;
        }
        setHeroState("missing");
        setHeroText("TeX environment is not set up yet.", uiText("TeX64 installs the complete TeX Live privately, without admin rights, and never touches any TeX you already have.", "TeX64 専用の場所に完全な TeX Live を管理者権限なしで導入します。既存の TeX には触れません。"));
        // The choice replaces the old single button; the button stays as the fallback
        // for a renderer whose markup predates the choice block.
        if (choiceEl instanceof HTMLElement) {
            renderChoiceLabels();
            setChoiceVisible(true);
            setSetupButton({ visible: false });
        }
        else {
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
    const handleEnvDetectResult = (payload) => {
        var _a, _b;
        detection = payload && payload.report ? payload.report : null;
        updateRuntimeSetupUi();
        (_b = (_a = runtime.deps).onRuntimeDetection) === null || _b === void 0 ? void 0 : _b.call(_a, detection, runtime.state.runtimeStatusSummary);
    };
    const startInstall = (variant) => {
        showInstalling(variant);
        runtime.deps.postToNative({ type: "env:install", target: "basictex", variant });
    };
    // The gate needs the variant on every packet (the estimate depends on it) but
    // the main process only names it on start, so it is remembered here.
    let installingVariant = "full";
    const handleEnvInstallStart = (payload) => {
        var _a, _b;
        installingVariant = "full";
        showInstalling(installingVariant);
        (_b = (_a = runtime.deps).onRuntimeInstallEvent) === null || _b === void 0 ? void 0 : _b.call(_a, { kind: "start", variant: installingVariant });
    };
    const handleEnvInstallResult = (payload) => {
        var _a, _b;
        installing = false;
        showProgress(false);
        const success = (payload === null || payload === void 0 ? void 0 : payload.success) === true;
        const rawMessage = typeof (payload === null || payload === void 0 ? void 0 : payload.message) === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
        if (success) {
            setInstallNote(rawMessage || "TeX environment installed successfully.", "success");
        }
        else {
            setInstallNote(rawMessage || "Setup did not finish. Please try again, or open the guide.", "error");
        }
        (_b = (_a = runtime.deps).onRuntimeInstallEvent) === null || _b === void 0 ? void 0 : _b.call(_a, {
            kind: "result",
            variant: installingVariant,
            success,
            message: rawMessage,
        });
        // Re-detect so the hero + component badges reflect the new reality.
        checkEnvironmentStatus();
    };
    const handleEnvInstallProgress = (payload) => {
        var _a, _b;
        installing = true;
        setHeroState("installing");
        showProgress(true);
        const phase = typeof (payload === null || payload === void 0 ? void 0 : payload.phase) === "string" ? payload.phase : "";
        const current = typeof (payload === null || payload === void 0 ? void 0 : payload.current) === "number" ? payload.current : null;
        const total = typeof (payload === null || payload === void 0 ? void 0 : payload.total) === "number" ? payload.total : null;
        let label = phaseLabel(phase);
        if (current && total) {
            label += ` (${current}/${total})`;
        }
        const percent = typeof (payload === null || payload === void 0 ? void 0 : payload.percent) === "number" ? payload.percent : null;
        setProgress(percent, label);
        (_b = (_a = runtime.deps).onRuntimeInstallEvent) === null || _b === void 0 ? void 0 : _b.call(_a, {
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
            startInstall("full");
        });
    }
    if (fullBtn instanceof HTMLButtonElement) {
        fullBtn.addEventListener("click", () => startInstall("full"));
    }
    if (settingsRuntimeOpenTexDocs instanceof HTMLButtonElement) {
        settingsRuntimeOpenTexDocs.addEventListener("click", () => {
            openExternalUrl(runtime, TEX64_LINKS.docsTexDistribution);
        });
    }
    const getRuntimeStatusSummary = () => runtime.state.runtimeStatusSummary ? { ...runtime.state.runtimeStatusSummary } : null;
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
