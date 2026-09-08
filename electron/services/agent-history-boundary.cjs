"use strict";
const historyBoundary = (service, root = service.workspace.getRootPath()) => service.getHistoryBoundary?.(root) || null;
const checkHistoryBoundary = (service, entry, root = service.workspace.getRootPath()) => {
  if ((entry?.historyBoundary || null) === historyBoundary(service, root)) return { ok: true };
  return { ok: false, reason: "history_restored", error: "The project was restored after this Axiom change. Use History to return to before the restore, or ask Axiom again." };
};
module.exports = { historyBoundary, checkHistoryBoundary };
