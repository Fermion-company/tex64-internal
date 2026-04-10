import { TEX64_LINKS } from "../platform-links.js";
import { formatBytes, openExternalUrl } from "./utils.js";
export const createSettingsPlatformUpdateOps = (runtime, attentionOps) => {
    const { settingsUpdateCurrent, settingsUpdateLatest, settingsUpdateStatus, settingsUpdateProgress, settingsUpdateProgressFill, settingsUpdateCheck, settingsUpdateApply, settingsUpdateOpen, } = runtime.context.dom;
    const resolveUpdateStatusText = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const phase = (_b = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _b !== void 0 ? _b : "idle";
        const latest = (_f = (_d = (_c = runtime.state.platformUpdate) === null || _c === void 0 ? void 0 : _c.latestVersion) !== null && _d !== void 0 ? _d : (_e = runtime.state.platformUpdateStatus) === null || _e === void 0 ? void 0 : _e.latestVersion) !== null && _f !== void 0 ? _f : null;
        if (((_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.message) && runtime.state.platformUpdateStatus.message.trim()) {
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
            const transferred = formatBytes((_j = (_h = runtime.state.platformUpdateStatus) === null || _h === void 0 ? void 0 : _h.transferredBytes) !== null && _j !== void 0 ? _j : 0);
            const total = formatBytes((_l = (_k = runtime.state.platformUpdateStatus) === null || _k === void 0 ? void 0 : _k.totalBytes) !== null && _l !== void 0 ? _l : 0);
            return `Downloading updates (${transferred} / ${total}).`;
        }
        if (phase === "downloaded") {
            return "Download completed. You can launch the installer with the Apply button.";
        }
        if (phase === "installing") {
            return "I started the installer. Follow the on-screen instructions to update.";
        }
        if (phase === "error") {
            const message = (_o = (_m = runtime.state.platformUpdateStatus) === null || _m === void 0 ? void 0 : _m.error) === null || _o === void 0 ? void 0 : _o.message;
            return message && message.trim() ? message.trim() : "Update processing failed.";
        }
        return "Waiting for update check.";
    };
    const updatePlatformUpdateUi = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
        const currentVersion = (_d = (_b = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.currentVersion) !== null && _b !== void 0 ? _b : (_c = runtime.state.platformUpdateStatus) === null || _c === void 0 ? void 0 : _c.currentVersion) !== null && _d !== void 0 ? _d : "-";
        const latestVersion = (_h = (_f = (_e = runtime.state.platformUpdate) === null || _e === void 0 ? void 0 : _e.latestVersion) !== null && _f !== void 0 ? _f : (_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.latestVersion) !== null && _h !== void 0 ? _h : "-";
        if (settingsUpdateCurrent instanceof HTMLElement) {
            settingsUpdateCurrent.textContent = currentVersion;
        }
        if (settingsUpdateLatest instanceof HTMLElement) {
            settingsUpdateLatest.textContent = latestVersion;
        }
        const statusText = resolveUpdateStatusText();
        if (settingsUpdateStatus instanceof HTMLElement) {
            settingsUpdateStatus.textContent = statusText;
            const phase = (_k = (_j = runtime.state.platformUpdateStatus) === null || _j === void 0 ? void 0 : _j.phase) !== null && _k !== void 0 ? _k : "idle";
            settingsUpdateStatus.classList.toggle("is-error", phase === "error");
            settingsUpdateStatus.classList.toggle("is-success", phase === "downloaded");
        }
        const progress = typeof ((_l = runtime.state.platformUpdateStatus) === null || _l === void 0 ? void 0 : _l.progressPercent) === "number" &&
            Number.isFinite(runtime.state.platformUpdateStatus.progressPercent)
            ? Math.max(0, Math.min(100, runtime.state.platformUpdateStatus.progressPercent))
            : 0;
        const showProgress = ((_o = (_m = runtime.state.platformUpdateStatus) === null || _m === void 0 ? void 0 : _m.phase) !== null && _o !== void 0 ? _o : "") === "downloading";
        if (settingsUpdateProgress instanceof HTMLElement) {
            settingsUpdateProgress.classList.toggle("is-hidden", !showProgress);
            settingsUpdateProgress.setAttribute("aria-hidden", showProgress ? "false" : "true");
        }
        if (settingsUpdateProgressFill instanceof HTMLElement) {
            settingsUpdateProgressFill.style.width = `${progress}%`;
        }
        const phase = (_q = (_p = runtime.state.platformUpdateStatus) === null || _p === void 0 ? void 0 : _p.phase) !== null && _q !== void 0 ? _q : "idle";
        const hasUpdate = Boolean((_r = runtime.state.platformUpdate) === null || _r === void 0 ? void 0 : _r.hasUpdate);
        const hasDownloadedInstaller = Boolean((_s = runtime.state.platformUpdateStatus) === null || _s === void 0 ? void 0 : _s.downloadedPath);
        if (settingsUpdateCheck instanceof HTMLButtonElement) {
            settingsUpdateCheck.disabled = phase === "checking" || phase === "downloading";
        }
        const canApplyUpdate = hasUpdate || hasDownloadedInstaller || phase === "available" || phase === "downloaded";
        if (settingsUpdateApply instanceof HTMLButtonElement) {
            settingsUpdateApply.classList.toggle("is-hidden", !canApplyUpdate);
            settingsUpdateApply.setAttribute("aria-hidden", canApplyUpdate ? "false" : "true");
            settingsUpdateApply.disabled =
                !canApplyUpdate || phase === "checking" || phase === "downloading" || phase === "installing";
        }
        if (settingsUpdateOpen instanceof HTMLButtonElement) {
            settingsUpdateOpen.disabled = false;
        }
        attentionOps.syncUpdateAttentionUi();
    };
    const handlePlatformUpdate = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        runtime.state.platformUpdate = (_a = payload === null || payload === void 0 ? void 0 : payload.update) !== null && _a !== void 0 ? _a : null;
        if (runtime.state.platformUpdateStatus) {
            runtime.state.platformUpdateStatus = {
                ...runtime.state.platformUpdateStatus,
                latestVersion: (_d = (_c = (_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.latestVersion) !== null && _c !== void 0 ? _c : runtime.state.platformUpdateStatus.latestVersion) !== null && _d !== void 0 ? _d : null,
                currentVersion: (_g = (_f = (_e = runtime.state.platformUpdate) === null || _e === void 0 ? void 0 : _e.currentVersion) !== null && _f !== void 0 ? _f : runtime.state.platformUpdateStatus.currentVersion) !== null && _g !== void 0 ? _g : null,
            };
        }
        if ((_h = payload === null || payload === void 0 ? void 0 : payload.error) === null || _h === void 0 ? void 0 : _h.message) {
            runtime.state.platformUpdateStatus = {
                phase: "error",
                mode: (_k = (_j = runtime.state.platformUpdateStatus) === null || _j === void 0 ? void 0 : _j.mode) !== null && _k !== void 0 ? _k : null,
                message: payload.error.message,
                progressPercent: null,
                transferredBytes: null,
                totalBytes: null,
                downloadedPath: (_m = (_l = runtime.state.platformUpdateStatus) === null || _l === void 0 ? void 0 : _l.downloadedPath) !== null && _m !== void 0 ? _m : null,
                currentVersion: (_r = (_p = (_o = runtime.state.platformUpdate) === null || _o === void 0 ? void 0 : _o.currentVersion) !== null && _p !== void 0 ? _p : (_q = runtime.state.platformUpdateStatus) === null || _q === void 0 ? void 0 : _q.currentVersion) !== null && _r !== void 0 ? _r : null,
                latestVersion: (_v = (_t = (_s = runtime.state.platformUpdate) === null || _s === void 0 ? void 0 : _s.latestVersion) !== null && _t !== void 0 ? _t : (_u = runtime.state.platformUpdateStatus) === null || _u === void 0 ? void 0 : _u.latestVersion) !== null && _v !== void 0 ? _v : null,
                checkedAt: (_x = (_w = runtime.state.platformUpdate) === null || _w === void 0 ? void 0 : _w.checkedAt) !== null && _x !== void 0 ? _x : Date.now(),
                updatedAt: Date.now(),
                error: {
                    code: (_y = payload.error.code) !== null && _y !== void 0 ? _y : null,
                    message: payload.error.message,
                },
            };
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
        updatePlatformUpdateUi();
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
        if (runtime.state.updateAutoCheckTimer !== null) {
            window.clearTimeout(runtime.state.updateAutoCheckTimer);
            runtime.state.updateAutoCheckTimer = null;
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
        runtime.deps.postToNative({ type: "update:status:get" }, true);
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
    if (settingsUpdateApply instanceof HTMLButtonElement) {
        settingsUpdateApply.addEventListener("click", () => {
            var _a, _b, _c;
            const phase = (_b = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _b !== void 0 ? _b : "idle";
            const hasDownloadedInstaller = Boolean((_c = runtime.state.platformUpdateStatus) === null || _c === void 0 ? void 0 : _c.downloadedPath);
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
        });
    }
    if (settingsUpdateOpen instanceof HTMLButtonElement) {
        settingsUpdateOpen.addEventListener("click", () => {
            var _a, _b, _c, _d;
            const fallbackUrl = (_d = (_b = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.artifactUrl) !== null && _b !== void 0 ? _b : (_c = runtime.state.platformUpdate) === null || _c === void 0 ? void 0 : _c.notesUrl) !== null && _d !== void 0 ? _d : TEX64_LINKS.download;
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
