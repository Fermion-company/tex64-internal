export const createEditorSessionNavigationOps = (runtime, coreOps, issueOps, deps) => {
    const applyContentToOpenFile = (path, content, options) => {
        const targetGroupKey = coreOps.findGroupKeyByPath(path);
        if (!targetGroupKey) {
            return { handled: false, conflict: false };
        }
        const targetGroup = coreOps.getEditorGroup(targetGroupKey);
        const conflict = deps.applyFormattedContent(targetGroup, path, content, options);
        return { handled: true, conflict };
    };
    const jumpToFileLine = (path, line, groupKey, options = {}) => {
        const forceOpen = options.force === true;
        const { focus, className, column, issueMessage } = options;
        const targetGroupKey = forceOpen ? groupKey : coreOps.resolveOpenTargetGroupKey(path, groupKey);
        const targetGroup = coreOps.getEditorGroup(targetGroupKey);
        if (targetGroup.currentFilePath === path) {
            issueOps.revealLine(targetGroup, line, { focus, className, column, issueMessage });
            return;
        }
        // An open tab can install its model before requestOpenFile returns.
        const reveal = { path, line, column, issueMessage, group: targetGroupKey, focus, className };
        runtime.fileOpsState.pendingReveal = reveal;
        if (!deps.requestOpenFile(path, targetGroupKey, forceOpen) && runtime.fileOpsState.pendingReveal === reveal) {
            runtime.fileOpsState.pendingReveal = null;
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
