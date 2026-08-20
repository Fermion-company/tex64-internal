import { uiText } from "./i18n.js";
import { INSTALL_VARIANT_LABELS } from "./tex-env-report.js";
// First-run gate. If TeX is already usable this never appears and the app opens
// straight into the editor; if it is not, this is the only thing the user sees
// until an install finishes.
// How long each variant takes end to end, measured on an M-series Mac with a
// normal connection (light: 2:08, full: the CTAN mirror dominates). Used until
// the run's own pace is known.
export const VARIANT_TOTAL_MS = {
    light: 2 * 60 * 1000,
    full: 45 * 60 * 1000,
};
// The progress bar is NOT linear in time: for the light install the whole
// install-tl phase (bar 0->80%) is ~15s while the package phase (80->98%) is
// ~95s, and for the full install it is the other way round. Mapping bar percent
// onto elapsed-time fraction is what makes the remaining-time estimate honest
// instead of collapsing from "5 minutes" to "done" at 80%.
const TIME_CURVE = {
    light: [
        [0, 0],
        [8, 0.05],
        [80, 0.13],
        [98, 0.92],
        [100, 1],
    ],
    full: [
        [0, 0],
        [8, 0.02],
        [80, 0.97],
        [98, 0.995],
        [100, 1],
    ],
};
export const timeFractionForPercent = (percent, variant) => {
    var _a;
    const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
    const curve = (_a = TIME_CURVE[variant]) !== null && _a !== void 0 ? _a : TIME_CURVE.light;
    for (let i = 1; i < curve.length; i += 1) {
        const [prevP, prevF] = curve[i - 1];
        const [nextP, nextF] = curve[i];
        if (p <= nextP) {
            const span = nextP - prevP;
            const ratio = span <= 0 ? 0 : (p - prevP) / span;
            return prevF + (nextF - prevF) * ratio;
        }
    }
    return 1;
};
export const initialEtaState = () => ({
    startedAt: null,
    percent: 0,
    remainingMs: null,
});
// Projects the total run time from how far along we are in *time* terms, then
// smooths it so the number does not jump with every progress packet. The
// estimate is allowed to rise: on a machine slower than the reference run that
// is the truth, and pinning it to only ever fall would strand the user at
// "almost done" while the install grinds on. Rises are damped harder than falls
// so it creeps up instead of lurching.
export const nextEtaState = (previous, input) => {
    var _a, _b;
    const startedAt = (_a = previous.startedAt) !== null && _a !== void 0 ? _a : input.now;
    const percent = Math.max(previous.percent, Math.max(0, Math.min(100, Number.isFinite(input.percent) ? input.percent : 0)));
    const elapsed = Math.max(0, input.now - startedAt);
    const fraction = timeFractionForPercent(percent, input.variant);
    const fallbackTotal = (_b = VARIANT_TOTAL_MS[input.variant]) !== null && _b !== void 0 ? _b : VARIANT_TOTAL_MS.light;
    // Only trust the measured pace once enough of the run has happened for the
    // ratio to mean anything.
    const measuredTotal = fraction >= 0.04 && elapsed >= 2000 ? elapsed / fraction : null;
    const projectedTotal = measuredTotal !== null && measuredTotal !== void 0 ? measuredTotal : fallbackTotal;
    const raw = Math.max(0, projectedTotal - elapsed);
    let smoothed = raw;
    if (previous.remainingMs !== null) {
        // Falls track the measured pace closely (a real install sends hundreds of
        // packets, and lagging behind means promising a minute when ten seconds are
        // left); rises are damped so one slow packet cannot lurch the number.
        const weight = raw > previous.remainingMs ? 0.15 : 0.5;
        smoothed = previous.remainingMs * (1 - weight) + raw * weight;
    }
    return { startedAt, percent, remainingMs: percent >= 100 ? 0 : smoothed };
};
// Rounded to something a person would actually say. Precision here would be a
// lie anyway — the number comes from a projection.
export const formatRemaining = (remainingMs) => {
    if (remainingMs === null || !Number.isFinite(remainingMs)) {
        return "";
    }
    const seconds = Math.max(0, Math.round(remainingMs / 1000));
    if (seconds <= 10) {
        return uiText("almost done", "まもなく完了");
    }
    if (seconds < 60) {
        const rounded = Math.max(10, Math.round(seconds / 10) * 10);
        return uiText(`about ${rounded} seconds left`, `残り 約 ${rounded} 秒`);
    }
    const minutes = Math.round(seconds / 60);
    if (minutes <= 1) {
        return uiText("about a minute left", "残り 約 1 分");
    }
    if (minutes < 60) {
        return uiText(`about ${minutes} minutes left`, `残り 約 ${minutes} 分`);
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
        ? uiText(`about ${hours} h left`, `残り 約 ${hours} 時間`)
        : uiText(`about ${hours} h ${rest} min left`, `残り 約 ${hours} 時間 ${rest} 分`);
};
export const installPhaseLabel = (phase) => {
    switch (phase) {
        case "download":
            return uiText("Downloading the installer…", "インストーラをダウンロード中…");
        case "extract":
            return uiText("Preparing the installer…", "インストーラを準備中…");
        case "texlive":
            return uiText("Installing TeX Live…", "TeX Live を導入中…");
        case "packages":
            return uiText("Installing packages…", "パッケージを導入中…");
        case "finalize":
            return uiText("Finishing up…", "仕上げ中…");
        default:
            return uiText("Setting up…", "セットアップ中…");
    }
};
export const initOnboardingUi = (deps) => {
    const root = document.getElementById("onboarding");
    const choiceStep = document.getElementById("onboarding-choice");
    const progressStep = document.getElementById("onboarding-progress");
    const lightBtn = document.getElementById("onboarding-choice-light");
    const fullBtn = document.getElementById("onboarding-choice-full");
    const skipBtn = document.getElementById("onboarding-skip");
    const fill = document.getElementById("onboarding-gauge-fill");
    const percentEl = document.getElementById("onboarding-percent");
    const etaEl = document.getElementById("onboarding-eta");
    const phaseEl = document.getElementById("onboarding-phase");
    const noteEl = document.getElementById("onboarding-note");
    const progressTitle = document.getElementById("onboarding-progress-title");
    let eta = initialEtaState();
    let visible = false;
    const setVisible = (value) => {
        visible = value;
        if (root instanceof HTMLElement) {
            root.classList.toggle("is-visible", value);
            root.setAttribute("aria-hidden", value ? "false" : "true");
        }
        document.body.classList.toggle("has-onboarding", value);
    };
    const setStep = (step) => {
        choiceStep === null || choiceStep === void 0 ? void 0 : choiceStep.classList.toggle("is-hidden", step !== "choice");
        progressStep === null || progressStep === void 0 ? void 0 : progressStep.classList.toggle("is-hidden", step !== "progress");
    };
    const renderChoiceLabels = () => {
        for (const [variant, button] of [
            ["light", lightBtn],
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
                badge.textContent = labels.badge || " ";
            }
            if (title) {
                title.textContent = labels.title;
            }
            if (detail) {
                detail.textContent = labels.detail;
            }
            // The size is not decoration: it is half of what the choice is about, so
            // it is always rendered, never truncated away.
            if (size) {
                size.textContent = labels.size;
            }
        }
    };
    const showChoice = () => {
        eta = initialEtaState();
        renderChoiceLabels();
        setStep("choice");
        if (noteEl instanceof HTMLElement) {
            noteEl.classList.add("is-hidden");
        }
        setVisible(true);
    };
    const showProgress = (input) => {
        setStep("progress");
        setVisible(true);
        const percent = typeof input.percent === "number" ? input.percent : eta.percent;
        eta = nextEtaState(eta, { percent, now: Date.now(), variant: input.variant });
        if (fill instanceof HTMLElement) {
            fill.style.width = `${Math.round(eta.percent)}%`;
        }
        if (percentEl instanceof HTMLElement) {
            percentEl.textContent = `${Math.round(eta.percent)}%`;
        }
        if (etaEl instanceof HTMLElement) {
            etaEl.textContent = formatRemaining(eta.remainingMs);
        }
        if (phaseEl instanceof HTMLElement) {
            const counts = typeof input.current === "number" && typeof input.total === "number" && input.total > 0
                ? ` (${input.current}/${input.total})`
                : "";
            phaseEl.textContent = `${installPhaseLabel(input.phase)}${counts}`;
        }
        if (progressTitle instanceof HTMLElement) {
            progressTitle.textContent =
                input.variant === "light"
                    ? uiText("Setting up TeX (light)…", "TeX をセットアップ中（ライト）…")
                    : uiText("Setting up TeX (everything)…", "TeX をセットアップ中（フル）…");
        }
    };
    const showFailure = (message) => {
        setStep("choice");
        setVisible(true);
        if (noteEl instanceof HTMLElement) {
            noteEl.textContent =
                message ||
                    uiText("Setup did not finish. You can try again.", "セットアップが完了しませんでした。もう一度お試しください。");
            noteEl.classList.remove("is-hidden");
        }
    };
    const finish = () => {
        setVisible(false);
        deps.onFinished();
    };
    lightBtn === null || lightBtn === void 0 ? void 0 : lightBtn.addEventListener("click", () => deps.startInstall("light"));
    fullBtn === null || fullBtn === void 0 ? void 0 : fullBtn.addEventListener("click", () => deps.startInstall("full"));
    skipBtn === null || skipBtn === void 0 ? void 0 : skipBtn.addEventListener("click", () => {
        setVisible(false);
        deps.onSkip();
    });
    return { showChoice, showProgress, showFailure, finish, isVisible: () => visible };
};
