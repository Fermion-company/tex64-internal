/** Convert the engine snapshot into one unambiguous viewer state. */
export const resolvePdfLiveStatus = (status, presentationPending) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    if (!status)
        return null;
    if (status.up === false) {
        return { key: "liveUnavailable", tone: "error", detail: "" };
    }
    if (status.busy || ((_b = (_a = status.render) === null || _a === void 0 ? void 0 : _a.queued) === null || _b === void 0 ? void 0 : _b.length) || ((_d = (_c = status.render) === null || _c === void 0 ? void 0 : _c.active) === null || _d === void 0 ? void 0 : _d.length) ||
        ((_e = status.render) === null || _e === void 0 ? void 0 : _e.pumping) || ((_g = (_f = status.shipping) === null || _f === void 0 ? void 0 : _f.retry) === null || _g === void 0 ? void 0 : _g.state) === "booting" ||
        ((_j = (_h = status.cold) === null || _h === void 0 ? void 0 : _h.pending) === null || _j === void 0 ? void 0 : _j.length)) {
        return { key: "liveUpdating", tone: "busy", detail: "" };
    }
    // A future timer can coexist with a compile of an earlier revision.
    // Use the explicit running state; preserve the conservative fallback
    // only for engines which predate that field.
    const compiling = typeof ((_k = status.canonical) === null || _k === void 0 ? void 0 : _k.compiling) === "boolean"
        ? status.canonical.compiling
        : Number((_l = status.canonical) === null || _l === void 0 ? void 0 : _l.authorityChildren) > 0 ||
            ((_m = status.canonical) === null || _m === void 0 ? void 0 : _m.inFlight) && typeof status.canonical.scheduledInMs !== "number";
    if (compiling) {
        return { key: "liveCompiling", tone: "busy", detail: "" };
    }
    if (((_o = status.canonical) === null || _o === void 0 ? void 0 : _o.error) &&
        Number(status.canonical.errorRev) >= Number(status.srcRev)) {
        return { key: "liveError", tone: "error", detail: status.canonical.error };
    }
    const demandedRevision = (_p = status.canonical) === null || _p === void 0 ? void 0 : _p.displayDemandRev;
    const waitingForDisplay = Number.isInteger(demandedRevision) &&
        Number(demandedRevision) === Number(status.srcRev) &&
        Number((_r = (_q = status.canonical) === null || _q === void 0 ? void 0 : _q.rev) !== null && _r !== void 0 ? _r : 0) < Number(status.srcRev);
    if (presentationPending === true || waitingForDisplay) {
        return { key: "liveExactRendering", tone: "busy", detail: "" };
    }
    if (status.mode === "opaque") {
        return { key: "liveFullCompile", tone: "idle", detail: "" };
    }
    return { key: "live", tone: "idle", detail: "" };
};
