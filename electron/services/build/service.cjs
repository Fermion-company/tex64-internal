class BuildService {
  constructor() {
    this.isBuilding = false;
    this.activeProcess = null;
    this.cancelRequested = false;
  }
}

require("./actions.cjs")(BuildService);
require("./pdf-path.cjs")(BuildService);
require("./profiles.cjs")(BuildService);
require("./latexmk.cjs")(BuildService);
require("./runtime.cjs")(BuildService);
require("./issues.cjs")(BuildService);

module.exports = { BuildService };

