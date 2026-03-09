import type { AppContext } from "./context.js";
import type { BuildProfile } from "./types.js";

type BuildProfilesUiDeps = {
  getWorkspaceRootKey: () => string | null;
  getBuildProfiles: () => BuildProfile[];
  getBuildProfileId: () => string | null;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
};

export type BuildProfilesUiApi = {
  render: () => void;
};

const normalizeBuildProfiles = (profiles: BuildProfile[]) => {
  const normalized = Array.isArray(profiles) ? profiles : [];
  const seen = new Set<string>();
  const cleaned: BuildProfile[] = [];
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
    const outDir =
      typeof profile.outDir === "string" ? profile.outDir.trim() || null : null;
    const extraArgs =
      typeof profile.extraArgs === "string" ? profile.extraArgs.trim() || null : null;
    cleaned.push({
      id,
      name: name || id,
      outDir,
      extraArgs,
    });
  });
  return cleaned.slice(0, 20);
};

export const initBuildProfilesUi = (
  context: AppContext,
  deps: BuildProfilesUiDeps
): BuildProfilesUiApi => {
  const {
    settingsBuildProfileSelect,
    settingsBuildProfileName,
    settingsBuildOutDir,
    settingsBuildExtraArgs,
    settingsBuildProfileAdd,
    settingsBuildProfileDelete,
    settingsBuildProfileHint,
    settingsBuildCleanButton,
    settingsBuildCleanAllButton,
  } = context.dom;

  let buildProfiles: BuildProfile[] = [];
  let activeProfileId: string | null = null;
  let saveTimer: number | null = null;
  let hasPendingSave = false;
  let lastRenderedSelectedId: string | null = null;

  const isWorkspaceReady = () => Boolean(deps.getWorkspaceRootKey());

  const updateHint = () => {
    if (!(settingsBuildProfileHint instanceof HTMLElement)) {
      return;
    }
    const enabled = isWorkspaceReady();
    const selectedId =
      settingsBuildProfileSelect instanceof HTMLSelectElement
        ? settingsBuildProfileSelect.value
        : "";
    const selected =
      selectedId && selectedId !== ""
        ? buildProfiles.find((profile) => profile.id === selectedId) ?? null
        : null;
    const isCustom = Boolean(selected);
    settingsBuildProfileHint.textContent = enabled
      ? isCustom
        ? hasPendingSave
          ? "保存中..."
          : "変更は自動で保存されます。"
        : ""
      : "ワークスペースを開くとビルドプロファイルを編集できます。";
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
    defaultOption.textContent = "デフォルト";
    settingsBuildProfileSelect.appendChild(defaultOption);

    buildProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name || profile.id;
      settingsBuildProfileSelect.appendChild(option);
    });

    const preferred = activeProfileId ?? "";
    const hasPreferred = Array.from(settingsBuildProfileSelect.options).some(
      (option) => option.value === preferred
    );
    settingsBuildProfileSelect.value = hasPreferred ? preferred : "";
  };

  const setInputValueIfAllowed = (
    input: HTMLInputElement,
    nextValue: string,
    force: boolean
  ) => {
    if (!force && document.activeElement === input) {
      return;
    }
    if (input.value !== nextValue) {
      input.value = nextValue;
    }
  };

  const renderFields = (forceValues = false) => {
    const enabled = isWorkspaceReady();
    const selectedId = getSelectedBuildProfileId();
    const selected =
      selectedId && selectedId !== ""
        ? buildProfiles.find((profile) => profile.id === selectedId) ?? null
        : null;

    const isCustom = Boolean(selected);
    const selectionChanged = selectedId !== lastRenderedSelectedId;
    lastRenderedSelectedId = selectedId;

    const shouldForceValues = forceValues || selectionChanged;
    const allowEdit = enabled && isCustom;

    if (settingsBuildProfileName instanceof HTMLInputElement) {
      settingsBuildProfileName.disabled = !allowEdit;
      setInputValueIfAllowed(
        settingsBuildProfileName,
        selected?.name ?? "",
        shouldForceValues
      );
    }
    if (settingsBuildOutDir instanceof HTMLInputElement) {
      settingsBuildOutDir.disabled = !allowEdit;
      setInputValueIfAllowed(
        settingsBuildOutDir,
        selected?.outDir ?? "",
        shouldForceValues
      );
    }
    if (settingsBuildExtraArgs instanceof HTMLInputElement) {
      settingsBuildExtraArgs.disabled = !allowEdit;
      setInputValueIfAllowed(
        settingsBuildExtraArgs,
        selected?.extraArgs ?? "",
        shouldForceValues
      );
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
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const rand = Math.random().toString(36).slice(2, 8);
    return `profile-${Date.now().toString(36)}-${rand}`;
  };

  const postBuildProfilesUpdate = (silent = true) => {
    const activeId = getSelectedBuildProfileId();
    deps.postToNative(
      {
        type: "build:profiles:update",
        profiles: buildProfiles,
        activeId,
      },
      silent
    );
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

  const updateSelectedProfile = (patch: Partial<BuildProfile>) => {
    const selectedId = getSelectedBuildProfileId();
    if (!selectedId) {
      return;
    }
    const index = buildProfiles.findIndex((profile) => profile.id === selectedId);
    if (index < 0) {
      return;
    }
    const current = buildProfiles[index];
    const next: BuildProfile = {
      ...current,
      ...patch,
      id: current.id,
    };
    buildProfiles = buildProfiles.map((profile) =>
      profile.id === selectedId ? next : profile
    );
  };

  const handleBuildProfileTextChange = () => {
    if (!isWorkspaceReady()) {
      return;
    }
    const selectedId = getSelectedBuildProfileId();
    if (!selectedId) {
      return;
    }
    const name =
      settingsBuildProfileName instanceof HTMLInputElement
        ? settingsBuildProfileName.value.trim()
        : "";
    const outDir =
      settingsBuildOutDir instanceof HTMLInputElement
        ? settingsBuildOutDir.value.trim()
        : "";
    const extraArgs =
      settingsBuildExtraArgs instanceof HTMLInputElement
        ? settingsBuildExtraArgs.value.trim()
        : "";
    updateSelectedProfile({
      name: name || selectedId,
      outDir: outDir || null,
      extraArgs: extraArgs || null,
    });
    if (settingsBuildProfileSelect instanceof HTMLSelectElement) {
      const option = Array.from(settingsBuildProfileSelect.options).find(
        (entry) => entry.value === selectedId
      );
      if (option) {
        option.textContent = name || selectedId;
      }
    }
    scheduleBuildProfilesSave();
  };

  const requestBuildClean = (deep: boolean) => {
    if (!isWorkspaceReady()) {
      return;
    }
    const message = deep
      ? "clean -C を実行します。PDF なども削除されます。よろしいですか？"
      : "clean を実行します。補助ファイルを削除します。よろしいですか？";
    if (!window.confirm(message)) {
      return;
    }
    commitBuildProfilesUpdate(true);
    const activeId = getSelectedBuildProfileId();
    const activeProfile =
      activeId && activeId !== ""
        ? buildProfiles.find((profile) => profile.id === activeId) ?? null
        : null;
    deps.postToNative(
      {
        type: "build:clean",
        deep: deep === true,
        buildProfile: activeProfile
          ? {
              outDir: activeProfile.outDir ?? null,
              extraArgs: activeProfile.extraArgs ?? null,
            }
          : null,
      },
      false
    );
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
      const next: BuildProfile = {
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
      const ok = window.confirm(
        `プロファイル「${selected.name || selected.id}」を削除しますか？`
      );
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
