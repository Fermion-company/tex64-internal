const normalizeBuildProfiles = (profiles) => {
    const normalized = Array.isArray(profiles) ? profiles : [];
    const seen = new Set();
    const cleaned = [];
    normalized.forEach((profile) => {
        if (!profile || typeof profile !== "object") {
            return;
        }
        const id = typeof profile.id === "string" ? profile.id.trim() : "";
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        const name = typeof profile.name === "string" ? profile.name.trim() : "";
        const outDir = typeof profile.outDir === "string" ? profile.outDir.trim() || null : null;
        const extraArgs = typeof profile.extraArgs === "string" ? profile.extraArgs.trim() || null : null;
        cleaned.push({
            id,
            name: name || id,
            outDir,
            extraArgs,
        });
    });
    return cleaned.slice(0, 20);
};
export const initBuildProfilesUi = (context, deps) => {
    const { settingsBuildProfileSelect, settingsBuildProfileName, settingsBuildOutDir, settingsBuildExtraArgs, settingsBuildProfileAdd, settingsBuildProfileDelete, settingsBuildProfileHint, settingsBuildCleanButton, settingsBuildCleanAllButton, } = context.dom;
    let buildProfiles = [];
    let activeProfileId = null;
    let saveTimer = null;
    let hasPendingSave = false;
    let lastRenderedSelectedId = null;
    const isWorkspaceReady = () => Boolean(deps.getWorkspaceRootKey());
    const updateHint = () => {
        var _a;
        if (!(settingsBuildProfileHint instanceof HTMLElement)) {
            return;
        }
        const enabled = isWorkspaceReady();
        const selectedId = settingsBuildProfileSelect instanceof HTMLSelectElement
            ? settingsBuildProfileSelect.value
            : "";
        const selected = selectedId && selectedId !== ""
            ? (_a = buildProfiles.find((profile) => profile.id === selectedId)) !== null && _a !== void 0 ? _a : null
            : null;
        const isCustom = Boolean(selected);
        settingsBuildProfileHint.textContent = enabled
            ? isCustom
                ? hasPendingSave
                    ? "Saving..."
                    : "Changes are saved automatically."
                : ""
            : "You can edit the build profile by opening the workspace.";
    };
    const getSelectedBuildProfileId = () => {
        if (!(settingsBuildProfileSelect instanceof HTMLSelectElement)) {
            return "";
        }
        return settingsBuildProfileSelect.value;
    };
    const renderSelect = () => {
        if (!(settingsBuildProfileSelect instanceof HTMLSelectElement)) {
            return;
        }
        settingsBuildProfileSelect.innerHTML = "";
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Default";
        settingsBuildProfileSelect.appendChild(defaultOption);
        buildProfiles.forEach((profile) => {
            const option = document.createElement("option");
            option.value = profile.id;
            option.textContent = profile.name || profile.id;
            settingsBuildProfileSelect.appendChild(option);
        });
        const preferred = activeProfileId !== null && activeProfileId !== void 0 ? activeProfileId : "";
        const hasPreferred = Array.from(settingsBuildProfileSelect.options).some((option) => option.value === preferred);
        settingsBuildProfileSelect.value = hasPreferred ? preferred : "";
    };
    const setInputValueIfAllowed = (input, nextValue, force) => {
        if (!force && document.activeElement === input) {
            return;
        }
        if (input.value !== nextValue) {
            input.value = nextValue;
        }
    };
    const renderFields = (forceValues = false) => {
        var _a, _b, _c, _d;
        const enabled = isWorkspaceReady();
        const selectedId = getSelectedBuildProfileId();
        const selected = selectedId && selectedId !== ""
            ? (_a = buildProfiles.find((profile) => profile.id === selectedId)) !== null && _a !== void 0 ? _a : null
            : null;
        const isCustom = Boolean(selected);
        const selectionChanged = selectedId !== lastRenderedSelectedId;
        lastRenderedSelectedId = selectedId;
        const shouldForceValues = forceValues || selectionChanged;
        const allowEdit = enabled && isCustom;
        if (settingsBuildProfileName instanceof HTMLInputElement) {
            settingsBuildProfileName.disabled = !allowEdit;
            setInputValueIfAllowed(settingsBuildProfileName, (_b = selected === null || selected === void 0 ? void 0 : selected.name) !== null && _b !== void 0 ? _b : "", shouldForceValues);
        }
        if (settingsBuildOutDir instanceof HTMLInputElement) {
            settingsBuildOutDir.disabled = !allowEdit;
            setInputValueIfAllowed(settingsBuildOutDir, (_c = selected === null || selected === void 0 ? void 0 : selected.outDir) !== null && _c !== void 0 ? _c : "", shouldForceValues);
        }
        if (settingsBuildExtraArgs instanceof HTMLInputElement) {
            settingsBuildExtraArgs.disabled = !allowEdit;
            setInputValueIfAllowed(settingsBuildExtraArgs, (_d = selected === null || selected === void 0 ? void 0 : selected.extraArgs) !== null && _d !== void 0 ? _d : "", shouldForceValues);
        }
        if (settingsBuildProfileAdd instanceof HTMLButtonElement) {
            settingsBuildProfileAdd.disabled = !enabled;
        }
        if (settingsBuildProfileDelete instanceof HTMLButtonElement) {
            settingsBuildProfileDelete.disabled = !enabled || !isCustom;
        }
        if (settingsBuildCleanButton instanceof HTMLButtonElement) {
            settingsBuildCleanButton.disabled = !enabled;
        }
        if (settingsBuildCleanAllButton instanceof HTMLButtonElement) {
            settingsBuildCleanAllButton.disabled = !enabled;
        }
        if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
            settingsBuildProfileSelect.disabled = !enabled;
        }
        updateHint();
    };
    const loadStateFromDeps = () => {
        buildProfiles = normalizeBuildProfiles(deps.getBuildProfiles());
        const active = deps.getBuildProfileId();
        activeProfileId = typeof active === "string" && active.trim() ? active.trim() : null;
    };
    const render = () => {
        loadStateFromDeps();
        renderSelect();
        renderFields(false);
    };
    const generateBuildProfileId = () => {
        var _a;
        if (typeof ((_a = window.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID) === "function") {
            return window.crypto.randomUUID();
        }
        const rand = Math.random().toString(36).slice(2, 8);
        return `profile-${Date.now().toString(36)}-${rand}`;
    };
    const postBuildProfilesUpdate = (silent = true) => {
        const activeId = getSelectedBuildProfileId();
        deps.postToNative({
            type: "build:profiles:update",
            profiles: buildProfiles,
            activeId,
        }, silent);
    };
    const cancelPendingSave = () => {
        if (saveTimer !== null) {
            window.clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (!hasPendingSave) {
            return;
        }
        hasPendingSave = false;
        updateHint();
    };
    const scheduleBuildProfilesSave = () => {
        if (saveTimer !== null) {
            window.clearTimeout(saveTimer);
            saveTimer = null;
        }
        hasPendingSave = true;
        updateHint();
        saveTimer = window.setTimeout(() => {
            saveTimer = null;
            hasPendingSave = false;
            updateHint();
            postBuildProfilesUpdate(true);
        }, 320);
    };
    const commitBuildProfilesUpdate = (silent = true) => {
        if (!isWorkspaceReady()) {
            return;
        }
        cancelPendingSave();
        postBuildProfilesUpdate(silent);
    };
    const updateSelectedProfile = (patch) => {
        const selectedId = getSelectedBuildProfileId();
        if (!selectedId) {
            return;
        }
        const index = buildProfiles.findIndex((profile) => profile.id === selectedId);
        if (index < 0) {
            return;
        }
        const current = buildProfiles[index];
        const next = {
            ...current,
            ...patch,
            id: current.id,
        };
        buildProfiles = buildProfiles.map((profile) => profile.id === selectedId ? next : profile);
    };
    const handleBuildProfileTextChange = () => {
        if (!isWorkspaceReady()) {
            return;
        }
        const selectedId = getSelectedBuildProfileId();
        if (!selectedId) {
            return;
        }
        const name = settingsBuildProfileName instanceof HTMLInputElement
            ? settingsBuildProfileName.value.trim()
            : "";
        const outDir = settingsBuildOutDir instanceof HTMLInputElement
            ? settingsBuildOutDir.value.trim()
            : "";
        const extraArgs = settingsBuildExtraArgs instanceof HTMLInputElement
            ? settingsBuildExtraArgs.value.trim()
            : "";
        updateSelectedProfile({
            name: name || selectedId,
            outDir: outDir || null,
            extraArgs: extraArgs || null,
        });
        if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
            const option = Array.from(settingsBuildProfileSelect.options).find((entry) => entry.value === selectedId);
            if (option) {
                option.textContent = name || selectedId;
            }
        }
        scheduleBuildProfilesSave();
    };
    const requestBuildClean = (deep) => {
        var _a, _b, _c;
        if (!isWorkspaceReady()) {
            return;
        }
        const message = deep
            ? "Run clean -C. PDFs etc. will also be deleted. Are you sure?"
            : "Run clean. Delete auxiliary files. Are you sure?";
        if (!window.confirm(message)) {
            return;
        }
        commitBuildProfilesUpdate(true);
        const activeId = getSelectedBuildProfileId();
        const activeProfile = activeId && activeId !== ""
            ? (_a = buildProfiles.find((profile) => profile.id === activeId)) !== null && _a !== void 0 ? _a : null
            : null;
        deps.postToNative({
            type: "build:clean",
            deep: deep === true,
            buildProfile: activeProfile
                ? {
                    outDir: (_b = activeProfile.outDir) !== null && _b !== void 0 ? _b : null,
                    extraArgs: (_c = activeProfile.extraArgs) !== null && _c !== void 0 ? _c : null,
                }
                : null,
        }, false);
    };
    if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
        settingsBuildProfileSelect.addEventListener("change", () => {
            if (!isWorkspaceReady()) {
                renderFields(true);
                return;
            }
            cancelPendingSave();
            renderFields(true);
            postBuildProfilesUpdate(true);
        });
    }
    if (settingsBuildProfileAdd instanceof HTMLButtonElement) {
        settingsBuildProfileAdd.addEventListener("click", () => {
            if (!isWorkspaceReady()) {
                return;
            }
            cancelPendingSave();
            const id = generateBuildProfileId();
            const next = {
                id,
                name: "New profile",
                outDir: null,
                extraArgs: null,
            };
            buildProfiles = buildProfiles.concat(next);
            activeProfileId = id;
            renderSelect();
            if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
                settingsBuildProfileSelect.value = id;
            }
            renderFields(true);
            postBuildProfilesUpdate(false);
        });
    }
    if (settingsBuildProfileDelete instanceof HTMLButtonElement) {
        settingsBuildProfileDelete.addEventListener("click", () => {
            if (!isWorkspaceReady()) {
                return;
            }
            cancelPendingSave();
            const selectedId = getSelectedBuildProfileId();
            if (!selectedId) {
                return;
            }
            const selected = buildProfiles.find((profile) => profile.id === selectedId);
            if (!selected) {
                return;
            }
            const ok = window.confirm(`Do you want to delete profile "${selected.name || selected.id}"?`);
            if (!ok) {
                return;
            }
            buildProfiles = buildProfiles.filter((profile) => profile.id !== selectedId);
            activeProfileId = null;
            renderSelect();
            renderFields(true);
            postBuildProfilesUpdate(false);
        });
    }
    if (settingsBuildProfileName instanceof HTMLInputElement) {
        settingsBuildProfileName.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    if (settingsBuildOutDir instanceof HTMLInputElement) {
        settingsBuildOutDir.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    if (settingsBuildExtraArgs instanceof HTMLInputElement) {
        settingsBuildExtraArgs.addEventListener("input", () => {
            handleBuildProfileTextChange();
        });
    }
    if (settingsBuildCleanButton instanceof HTMLButtonElement) {
        settingsBuildCleanButton.addEventListener("click", () => {
            requestBuildClean(false);
        });
    }
    if (settingsBuildCleanAllButton instanceof HTMLButtonElement) {
        settingsBuildCleanAllButton.addEventListener("click", () => {
            requestBuildClean(true);
        });
    }
    render();
    return { render };
};
