export const createSettingsAttentionOps = (runtime) => {
    var _a, _b;
    const { settingsNavItems, settingsRuntimeAttention, settingsAccountAttention } = runtime.context.dom;
    const runtimeSettingsNavItem = (_a = settingsNavItems.find((button) => button.dataset.settingsTarget === "env")) !== null && _a !== void 0 ? _a : null;
    const accountSettingsNavItem = (_b = settingsNavItems.find((button) => button.dataset.settingsTarget === "account")) !== null && _b !== void 0 ? _b : null;
    const hasRuntimeSetupAttention = () => {
        var _a, _b;
        return Boolean(((_a = runtime.state.runtimeStatusSummary) === null || _a === void 0 ? void 0 : _a.hasAnyResult) &&
            ((_b = runtime.state.runtimeStatusSummary) === null || _b === void 0 ? void 0 : _b.runtimeReady) === false);
    };
    const hasUpdateAttention = () => {
        var _a, _b, _c;
        const phase = (_b = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _b !== void 0 ? _b : "idle";
        if (phase === "available" || phase === "downloaded" || phase === "error") {
            return true;
        }
        if (phase === "idle" && ((_c = runtime.state.platformUpdate) === null || _c === void 0 ? void 0 : _c.hasUpdate)) {
            return true;
        }
        return false;
    };
    const syncUpdateAttentionUi = () => {
        var _a, _b;
        const updateAttention = hasUpdateAttention();
        const runtimeAttention = hasRuntimeSetupAttention();
        // Updates are surfaced via the header-bar Update button, NOT the settings
        // (gear) tab — so the gear's alert dot follows only runtime-setup attention.
        const hideAlertWhileRuntimeOpen = runtime.state.activeSettingsPage === "env";
        const showTabAlert = runtimeAttention && !hideAlertWhileRuntimeOpen;
        if (runtimeSettingsNavItem instanceof HTMLElement) {
            runtimeSettingsNavItem.classList.toggle("has-alert", runtimeAttention);
        }
        if (accountSettingsNavItem instanceof HTMLElement) {
            accountSettingsNavItem.classList.toggle("has-alert", updateAttention);
        }
        if (settingsRuntimeAttention instanceof HTMLElement) {
            settingsRuntimeAttention.textContent = "Setup needed";
            settingsRuntimeAttention.classList.toggle("is-hidden", !runtimeAttention);
            settingsRuntimeAttention.setAttribute("aria-hidden", runtimeAttention ? "false" : "true");
        }
        if (settingsAccountAttention instanceof HTMLElement) {
            settingsAccountAttention.textContent = "Update";
            settingsAccountAttention.classList.toggle("is-hidden", !updateAttention);
            settingsAccountAttention.setAttribute("aria-hidden", updateAttention ? "false" : "true");
        }
        (_b = (_a = runtime.deps).onUpdateAttentionChange) === null || _b === void 0 ? void 0 : _b.call(_a, showTabAlert);
    };
    return { hasRuntimeSetupAttention, hasUpdateAttention, syncUpdateAttentionUi };
};
