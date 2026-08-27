/** Convert the engine snapshot into one unambiguous viewer state. */
export const resolvePdfLiveStatus = (status) => {
    var _a, _b;
    if (!status)
        return null;
    if (status.up === false) {
        return { key: "liveUnavailable", tone: "error", detail: "" };
    }
    // canonical.inFlight is the exact LuaLaTeX path. It may overlap with the
    // foreground engine's generic busy flag, so it must take precedence.
    if ((_a = status.canonical) === null || _a === void 0 ? void 0 : _a.inFlight) {
        return { key: "liveExactRendering", tone: "busy", detail: "" };
    }
    if (status.busy) {
        return { key: "liveUpdating", tone: "busy", detail: "" };
    }
    if (((_b = status.canonical) === null || _b === void 0 ? void 0 : _b.error) &&
        Number(status.canonical.errorRev) >= Number(status.srcRev)) {
        return { key: "liveError", tone: "error", detail: status.canonical.error };
    }
    if (status.mode === "opaque") {
        return { key: "liveFullCompile", tone: "idle", detail: "" };
    }
    return { key: "live", tone: "idle", detail: "" };
};
