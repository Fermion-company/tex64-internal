"use strict";

// The provider credential is loaded only by the Electron service. It is not
// injected into the renderer build, watcher or AI web server environments.
process.env.TEX64_AGENT_RUNTIME = "agents-api";
require("./dev.cjs");
