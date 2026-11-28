class SynctexService {
  constructor() {
    this.forwardHints = [];
    this.sourceLineCache = new Map();
    this.debugHints = process.env.TEX64_SYNCTEX_DEBUG_HINTS === "1";
  }

  clearWorkspaceCaches() {
    this.sourceLineCache.clear();
    this.forwardIndexCache?.clear();
    this.forwardHints.length = 0;
  }
}

require("./hints.cjs")(SynctexService);
require("./source-cache.cjs")(SynctexService);
require("./runtime.cjs")(SynctexService);
require("./forward.cjs")(SynctexService);
require("./forward-index.cjs")(SynctexService);
require("./marker-box.cjs")(SynctexService);
require("./reverse-parse.cjs")(SynctexService);
require("./reverse-heuristics.cjs")(SynctexService);
require("./reverse-core.cjs")(SynctexService);

module.exports = { SynctexService };

