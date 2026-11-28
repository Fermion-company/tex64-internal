import { uiText } from "../i18n.js";
import type { PlatformAuthSnapshot } from "../types.js";
import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsPlatformAuthOps = {
  updatePlatformAuthUi: () => void;
  handlePlatformAuth: (payload: { auth: PlatformAuthSnapshot; action?: string; error?: { code?: string; message?: string } }) => void;
};

export const createSettingsPlatformAuthOps = (runtime: SettingsUiRuntime): SettingsPlatformAuthOps => {
  const { settingsAuthStatus, settingsAuthLogin, settingsAuthCancel, settingsAuthLogout } = runtime.context.dom;

  const updatePlatformAuthUi = () => {
    const authenticated = Boolean(runtime.state.platformAuth?.authenticated);
    const pending = Boolean(runtime.state.platformAuth?.pending);
    const userLabel =
      typeof runtime.state.platformAuth?.user?.email === "string" && runtime.state.platformAuth.user.email.trim()
        ? runtime.state.platformAuth.user.email.trim()
        : "";

    if (settingsAuthStatus instanceof HTMLElement) {
      if (authenticated) {
        settingsAuthStatus.textContent = userLabel || "Signed in";
      } else if (pending) {
        settingsAuthStatus.textContent = "Signing in";
      } else {
        settingsAuthStatus.textContent = "Signed out";
      }
    }
    if (settingsAuthLogin instanceof HTMLButtonElement) {
      const showLogin = !authenticated;
      settingsAuthLogin.classList.toggle("is-hidden", !showLogin);
      settingsAuthLogin.setAttribute("aria-hidden", showLogin ? "false" : "true");
      settingsAuthLogin.disabled = pending;
      settingsAuthLogin.textContent = pending ? "Signing in…" : "Login";
    }
    if (settingsAuthCancel instanceof HTMLButtonElement) {
      settingsAuthCancel.classList.toggle("is-hidden", !pending);
      settingsAuthCancel.setAttribute("aria-hidden", String(!pending));
    }
    if (settingsAuthLogout instanceof HTMLButtonElement) {
      settingsAuthLogout.classList.toggle("is-hidden", !authenticated);
      settingsAuthLogout.disabled = !authenticated;
    }
  };

  const handlePlatformAuth = (payload: { auth: PlatformAuthSnapshot; action?: string; error?: { code?: string; message?: string } }) => {
    runtime.state.platformAuth = payload?.auth ?? null;
    updatePlatformAuthUi();
    if (settingsAuthStatus instanceof HTMLElement && payload?.action && payload.error) {
      const fallback = payload.action === "logout"
        ? uiText("Could not sign out.", "ログアウトできませんでした。")
        : payload.action === "cancel" ? uiText("Could not cancel sign-in.", "ログインを中止できませんでした。")
        : uiText("Could not sign in.", "ログインできませんでした。");
      settingsAuthStatus.textContent = [fallback, payload.error.message].filter(Boolean).join(" ");
    }
  };

  settingsAuthCancel?.addEventListener("click", () => {
    runtime.deps.postToNative({ type: "auth:google:cancel" });
  });

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

