// CSP-safe replacement for the inline onload/onerror handlers that used to sit on
// the MathLive <script> tag. The page runs under script-src 'self' 'unsafe-eval',
// so inline scripts and inline event handlers are blocked outright — which meant
// the "mathlive-ready" event never fired and the setup retry path was dead.
// Loaded before mathlive.min.js; resource load/error events are caught in the
// capture phase on window because they do not bubble.
(function () {
  "use strict";
  var MATHLIVE_SRC = /mathlive(\.min)?\.js(\?|$)/;
  var isMathLiveScript = function (target) {
    return Boolean(
      target && target.tagName === "SCRIPT" && MATHLIVE_SRC.test(target.src || "")
    );
  };
  window.MATHLIVE_LOAD_ERROR = null;
  window.addEventListener(
    "load",
    function (event) {
      if (isMathLiveScript(event.target)) {
        window.dispatchEvent(new Event("mathlive-ready"));
      }
    },
    true
  );
  window.addEventListener(
    "error",
    function (event) {
      if (isMathLiveScript(event.target)) {
        window.MATHLIVE_LOAD_ERROR = "Script load failed";
      }
    },
    true
  );
})();
