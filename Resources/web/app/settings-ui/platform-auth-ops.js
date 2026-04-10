export const createSettingsPlatformAuthOps = (runtime) => {
    const { settingsAuthStatus, settingsAuthLogin, settingsAuthLogout } = runtime.context.dom;
    const updatePlatformAuthUi = () => {
        var _a, _b, _c, _d;
        const authenticated = Boolean((_a = runtime.state.platformAuth) === null || _a === void 0 ? void 0 : _a.authenticated);
        const pending = Boolean((_b = runtime.state.platformAuth) === null || _b === void 0 ? void 0 : _b.pending);
        const userLabel = typeof ((_d = (_c = runtime.state.platformAuth) === null || _c === void 0 ? void 0 : _c.user) === null || _d === void 0 ? void 0 : _d.email) === "string" && runtime.state.platformAuth.user.email.trim()
            ? runtime.state.platformAuth.user.email.trim()
            : "";
        if (settingsAuthStatus instanceof HTMLElement) {
            if (authenticated) {
                settingsAuthStatus.textContent = userLabel ? `Signed in: ${userLabel}` : "Signed in";
            }
            else if (pending) {
                settingsAuthStatus.textContent = "Signing in";
            }
            else {
                settingsAuthStatus.textContent = "Signed out";
            }
        }
        if (settingsAuthLogin instanceof HTMLButtonElement) {
            const showLogin = !authenticated;
            settingsAuthLogin.classList.toggle("is-hidden", !showLogin);
            settingsAuthLogin.setAttribute("aria-hidden", showLogin ? "false" : "true");
            settingsAuthLogin.disabled = pending;
            settingsAuthLogin.textContent = pending ? "Signing in..." : "Login";
        }
        if (settingsAuthLogout instanceof HTMLButtonElement) {
            settingsAuthLogout.classList.toggle("is-hidden", !authenticated);
            settingsAuthLogout.disabled = !authenticated;
        }
    };
    const handlePlatformAuth = (payload) => {
        var _a;
        runtime.state.platformAuth = (_a = payload === null || payload === void 0 ? void 0 : payload.auth) !== null && _a !== void 0 ? _a : null;
        updatePlatformAuthUi();
    };
    if (settingsAuthLogout instanceof HTMLButtonElement) {
        settingsAuthLogout.addEventListener("click", () => {
            runtime.deps.postToNative({ type: "auth:signout" });
        });
    }
    if (settingsAuthLogin instanceof HTMLButtonElement) {
        settingsAuthLogin.addEventListener("click", () => {
            if (settingsAuthLogin.disabled) {
                return;
            }
            runtime.deps.postToNative({ type: "auth:google:start" });
        });
    }
    return { updatePlatformAuthUi, handlePlatformAuth };
};
