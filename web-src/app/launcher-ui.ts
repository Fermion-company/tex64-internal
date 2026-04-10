import type { AppContext } from "./context.js";
import { getUiLocale, setUiLocale, onUiLocaleChange, uiText } from "./i18n.js";

type RecentProject = {
  path: string;
  name: string;
  openedAt: number;
};

type LauncherUiDeps = {
  onCreate: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
};

export type LauncherUiApi = {
  setVisible: (isVisible: boolean) => void;
  setStatus: (payload: { isBusy?: boolean; message?: string | null }) => void;
  isBusy: () => boolean;
  updateRecentProjects: (projects: RecentProject[]) => void;
};

const INITIAL_VISIBLE_COUNT = 3;

export const initLauncherUi = (
  context: AppContext,
  deps: LauncherUiDeps
): LauncherUiApi => {
  const {
    launcher,
    launcherCreateButton,
    launcherOpenButton,
    launcherStatusMessage,
    launcherRecent,
    launcherRecentList,
    launcherRecentEmpty,
    launcherRecentToggle,
    launcherLangToggle,
    launcherLangToggleLabel,
  } = context.dom;

  let selectedActionIndex = 0;
  let launcherBusy = false;
  const launcherActions = [launcherOpenButton, launcherCreateButton];
  
  let recentProjects: RecentProject[] = [];
  let recentExpanded = false;

  const updateActionSelection = () => {
    launcherActions.forEach((btn, index) => {
      if (btn instanceof HTMLElement) {
        if (index === selectedActionIndex) {
          btn.classList.add("is-selected");
          requestAnimationFrame(() => btn.focus());
        } else {
          btn.classList.remove("is-selected");
        }
      }
    });
  };

  const setVisible = (isVisible: boolean) => {
    if (launcher instanceof HTMLElement) {
      launcher.classList.toggle("is-visible", isVisible);
      launcher.setAttribute("aria-hidden", isVisible ? "false" : "true");
    }
    document.body.classList.toggle("has-launcher", isVisible);
    if (isVisible) {
      selectedActionIndex = 0;
      updateActionSelection();
    }
  };

  const setStatus = (payload: { isBusy?: boolean; message?: string | null }) => {
    if (typeof payload.isBusy === "boolean") {
      launcherBusy = payload.isBusy;
    }
    if (launcherCreateButton instanceof HTMLButtonElement) {
      launcherCreateButton.disabled = launcherBusy;
    }
    if (launcherOpenButton instanceof HTMLButtonElement) {
      launcherOpenButton.disabled = launcherBusy;
    }
    if (launcherStatusMessage instanceof HTMLElement) {
      const message =
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "";
      launcherStatusMessage.textContent = message;
      launcherStatusMessage.classList.toggle("is-hidden", !message);
      launcherStatusMessage.setAttribute("aria-hidden", message ? "false" : "true");
    }
  };

  const renderRecentProjects = () => {
    if (!(launcherRecentList instanceof HTMLElement)) {
      return;
    }
    launcherRecentList.innerHTML = "";
    
    const visibleProjects = recentExpanded 
      ? recentProjects 
      : recentProjects.slice(0, INITIAL_VISIBLE_COUNT);
    
    for (const project of visibleProjects) {
      const row = document.createElement("div");
      row.className = "launcher-recent-row";

      const item = document.createElement("button");
      item.className = "launcher-recent-item";
      item.type = "button";
      item.dataset.path = project.path;
      
      const nameSpan = document.createElement("span");
      nameSpan.className = "launcher-recent-item-name";
      nameSpan.textContent = project.name;
      
      const pathSpan = document.createElement("span");
      pathSpan.className = "launcher-recent-item-path";
      pathSpan.textContent = project.path;
      
      item.appendChild(nameSpan);
      item.appendChild(pathSpan);
      
      item.addEventListener("click", () => {
        if (launcherBusy) return;
        setStatus({ isBusy: true, message: null });
        deps.onOpenRecent(project.path);
      });

      const removeButton = document.createElement("button");
      removeButton.className = "launcher-recent-remove";
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.title = uiText("Remove from recent", "Delete from recent");
      removeButton.setAttribute("aria-label", uiText("Remove from recent", "Delete from recent"));
      removeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (launcherBusy) return;
        recentProjects = recentProjects.filter((entry) => entry.path !== project.path);
        renderRecentProjects();
        deps.onRemoveRecent(project.path);
      });
      
      row.appendChild(item);
      row.appendChild(removeButton);
      launcherRecentList.appendChild(row);
    }
    
    // Update empty state
    if (launcherRecentEmpty instanceof HTMLElement) {
      launcherRecentEmpty.style.display = recentProjects.length === 0 ? "" : "none";
    }
    
    // Update toggle button
    if (launcherRecentToggle instanceof HTMLElement) {
      const hasMore = recentProjects.length > INITIAL_VISIBLE_COUNT;
      launcherRecentToggle.style.display = hasMore ? "" : "none";
      launcherRecentToggle.setAttribute("aria-expanded", recentExpanded ? "true" : "false");
      const toggleText = launcherRecentToggle.querySelector(".launcher-recent-toggle-text");
      if (toggleText) {
        toggleText.textContent = recentExpanded
          ? uiText("Collapse", "fold")
          : uiText("Show all", "Show All");
      }
    }
    
    // Update recent section visibility
    if (launcherRecent instanceof HTMLElement) {
      launcherRecent.style.display = "";
    }
  };

  const updateRecentProjects = (projects: RecentProject[]) => {
    recentProjects = projects;
    renderRecentProjects();
  };

  // Toggle handler for recent projects
  if (launcherRecentToggle instanceof HTMLElement) {
    launcherRecentToggle.addEventListener("click", () => {
      recentExpanded = !recentExpanded;
      renderRecentProjects();
    });
  }

  const handleLauncherKeydown = (event: KeyboardEvent) => {
    if (!launcher?.classList.contains("is-visible")) {
      return;
    }
    if (event.key === "ArrowDown") {
      selectedActionIndex = (selectedActionIndex + 1) % launcherActions.length;
      updateActionSelection();
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp") {
      selectedActionIndex =
        (selectedActionIndex - 1 + launcherActions.length) % launcherActions.length;
      updateActionSelection();
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const currentBtn = launcherActions[selectedActionIndex];
      if (currentBtn instanceof HTMLButtonElement && !currentBtn.disabled) {
        currentBtn.click();
      }
    }
  };

  window.addEventListener("keydown", handleLauncherKeydown);

  if (launcherCreateButton instanceof HTMLButtonElement) {
    launcherCreateButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setStatus({ isBusy: true, message: null });
      deps.onCreate();
    });
  }

  if (launcherOpenButton instanceof HTMLButtonElement) {
    launcherOpenButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setStatus({ isBusy: true, message: null });
      deps.onOpen();
    });
  }

  // Language toggle
  const syncLangLabel = () => {
    if (launcherLangToggleLabel instanceof HTMLElement) {
      launcherLangToggleLabel.textContent = getUiLocale() === "en" ? "日本語" : "English";
    }
  };

  syncLangLabel();
  onUiLocaleChange(() => {
    syncLangLabel();
    renderRecentProjects();
  });

  if (launcherLangToggle instanceof HTMLElement) {
    launcherLangToggle.addEventListener("click", () => {
      setUiLocale(getUiLocale() === "en" ? "ja" : "en");
    });
  }

  return {
    setVisible,
    setStatus,
    isBusy: () => launcherBusy,
    updateRecentProjects,
  };
};
