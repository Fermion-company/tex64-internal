"use strict";

const snapshotFromContext = (context, targetPath) => {
  if (!context || !targetPath) return null;
  if (context.activeFilePath === targetPath && typeof context.activeFileContent === "string") {
    return {
      path: targetPath,
      content: context.activeFileContent,
      isDirty: Boolean(context.activeFileIsDirty),
      truncated: Boolean(context.activeFileContentTruncated),
      contentLength:
        typeof context.activeFileContentLength === "number"
          ? context.activeFileContentLength
          : context.activeFileContent.length,
    };
  }
  const snapshots = Array.isArray(context.openFileSnapshots) ? context.openFileSnapshots : [];
  const match = snapshots.find((entry) => entry?.path === targetPath);
  if (!match || typeof match.content !== "string") {
    return null;
  }
  return {
    path: match.path,
    content: match.content,
    isDirty: Boolean(match.isDirty),
    truncated: Boolean(match.truncated),
    contentLength:
      typeof match.contentLength === "number" ? match.contentLength : match.content.length,
  };
};

module.exports = { snapshotFromContext };
