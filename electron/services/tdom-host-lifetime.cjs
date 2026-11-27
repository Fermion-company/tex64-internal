"use strict";

// The IPC pipe closes even when the TeX64 main process is killed. Use the
// engine's normal shutdown handler so resident TeX processes exit with it.
process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
