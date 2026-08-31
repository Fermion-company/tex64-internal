class BuildService {
  constructor(options = {}) {
    this.isBuilding = false;
    this.activeProcess = null;
    this.cancelRequested = false;
    this.queuedBuildTail = Promise.resolve();
    // Instance overrides keep the production bounds fixed while allowing the
    // pipe-hold failure mode to be covered without a multi-minute test.
    this.processTimeoutMs =
      Number.isFinite(options.processTimeoutMs) && options.processTimeoutMs > 0
        ? options.processTimeoutMs
        : null;
    this.processForceCompletionMs =
      Number.isFinite(options.processForceCompletionMs) &&
      options.processForceCompletionMs > 0
        ? options.processForceCompletionMs
        : null;
    this.processKillEscalationMs =
      Number.isFinite(options.processKillEscalationMs) &&
      options.processKillEscalationMs > 0
        ? options.processKillEscalationMs
        : null;
  }
}

require("./actions.cjs")(BuildService);
require("./pdf-path.cjs")(BuildService);
require("./pdf-output.cjs")(BuildService);
require("./profiles.cjs")(BuildService);
require("./latexmk.cjs")(BuildService);
require("./runtime.cjs")(BuildService);
require("./issues.cjs")(BuildService);
require("./transcript.cjs")(BuildService);

module.exports = { BuildService };
