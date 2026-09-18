"use strict";

// An accepted correction belongs to the active run and is persisted immediately.
// The id survives the run so an acknowledgement retry cannot submit it twice.
const acceptSteering = (service, id, input) => {
  const text = typeof input.message === "string" ? input.message.trim() : "";
  const key = typeof input.steeringId === "string" ? input.steeringId : "";
  if (!key || key.length > 120 || !text || text.length > 30000) return false;
  const conversation = service.buildConversation(id);
  if (conversation.some((entry) => entry.steeringId === key)) return true;
  const run = service.runningControllers.get(id);
  if (!run?.acceptingSteering || run.controller.signal.aborted || run.workspaceRoot !== service.workspace.getRootPath()) return false;
  if (run.steering.length >= 20) return false;
  conversation.push({ role: "user", content: text, steeringId: key });
  service.markSessionDirty(id);
  run.steering.push(text);
  return true;
};
module.exports = { acceptSteering };
