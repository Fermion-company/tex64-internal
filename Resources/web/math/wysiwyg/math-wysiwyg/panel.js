export const createMathWysiwygPanelOps = (state) => {
    let applyCandidate = () => { };
    const resolvePanelHost = () => {
        var _a, _b;
        if (state.panelHost && state.panelHost.isConnected) {
            return state.panelHost;
        }
        if (!state.deps.container) {
            return null;
        }
        const host = (_b = (_a = state.deps.container.closest(".panel-body.blocks-panel")) !== null && _a !== void 0 ? _a : state.deps.container.closest(".panel-body")) !== null && _b !== void 0 ? _b : state.deps.container;
        state.panelHost = host;
        return host;
    };
    const positionPanelNearCaret = () => {
        if (!state.deps.container || !state.active) {
            return;
        }
        const host = resolvePanelHost();
        if (!host) {
            return;
        }
        const hostRect = host.getBoundingClientRect();
        const containerRect = state.deps.container.getBoundingClientRect();
        const margin = 8;
        const offset = 20;
        const maxWidth = Math.max(160, hostRect.width - margin * 2);
        state.panel.style.position = "absolute";
        state.panel.style.right = "auto";
        state.panel.style.bottom = "auto";
        state.panel.style.maxWidth = `${maxWidth}px`;
        let left = margin;
        let top = Math.round(containerRect.bottom - hostRect.top + offset);
        state.panel.style.left = `${left}px`;
        state.panel.style.top = `${Math.max(margin, top)}px`;
        const panelRect = state.panel.getBoundingClientRect();
        if (panelRect.width > 0 && hostRect.width > 0) {
            const maxLeft = Math.max(margin, hostRect.width - panelRect.width - margin);
            left = Math.min(Math.max(margin, left), maxLeft);
            state.panel.style.left = `${left}px`;
        }
        if (panelRect.height > 0 && hostRect.height > 0) {
            const maxTop = Math.max(margin, hostRect.height - panelRect.height - margin);
            const wouldOverflowBottom = panelRect.bottom > hostRect.bottom - margin && panelRect.height < hostRect.height;
            if (wouldOverflowBottom) {
                const aboveTop = Math.round(containerRect.top - hostRect.top - panelRect.height - offset);
                if (aboveTop >= margin) {
                    state.panel.style.top = `${aboveTop}px`;
                    return;
                }
            }
            top = Math.min(Math.max(margin, top), maxTop);
            state.panel.style.top = `${top}px`;
        }
    };
    const ensurePanel = () => {
        const host = resolvePanelHost();
        if (!host) {
            return;
        }
        if (!state.panel.isConnected) {
            host.appendChild(state.panel);
        }
    };
    const setPanelVisible = (visible) => {
        var _a;
        state.active = visible;
        if (!visible) {
            state.explicitSession = false;
            state.explicitSessionPrefixLatex = null;
        }
        state.panel.setAttribute("aria-hidden", visible ? "false" : "true");
        (_a = state.deps.container) === null || _a === void 0 ? void 0 : _a.classList.toggle("has-wysiwyg-suggestions", visible);
        if (!visible) {
            state.panel.textContent = "";
            state.panel.style.removeProperty("left");
            state.panel.style.removeProperty("top");
            state.panel.style.removeProperty("right");
            state.panel.style.removeProperty("bottom");
            state.panel.style.removeProperty("max-width");
        }
    };
    const renderCandidate = (candidate, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "math-wysiwyg-item";
        button.setAttribute("role", "option");
        const isActive = index === state.selectedIndex;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", isActive ? "true" : "false");
        const symbol = document.createElement("span");
        symbol.className = "math-wysiwyg-symbol";
        const MathLiveGlobal = window.MathLive;
        if (candidate.displayLatex && (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup)) {
            try {
                const latexToRender = `\\displaystyle ${candidate.displayLatex}`;
                symbol.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
            }
            catch {
                symbol.textContent = candidate.label;
            }
        }
        else {
            symbol.textContent = candidate.label;
        }
        const label = document.createElement("span");
        label.className = "math-wysiwyg-label";
        label.textContent = candidate.hint;
        button.appendChild(symbol);
        button.appendChild(label);
        button.addEventListener("pointerdown", (event) => {
            event.preventDefault();
        });
        button.addEventListener("click", () => {
            applyCandidate(index);
        });
        return button;
    };
    const scrollActiveIntoView = () => {
        if (!state.active) {
            return;
        }
        const activeItem = state.panel.querySelector(".math-wysiwyg-item.is-active");
        if (!activeItem) {
            return;
        }
        try {
            activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        catch {
            // ignore
        }
    };
    const renderPanel = () => {
        if (!state.active) {
            return;
        }
        state.panel.textContent = "";
        state.currentCandidates.forEach((candidate, index) => {
            state.panel.appendChild(renderCandidate(candidate, index));
        });
        positionPanelNearCaret();
        scrollActiveIntoView();
    };
    const setApplyCandidateHandler = (handler) => {
        applyCandidate = handler;
    };
    return {
        resolvePanelHost,
        ensurePanel,
        setPanelVisible,
        renderPanel,
        positionPanelNearCaret,
        scrollActiveIntoView,
        setApplyCandidateHandler,
    };
};
