export const createSettingsAttentionOps = (runtime) => {
    var _a;
    const { settingsNavItems, settingsAccountAttention } = runtime.context.dom;
    const accountSettingsNavItem = (_a = settingsNavItems.find((button) => button.dataset.settingsTarget === "account")) !== null && _a !== void 0 ? _a : null;
    const hasUpdateAttention = () => {
        var _a, _b;
        var _c;
        const phase = (_c = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _c !== void 0 ? _c : "idle";
        if (phase === "available" || phase === "downloaded" || phase === "error") {
            return true;
        }
        if (phase === "idle" && ((_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.hasUpdate)) {
            return true;
        }
        return false;
    };
    const syncUpdateAttentionUi = () => {
        var _a, _b;
        const updateAttention = hasUpdateAttention();
        if (accountSettingsNavItem instanceof HTMLElement) {
            accountSettingsNavItem.classList.toggle("has-alert", updateAttention);
        }
        if (settingsAccountAttention instanceof HTMLElement) {
            settingsAccountAttention.textContent = "Update Available";
            settingsAccountAttention.classList.toggle("is-hidden", !updateAttention);
            settingsAccountAttention.setAttribute("aria-hidden", updateAttention ? "false" : "true");
        }
        // The environment screen no longer raises a "setup needed" alert, and app
        // updates surface via the header Update button — so the gear tab stays clean.
        (_b = (_a = runtime.deps).onUpdateAttentionChange) === null || _b === void 0 ? void 0 : _b.call(_a, false);
    };
    return { hasUpdateAttention, syncUpdateAttentionUi };
};
