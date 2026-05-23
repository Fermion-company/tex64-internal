const STORAGE_KEY_SIDEBAR = "tex64.layout.sidebarVisible";
const STORAGE_KEY_BOTTOM = "tex64.layout.bottomPanelVisible";
const STORAGE_KEY_BOTTOM_HEIGHT = "tex64.layout.bottomPanelHeight";
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 600;
const DEFAULT_PANEL_HEIGHT = 220;
export const initBottomPanelUi = (context, deps = {}) => {
    const { bottomPanel, bottomPanelResizer, bottomPanelClose, bottomPanelBody, bottomPanelTabs, toggleSidebarButton, toggleBottomPanelButton, } = context.dom;
    const editorSection = document.querySelector("section.editor");
    const mainEl = document.querySelector(".main");
    const blockCompose = document.querySelector(".block-compose");
    const sidebarBlocksBody = document.querySelector(".blocks-panel");
    let sidebarVisible = true;
    let bottomPanelOpen = false;
    let panelHeight = DEFAULT_PANEL_HEIGHT;
    let activeBottomTab = "blocks";
    /** remember where block-compose originally lived */
    let blockComposeOriginalParent = sidebarBlocksBody;
    const tabButtons = bottomPanelTabs !== null && bottomPanelTabs !== void 0 ? bottomPanelTabs : [];
    // --- Persistence ---
    const loadState = () => {
        try {
            const sv = localStorage.getItem(STORAGE_KEY_SIDEBAR);
            if (sv !== null)
                sidebarVisible = sv !== "false";
            const bv = localStorage.getItem(STORAGE_KEY_BOTTOM);
            if (bv !== null)
                bottomPanelOpen = bv === "true";
            const bh = localStorage.getItem(STORAGE_KEY_BOTTOM_HEIGHT);
            if (bh !== null) {
                const parsed = parseInt(bh, 10);
                if (Number.isFinite(parsed)) {
                    panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, parsed));
                }
            }
        }
        catch { /* ignore */ }
    };
    const saveState = () => {
        try {
            localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarVisible));
            localStorage.setItem(STORAGE_KEY_BOTTOM, String(bottomPanelOpen));
            localStorage.setItem(STORAGE_KEY_BOTTOM_HEIGHT, String(panelHeight));
        }
        catch { /* ignore */ }
    };
    // --- DOM manipulation ---
    const moveBlocksToBottom = () => {
        if (!blockCompose || !bottomPanelBody)
            return;
        if (blockCompose.parentElement === bottomPanelBody)
            return;
        bottomPanelBody.appendChild(blockCompose);
    };
    const moveBlocksToSidebar = () => {
        if (!blockCompose || !blockComposeOriginalParent)
            return;
        if (blockCompose.parentElement === blockComposeOriginalParent)
            return;
        blockComposeOriginalParent.appendChild(blockCompose);
    };
    // --- Tabs (Blocks / Terminal) ---
    const applyActiveTab = () => {
        if (bottomPanelBody) {
            bottomPanelBody.dataset.pane = activeBottomTab;
        }
        tabButtons.forEach((button) => {
            const tab = button.getAttribute("data-bottom-tab");
            button.classList.toggle("is-active", tab === activeBottomTab);
        });
    };
    const setActiveBottomTab = (tab) => {
        var _a, _b;
        activeBottomTab = tab === "terminal" ? "terminal" : "blocks";
        applyActiveTab();
        if (activeBottomTab === "terminal") {
            if (bottomPanelOpen) {
                (_a = deps.onTerminalShow) === null || _a === void 0 ? void 0 : _a.call(deps);
            }
        }
        else {
            (_b = deps.onTerminalHide) === null || _b === void 0 ? void 0 : _b.call(deps);
        }
    };
    // --- Apply layout ---
    const applyBottomPanel = () => {
        var _a;
        if (!editorSection || !bottomPanel)
            return;
        if (bottomPanelOpen) {
            editorSection.classList.add("has-bottom-panel");
            editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
            bottomPanel.setAttribute("aria-hidden", "false");
            moveBlocksToBottom();
        }
        else {
            editorSection.classList.remove("has-bottom-panel");
            editorSection.style.removeProperty("--bottom-panel-height");
            bottomPanel.setAttribute("aria-hidden", "true");
            moveBlocksToSidebar();
        }
        // Toggle button state
        if (toggleBottomPanelButton) {
            toggleBottomPanelButton.classList.toggle("is-active", bottomPanelOpen);
            toggleBottomPanelButton.setAttribute("aria-pressed", String(bottomPanelOpen));
        }
        if (bottomPanelOpen && activeBottomTab === "terminal") {
            (_a = deps.onTerminalShow) === null || _a === void 0 ? void 0 : _a.call(deps);
        }
    };
    const applySidebar = () => {
        if (!mainEl)
            return;
        mainEl.classList.toggle("sidebar-collapsed", !sidebarVisible);
        if (toggleSidebarButton) {
            toggleSidebarButton.classList.toggle("is-active", sidebarVisible);
            toggleSidebarButton.setAttribute("aria-pressed", String(sidebarVisible));
        }
    };
    // --- Public API ---
    const openBottomPanel = () => {
        bottomPanelOpen = true;
        applyBottomPanel();
        saveState();
    };
    const closeBottomPanel = () => {
        bottomPanelOpen = false;
        applyBottomPanel();
        saveState();
    };
    const toggleBottomPanel = () => {
        bottomPanelOpen = !bottomPanelOpen;
        applyBottomPanel();
        saveState();
    };
    const isBottomPanelOpen = () => bottomPanelOpen;
    const toggleSidebar = () => {
        sidebarVisible = !sidebarVisible;
        applySidebar();
        saveState();
        // Trigger Monaco editor relayout after sidebar collapse/expand
        window.dispatchEvent(new Event("resize"));
    };
    const isSidebarVisible = () => sidebarVisible;
    // --- Resizer drag ---
    const initResizer = () => {
        if (!bottomPanelResizer || !editorSection)
            return;
        let startY = 0;
        let startHeight = 0;
        let pendingClientY = 0;
        let rafId = null;
        // Apply the latest pointer position once per animation frame. The CSS var
        // change reflows the grid, which makes the embedded MathLive field (and the
        // editor) re-layout — coalescing to one update per frame keeps it smooth.
        const applyResize = () => {
            rafId = null;
            const delta = startY - pendingClientY;
            const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startHeight + delta));
            panelHeight = newHeight;
            editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
        };
        const onMouseMove = (e) => {
            e.preventDefault();
            pendingClientY = e.clientY;
            if (rafId === null) {
                rafId = window.requestAnimationFrame(applyResize);
            }
        };
        const onMouseUp = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            bottomPanelResizer.classList.remove("is-resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            saveState();
            window.dispatchEvent(new Event("resize"));
        };
        bottomPanelResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = panelHeight;
            pendingClientY = e.clientY;
            bottomPanelResizer.classList.add("is-resizing");
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    };
    // --- Event listeners ---
    if (toggleSidebarButton) {
        toggleSidebarButton.addEventListener("click", toggleSidebar);
    }
    if (toggleBottomPanelButton) {
        toggleBottomPanelButton.addEventListener("click", toggleBottomPanel);
    }
    if (bottomPanelClose) {
        bottomPanelClose.addEventListener("click", closeBottomPanel);
    }
    tabButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const tab = button.getAttribute("data-bottom-tab") === "terminal" ? "terminal" : "blocks";
            if (!bottomPanelOpen) {
                openBottomPanel();
            }
            setActiveBottomTab(tab);
        });
    });
    // --- Init ---
    loadState();
    applySidebar();
    applyActiveTab();
    applyBottomPanel();
    initResizer();
    return {
        openBottomPanel,
        closeBottomPanel,
        toggleBottomPanel,
        isBottomPanelOpen,
        toggleSidebar,
        isSidebarVisible,
    };
};
