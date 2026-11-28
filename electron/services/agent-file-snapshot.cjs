"use strict";

// `isTarget` decides whether a context path names the target file (the
// proposal runtime passes one that also accepts other spellings of it).
const snapshotFromContext = (context, targetPath, isTarget = (file) => file === targetPath) => {
  if (!context || !targetPath) return null;
  if (isTarget(context.activeFilePath) && typeof context.activeFileContent === "string") {
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
  const match = snapshots.find((entry) => isTarget(entry?.path));
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
