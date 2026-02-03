export const initUiEvents = (context, deps) => {
    const { tabs, editorHost, editorHostSecondary, diffModalSubmit, diffModalCancel, saveFileButton, } = context.dom;
    const handleSave = () => {
        deps.saveCurrentFile().catch((message) => {
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        });
    };
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
                var _a, _b;
                const diffContext = deps.diffModal.getDiffContext();
                if ((diffContext === null || diffContext === void 0 ? void 0 : diffContext.type) === "aiApply") {
                    (_a = deps.aiOps) === null || _a === void 0 ? void 0 : _a.applyPendingFromDiffModal();
                    deps.diffModal.closeDiffModal();
                    return;
                }
                (_b = deps.blockInsert) === null || _b === void 0 ? void 0 : _b.applyPendingFromDiffModal();
                deps.diffModal.closeDiffModal();
            });
        }
        if (diffModalCancel instanceof HTMLButtonElement) {
            diffModalCancel.addEventListener("click", () => {
                var _a, _b;
                deps.diffModal.closeDiffModal();
                (_a = deps.blockInsert) === null || _a === void 0 ? void 0 : _a.clearPending();
                (_b = deps.aiOps) === null || _b === void 0 ? void 0 : _b.clearPending();
            });
        }
        if (saveFileButton instanceof HTMLButtonElement) {
            saveFileButton.addEventListener("click", () => {
                handleSave();
            });
        }
        deps.buildOps.setupActionButtons();
        deps.rootSelectorUi.setupActions();
        window.addEventListener("keydown", (event) => {
            if (event.metaKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                handleSave();
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
                event.preventDefault();
                deps.buildOps.startBuild();
            }
        });
    };
    return { setup };
};
