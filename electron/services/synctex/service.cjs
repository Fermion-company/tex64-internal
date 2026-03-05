class SynctexService {
  constructor() {
    this.forwardHints = [];
    this.sourceLineCache = new Map();
    this.debugHints = process.env.TEX64_SYNCTEX_DEBUG_HINTS === "1";
  }
}

require("./hints.cjs")(SynctexService);
require("./source-cache.cjs")(SynctexService);
require("./runtime.cjs")(SynctexService);
require("./forward.cjs")(SynctexService);
require("./reverse-parse.cjs")(SynctexService);
require("./reverse-heuristics.cjs")(SynctexService);
require("./reverse-core.cjs")(SynctexService);

module.exports = { SynctexService };

