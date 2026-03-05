export const createEditorSessionRuntime = (context, deps) => {
    var _a, _b;
    const { editorGroups: editorGroupsRoot, editorTabs, editorTabsList, editorTabsSecondary, editorTabsListSecondary, editorHost, editorHostSecondary, editorSplitButton, editorSplitter, } = context.dom;
    const editorGroupsRootEl = editorGroupsRoot instanceof HTMLElement ? editorGroupsRoot : null;
    const editorGroupPrimary = (_a = editorGroupsRootEl === null || editorGroupsRootEl === void 0 ? void 0 : editorGroupsRootEl.querySelector('[data-editor-group="primary"]')) !== null && _a !== void 0 ? _a : null;
    const editorGroupSecondary = (_b = editorGroupsRootEl === null || editorGroupsRootEl === void 0 ? void 0 : editorGroupsRootEl.querySelector('[data-editor-group="secondary"]')) !== null && _b !== void 0 ? _b : null;
    const editorGroups = {
        primary: {
            key: "primary",
            root: editorGroupPrimary,
            tabs: editorTabs,
            tabsList: editorTabsList,
            editorHost,
            viewer: context.viewers.primary,
            editor: null,
            openTabs: [],
            currentFilePath: null,
            currentFileSavedContent: null,
            isDirty: false,
            viewStates: new Map(),
            isApplyingFile: false,
            isComposing: false,
            compositionText: "",
            composingFilePath: null,
            pendingCompositionAction: null,
        },
        secondary: {
            key: "secondary",
            root: editorGroupSecondary,
            tabs: editorTabsSecondary,
            tabsList: editorTabsListSecondary,
            editorHost: editorHostSecondary,
            viewer: context.viewers.secondary,
            editor: null,
            openTabs: [],
            currentFilePath: null,
            currentFileSavedContent: null,
            isDirty: false,
            viewStates: new Map(),
            isApplyingFile: false,
            isComposing: false,
            compositionText: "",
            composingFilePath: null,
            pendingCompositionAction: null,
        },
    };
    const fileOpsState = {
        pendingOpenRequests: [],
        pendingReveal: null,
        pendingSave: null,
        autoSaveTimer: null,
        autoSavePending: false,
    };
    return {
        context,
        deps,
        dom: {
            editorGroupsRootEl,
            editorSplitButton: editorSplitButton instanceof HTMLElement ? editorSplitButton : null,
            editorSplitter: editorSplitter instanceof HTMLElement ? editorSplitter : null,
        },
        editorGroups,
        state: {
            activeEditorGroup: "primary",
            splitViewEnabled: false,
            splitRatioKey: "tex64.editorSplitRatio",
            splitRatio: 0.5,
            layoutFrame: null,
            pendingAutoOpenPath: null,
            issueDecorations: [],
            issueDecorationGroup: null,
        },
        fileOpsState,
        jumpDecorations: {
            primary: [],
            secondary: [],
        },
        jumpDecorationClassNames: {
            primary: null,
            secondary: null,
        },
        issueHighlightClassNames: new Set(["issue-line-warning", "issue-line-highlight"]),
        lastCursorPositions: new Map(),
        monacoModels: new Map(),
        dirtyFiles: new Set(),
        emptyEditorModel: null,
    };
};
