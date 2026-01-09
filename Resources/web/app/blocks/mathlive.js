export const initMathLive = (context, deps) => {
    const { blockMathInputContainer } = context.dom;
    const setupMathField = async () => {
        var _a;
        if (!blockMathInputContainer) {
            console.error("MathLive container not found");
            return;
        }
        if (blockMathInputContainer.querySelector("math-field")) {
            return;
        }
        const MathLiveGlobal = window.MathLive;
        const hasMathLive = !!MathLiveGlobal;
        const hasMathfieldElement = hasMathLive && !!MathLiveGlobal.MathfieldElement;
        const loadError = window.MATHLIVE_LOAD_ERROR;
        if (!customElements.get("math-field")) {
            if (hasMathfieldElement) {
                try {
                    customElements.define("math-field", MathLiveGlobal.MathfieldElement);
                }
                catch {
                    // element may already be defined
                }
            }
        }
        if (!customElements.get("math-field")) {
            const debugInfo = `MathLive: ${hasMathLive ? "OK" : "NG"}, MathfieldElement: ${hasMathfieldElement ? "OK" : "NG"}, LoadError: ${loadError || "none"}`;
            blockMathInputContainer.textContent = `Loading... (${debugInfo})`;
            try {
                await Promise.race([
                    customElements.whenDefined("math-field"),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000)),
                ]);
                blockMathInputContainer.textContent = "";
            }
            catch {
                blockMathInputContainer.innerHTML = `
          <div style="font-size:12px;">MathLiveの読み込みに失敗しました。</div>
          <div style="font-size:10px;color:#888;margin-top:4px;">${debugInfo}</div>
        `;
                blockMathInputContainer.style.color = "#ff6b6b";
                return;
            }
        }
        if (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup) {
            deps.onMathLiveReady();
        }
        else {
            deps.onEnsureMathLiveReady();
        }
        const mathfield = document.createElement("math-field");
        mathfield.id = "block-math-input";
        mathfield.className = "block-math-field";
        if (context.isE2E) {
            try {
                let e2eValue = "";
                Object.defineProperty(mathfield, "value", {
                    get() {
                        return e2eValue;
                    },
                    set(next) {
                        e2eValue = typeof next === "string" ? next : String(next !== null && next !== void 0 ? next : "");
                    },
                    configurable: true,
                });
            }
            catch {
                // ignore value override failures
            }
        }
        blockMathInputContainer.innerHTML = "";
        blockMathInputContainer.appendChild(mathfield);
        const closeMathFieldMenu = () => {
            var _a;
            const internalMenu = (_a = mathfield._mathfield) === null || _a === void 0 ? void 0 : _a.menu;
            if (internalMenu && typeof internalMenu.hide === "function") {
                if (internalMenu.state && internalMenu.state !== "closed") {
                    internalMenu.hide();
                    return;
                }
                const element = internalMenu.element;
                if (element === null || element === void 0 ? void 0 : element.isConnected) {
                    internalMenu.hide();
                    return;
                }
            }
            const executeCommand = mathfield
                .executeCommand;
            if (typeof executeCommand === "function") {
                const menuElement = document.querySelector("menu.ui-menu-container");
                if (menuElement) {
                    executeCommand.call(mathfield, "toggleContextMenu");
                }
            }
        };
        blockMathInputContainer.addEventListener("pointerdown", (event) => {
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            const clickedMenuToggle = path.some((node) => {
                var _a, _b, _c;
                if (!(node instanceof HTMLElement))
                    return false;
                if (((_a = node.getAttribute) === null || _a === void 0 ? void 0 : _a.call(node, "part")) === "menu-toggle")
                    return true;
                return (_c = (_b = node.classList) === null || _b === void 0 ? void 0 : _b.contains("ML__menu-toggle")) !== null && _c !== void 0 ? _c : false;
            });
            if (!clickedMenuToggle) {
                closeMathFieldMenu();
            }
            if (typeof mathfield.focus === "function") {
                mathfield.focus();
            }
        });
        deps.onMathFieldCreated(mathfield);
        if (typeof mathfield.setOptions === "function") {
            mathfield.setOptions({
                smartMode: false,
                defaultMode: "math",
                virtualKeyboardMode: "off",
                fontsDirectory: "mathlive/fonts",
                soundsDirectory: null,
                keypressSound: null,
                plonkSound: null,
                locale: "ja",
            });
        }
        try {
            if ("menuItems" in mathfield) {
                const blockedLabels = [
                    "モード",
                    "フォントスタイル",
                    "色",
                    "背景",
                    "切り取り",
                    "コピー",
                    "貼り付け",
                    "すべて選択",
                ];
                const blockedPattern = /(mode|font\s*style|color|background|cut|copy|paste|select\s*all)/i;
                const readText = (value) => {
                    if (typeof value === "string")
                        return value;
                    if (typeof value === "number" || typeof value === "boolean")
                        return String(value);
                    return "";
                };
                const readLabel = (value) => {
                    if (typeof value === "function") {
                        try {
                            return readText(value({ alt: false, control: false, shift: false, meta: false }));
                        }
                        catch {
                            return "";
                        }
                    }
                    return readText(value);
                };
                const isDivider = (item) => item.type === "divider";
                const cleanDividers = (items) => {
                    const cleaned = [];
                    let lastWasDivider = true;
                    for (const item of items) {
                        if (isDivider(item)) {
                            if (lastWasDivider)
                                continue;
                            cleaned.push(item);
                            lastWasDivider = true;
                            continue;
                        }
                        cleaned.push(item);
                        lastWasDivider = false;
                    }
                    while (cleaned.length > 0 && isDivider(cleaned[cleaned.length - 1])) {
                        cleaned.pop();
                    }
                    return cleaned;
                };
                const getCandidates = (item) => {
                    const candidates = [];
                    candidates.push(readText(item.id));
                    candidates.push(readLabel(item.label));
                    candidates.push(readLabel(item.ariaLabel));
                    candidates.push(readLabel(item.tooltip));
                    candidates.push(readText(item.command));
                    if (item.data && typeof item.data === "object") {
                        const dataObj = item.data;
                        candidates.push(readText(dataObj.command));
                        candidates.push(readText(dataObj.id));
                        candidates.push(readLabel(dataObj.label));
                    }
                    else {
                        candidates.push(readText(item.data));
                    }
                    return candidates.filter(Boolean);
                };
                const shouldHideItem = (candidates) => candidates.some((text) => {
                    const trimmed = text.trim();
                    if (!trimmed)
                        return false;
                    if (blockedPattern.test(trimmed))
                        return true;
                    return blockedLabels.some((label) => trimmed.includes(label));
                });
                const filterMenuItems = (items) => {
                    const filtered = items
                        .map((item) => {
                        if (!item || typeof item !== "object")
                            return null;
                        if (item.type === "heading")
                            return null;
                        const candidates = getCandidates(item);
                        if (shouldHideItem(candidates))
                            return null;
                        if (Array.isArray(item.submenu)) {
                            const submenu = filterMenuItems(item.submenu);
                            if (submenu.length === 0)
                                return null;
                            if (submenu === item.submenu)
                                return item;
                            return { ...item, submenu };
                        }
                        if (isDivider(item))
                            return item;
                        return item;
                    })
                        .filter(Boolean);
                    return cleanDividers(filtered);
                };
                const currentMenuItems = (_a = mathfield.menuItems) !== null && _a !== void 0 ? _a : [];
                mathfield.menuItems = filterMenuItems(currentMenuItems);
            }
        }
        catch {
            // ignore menu configuration failures
        }
        const injectStyles = () => {
            if (!mathfield.shadowRoot)
                return;
            if (mathfield.shadowRoot.querySelector('style[data-tex64-style]'))
                return;
            const style = document.createElement("style");
            style.setAttribute("data-tex64-style", "true");
            style.textContent = `
        :host {
          color: var(--text, #eef3fb) !important;
          background-color: transparent !important;
        }
        .ML__field {
          color: var(--text, #eef3fb) !important;
        }
        .ML__placeholder {
          color: #8fb3d4 !important;
          opacity: 0.85;
        }
        .ML__selection {
          background: rgba(110, 195, 255, 0.7) !important;
          color: #f8fbff !important;
        }
        .ML__caret {
          background-color: var(--accent, #5bc2ff) !important;
        }
        .ML__contains-highlight {
          background: rgba(110, 195, 255, 0.25) !important;
        }
        .ML__virtual-keyboard-toggle {
          display: none !important;
        }
        button[part="virtual-keyboard-toggle"] {
          display: none !important;
        }
        .ML__container {
          justify-content: flex-start !important;
          padding-right: 2px !important;
        }
        .ML__content {
          flex: 1 1 auto !important;
          min-width: 0 !important;
        }
        .ML__toggles {
          margin-left: auto !important;
        }
        .ML__menu-toggle {
          margin-right: 0 !important;
          width: 28px !important;
          height: 28px !important;
        }
      `;
            mathfield.shadowRoot.appendChild(style);
        };
        setTimeout(() => {
            injectStyles();
        }, 0);
        deps.onAttachMathFieldEvents(mathfield);
    };
    return { setupMathField };
};
