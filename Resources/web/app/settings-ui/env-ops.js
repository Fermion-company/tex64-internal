import { createEnvStatusManager } from "../settings-env.js";
import { TEX64_LINKS } from "../platform-links.js";
import { openExternalUrl } from "./utils.js";
export const createSettingsEnvOps = (runtime, attentionOps) => {
    const { settingsRuntimeInstallStatus, settingsRuntimeSetupStatus, settingsRuntimeOnboardingStatus, settingsRuntimeRunFirstBuild, settingsRuntimeOpenGettingStarted, settingsRuntimeOpenInstallDocs, settingsRuntimeOpenTexDocs, settingsEnvRefresh, } = runtime.context.dom;
    const resolveEnvInstallTargetLabel = (target) => {
        if (target === "basictex") {
            return "TeX Distribution";
        }
        if (target === "latexmk") {
            return "latexmk";
        }
        if (target === "latexindent") {
            return "latexindent";
        }
        return target || "実行環境";
    };
    const setRuntimeInstallStatus = (message, tone = "neutral") => {
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
    const resolveRuntimeMissingLabel = (key) => {
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
    const hasCompletedFirstBuild = () => {
        try {
            return localStorage.getItem(runtime.keys.firstBuildCompletedKey) === "1";
        }
        catch {
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
                    "初回セットアップ: 1) 実行環境を確認中 2) ワークスペースを開く 3) 最初のビルドを実行";
            }
            else if (firstBuildCompleted) {
                settingsRuntimeOnboardingStatus.classList.add("is-success");
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ完了: いつでも Build を実行できます。";
            }
            else if (!summary.runtimeReady) {
                const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
                settingsRuntimeOnboardingStatus.classList.add("is-warning");
                settingsRuntimeOnboardingStatus.textContent =
                    missing.length > 0
                        ? `初回セットアップ: 1/3 実行環境が不足 (${missing.join(", ")})。上の「インストール」ボタンをクリックしてください。`
                        : "初回セットアップ: 1/3 実行環境が不足しています。上の「インストール」ボタンをクリックしてください。";
            }
            else if (!hasWorkspace) {
                settingsRuntimeOnboardingStatus.classList.add("is-warning");
                settingsRuntimeOnboardingStatus.textContent = "初回セットアップ: 2/3 ワークスペースを開いてください。";
            }
            else {
                settingsRuntimeOnboardingStatus.classList.add("is-success");
                settingsRuntimeOnboardingStatus.textContent =
                    "初回セットアップ: 3/3 最初のビルドを実行してください。";
            }
        }
        if (settingsRuntimeRunFirstBuild instanceof HTMLButtonElement) {
            const canRunBuild = Boolean((summary === null || summary === void 0 ? void 0 : summary.runtimeReady) && hasWorkspace);
            settingsRuntimeRunFirstBuild.disabled = !canRunBuild;
            settingsRuntimeRunFirstBuild.textContent = firstBuildCompleted ? "ビルドを実行" : "最初のビルドを実行";
        }
    };
    const updateRuntimeSetupUi = () => {
        if (!(settingsRuntimeSetupStatus instanceof HTMLElement)) {
            return;
        }
        const summary = runtime.state.runtimeStatusSummary;
        settingsRuntimeSetupStatus.classList.remove("is-warning", "is-success");
        if (!summary || !summary.hasAnyResult) {
            settingsRuntimeSetupStatus.textContent = "実行環境を確認中です。";
            updateRuntimeOnboardingUi();
            return;
        }
        if (summary.runtimeReady) {
            settingsRuntimeSetupStatus.classList.add("is-success");
            if (summary.missingRecommended.includes("latexindent")) {
                settingsRuntimeSetupStatus.textContent =
                    "利用開始の準備は完了しています（任意: latexindent 未検出）。";
            }
            else {
                settingsRuntimeSetupStatus.textContent = "利用開始の準備が完了しています。";
            }
            updateRuntimeOnboardingUi();
            return;
        }
        settingsRuntimeSetupStatus.classList.add("is-warning");
        const missing = summary.missingRequired.map((item) => resolveRuntimeMissingLabel(item));
        settingsRuntimeSetupStatus.textContent = `不足: ${missing.join(", ")}。TeX環境を整備して再チェックしてください。`;
        updateRuntimeOnboardingUi();
    };
    const envBtns = Array.from(document.querySelectorAll(".env-btn"));
    const handleEnvInstallStart = (payload) => {
        const target = typeof (payload === null || payload === void 0 ? void 0 : payload.target) === "string" && payload.target.trim() ? payload.target.trim() : "";
        if (!target) {
            setRuntimeInstallStatus("インストールを開始しました。");
            return;
        }
        const label = resolveEnvInstallTargetLabel(target);
        setRuntimeInstallStatus(`${label} をインストールしています...`);
        envBtns
            .filter((btn) => btn.dataset.target === target)
            .forEach((btn) => {
            btn.textContent = "インストール中...";
            btn.disabled = true;
        });
    };
    const handleEnvInstallResult = (payload) => {
        const target = typeof (payload === null || payload === void 0 ? void 0 : payload.target) === "string" && payload.target.trim() ? payload.target.trim() : "";
        const success = (payload === null || payload === void 0 ? void 0 : payload.success) === true;
        const rawMessage = typeof (payload === null || payload === void 0 ? void 0 : payload.message) === "string" && payload.message.trim() ? payload.message.trim() : "";
        const label = resolveEnvInstallTargetLabel(target);
        const message = rawMessage ||
            (success ? `${label} のインストールを実行しました。` : `${label} のインストールに失敗しました。`);
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
            btn.textContent = "インストール中...";
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
            var _a, _b;
            if (settingsRuntimeRunFirstBuild.disabled) {
                return;
            }
            (_b = (_a = runtime.deps).onRequestFirstBuild) === null || _b === void 0 ? void 0 : _b.call(_a);
        });
    }
    const getRuntimeStatusSummary = () => runtime.state.runtimeStatusSummary ? { ...runtime.state.runtimeStatusSummary } : null;
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
