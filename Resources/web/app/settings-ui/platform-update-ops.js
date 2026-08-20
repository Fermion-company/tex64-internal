import { TEX64_LINKS } from "../platform-links.js";
import { formatBytes, openExternalUrl } from "./utils.js";
const MICROSOFT_STORE_UPDATE_MODE = "microsoft-store";
export const createSettingsPlatformUpdateOps = (runtime, attentionOps) => {
    const { settingsUpdateCurrent, settingsUpdateLatest, settingsUpdateStatus, settingsUpdateProgress, settingsUpdateProgressFill, settingsUpdateCheck, settingsUpdateApply, settingsUpdateOpen, updateButton, } = runtime.context.dom;
    const isMicrosoftStoreManaged = () => { var _a, _b; return ((_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.mode) === MICROSOFT_STORE_UPDATE_MODE ||
        ((_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.channel) === MICROSOFT_STORE_UPDATE_MODE; };
    const clearUpdateAutoCheckTimer = () => {
        if (runtime.state.updateAutoCheckTimer !== null) {
            window.clearTimeout(runtime.state.updateAutoCheckTimer);
            runtime.state.updateAutoCheckTimer = null;
        }
    };
    const resolveUpdateStatusText = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        var _j, _k, _l, _m, _o;
        const phase = (_j = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _j !== void 0 ? _j : "idle";
        const latest = (_l = (_k = (_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.latestVersion) !== null && _k !== void 0 ? _k : (_c = runtime.state.platformUpdateStatus) === null || _c === void 0 ? void 0 : _c.latestVersion) !== null && _l !== void 0 ? _l : null;
        if (((_d = runtime.state.platformUpdateStatus) === null || _d === void 0 ? void 0 : _d.message) && runtime.state.platformUpdateStatus.message.trim()) {
            return runtime.state.platformUpdateStatus.message.trim();
        }
        if (phase === "checking") {
            return "Checking for updates.";
        }
        if (phase === "up-to-date") {
            return latest ? `Latest version ${latest}.` : "Up to date.";
        }
        if (phase === "available") {
            return latest ? `A new version of ${latest} is available.` : "A new version is available.";
        }
        if (phase === "downloading") {
            const transferred = formatBytes((_m = (_e = runtime.state.platformUpdateStatus) === null || _e === void 0 ? void 0 : _e.transferredBytes) !== null && _m !== void 0 ? _m : 0);
            const total = formatBytes((_o = (_f = runtime.state.platformUpdateStatus) === null || _f === void 0 ? void 0 : _f.totalBytes) !== null && _o !== void 0 ? _o : 0);
            return `Downloading updates (${transferred} / ${total}).`;
        }
        if (phase === "downloaded") {
            return "Download completed. You can launch the installer with the Apply button.";
        }
        if (phase === "installing") {
            return "I started the installer. Follow the on-screen instructions to update.";
        }
        if (phase === "error") {
            const message = (_h = (_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.error) === null || _h === void 0 ? void 0 : _h.message;
            return message && message.trim() ? message.trim() : "Update processing failed.";
        }
        return "Waiting for update check.";
    };
    const updatePlatformUpdateUi = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        var _l, _m, _o, _p, _q, _r, _s;
        const currentVersion = (_m = (_l = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.currentVersion) !== null && _l !== void 0 ? _l : (_b = runtime.state.platformUpdateStatus) === null || _b === void 0 ? void 0 : _b.currentVersion) !== null && _m !== void 0 ? _m : "-";
        const latestVersion = (_p = (_o = (_c = runtime.state.platformUpdate) === null || _c === void 0 ? void 0 : _c.latestVersion) !== null && _o !== void 0 ? _o : (_d = runtime.state.platformUpdateStatus) === null || _d === void 0 ? void 0 : _d.latestVersion) !== null && _p !== void 0 ? _p : "-";
        if (settingsUpdateCurrent instanceof HTMLElement) {
            settingsUpdateCurrent.textContent = currentVersion;
        }
        if (settingsUpdateLatest instanceof HTMLElement) {
            settingsUpdateLatest.textContent = latestVersion;
        }
        const statusText = resolveUpdateStatusText();
        if (settingsUpdateStatus instanceof HTMLElement) {
            settingsUpdateStatus.textContent = statusText;
            const phase = (_q = (_e = runtime.state.platformUpdateStatus) === null || _e === void 0 ? void 0 : _e.phase) !== null && _q !== void 0 ? _q : "idle";
            settingsUpdateStatus.classList.toggle("is-error", phase === "error");
            settingsUpdateStatus.classList.toggle("is-success", phase === "downloaded" || isMicrosoftStoreManaged());
        }
        const progress = typeof ((_f = runtime.state.platformUpdateStatus) === null || _f === void 0 ? void 0 : _f.progressPercent) === "number" &&
            Number.isFinite(runtime.state.platformUpdateStatus.progressPercent)
            ? Math.max(0, Math.min(100, runtime.state.platformUpdateStatus.progressPercent))
            : 0;
        const storeManaged = isMicrosoftStoreManaged();
        const showProgress = !storeManaged && ((_r = (_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.phase) !== null && _r !== void 0 ? _r : "") === "downloading";
        if (settingsUpdateProgress instanceof HTMLElement) {
            settingsUpdateProgress.classList.toggle("is-hidden", !showProgress);
            settingsUpdateProgress.setAttribute("aria-hidden", showProgress ? "false" : "true");
        }
        if (settingsUpdateProgressFill instanceof HTMLElement) {
            settingsUpdateProgressFill.style.width = `${progress}%`;
        }
        const phase = (_s = (_h = runtime.state.platformUpdateStatus) === null || _h === void 0 ? void 0 : _h.phase) !== null && _s !== void 0 ? _s : "idle";
        const hasUpdate = Boolean((_j = runtime.state.platformUpdate) === null || _j === void 0 ? void 0 : _j.hasUpdate);
        const hasDownloadedInstaller = Boolean((_k = runtime.state.platformUpdateStatus) === null || _k === void 0 ? void 0 : _k.downloadedPath);
        if (settingsUpdateCheck instanceof HTMLButtonElement) {
            settingsUpdateCheck.classList.toggle("is-hidden", storeManaged);
            settingsUpdateCheck.setAttribute("aria-hidden", storeManaged ? "true" : "false");
            settingsUpdateCheck.disabled =
                storeManaged || phase === "checking" || phase === "downloading";
        }
        const canApplyUpdate = !storeManaged &&
            (hasUpdate || hasDownloadedInstaller || phase === "available" || phase === "downloaded");
        if (settingsUpdateApply instanceof HTMLButtonElement) {
            settingsUpdateApply.classList.toggle("is-hidden", !canApplyUpdate);
            settingsUpdateApply.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
            settingsUpdateApply.disabled =
                !canApplyUpdate || phase === "checking" || phase === "downloading" || phase === "installing";
        }
        // Mirror the Apply button in the header bar: show a one-click Update button
        // whenever an update can be applied. Pulse (is-attention) when ready, show
        // a spinner (is-busy) while downloading/installing.
        if (updateButton instanceof HTMLButtonElement) {
            const busy = phase === "downloading" || phase === "installing";
            updateButton.classList.toggle("is-hidden", !canApplyUpdate);
            updateButton.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
            updateButton.classList.toggle("is-busy", busy);
            updateButton.classList.toggle("is-attention", canApplyUpdate && !busy);
            updateButton.disabled = !canApplyUpdate || phase === "checking" || busy;
        }
        if (settingsUpdateOpen instanceof HTMLButtonElement) {
            settingsUpdateOpen.classList.toggle("is-hidden", storeManaged);
            settingsUpdateOpen.setAttribute("aria-hidden", storeManaged ? "true" : "false");
            settingsUpdateOpen.disabled = storeManaged;
        }
        attentionOps.syncUpdateAttentionUi();
    };
    const handlePlatformUpdate = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        var _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        runtime.state.platformUpdate = (_l = payload === null || payload === void 0 ? void 0 : payload.update) !== null && _l !== void 0 ? _l : null;
        if (runtime.state.platformUpdateStatus) {
            runtime.state.platformUpdateStatus = {
                ...runtime.state.platformUpdateStatus,
                latestVersion: (_o = (_m = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.latestVersion) !== null && _m !== void 0 ? _m : runtime.state.platformUpdateStatus.latestVersion) !== null && _o !== void 0 ? _o : null,
                currentVersion: (_q = (_p = (_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.currentVersion) !== null && _p !== void 0 ? _p : runtime.state.platformUpdateStatus.currentVersion) !== null && _q !== void 0 ? _q : null,
            };
        }
        if ((_c = payload === null || payload === void 0 ? void 0 : payload.error) === null || _c === void 0 ? void 0 : _c.message) {
            runtime.state.platformUpdateStatus = {
                phase: "error",
                mode: (_r = (_d = runtime.state.platformUpdateStatus) === null || _d === void 0 ? void 0 : _d.mode) !== null && _r !== void 0 ? _r : null,
                message: payload.error.message,
                progressPercent: null,
                transferredBytes: null,
                totalBytes: null,
                downloadedPath: (_s = (_e = runtime.state.platformUpdateStatus) === null || _e === void 0 ? void 0 : _e.downloadedPath) !== null && _s !== void 0 ? _s : null,
                currentVersion: (_u = (_t = (_f = runtime.state.platformUpdate) === null || _f === void 0 ? void 0 : _f.currentVersion) !== null && _t !== void 0 ? _t : (_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.currentVersion) !== null && _u !== void 0 ? _u : null,
                latestVersion: (_w = (_v = (_h = runtime.state.platformUpdate) === null || _h === void 0 ? void 0 : _h.latestVersion) !== null && _v !== void 0 ? _v : (_j = runtime.state.platformUpdateStatus) === null || _j === void 0 ? void 0 : _j.latestVersion) !== null && _w !== void 0 ? _w : null,
                checkedAt: (_x = (_k = runtime.state.platformUpdate) === null || _k === void 0 ? void 0 : _k.checkedAt) !== null && _x !== void 0 ? _x : Date.now(),
                updatedAt: Date.now(),
                error: {
                    code: (_y = payload.error.code) !== null && _y !== void 0 ? _y : null,
                    message: payload.error.message,
                },
            };
        }
        if (isMicrosoftStoreManaged()) {
            clearUpdateAutoCheckTimer();
            runtime.state.updateAutoCheckStarted = true;
        }
        updatePlatformUpdateUi();
    };
    const handlePlatformUpdateStatus = (payload) => {
        var _a;
        const status = (_a = payload === null || payload === void 0 ? void 0 : payload.status) !== null && _a !== void 0 ? _a : null;
        if (!status) {
            return;
        }
        runtime.state.platformUpdateStatus = {
            ...status,
            updatedAt: typeof status.updatedAt === "number" && Number.isFinite(status.updatedAt) ? status.updatedAt : Date.now(),
        };
        if (isMicrosoftStoreManaged()) {
            clearUpdateAutoCheckTimer();
            runtime.state.updateAutoCheckStarted = true;
        }
        updatePlatformUpdateUi();
        if (!isMicrosoftStoreManaged() && !runtime.state.updateAutoCheckStarted) {
            maybeRequestPlatformUpdateCheck(false);
        }
    };
    const readUpdateLastAutoCheckAt = () => {
        try {
            const raw = localStorage.getItem(runtime.keys.updateLastAutoCheckAtKey);
            if (!raw) {
                return 0;
            }
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return 0;
            }
            return parsed;
        }
        catch {
            return 0;
        }
    };
    const markUpdateAutoCheckAt = (timestamp) => {
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            return;
        }
        try {
            localStorage.setItem(runtime.keys.updateLastAutoCheckAtKey, String(Math.round(timestamp)));
        }
        catch {
            // ignore storage failures
        }
    };
    const scheduleUpdateAutoCheck = () => {
        clearUpdateAutoCheckTimer();
        if (isMicrosoftStoreManaged()) {
            return;
        }
        const now = Date.now();
        const last = readUpdateLastAutoCheckAt();
        const elapsed = Math.max(0, now - last);
        const remaining = Math.max(30000, runtime.config.updateAutoCheckIntervalMs - elapsed);
        runtime.state.updateAutoCheckTimer = window.setTimeout(() => {
            runtime.state.updateAutoCheckTimer = null;
            maybeRequestPlatformUpdateCheck(false);
            scheduleUpdateAutoCheck();
        }, remaining);
    };
    const maybeRequestPlatformUpdateCheck = (force = false) => {
        if (!force &&
            runtime.state.platformUpdate === null &&
            runtime.state.platformUpdateStatus === null) {
            runtime.deps.postToNative({ type: "update:status:get" }, true);
            return false;
        }
        runtime.deps.postToNative({ type: "update:status:get" }, true);
        if (isMicrosoftStoreManaged()) {
            clearUpdateAutoCheckTimer();
            runtime.state.updateAutoCheckStarted = true;
            return false;
        }
        let dispatched = false;
        if (force) {
            markUpdateAutoCheckAt(Date.now());
            runtime.state.updateAutoCheckStarted = true;
            runtime.deps.postToNative({ type: "update:check", force: true }, true);
            dispatched = true;
            scheduleUpdateAutoCheck();
            return dispatched;
        }
        if (!runtime.state.updateAutoCheckStarted) {
            runtime.state.updateAutoCheckStarted = true;
            markUpdateAutoCheckAt(Date.now());
            runtime.deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
            dispatched = true;
            scheduleUpdateAutoCheck();
            return dispatched;
        }
        const now = Date.now();
        const last = readUpdateLastAutoCheckAt();
        if (now - last >= runtime.config.updateAutoCheckIntervalMs) {
            markUpdateAutoCheckAt(now);
            runtime.deps.postToNative({ type: "update:check", force: false, source: "background" }, true);
            dispatched = true;
        }
        scheduleUpdateAutoCheck();
        return dispatched;
    };
    if (settingsUpdateCheck instanceof HTMLButtonElement) {
        settingsUpdateCheck.addEventListener("click", () => {
            maybeRequestPlatformUpdateCheck(true);
        });
    }
    const applyUpdate = () => {
        var _a, _b;
        var _c;
        if (isMicrosoftStoreManaged()) {
            return;
        }
        const phase = (_c = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _c !== void 0 ? _c : "idle";
        const hasDownloadedInstaller = Boolean((_b = runtime.state.platformUpdateStatus) === null || _b === void 0 ? void 0 : _b.downloadedPath);
        if (phase === "downloaded" || hasDownloadedInstaller) {
            runtime.deps.postToNative({ type: "update:install", openFallbackOnError: true }, true);
            return;
        }
        runtime.deps.postToNative({
            type: "update:download",
            forceCheck: true,
            autoInstall: true,
            openFallbackOnError: true,
        }, true);
    };
    if (settingsUpdateApply instanceof HTMLButtonElement) {
        settingsUpdateApply.addEventListener("click", () => {
            applyUpdate();
        });
    }
    if (updateButton instanceof HTMLButtonElement) {
        updateButton.addEventListener("click", () => {
            applyUpdate();
        });
    }
    if (settingsUpdateOpen instanceof HTMLButtonElement) {
        settingsUpdateOpen.addEventListener("click", () => {
            var _a, _b;
            var _c, _d;
            if (isMicrosoftStoreManaged()) {
                return;
            }
            const fallbackUrl = (_d = (_c = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.artifactUrl) !== null && _c !== void 0 ? _c : (_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.notesUrl) !== null && _d !== void 0 ? _d : TEX64_LINKS.download;
            openExternalUrl(runtime, fallbackUrl);
        });
    }
    return {
        updatePlatformUpdateUi,
        handlePlatformUpdate,
        handlePlatformUpdateStatus,
        maybeRequestPlatformUpdateCheck,
    };
};
