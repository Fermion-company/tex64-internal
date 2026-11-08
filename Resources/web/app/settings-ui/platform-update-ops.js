import { getUiLocale, onUiLocaleChange, setLocalizedAttribute, uiText } from "../i18n.js";
const MICROSOFT_STORE_UPDATE_MODE = "microsoft-store";
// "Update" alone is the figure editor's 「更新」 in the dictionaries; the app's
// own update is 「アップデート」 (and its counterpart in each language) under
// "Update app".
const appUpdateLabel = () => (getUiLocale() === "en" ? "Update" : uiText("Update app", "アップデート"));
// Updates work like the Claude desktop app: the main process downloads and
// verifies a new version quietly whenever a check finds one, and the top bar
// shows one small chip only once the installer is ready. The chip and the one
// button in Settings > Account save every open file before opening the
// installer.
export const createSettingsPlatformUpdateOps = (runtime) => {
    const { settingsUpdateVersion, settingsUpdateStatus, settingsUpdateAction, updateButton } = runtime.context.dom;
    const isMicrosoftStoreManaged = () => {
        var _a, _b;
        return ((_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.mode) === MICROSOFT_STORE_UPDATE_MODE ||
            ((_b = runtime.state.platformUpdate) === null || _b === void 0 ? void 0 : _b.channel) === MICROSOFT_STORE_UPDATE_MODE;
    };
    const clearUpdateAutoCheckTimer = () => {
        if (runtime.state.updateAutoCheckTimer !== null) {
            window.clearTimeout(runtime.state.updateAutoCheckTimer);
            runtime.state.updateAutoCheckTimer = null;
        }
    };
    const getPhase = () => { var _a, _b; return (_b = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.phase) !== null && _b !== void 0 ? _b : "idle"; };
    // The verified installer is on disk: "downloaded", or "installing" once it
    // has been opened (the user may close it and come back).
    const isInstallerReady = () => {
        var _a;
        const phase = getPhase();
        return (!isMicrosoftStoreManaged() &&
            Boolean((_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.downloadedPath) &&
            (phase === "downloaded" || phase === "installing"));
    };
    const isDownloading = () => {
        const phase = getPhase();
        return !isMicrosoftStoreManaged() && (phase === "available" || phase === "downloading");
    };
    // Failures and the Store's own management are the only states with words.
    const resolveUpdateStatusText = () => {
        var _a, _b, _c, _d, _e;
        if (isMicrosoftStoreManaged()) {
            return uiText("Updates are managed automatically by Microsoft Store.", "アップデートは Microsoft Store によって自動的に管理されます。");
        }
        if (getPhase() === "error") {
            const message = ((_b = (_a = runtime.state.platformUpdateStatus) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.trim()) ||
                ((_e = (_d = (_c = runtime.state.platformUpdateStatus) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.trim());
            return message || "Update processing failed.";
        }
        return "";
    };
    const resolveVersionText = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const current = (_d = (_b = (_a = runtime.state.platformUpdate) === null || _a === void 0 ? void 0 : _a.currentVersion) !== null && _b !== void 0 ? _b : (_c = runtime.state.platformUpdateStatus) === null || _c === void 0 ? void 0 : _c.currentVersion) !== null && _d !== void 0 ? _d : "-";
        const latest = (_h = (_f = (_e = runtime.state.platformUpdate) === null || _e === void 0 ? void 0 : _e.latestVersion) !== null && _f !== void 0 ? _f : (_g = runtime.state.platformUpdateStatus) === null || _g === void 0 ? void 0 : _g.latestVersion) !== null && _h !== void 0 ? _h : null;
        const phase = getPhase();
        const hasNewer = !isMicrosoftStoreManaged() &&
            Boolean(latest) &&
            latest !== current &&
            (Boolean((_j = runtime.state.platformUpdate) === null || _j === void 0 ? void 0 : _j.hasUpdate) ||
                phase === "available" ||
                phase === "downloading" ||
                phase === "downloaded" ||
                phase === "installing");
        return hasNewer ? `${current} → ${latest}` : current;
    };
    const updatePlatformUpdateUi = () => {
        if (settingsUpdateVersion instanceof HTMLElement) {
            settingsUpdateVersion.textContent = resolveVersionText();
        }
        const statusText = resolveUpdateStatusText();
        if (settingsUpdateStatus instanceof HTMLElement) {
            settingsUpdateStatus.textContent = statusText;
            settingsUpdateStatus.classList.toggle("is-hidden", !statusText);
            settingsUpdateStatus.classList.toggle("is-error", getPhase() === "error");
        }
        const ready = isInstallerReady();
        const downloading = isDownloading();
        if (settingsUpdateAction instanceof HTMLButtonElement) {
            const storeManaged = isMicrosoftStoreManaged();
            settingsUpdateAction.hidden = storeManaged;
            settingsUpdateAction.dataset.noI18n = "";
            settingsUpdateAction.textContent = ready
                ? appUpdateLabel()
                : downloading
                    ? uiText("Downloading…", "ダウンロード中…")
                    : uiText("Check for updates", "アップデートを確認");
            settingsUpdateAction.classList.toggle("ghost", !ready);
            settingsUpdateAction.disabled = storeManaged || downloading || getPhase() === "checking";
            settingsUpdateAction.setAttribute("aria-busy", downloading || getPhase() === "checking" ? "true" : "false");
        }
        if (updateButton instanceof HTMLButtonElement) {
            updateButton.hidden = !ready;
            const label = updateButton.querySelector(".update-chip-label");
            if (label)
                label.textContent = appUpdateLabel();
            setLocalizedAttribute(updateButton, "aria-label", appUpdateLabel());
        }
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
    // Every unsaved file is written first; the installer may close the app. A
    // build that is running keeps running: nothing is asked.
    let installing = false;
    const installUpdate = async () => {
        var _a, _b, _c;
        if (installing || !isInstallerReady()) {
            return;
        }
        installing = true;
        try {
            const saved = (_c = (await ((_b = (_a = runtime.deps).saveDirtyFiles) === null || _b === void 0 ? void 0 : _b.call(_a)))) !== null && _c !== void 0 ? _c : true;
            // A file that could not be saved says so in the toolbar; the installer
            // waits for the next click.
            if (!saved)
                return;
            runtime.deps.postToNative({ type: "update:install", openFallbackOnError: true }, true);
        }
        finally {
            installing = false;
        }
    };
    onUiLocaleChange(() => updatePlatformUpdateUi());
    if (updateButton instanceof HTMLButtonElement) {
        updateButton.addEventListener("click", () => {
            void installUpdate();
        });
    }
    if (settingsUpdateAction instanceof HTMLButtonElement) {
        settingsUpdateAction.addEventListener("click", () => {
            if (isMicrosoftStoreManaged() || isDownloading()) {
                return;
            }
            if (isInstallerReady()) {
                void installUpdate();
                return;
            }
            if (getPhase() === "error") {
                // Try again in full; if the download fails once more, the download
                // page opens in the browser instead.
                markUpdateAutoCheckAt(Date.now());
                runtime.deps.postToNative({ type: "update:download", forceCheck: true, openFallbackOnError: true }, true);
                return;
            }
            maybeRequestPlatformUpdateCheck(true);
        });
    }
    return {
        updatePlatformUpdateUi,
        handlePlatformUpdate,
        handlePlatformUpdateStatus,
        maybeRequestPlatformUpdateCheck,
    };
};
