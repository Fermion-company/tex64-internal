import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type { IssueItem, IssuesStatus, RootSource } from "./types.js";

type RootSelectorDeps = {
  getWorkspaceRootKey: () => string | null;
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
  getRootSource: () => RootSource;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
};

export type RootSelectorApi = {
  render: () => void;
  setupActions: () => void;
};

export const initRootSelectorUi = (
  context: AppContext,
  deps: RootSelectorDeps
): RootSelectorApi => {
  const { settingsRootSelect, settingsRootAuto } = context.dom;

  const requestSetRoot = (path: string) => {
    if (!deps.getWorkspaceRootKey()) {
      const message = uiText("No workspace is selected.", "ワークスペースが未選択です。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    if (!path || path === deps.getRootFilePath()) {
      return;
    }
    deps.postToNative({ type: "setRoot", path });
  };

  const requestDetectRoot = () => {
    if (!deps.getWorkspaceRootKey()) {
      const message = uiText("No workspace is selected.", "ワークスペースが未選択です。");
      deps.updateIssues(1, message, "error", [
        { severity: "error", message },
      ]);
      return;
    }
    deps.postToNative({ type: "detectRoot" });
  };

  const render = () => {
    if (!(settingsRootSelect instanceof HTMLSelectElement)) {
      return;
    }
    settingsRootSelect.innerHTML = "";
    const workspaceFiles = deps.getWorkspaceFiles();
    const workspaceRootKey = deps.getWorkspaceRootKey();
    const rootFilePath = deps.getRootFilePath();
    const rootSource = deps.getRootSource();
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));
    const placeholder = document.createElement("option");
    if (!workspaceRootKey) {
      placeholder.textContent = uiText("No workspace selected", "ワークスペース未選択");
    } else if (texFiles.length === 0) {
      placeholder.textContent = uiText("No TeX files found", "TeX file is missing");
    } else {
      placeholder.textContent = rootFilePath
        ? uiText("Main TeX", "メインTeX")
        : uiText("Select main TeX", "メインTeXを選択");
    }
    placeholder.value = "";
    placeholder.disabled = true;
    if (!rootFilePath) {
      placeholder.selected = true;
    }
    settingsRootSelect.appendChild(placeholder);
    if (rootFilePath && !texFiles.includes(rootFilePath)) {
      const missing = document.createElement("option");
      missing.value = rootFilePath;
      missing.textContent = uiText(`${rootFilePath} (not found)`, `${rootFilePath} (not found)`);
      settingsRootSelect.appendChild(missing);
    }
    texFiles.forEach((path) => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      settingsRootSelect.appendChild(option);
    });
    settingsRootSelect.disabled = !workspaceRootKey || texFiles.length === 0;
    settingsRootSelect.value = rootFilePath ?? "";
    if (settingsRootAuto instanceof HTMLButtonElement) {
      settingsRootAuto.disabled = !workspaceRootKey || texFiles.length === 0;
      settingsRootAuto.textContent =
        rootSource === "manual"
          ? uiText("Revert to automatic", "revert to automatic")
          : uiText("Detect again", "redetection");
    }
  };

  const setupActions = () => {
    if (settingsRootSelect instanceof HTMLSelectElement) {
      settingsRootSelect.addEventListener("change", () => {
        if (settingsRootSelect.value) {
          requestSetRoot(settingsRootSelect.value);
        }
      });
    }

    if (settingsRootAuto instanceof HTMLButtonElement) {
      settingsRootAuto.addEventListener("click", () => {
        requestDetectRoot();
      });
    }
  };

  return { render, setupActions };
};
