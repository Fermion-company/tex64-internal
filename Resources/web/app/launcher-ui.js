import { showEditorNotice } from "./editor-notice.js";
import { editorTabLabels } from "./editor-tab-labels.js";
import { getUiLocale, setUiLocale, onUiLocaleChange, uiText, SUPPORTED_LOCALES, } from "./i18n.js";
const INITIAL_VISIBLE_COUNT = 3;
export const initLauncherUi = (context, deps) => {
    const { launcher, launcherCreateButton, launcherOpenButton, launcherStatusMessage, launcherRecent, launcherRecentList, launcherRecentEmpty, launcherRecentToggle, launcherLangToggle, launcherLangToggleLabel, launcherLangMenu, } = context.dom;
    let selectedActionIndex = 0;
    let launcherBusy = false;
    const launcherActions = [launcherOpenButton, launcherCreateButton];
    let recentProjects = [];
    let recentExpanded = false;
    // Focus follows the arrow keys only; on opening, Enter still runs the selected
    // action without a focus ring drawn before the user has done anything.
    const updateActionSelection = (moveFocus = false) => {
        launcherActions.forEach((btn, index) => {
            if (btn instanceof HTMLElement) {
                if (index === selectedActionIndex) {
                    btn.classList.add("is-selected");
                    if (moveFocus)
                        requestAnimationFrame(() => btn.focus());
                }
                else {
                    btn.classList.remove("is-selected");
                }
            }
        });
    };
    const setVisible = (isVisible) => {
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
    const setStatus = (payload) => {
        if (typeof payload.isBusy === "boolean") {
            launcherBusy = payload.isBusy;
        }
        if (launcherCreateButton instanceof HTMLButtonElement) {
            launcherCreateButton.disabled = launcherBusy;
        }
        if (launcherOpenButton instanceof HTMLButtonElement) {
            launcherOpenButton.disabled = launcherBusy;
        }
        const message = typeof payload.message === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
        if (launcherStatusMessage instanceof HTMLElement) {
            launcherStatusMessage.textContent = message;
            launcherStatusMessage.classList.toggle("is-hidden", !message);
            launcherStatusMessage.setAttribute("aria-hidden", message ? "false" : "true");
        }
        // With a folder open the launcher, and this status line, are hidden: a
        // refusal such as "this folder is open in another TeX64 window" was silent.
        if (message && !launcherBusy && !document.body.classList.contains("has-launcher")) {
            showEditorNotice(null, message, { tone: "error", owner: "launcher" });
        }
    };
    const renderRecentProjects = () => {
        var _a, _b, _c;
        if (!(launcherRecentList instanceof HTMLElement)) {
            return;
        }
        const focused = document.activeElement;
        const focusedRow = focused === null || focused === void 0 ? void 0 : focused.closest(".launcher-recent-row");
        const focusedIndex = focusedRow ? Array.from(launcherRecentList.children).indexOf(focusedRow) : -1;
        const focusedPath = (_a = focusedRow === null || focusedRow === void 0 ? void 0 : focusedRow.querySelector(".launcher-recent-item")) === null || _a === void 0 ? void 0 : _a.dataset.path;
        launcherRecentList.innerHTML = "";
        const visibleProjects = recentExpanded
            ? recentProjects
            : recentProjects.slice(0, INITIAL_VISIBLE_COUNT);
        const labels = editorTabLabels(recentProjects.map(project => project.path.replace(/\\/g, "/")));
        for (const [index, project] of visibleProjects.entries()) {
            const row = document.createElement("div");
            row.className = "launcher-recent-row";
            const item = document.createElement("button");
            item.className = "launcher-recent-item";
            item.type = "button";
            item.dataset.path = project.path;
            item.dataset.noI18n = "";
            // Show a folder qualifier only when another project has the same name.
            item.title = project.path;
            const nameSpan = document.createElement("span");
            nameSpan.className = "launcher-recent-item-name";
            nameSpan.textContent = project.name;
            item.appendChild(nameSpan);
            if (labels[index].detail) {
                const location = document.createElement("span");
                location.className = "launcher-recent-location";
                location.textContent = labels[index].detail;
                item.appendChild(location);
            }
            item.addEventListener("click", () => {
                if (launcherBusy)
                    return;
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
                if (launcherBusy)
                    return;
                recentProjects = recentProjects.filter((entry) => entry.path !== project.path);
                renderRecentProjects();
                deps.onRemoveRecent(project.path);
            });
            row.appendChild(item);
            row.appendChild(removeButton);
            launcherRecentList.appendChild(row);
        }
        if (focusedIndex >= 0) {
            const sameIndex = visibleProjects.findIndex(project => project.path === focusedPath);
            const row = launcherRecentList.children[sameIndex >= 0 ? sameIndex : Math.min(focusedIndex, visibleProjects.length - 1)];
            const selector = sameIndex >= 0 && (focused === null || focused === void 0 ? void 0 : focused.classList.contains("launcher-recent-remove"))
                ? ".launcher-recent-remove" : ".launcher-recent-item";
            (_c = ((_b = row === null || row === void 0 ? void 0 : row.querySelector(selector)) !== null && _b !== void 0 ? _b : launcherOpenButton)) === null || _c === void 0 ? void 0 : _c.focus({ preventScroll: true });
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
    const updateRecentProjects = (projects) => {
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
    const handleLauncherKeydown = (event) => {
        if (!(launcher === null || launcher === void 0 ? void 0 : launcher.classList.contains("is-visible")) || event.defaultPrevented || (launcherLangMenu === null || launcherLangMenu === void 0 ? void 0 : launcherLangMenu.contains(event.target))) {
            return;
        }
        if (event.key === "ArrowDown") {
            selectedActionIndex = (selectedActionIndex + 1) % launcherActions.length;
            updateActionSelection(true);
            event.preventDefault();
            return;
        }
        if (event.key === "ArrowUp") {
            selectedActionIndex =
                (selectedActionIndex - 1 + launcherActions.length) % launcherActions.length;
            updateActionSelection(true);
            event.preventDefault();
            return;
        }
        if (event.key === "Enter") {
            const currentBtn = launcherActions[selectedActionIndex];
            // Any other focused control (a recent project, its ×, Show all, the
            // language menu, the other action) keeps its own Enter.
            const focused = document.activeElement;
            if (focused instanceof HTMLElement &&
                focused !== currentBtn &&
                focused.closest("button, a[href], input, select, textarea, [role='menuitem'], [contenteditable='true']")) {
                return;
            }
            event.preventDefault();
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
    // Language popover (7 locales)
    const findLocaleEntry = (code) => { var _a; return (_a = SUPPORTED_LOCALES.find((entry) => entry.code === code)) !== null && _a !== void 0 ? _a : SUPPORTED_LOCALES[0]; };
    const syncLangLabel = () => {
        if (launcherLangToggleLabel instanceof HTMLElement) {
            launcherLangToggleLabel.textContent = findLocaleEntry(getUiLocale()).nativeLabel;
        }
    };
    const closeLangMenu = (focusToggle = false) => {
        if (!(launcherLangMenu instanceof HTMLElement))
            return;
        launcherLangMenu.classList.add("is-hidden");
        launcherLangMenu.setAttribute("aria-hidden", "true");
        if (launcherLangToggle instanceof HTMLElement) {
            launcherLangToggle.setAttribute("aria-expanded", "false");
            if (focusToggle)
                launcherLangToggle.focus();
        }
    };
    const openLangMenu = () => {
        var _a;
        if (!(launcherLangMenu instanceof HTMLElement))
            return;
        launcherLangMenu.classList.remove("is-hidden");
        launcherLangMenu.setAttribute("aria-hidden", "false");
        if (launcherLangToggle instanceof HTMLElement) {
            launcherLangToggle.setAttribute("aria-expanded", "true");
        }
        (_a = launcherLangMenu.querySelector(".is-active")) === null || _a === void 0 ? void 0 : _a.focus();
    };
    const renderLangMenu = () => {
        if (!(launcherLangMenu instanceof HTMLElement))
            return;
        const active = getUiLocale();
        launcherLangMenu.replaceChildren();
        SUPPORTED_LOCALES.forEach((entry) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "launcher-lang-option";
            item.setAttribute("role", "menuitemradio");
            item.setAttribute("aria-checked", String(entry.code === active));
            item.tabIndex = -1;
            item.dataset.locale = entry.code;
            if (entry.code === active)
                item.classList.add("is-active");
            item.textContent = entry.nativeLabel;
            item.addEventListener("click", () => {
                setUiLocale(entry.code);
                closeLangMenu(true);
            });
            launcherLangMenu.appendChild(item);
        });
    };
    syncLangLabel();
    renderLangMenu();
    onUiLocaleChange(() => {
        syncLangLabel();
        renderLangMenu();
        renderRecentProjects();
    });
    if (launcherLangToggle instanceof HTMLElement) {
        launcherLangToggle.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!(launcherLangMenu instanceof HTMLElement))
                return;
            if (launcherLangMenu.classList.contains("is-hidden")) {
                openLangMenu();
            }
            else {
                closeLangMenu();
            }
        });
    }
    launcherLangToggle === null || launcherLangToggle === void 0 ? void 0 : launcherLangToggle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
            return;
        event.preventDefault();
        openLangMenu();
    });
    launcherLangMenu === null || launcherLangMenu === void 0 ? void 0 : launcherLangMenu.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
            closeLangMenu(true);
            return;
        }
        const items = Array.from(launcherLangMenu.querySelectorAll(".launcher-lang-option"));
        const at = items.findIndex((item) => item === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : event.key === "ArrowDown" ? (at + 1) % items.length
                : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length : -1;
        if (next < 0 || !items[next])
            return;
        event.preventDefault();
        items[next].focus();
    });
    document.addEventListener("click", (event) => {
        if (!(launcherLangMenu instanceof HTMLElement))
            return;
        if (launcherLangMenu.classList.contains("is-hidden"))
            return;
        const target = event.target;
        if (target instanceof Node && launcherLangMenu.contains(target))
            return;
        if (target instanceof Node &&
            launcherLangToggle instanceof HTMLElement &&
            launcherLangToggle.contains(target)) {
            return;
        }
        closeLangMenu();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && launcherLangMenu instanceof HTMLElement && !launcherLangMenu.classList.contains("is-hidden")) {
            event.preventDefault();
            closeLangMenu(true);
        }
    });
    return {
        setVisible,
        setStatus,
        isBusy: () => launcherBusy,
        updateRecentProjects,
    };
};
