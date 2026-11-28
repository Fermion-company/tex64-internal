"use strict";

const fs = require("node:fs/promises");

async function readWorkspaceComments(file) {
  let contents;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { comments: [], missing: true };
    throw error;
  }
  const stored = JSON.parse(contents);
  if (!Array.isArray(stored?.comments)) throw new Error("Invalid .tex64/comments.json.");
  const comments = stored.comments.map(comment => {
    const range = comment?.range ?? comment;
    if (typeof comment?.id !== "string" || typeof comment.filePath !== "string" ||
        typeof comment.text !== "string" || !comment.text.trim() ||
        ![range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn].every(Number.isFinite)) {
      throw new Error("Invalid comment in .tex64/comments.json.");
    }
    return comment.range ? comment : { ...comment, range: {
      startLineNumber: range.startLineNumber, startColumn: range.startColumn,
      endLineNumber: range.endLineNumber, endColumn: range.endColumn,
    } };
  });
  return { comments };
}

module.exports = { readWorkspaceComments };
