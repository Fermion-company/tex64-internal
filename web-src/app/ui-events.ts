import type { TabKey } from "./config.js";
import type { AppContext } from "./context.js";
import type { DiffContext } from "./diff-modal.js";
import type { IssueItem } from "./types.js";

type UiEventsDeps = {
  setActiveTab: (tabKey: TabKey) => void;
  normalizeTabKey: (key: string | undefined) => TabKey;
  getCurrentIssues: () => IssueItem[];
  fileTree: {
    setTreeFocus: (value: boolean) => void;
  };
  diffModal: {
    getDiffContext: () => DiffContext;
    closeDiffModal: () => void;
  };
  blockInsert?: {
    applyPendingFromDiffModal: () => void;
    clearPending: () => void;
  } | null;
  aiOps?: {
    applyPendingFromDiffModal: () => void;
    clearPending: () => void;
  } | null;
  buildOps: {
    setupActionButtons: () => void;
    startBuild: () => void;
  };
  rootSelectorUi: {
    setupActions: () => void;
  };
  saveCurrentFile: () => void;
};

export type UiEventsApi = {
  setup: () => void;
};

export const initUiEvents = (context: AppContext, deps: UiEventsDeps): UiEventsApi => {
  const {
    tabs,
    editorHost,
    editorHostSecondary,
    diffModalSubmit,
    diffModalCancel,
    saveButton,
  } = context.dom;

  const setup = () => {
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        deps.setActiveTab(deps.normalizeTabKey(tab.dataset.tab));
      });
    });

    if (editorHost instanceof HTMLElement) {
      editorHost.addEventListener("mousedown", () => {
        deps.fileTree.setTreeFocus(false);
      });
    }
    if (editorHostSecondary instanceof HTMLElement) {
      editorHostSecondary.addEventListener("mousedown", () => {
        deps.fileTree.setTreeFocus(false);
      });
    }

    if (diffModalSubmit instanceof HTMLButtonElement) {
      diffModalSubmit.addEventListener("click", () => {
        const diffContext = deps.diffModal.getDiffContext();
        if (diffContext?.type === "aiApply") {
          deps.aiOps?.applyPendingFromDiffModal();
          deps.diffModal.closeDiffModal();
          return;
        }
        deps.blockInsert?.applyPendingFromDiffModal();
        deps.diffModal.closeDiffModal();
      });
    }

    if (diffModalCancel instanceof HTMLButtonElement) {
      diffModalCancel.addEventListener("click", () => {
        deps.diffModal.closeDiffModal();
        deps.blockInsert?.clearPending();
        deps.aiOps?.clearPending();
      });
    }

    deps.buildOps.setupActionButtons();
    deps.rootSelectorUi.setupActions();

    if (saveButton instanceof HTMLButtonElement) {
      saveButton.addEventListener("click", () => {
        deps.saveCurrentFile();
      });
    }

    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        deps.saveCurrentFile();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        deps.buildOps.startBuild();
      }
    });

  };

  return { setup };
};
