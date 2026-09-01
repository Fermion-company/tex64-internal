export const createEditorSessionNavigationOps = (runtime, coreOps, issueOps, deps) => {
    const applyContentToOpenFile = (path, content, options) => {
        const targetGroupKey = coreOps.findGroupKeyByPath(path);
        if (!targetGroupKey) {
            return false;
        }
        const targetGroup = coreOps.getEditorGroup(targetGroupKey);
        deps.applyFormattedContent(targetGroup, path, content, options);
        return true;
    };
    const jumpToFileLine = (path, line, groupKey, options = {}) => {
        const forceOpen = options.force === true;
        const focus = options.focus;
        const className = options.className;
        const column = options.column;
        const targetGroupKey = forceOpen ? groupKey : coreOps.resolveOpenTargetGroupKey(path, groupKey);
        const targetGroup = coreOps.getEditorGroup(targetGroupKey);
        if (targetGroup.currentFilePath === path) {
            issueOps.revealLine(targetGroup, line, { focus, className, column });
            return;
        }
        const requested = deps.requestOpenFile(path, targetGroupKey, forceOpen);
        if (requested) {
            runtime.fileOpsState.pendingReveal = {
                path,
                line,
                column,
                group: targetGroupKey,
                focus,
                className,
            };
        }
    };
    const jumpToLocation = (entry) => {
        if (!entry.path || !entry.line) {
            return;
        }
        jumpToFileLine(entry.path, entry.line, coreOps.getActiveEditorGroupKey());
    };
    return {
        applyContentToOpenFile,
        jumpToFileLine,
        jumpToLocation,
    };
};
