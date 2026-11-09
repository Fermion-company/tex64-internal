export const PDF_LIVE_BEHIND_THRESHOLD_MS = 3000;
/** One snapshot step; the caller owns the clock and resets on document changes. */
export const stepPdfLiveStatusMark = (status, { previous, now, presentationPending, appliedSrcRev }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
    const revision = (value) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
    const source = revision(status === null || status === void 0 ? void 0 : status.srcRev);
    const applied = revision(appliedSrcRev);
    // The iframe can apply an edit before the next /status poll arrives.
    const srcRev = source === null ? applied : Math.max(source, applied !== null && applied !== void 0 ? applied : source);
    if (srcRev !== null && (previous === null || previous === void 0 ? void 0 : previous.srcRev) != null && srcRev < previous.srcRev)
        previous = null;
    // Engine rev counts layout updates, not source edits. Only the iframe's
    // presentation acknowledgement certifies which source is actually drawn.
    const drawnRev = presentationPending === false
        ? applied !== null && applied !== void 0 ? applied : srcRev
        : (_a = previous === null || previous === void 0 ? void 0 : previous.drawnRev) !== null && _a !== void 0 ? _a : null;
    const behind = srcRev !== null && (drawnRev === null || drawnRev < srcRev);
    const progressed = drawnRev !== null && ((previous === null || previous === void 0 ? void 0 : previous.drawnRev) == null || drawnRev > previous.drawnRev);
    // More typing must not postpone overload forever. Restart only on drawing
    // progress (or after catching up), not on each new source revision.
    const behindSince = behind ? progressed ? now : (_b = previous === null || previous === void 0 ? void 0 : previous.behindSince) !== null && _b !== void 0 ? _b : now : null;
    const currentError = Boolean((_c = status === null || status === void 0 ? void 0 : status.canonical) === null || _c === void 0 ? void 0 : _c.error) && srcRev !== null &&
        revision((_d = status === null || status === void 0 ? void 0 : status.canonical) === null || _d === void 0 ? void 0 : _d.errorRev) === srcRev;
    const overloaded = behindSince !== null && now - behindSince >= PDF_LIVE_BEHIND_THRESHOLD_MS;
    const working = !status || status.busy || ((_f = (_e = status.render) === null || _e === void 0 ? void 0 : _e.queued) === null || _f === void 0 ? void 0 : _f.length) || ((_h = (_g = status.render) === null || _g === void 0 ? void 0 : _g.active) === null || _h === void 0 ? void 0 : _h.length) ||
        ((_j = status.render) === null || _j === void 0 ? void 0 : _j.pumping) || ((_l = (_k = status.cold) === null || _k === void 0 ? void 0 : _k.pending) === null || _l === void 0 ? void 0 : _l.length) || ((_o = (_m = status.shipping) === null || _m === void 0 ? void 0 : _m.retry) === null || _o === void 0 ? void 0 : _o.state) === "booting" ||
        ((_p = status.canonical) === null || _p === void 0 ? void 0 : _p.compiling) || ((_q = status.canonical) === null || _q === void 0 ? void 0 : _q.inFlight) || Number((_r = status.canonical) === null || _r === void 0 ? void 0 : _r.authorityChildren) > 0 ||
        typeof ((_s = status.canonical) === null || _s === void 0 ? void 0 : _s.scheduledInMs) === "number" ||
        (srcRev !== null && revision((_t = status.canonical) === null || _t === void 0 ? void 0 : _t.displayDemandRev) === srcRev) ||
        presentationPending !== false || behind || srcRev === null ||
        revision((_u = status.canonical) === null || _u === void 0 ? void 0 : _u.rev) === null || Number((_v = status.canonical) === null || _v === void 0 ? void 0 : _v.rev) < srcRev;
    return {
        color: (status === null || status === void 0 ? void 0 : status.up) === false || currentError || overloaded ? "red" : working ? "orange" : "green",
        srcRev,
        drawnRev,
        behindSince,
    };
};
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
